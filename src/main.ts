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
import { Gauge } from './engine/gauge.ts';
import { runSession, trustRefusal, type Approver, type SessionHandle, type Task } from './engine/session.ts';
import { startDaemon } from './server/http.ts';
import { logEvent, type TokenUsage } from './state/logbook.ts';
import { readPlaybook } from './state/playbook.ts';
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
  onTaskStart?: (task: Task) => void;
  onTaskFinish?: (run: TaskRun) => void;
  /** The running session's handle, or null when no session is running. */
  onHandle?: (handle: SessionHandle | null) => void;
  /** What the previous run handed over, so a second `conductor run` is not a memory wipe. */
  carry?: Carry | null;
  /** The note this run ends holding, for the caller to feed back in next time. */
  onCarry?: (carry: Carry | null) => void;
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
    for (const task of claimed) {
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

      logEvent(config, {
        kind: 'task_start',
        taskId: task.id,
        account: account.name,
        cwd: task.cwd,
        ...(task.model ? { model: task.model } : {}),
      });
      options.onTaskStart?.(task);

      const result = await runSession(config, task, {
        configDir: account.configDir,
        gauge,
        openingPrompt: buildOpeningPrompt(task.prompt, carry),
        ...(options.onMessage ? { onMessage: (message: SDKMessage) => options.onMessage?.(task.id, message) } : {}),
        ...(options.approve ? { approve: options.approve } : {}),
        ...(options.onHandle ? { onHandle: options.onHandle } : {}),
      });

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
        errorText: result.errorText ?? (finish ? null : 'the session ended without calling finish_task'),
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
