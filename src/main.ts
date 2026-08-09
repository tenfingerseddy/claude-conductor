// Daemon entry point and the M1 task loop.
//
// runTasks is the whole of the core loop in one function: for each task in order, start a fresh
// session on the chosen account, let Claude work, take the cut when it calls finish_task, and hand
// the note it wrote to the next task. The list is a plain array on purpose. The real queue, with
// pacing and playbook rules deciding what runs when, is M2.

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveAccount, usableAccounts, type Config } from './config.ts';
import { buildOpeningPrompt, logCut, type Carry } from './engine/cut.ts';
import { logTaskFinish, type FinishTaskCall } from './engine/finish-task.ts';
import { Gauge, readOfficialFile, usableForPause, windowIdFor, type Reading, type UsageWindows, type WindowId } from './engine/gauge.ts';
import { createWorkspace, describeWorkspace, sealWorkspace, type Workspace } from './engine/isolation.ts';
import { runSession, trustRefusal, type Approver, type SessionHandle, type Task } from './engine/session.ts';
import { startDaemon } from './server/http.ts';
import { logEvent, type TokenUsage } from './state/logbook.ts';
import { readPauseThreshold, readPlaybook } from './state/playbook.ts';
import { tokenPath } from './state/token.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export const VERSION = '0.1.0';

export interface TaskRun {
  taskId: string;
  sessionId: string | undefined;
  outcome: string;
  handoffPath: string | null;
  followUps: string[];
  usage: TokenUsage;
  errorText: string | null;
}

export interface RunTasksOptions {
  config?: Config;
  /** Every SDK message, tagged with its task, so the doors can stream it. */
  onMessage?: (taskId: string, message: SDKMessage) => void;
  approve?: Approver;
  /** Gauges owned by the caller, so a long-lived daemon keeps self-metering across runs. */
  gauges?: Map<string, Gauge>;
  /** The queued task, the copy it will run in, and the sentence describing that copy. */
  onTaskStart?: (task: Task, workspace: Workspace, description: string) => void;
  onTaskFinish?: (run: TaskRun) => void;
  /** The running session's handle, or null when no session is running. */
  onHandle?: (handle: SessionHandle | null) => void;
  /** What the previous run handed over, so a second `conductor run` is not a memory wipe. */
  carry?: Carry | null;
  /** The note this run ends holding, for the caller to feed back in next time. */
  onCarry?: (carry: Carry | null) => void;
  /** A task is waiting for a limit window to reset. Null when the wait is over. */
  onPause?: (pause: PauseNotice | null) => void;
}

// --- the pause primitive -----------------------------------------------------
//
// The smallest useful piece of slice D, brought forward because Kane asked for lost time to be
// measurable and there is nothing to measure until something actually pauses. The full pacing brain
// (heavy work waits for a reset, light work fills the headroom that is left) is still slice D.
//
// The shape is deliberately dumb: before a task starts, if the binding window has no room, do not
// start it, wait for the reset, look again. One rule, one wait, two log lines. Everything clever
// about ordering the queue against the gauge belongs later and is not smuggled in here.

/** Resets are not exact, so the wait clears the stated time by a margin before looking again. */
export const RESET_GRACE_MS = 60 * 1000;

/**
 * How many resets one hold may wait out before the task is refused.
 *
 * Not a safety valve for the common case, which resolves on round one. It is there because every
 * round after the first is the account saying a window we already waited out is still full, and at
 * that point the honest reading is that Conductor does not understand these numbers.
 *
 * What it does *not* do is let the task through. Sol's finding 1: ending the ceiling by starting the
 * task turned the paid-credit rail into a three-strikes rule, so the ceiling now ends in a refusal.
 * Waiting forever costs the machine; passing costs money. Refusing costs a re-queue.
 */
const MAX_PAUSE_ROUNDS = 3;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** What a door shows while a task is held back. */
export interface PauseNotice {
  holdId: string;
  startedAt: string;
  taskId: string;
  account: string;
  window: WindowId;
  utilization: number;
  resetsAt: string;
  threshold: number;
  reason: 'threshold' | 'paid_credit_boundary';
  tasksWaiting: number;
  waitUntil: string;
  sentence: string;
}

