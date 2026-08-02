// Daemon entry point and the M1 task loop.
//
// runTasks is the whole of the core loop in one function: for each task in order, start a fresh
// session on the chosen account, let Claude work, take the cut when it calls finish_task, and hand
// the note it wrote to the next task. The list is a plain array on purpose. The real queue, with
// pacing and playbook rules deciding what runs when, is M2.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveAccount, usableAccounts, type Config } from './config.ts';
import { buildOpeningPrompt, logCut, type Carry } from './engine/cut.ts';
import { logTaskFinish, type FinishTaskCall } from './engine/finish-task.ts';
import { Gauge, readOfficialFile, usableForPause, type Reading, type UsageWindows, type WindowId } from './engine/gauge.ts';
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
 * How many times one task may pause before Conductor gives up and starts it anyway.
 *
 * Not a safety valve for the common case, which resolves on round one. It is there because every
 * round after the first is being told by the account that a window we just waited out is still
 * full, and at that point the honest reading is that we do not understand the numbers rather than
 * that we should keep waiting. Starting a task that the account then refuses costs one wasted
 * start. Waiting forever costs the machine.
 */
const MAX_PAUSE_ROUNDS = 3;

/** What a door shows while a task is held back. */
export interface PauseNotice {
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

function pauseSentence(notice: Omit<PauseNotice, 'sentence'>): string {
  const windowName = notice.window === 'session_5h' ? '5-hour' : 'weekly';
  const why =
    notice.reason === 'paid_credit_boundary'
      ? `that is the plan limit, which this account does not stop at: extra-usage credits are enabled, so more work would spend real money`
      : `that is at or above the ${notice.threshold}% pause threshold`;
  const others = notice.tasksWaiting - 1;
  const queue = others > 0 ? ` ${notice.tasksWaiting} tasks are waiting, including this one.` : ' It is the only task waiting.';
  return (
    `Paused: task ${notice.taskId} has not started. Account "${notice.account}" is at ` +
    `${Math.round(notice.utilization)}% of its ${windowName} window and ${why}. Waiting until that window resets at ` +
    `${notice.resetsAt}, then starting.${queue}`
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

/** Every other usable account's file reading, taken at this moment. Names only, never identities. */
function otherAccountReadings(config: Config, paused: string): { account: string; fiveHour: number | null; weekly: number | null }[] {
  return usableAccounts(config)
    .filter((account) => account.name !== paused)
    .map((account) => {
      const file = readOfficialFile(account.configDir);
      return {
        account: account.name,
        fiveHour: file?.fiveHour.percent ?? null,
        weekly: file?.weekly.percent ?? null,
      };
    });
}

/**
 * Holds a task back while the account it runs on has no room, and measures the hold.
 *
 * Returns `interrupted: true` when the daemon stopped mid-wait, in which case the caller must not
 * start the task: nobody is left to watch it.
 */
export async function pauseForLimits(
  config: Config,
  gauge: Gauge,
  task: Task,
  tasksWaiting: number,
  onPause?: (pause: PauseNotice | null) => void,
): Promise<{ paused: boolean; interrupted: boolean }> {
  const threshold = readPauseThreshold(config);
  let paused = false;
  let lastResetsAtMs = 0;

  for (let round = 0; round < MAX_PAUSE_ROUNDS; round++) {
    if (round > 0) gauge.refreshFile();
    const creditsEnabled = gauge.extraUsageEnabled === true;

    // Every window that says there is no room, whether or not its reading is solid enough to act on.
    const tripped: { window: keyof UsageWindows; percent: number }[] = [];
    for (const window of ['fiveHour', 'weekly'] as (keyof UsageWindows)[]) {
      const percent = gauge.readingFor(window).percent;
      if (percent === null) continue;
      if (percent >= threshold || percent >= 100) tripped.push({ window, percent });
    }
    if (tripped.length === 0) return { paused, interrupted: false };

    // Of those, the ones whose reading can say when the wait would end. A pause with no fresh
    // reading is not a pause, so an unusable one is logged and stepped over rather than guessed at.
    const actionable = tripped
      .map((trip) => ({ trip, usable: usableForPause(trip.window, gauge.readingFor(trip.window)) }))
      .filter((entry): entry is { trip: typeof entry.trip; usable: NonNullable<typeof entry.usable> } => entry.usable !== null);

    if (actionable.length === 0) {
      logEvent(config, {
        kind: 'limit_reading_unusable',
        account: gauge.account,
        taskId: task.id,
        reason: unusableReason(tripped[0]!.window, tripped[0]!.percent, gauge.readingFor(tripped[0]!.window)),
      });
      return { paused, interrupted: false };
    }

    // When both windows are full, waiting out the earlier one leaves the later one still blocking,
    // so the binding window is the one that clears last. It is also the honest number to report: it
    // is when work can actually resume.
    const binding = actionable.reduce((worst, entry) => (entry.usable.resetsAtMs > worst.usable.resetsAtMs ? entry : worst));

    // A second round must be waiting for something new. If the account came back with a reset time
    // no later than the one we just sat through, its numbers are not moving the way a rolling window
    // moves, and waiting again would be waiting on a reading we have already disproved.
    if (round > 0 && binding.usable.resetsAtMs <= lastResetsAtMs) {
      logEvent(config, {
        kind: 'limit_reading_unusable',
        account: gauge.account,
        taskId: task.id,
        reason:
          `after waiting for ${new Date(lastResetsAtMs).toISOString()} the account still reports the same or an ` +
          `earlier reset (${binding.usable.resetsAt}) at ${Math.round(binding.usable.percent)}%, so the window is not ` +
          `rolling the way the reading claims. Starting the task rather than waiting on a number that did not move.`,
      });
      return { paused, interrupted: false };
    }
    lastResetsAtMs = binding.usable.resetsAtMs;

    const startedAt = Date.now();
    const waitUntilMs = binding.usable.resetsAtMs + RESET_GRACE_MS;
    const plannedMs = Math.max(0, waitUntilMs - startedAt);
    const reason: PauseNotice['reason'] =
      binding.usable.percent >= 100 && creditsEnabled ? 'paid_credit_boundary' : 'threshold';

    const bare = {
      taskId: task.id,
      account: gauge.account,
      window: binding.usable.window,
      utilization: binding.usable.percent,
      resetsAt: binding.usable.resetsAt,
      threshold,
      reason,
      tasksWaiting,
      waitUntil: new Date(waitUntilMs).toISOString(),
    };
    const notice: PauseNotice = { ...bare, sentence: pauseSentence(bare) };

    logEvent(config, {
      kind: 'limit_pause',
      account: notice.account,
      window: notice.window,
      utilization: Math.round(notice.utilization * 100) / 100,
      resetsAt: notice.resetsAt,
      threshold,
      reason,
      tasksWaiting,
      otherAccounts: otherAccountReadings(config, gauge.account),
    });
    paused = true;
    onPause?.(notice);
    process.stdout.write(`conductor: ${notice.sentence}\n`);

    const interrupted = await waitOutWindow(config, notice, startedAt, plannedMs);
    onPause?.(null);
    if (interrupted) return { paused, interrupted: true };
  }

  // Every round used and the window still says full. Say so and start: see MAX_PAUSE_ROUNDS.
  logEvent(config, {
    kind: 'limit_reading_unusable',
    account: gauge.account,
    taskId: task.id,
    reason: `paused ${MAX_PAUSE_ROUNDS} times and the window still reports no room, so the reading is not something to keep waiting on. Starting the task.`,
  });
  return { paused, interrupted: false };
}

/** The wait itself. Resolves true when the daemon stopped mid-pause. Logs `limit_resume` either way. */
function waitOutWindow(config: Config, notice: PauseNotice, startedAt: number, plannedMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (interrupted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activePauses.delete(entry);
      logEvent(config, {
        kind: 'limit_resume',
        account: notice.account,
        lostMs: Date.now() - startedAt,
        plannedMs,
        interrupted,
      });
      resolve(interrupted);
    };
    const timer = setTimeout(() => finish(false), plannedMs);
    const entry: ActivePause = { finish };
    activePauses.add(entry);
  });
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
      if (held.interrupted) {
        const stopped: TaskRun = {
          taskId: task.id,
          sessionId: undefined,
          outcome: 'blocked',
          handoffPath: null,
          followUps: [],
          usage: {},
          errorText: 'the daemon stopped while this task was waiting for a limit window to reset, so it never started',
        };
        runs.push(stopped);
        logTaskFinish(config, task.id, 'blocked', null, null, {});
        options.onTaskFinish?.(stopped);
        break; // the process is going down; the tasks behind this one are not ours to start either
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