/** A wait in progress. Only the way to end it, because that is all the shutdown path needs. */
interface ActivePause {
  finish: (interrupted: boolean) => void;
}

// Process-wide, because the thing that stops the daemon is not the thing that is waiting. A pause
// that dies with the process and logs nothing is a gap in exactly the measurement this feature
// exists to produce, so the shutdown path reaches in here and closes the books first.
const activePauses = new Set<ActivePause>();

/**
 * Ends every running pause as interrupted, logging what each one had cost so far. Called on the way
 * out of the daemon. Returns how many pauses it closed, so a caller can say so.
 *
 * Synchronous on purpose: it runs inside a shutdown handler that is about to exit the process, and
 * logEvent is a single appendFileSync, so the line is on disk before anything else happens.
 */
export function interruptPauses(): number {
  const closing = [...activePauses];
  for (const pause of closing) pause.finish(true);
  return closing.length;
}

function windowName(window: WindowId): string {
  return window === 'session_5h' ? '5-hour' : 'weekly';
}

/**
 * The sentence a human reads. It names every cause, not only the one being waited on, for the same
 * reason the event does: the window that decides how long the wait is and the window that decides
 * whether money was at stake need not be the same window.
 */
function pauseSentence(notice: Omit<PauseNotice, 'sentence' | 'holdId' | 'startedAt'>, causes: GateVerdict['causes']): string {
  // Grouped by window, because one window can fire both causes and saying "the 5-hour window is at
  // 100%" twice in one sentence reads like a stutter rather than like two facts.
  const byWindow = new Map<WindowId, { utilization: number; kinds: Set<string> }>();
  for (const cause of causes) {
    const entry = byWindow.get(cause.window) ?? { utilization: cause.utilization, kinds: new Set<string>() };
    entry.kinds.add(cause.kind);
    byWindow.set(cause.window, entry);
  }
  const reasons = [...byWindow.entries()].map(([window, entry]) => {
    const parts: string[] = [];
    if (entry.kinds.has('threshold')) parts.push(`at or above the ${notice.threshold}% pause threshold`);
    if (entry.kinds.has('paid_credit_boundary')) {
      parts.push('at the plan limit, which this account does not stop at because extra-usage credits are enabled, so more work would spend real money');
    }
    return `the ${windowName(window)} window is at ${Math.round(entry.utilization)}%, ${parts.join(', and ')}`;
  });
  const queue = notice.tasksWaiting > 1 ? ` ${notice.tasksWaiting} tasks are waiting, including this one.` : ' It is the only task waiting.';
  // Said only when it is true: with both windows tripped, the wait is aimed at the one that clears
  // last, because clearing the earlier one would leave the later one still blocking.
  const later = new Set(causes.map((cause) => cause.window)).size > 1 ? ', the later of the two to clear,' : '';
  const why = reasons.join('; and ');
  return (
    `Paused: task ${notice.taskId} has not started on account "${notice.account}". ` +
    `${why.charAt(0).toUpperCase()}${why.slice(1)}. Waiting until the ${windowName(notice.window)} window${later} ` +
    `resets at ${notice.resetsAt}, then starting.${queue}`
  );
}

/**
 * Why a reading that says "no room" is not one Conductor will stop work on. It names each test the
 * reading actually failed and no others: a line claiming a reset time has passed when it has not is
 * the same kind of small lie the gauge labels exist to prevent, and it was in the first version of
 * this message.
 */
function unusableReason(window: keyof UsageWindows, percent: number, reading: Reading, now: number = Date.now()): string {
  const failures: string[] = [];
  if (reading.confidence !== 'fresh') failures.push(`the reading is ${reading.confidence} from ${reading.source}`);
  if (reading.resetsAt === null) {
    failures.push('it carries no reset time');
  } else {
    const resetsAtMs = Date.parse(reading.resetsAt);
    if (!Number.isFinite(resetsAtMs)) failures.push(`its reset time "${reading.resetsAt}" is not a time`);
    else if (resetsAtMs <= now) failures.push(`its reset time ${reading.resetsAt} has already passed, leaving it describing a window that is gone`);
  }
  return (
    `the ${window === 'fiveHour' ? '5-hour' : 'weekly'} window reads ${Math.round(percent)}% but ` +
    `${failures.join(', and ')}, so it cannot say when a pause would end. Starting the task rather than idling on a guess.`
  );
}

/**
 * Every other usable account's file reading, taken at this moment, each carrying whether it is
 * evidence Conductor would itself act on.
 *
 * The freshness flags are the whole point. Without them the report counted a week-old file reading
 * zero as proof of headroom, which is the strongest claim in the whole feature resting on the
 * weakest evidence in it. `usableForPause` is reused rather than reimplemented so the standard for
 * "this account had room" is literally the standard for "this account had no room".
 */
function otherAccountReadings(
  config: Config,
  paused: string,
): { account: string; ageMs: number | null; fiveHour: number | null; weekly: number | null; fiveHourUsable: boolean; weeklyUsable: boolean }[] {
  const now = Date.now();
  return usableAccounts(config)
    .filter((account) => account.name !== paused)
    .map((account) => {
      const file = readOfficialFile(account.configDir, now);
      return {
        account: account.name,
        ageMs: file?.ageMs ?? null,
        fiveHour: file?.fiveHour.percent ?? null,
        weekly: file?.weekly.percent ?? null,
        fiveHourUsable: file ? usableForPause('fiveHour', file.fiveHour, now) !== null : false,
        weeklyUsable: file ? usableForPause('weekly', file.weekly, now) !== null : false,
      };
    });
}

/** Everything the pause gate concluded about one look at the gauge. */
interface GateVerdict {
  /** Every cause that fired, across both windows, independent of which one is waited on. */
  causes: { window: WindowId; utilization: number; kind: 'threshold' | 'paid_credit_boundary' }[];
  /** The window whose reset the wait aims at, or null when nothing actionable tripped. */
  binding: { window: WindowId; percent: number; resetsAt: string; resetsAtMs: number } | null;
  /** Set when a window says there is no room but no reading can say when the room comes back. */
  unusable: string | null;
}

/**
 * One look at the gauge: what fired, what to wait for, and whether anything can be trusted.
 *
 * Causes are collected across both windows before a binding window is chosen, because the two
 * questions are genuinely separate. Which window we wait on is "when can work resume". Which causes
 * fired is "why did work stop", and a reader deciding whether to raise the threshold needs the
 * second one whole.
 */
function readGate(gauge: Gauge, threshold: number, now: number = Date.now()): GateVerdict {
  const creditsEnabled = gauge.extraUsageEnabled === true;
  const causes: GateVerdict['causes'] = [];
  const actionable: { window: WindowId; percent: number; resetsAt: string; resetsAtMs: number }[] = [];
  let unusable: string | null = null;

  for (const window of ['fiveHour', 'weekly'] as (keyof UsageWindows)[]) {
    const reading = gauge.readingFor(window);
    const percent = reading.percent;
    if (percent === null) continue;
    const overThreshold = percent >= threshold;
    const overPlan = percent >= 100;
    if (!overThreshold && !overPlan) continue;

    if (overThreshold) causes.push({ window: windowIdFor(window), utilization: percent, kind: 'threshold' });
    // Independent of the threshold, and independent of which window ends up binding. At the plan
    // limit an account with credits enabled starts spending money rather than stopping, and that
    // fact belongs on the event whether or not this is the window being waited out.
    if (overPlan && creditsEnabled) causes.push({ window: windowIdFor(window), utilization: percent, kind: 'paid_credit_boundary' });

    const usable = usableForPause(window, reading, now);
    if (usable) actionable.push(usable);
    else unusable ??= unusableReason(window, percent, reading, now);
  }

  if (actionable.length === 0) return { causes, binding: null, unusable: causes.length > 0 ? unusable : null };

  // When both windows are full, waiting out the earlier one leaves the later one still blocking, so
  // the binding window is the one that clears last. It is also the honest number to report: it is
  // when work can actually resume.
  const binding = actionable.reduce((worst, entry) => (entry.resetsAtMs > worst.resetsAtMs ? entry : worst));
  return { causes, binding, unusable: null };
}

/** What a hold ended as. `refused` means the task must not start at all. */
export type HoldOutcome =
  | { paused: boolean; interrupted: false; refusal: null }
  | { paused: true; interrupted: true; refusal: null }
  | { paused: true; interrupted: false; refusal: string };

/**
 * Holds a task back while the account it runs on has no room, and measures the hold.
 *
 * One call is one hold, however many times the gauge is re-read inside it. That is Sol's finding 5:
 * a task that stayed blocked for three rounds used to be reported as three separate incidents, so
 * the count was inflated, the worst incident was shortened to its longest single round, and the
 * gaps between rounds vanished from the total even though the task was still held throughout.
 *
 * Three ways out, and only one of them starts the task:
 *
 *   - the windows come back with room, so the task runs;
 *   - the daemon stops mid-wait, so nothing starts and nobody is left to watch it;
 *   - the retry ceiling is reached, so the task is refused.
 *
 * That last one is Sol's finding 1 and it was a design error rather than a bug. The ceiling used to
 * end by starting the task, which turned "never cross into paid credits without a human" into
 * "cross it on the fourth attempt". A ceiling exists to stop Conductor waiting forever on numbers it
 * cannot make sense of. It is not a grant of passage, and the honest end of one is a refusal a human
 * can read and act on.
 */
export async function pauseForLimits(
  config: Config,
  gauge: Gauge,
  task: Task,
  tasksWaiting: number,
  onPause?: (pause: PauseNotice | null) => void,
): Promise<HoldOutcome> {
  const threshold = readPauseThreshold(config);
  let hold: Hold | null = null;
  let rounds = 0;
  // Summed across rounds, so the predicted cost of a hold is the whole of what it predicted rather
  // than only its first leg.
  let plannedTotalMs = 0;
  let lastResetsAtMs = 0;

  const release = (result: HoldOutcome): HoldOutcome => {
    if (hold) {
      hold.end(result.interrupted, rounds, plannedTotalMs);
      onPause?.(null);
    }
    return result;
  };

  for (let round = 0; round < MAX_PAUSE_ROUNDS; round++) {
    if (round > 0) gauge.refreshFile();
    const gate = readGate(gauge, threshold);

    if (gate.causes.length === 0) return release({ paused: hold !== null, interrupted: false, refusal: null });

    if (!gate.binding) {
      // Something says there is no room and nothing can say when the room returns. Not pausing is
      // the safe direction here, and it stays the safe direction inside a hold: a wait with no
      // stated end is not a measurement, it is an outage.
      logEvent(config, { kind: 'limit_reading_unusable', account: gauge.account, taskId: task.id, reason: gate.unusable ?? 'no usable reading' });
      return release({ paused: hold !== null, interrupted: false, refusal: null });
    }

    // A later round must be waiting for something new. If the account comes back with a reset time
    // no later than the one just sat through, its numbers are not rolling the way a window rolls,
    // and waiting again would be waiting on a reading already disproved.
    if (round > 0 && gate.binding.resetsAtMs <= lastResetsAtMs) {
      logEvent(config, {
        kind: 'limit_reading_unusable',
        account: gauge.account,
        taskId: task.id,
        reason:
          `after waiting for ${new Date(lastResetsAtMs).toISOString()} the account still reports the same or an ` +
          `earlier reset (${gate.binding.resetsAt}) at ${Math.round(gate.binding.percent)}%, so the window is not ` +
          `rolling the way the reading claims. Not waiting again on a number that did not move.`,
      });
      return release({ paused: hold !== null, interrupted: false, refusal: null });
    }
    lastResetsAtMs = gate.binding.resetsAtMs;

    // Revalidated here rather than trusted from the check above, because that check ran against an
    // earlier `Date.now()` and the reset can fall between the two. Sol's finding 3: a window that
    // expired in that gap still produced a wait and a pause count, against the rule that an expired
    // reading never pauses.
    const startedAtMs = Date.now();
    if (gate.binding.resetsAtMs <= startedAtMs) {
      logEvent(config, {
        kind: 'limit_reading_unusable',
        account: gauge.account,
        taskId: task.id,
        reason:
          `the ${gate.binding.window === 'session_5h' ? '5-hour' : 'weekly'} window reads ` +
          `${Math.round(gate.binding.percent)}% and its reset time ${gate.binding.resetsAt} passed while the gate was ` +
          `being read, so the window it describes is already gone. Not starting a wait for a reset that has happened.`,
      });
      return release({ paused: hold !== null, interrupted: false, refusal: null });
    }

    const plannedMs = Math.max(0, gate.binding.resetsAtMs + RESET_GRACE_MS - startedAtMs);

    if (!hold) {
      hold = beginHold(config, gauge, task, threshold, tasksWaiting, gate, startedAtMs);
      onPause?.(hold.notice);
      process.stdout.write(`conductor: ${hold.notice.sentence}\n`);
    }
    rounds = round + 1;
    plannedTotalMs += plannedMs;

    if (await hold.wait(plannedMs)) return release({ paused: true, interrupted: true, refusal: null });
  }

  // The ceiling. Every round was a fresh reading that still said no room, so the account is not
  // going to let this task run and Conductor is not going to guess its way past that.
  const refusal =
    `held for ${MAX_PAUSE_ROUNDS} rounds and account "${gauge.account}" still reports no room on a fresh reading, ` +
    `so this task was refused rather than started. Conductor waits for a window to reset; it does not decide that ` +
    `enough waiting earns a pass, and on an account with extra-usage credits enabled that pass would spend money. ` +
    `Re-queue the task once the gauge shows room, or raise the pause threshold in the playbook deliberately.`;
  return release({ paused: true, interrupted: false, refusal });
}

/** A hold in progress: the events are its edges, and everything between them is one measurement. */
interface Hold {
  notice: PauseNotice;
  /** Waits out one round. Resolves true when the daemon stopped and the hold is over. */
  wait(ms: number): Promise<boolean>;
  /** Writes `limit_resume`. Idempotent, so an interrupt and a timer cannot both close the books. */
  end(interrupted: boolean, rounds: number, plannedMs: number): void;
}

function beginHold(
  config: Config,
  gauge: Gauge,
  task: Task,
  threshold: number,
  tasksWaiting: number,
  gate: GateVerdict,
  startedAtMs: number,
): Hold {
  const binding = gate.binding!;
  const holdId = `h${randomBytes(9).toString('hex')}`;
  const startedAt = new Date(startedAtMs).toISOString();
  // Elapsed time comes off a monotonic clock. Sol's finding 3: with wall-clock subtraction a system
  // clock stepping backwards during a real hour-long wait produces a negative lostMs, which the
  // report would then subtract from the total, and a forward correction invents time nobody waited.
  const startedAtMonotonic = performance.now();

  // The strongest cause across every window, not the binding window's own. A weekly window can bind
  // the wait while the five-hour window is the one sitting on the money line.
  const reason: PauseNotice['reason'] = gate.causes.some((cause) => cause.kind === 'paid_credit_boundary')
    ? 'paid_credit_boundary'
    : 'threshold';

  const bare = {
    taskId: task.id,
    account: gauge.account,
    window: binding.window,
    utilization: binding.percent,
    resetsAt: binding.resetsAt,
    threshold,
    reason,
    tasksWaiting,
    waitUntil: new Date(binding.resetsAtMs + RESET_GRACE_MS).toISOString(),
  };
  const notice: PauseNotice = { ...bare, holdId, startedAt, sentence: pauseSentence(bare, gate.causes) };

  logEvent(config, {
    kind: 'limit_pause',
    holdId,
    taskId: task.id,
    account: gauge.account,
    startedAt,
    window: binding.window,
    utilization: round2(binding.percent),
    resetsAt: binding.resetsAt,
    threshold,
    reason,
    causes: gate.causes.map((cause) => ({ ...cause, utilization: round2(cause.utilization) })),
    creditsEnabled: gauge.extraUsageEnabled,
    creditsFresh: gauge.extraUsageFresh,
    tasksWaiting,
    otherAccounts: otherAccountReadings(config, gauge.account),
  });

  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let interruptRound: ((interrupted: boolean) => void) | null = null;

  const entry: ActivePause = {
    finish: (interrupted: boolean) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      interruptRound?.(interrupted);
    },
  };
  activePauses.add(entry);

  return {
    notice,
    wait: (ms: number) =>
      new Promise<boolean>((resolve) => {
        let done = false;
        const settleRound = (interrupted: boolean): void => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          timer = null;
          interruptRound = null;
          resolve(interrupted);
        };
        interruptRound = settleRound;
        timer = setTimeout(() => settleRound(false), ms);
      }),
    end: (interrupted: boolean, rounds: number, plannedMs: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activePauses.delete(entry);
      logEvent(config, {
        kind: 'limit_resume',
        holdId,
        taskId: task.id,
        account: gauge.account,
        startedAt,
        // Rounded, not floored: this is a duration in milliseconds and Math.max keeps a monotonic
        // clock that somehow went backwards from producing a negative one.
        lostMs: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
        plannedMs,
        rounds,
        interrupted,
      });
    },
  };
}

// Task ids currently being worked, process-wide. Sol's pass 2 finding 3: nothing marked or removed
// a task, so two overlapping callers could both run the same one, each logging its own start,
// finish and cut and racing for the same handoff filename. A claim is the smallest thing that makes
// that impossible without pretending this in-memory array is the real queue, which is M2's job.
const claimedTasks = new Set<string>();

export async function runTasks(tasks: Task[], options: RunTasksOptions = {}): Promise<TaskRun[]> {
  const config = options.config ?? loadConfig();
  const gauges = options.gauges ?? new Map<string, Gauge>(); // one per account, so self-metering accumulates
  const runs: TaskRun[] = [];
  let carry: Carry | null = options.carry ?? null;

  // A snapshot, because a live array can be appended to while this loop is suspended at an await,
  // and a JavaScript array iterator would happily walk into the new entries.
  const claimed: Task[] = [];
  for (const task of [...tasks]) {
    if (claimedTasks.has(task.id)) {
      process.stderr.write(`conductor: task "${task.id}" is already being worked, so this run skips it.\n`);
      continue;
    }
    claimedTasks.add(task.id);
    claimed.push(task);
  }

  try {
    for (const [index, task] of claimed.entries()) {
      // Gate two of two for autonomous trust. The queue refuses it on the way in; this refuses it
      // on the way out, so a task queued by an older daemon or written straight into the list is
      // still blocked rather than started. It is never downgraded to attended: a task written for
      // nobody to watch should be re-queued by a human, not reinterpreted by Conductor.
      const refusal = trustRefusal(task.trust);
      if (refusal) {
        const blocked: TaskRun = { taskId: task.id, sessionId: undefined, outcome: 'blocked', handoffPath: null, followUps: [], usage: {}, errorText: refusal };
        runs.push(blocked);
        logTaskFinish(config, task.id, 'blocked', null, null, {});
        options.onTaskFinish?.(blocked);
        continue;
      }

      // The execution path resolves accounts through the same validation the listing path uses,
      // and does not re-check placeholder and existence itself. Sol's re-check finding 7: the old
      // copy of the rules here missed the repository guard, so an account holding a login inside a
      // git checkout was hidden from every list and still executed when a task named it.
      const account = resolveAccount(config, task.account);
      if (!account) {
        const problem = `account "${task.account}" is not usable; check "${config.configFilePath}"`;
        const blocked: TaskRun = { taskId: task.id, sessionId: undefined, outcome: 'blocked', handoffPath: null, followUps: [], usage: {}, errorText: problem };
        runs.push(blocked);
        logTaskFinish(config, task.id, 'blocked', null, null, {});
        options.onTaskFinish?.(blocked);
        continue;
      }

      let gauge = gauges.get(account.name);
      if (!gauge) {
        gauge = new Gauge(config, account.name, account.configDir);
        gauges.set(account.name, gauge);
      }

      gauge.refreshBeforeTask(); // so the opening turn's gauge line carries a number, not a shrug

      // The pause, before the copy is made and before a single token is spent. Ordering matters:
      // making a worktree and then sitting on it for hours leaves a copy of the user's repo pinned
      // to a commit that ages while nothing works in it.
      const held = await pauseForLimits(config, gauge, task, claimed.length - index, options.onPause);
      // Two ways a hold ends without the task running, and both refuse rather than downgrade. The
      // refusal case is the retry ceiling: the account still has no room after every round, so the
      // task is blocked exactly like the trust and account gates above block one.
      if (held.interrupted || held.refusal) {
        const blocked: TaskRun = {
          taskId: task.id,
          sessionId: undefined,
          outcome: 'blocked',
          handoffPath: null,
          followUps: [],
          usage: {},
          errorText: held.refusal ?? 'the daemon stopped while this task was waiting for a limit window to reset, so it never started',
        };
        runs.push(blocked);
        logTaskFinish(config, task.id, 'blocked', null, null, {});
        options.onTaskFinish?.(blocked);
        if (held.interrupted) break; // the process is going down; the tasks behind this one are not ours to start
        continue; // the ceiling is this task's problem; the next one gets its own look at the gauge
      }
      if (held.paused) gauge.refreshBeforeTask(); // the numbers moved while we waited; log where they landed

      // The isolated copy, made before a single token is spent. A task that cannot be given its own
      // copy does not start, and there is deliberately no fallback to the user's folder: that
      // fallback is the whole failure mode isolation exists to remove. Every later slice of M2 that
      // loosens a permission rests on this line being here.
      const created = createWorkspace(config, task);
      if (!created.ok) {
        const blocked: TaskRun = { taskId: task.id, sessionId: undefined, outcome: 'blocked', handoffPath: null, followUps: [], usage: {}, errorText: created.reason };
        runs.push(blocked);
        logTaskFinish(config, task.id, 'blocked', null, null, {});
        options.onTaskFinish?.(blocked);
        continue;
      }
      const workspace = created.workspace;

      // What the session sees. Its cwd is the copy, so every structured-tool path check scopes to
      // the copy rather than to the folder the human is watching; `userCwd` keeps the folder they
      // named available for anything that has to say where the copy came from.
      const isolated: Task = { ...task, cwd: workspace.workdir, userCwd: task.cwd };

      logEvent(config, {
        kind: 'task_start',
        taskId: task.id,
        account: account.name,
        cwd: task.cwd,
        workdir: workspace.workdir,
        branch: workspace.branch,
        ...(task.model ? { model: task.model } : {}),
      });
      options.onTaskStart?.(task, workspace, describeWorkspace(workspace));

      // The seal, taken the moment the session stops for any reason. A task that crashes is exactly
      // the one whose work most needs capturing, so this is a `finally` and not a success path. The
      // copy is never discarded here: the branch is the task's output, and discarding is the
      // human's undo verb.
      //
      // A seal that fails must not eat the session's result. It is logged by sealWorkspace, its
      // reason joins the run's errorText below, and the copy is left on disk with the work in it.
      let result;
      let sealProblem: string | null = null;
      try {
        result = await runSession(config, isolated, {
          configDir: account.configDir,
          gauge,
          openingPrompt: buildOpeningPrompt(task.prompt, carry),
          ...(options.onMessage ? { onMessage: (message: SDKMessage) => options.onMessage?.(task.id, message) } : {}),
          ...(options.approve ? { approve: options.approve } : {}),
          ...(options.onHandle ? { onHandle: options.onHandle } : {}),
        });
      } finally {
        const sealed = sealWorkspace(config, workspace);
        if (!sealed.ok) {
          sealProblem =
            `the task's work could not be sealed onto "${workspace.branch}", so it is still uncommitted in ` +
            `"${workspace.worktreePath}": ${sealed.reason}`;
          process.stderr.write(`conductor: ${sealProblem}\n`);
        }
      }

      const finish: FinishTaskCall | null = result.finish;
      // A session that ends without finish_task did not hand off, and three things follow from
      // that (Sol pass 2 finding 1). The outcome is "aborted", not a quiet success: the task was
      // consumed and nobody said it was done. No cut event is written, because no cut happened and
      // a logbook that claims one is worse than a logbook missing one. And the carry is left
      // exactly as it was, so the next task still gets the last note somebody actually wrote
      // rather than being wiped by a task that fell over.
      const outcome = finish?.outcome ?? 'aborted';
      logTaskFinish(config, task.id, outcome, finish?.handoffPath ?? null, gauge.contextPeakPercent, result.usage);
      if (finish) {
        logCut(config, task.id, result.sessionId, `finish_task: ${finish.outcome}`);
        carry = { handoff: finish.handoff, handoffPath: finish.handoffPath, outcome: finish.outcome };
      }

      const run: TaskRun = {
        taskId: task.id,
        sessionId: result.sessionId,
        outcome,
        handoffPath: finish?.handoffPath ?? null,
        followUps: finish?.followUps ?? [],
        usage: result.usage,
        // Both problems, if both happened. A failed seal is a fact about the task's output and a
        // failed session is a fact about its work; reporting only one of them loses the other.
        errorText:
          [result.errorText ?? (finish ? null : 'the session ended without calling finish_task'), sealProblem]
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join('; ') || null,
      };
      runs.push(run);
      options.onTaskFinish?.(run);
    }
  } finally {
    for (const task of claimed) claimedTasks.delete(task.id);
    options.onCarry?.(carry);
  }

  return runs;
}

/** Boots the daemon in the foreground: state, log line, server, and a clean shutdown. */
export async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const accounts = usableAccounts(config);
  const playbook = readPlaybook(config);

  logEvent(config, {
    kind: 'daemon_start',
    pid: process.pid,
    stateRoot: config.stateRoot,
    version: VERSION,
    accounts: accounts.length,
  });

  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    // Before anything else, because a pause that is never resumed is a hole in the lost-time record
    // and the process is about to go away. Each open pause logs what it had cost and that it was cut
    // short, so the report can list it as a real wait rather than dropping it or guessing its end.
    const closed = interruptPauses();
    if (closed > 0) process.stdout.write(`conductor: ${closed} limit pause(s) ended early by the stop; each is logged as interrupted.\n`);
    logEvent(config, { kind: 'daemon_stop', pid: process.pid, reason });
    void daemon.close().finally(() => process.exit(0));
  };

  // Wrinkle 4 from the M1 finish line run. Windows cannot deliver SIGINT to a child process, so a
  // supervisor that stops the daemon programmatically killed it without its shutdown handler ever
  // running and `daemon_stop` was simply never logged. The fix is a door rather than a signal:
  // `POST /stop` (token required, like every other state-changing route) logs the stop and closes
  // the listener, and `conductor stop` is the CLI in front of it. Signals stay wired for a real
  // Ctrl+C at a real console, which does deliver.
  const daemon = await startDaemon(config, { onStop: () => stop('stop endpoint') });

  process.stdout.write(
    [
      `conductor ${VERSION}`,
      `  listening:  http://127.0.0.1:${daemon.port} (loopback only)`,
      `  state root: "${config.stateRoot}"`,
      `  door token: "${tokenPath(config)}" (fresh for this daemon; doors read it from there)`,
      `  playbook:   ${playbook.length} chars`,
      `  accounts:   ${accounts.length} usable of ${config.accounts.length} configured`,
      '',
    ].join('\n'),
  );

  if (accounts.length === 0) {
    process.stdout.write(
      `\nNo usable accounts yet. Edit "${config.configFilePath}" and point each entry at a real\n` +
        `Claude Code config directory.\n`,
    );
  }

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

// Only when run as the program. Importing this module (the CLI door, tests, a harness) must not
// boot a daemon as a side effect.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runDaemon();
