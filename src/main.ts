// Daemon entry point and the M1 task loop.
//
// runTasks is the whole of the core loop in one function: for each task in order, start a fresh
// session on the chosen account, let Claude work, take the cut when it calls finish_task, and hand
// the note it wrote to the next task. The list is a plain array on purpose. The real queue, with
// pacing and playbook rules deciding what runs when, is M2.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, usableAccounts, type Config } from './config.ts';
import { buildOpeningPrompt, logCut, type Carry } from './engine/cut.ts';
import { logTaskFinish, type FinishTaskCall } from './engine/finish-task.ts';
import { Gauge } from './engine/gauge.ts';
import { runSession, type Approver, type SessionHandle, type Task } from './engine/session.ts';
import { startDaemon } from './server/http.ts';
import { logEvent, type TokenUsage } from './state/logbook.ts';
import { readPlaybook } from './state/playbook.ts';
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
}

export async function runTasks(tasks: Task[], options: RunTasksOptions = {}): Promise<TaskRun[]> {
  const config = options.config ?? loadConfig();
  const gauges = options.gauges ?? new Map<string, Gauge>(); // one per account, so self-metering accumulates
  const runs: TaskRun[] = [];
  let carry: Carry | null = null;

  for (const task of tasks) {
    const account = config.accounts.find((a) => a.name === task.account);
    if (!account || account.placeholder || !existsSync(account.configDir)) {
      const problem = `account "${task.account}" is not configured in "${config.configFilePath}"`;
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
    // No finish_task means the loop did not close properly: record it plainly rather than
    // inventing a handoff, and let the next task start with nothing carried over.
    const outcome = finish?.outcome ?? (result.errorText ? 'error' : 'no_finish_task');
    logTaskFinish(config, task.id, outcome, finish?.handoffPath ?? null, gauge.contextPeakPercent, result.usage);
    logCut(config, task.id, result.sessionId, finish ? `finish_task: ${finish.outcome}` : `session ended without finish_task (${outcome})`);

    carry = finish ? { handoff: finish.handoff, handoffPath: finish.handoffPath, outcome: finish.outcome } : null;
    const run: TaskRun = {
      taskId: task.id,
      sessionId: result.sessionId,
      outcome,
      handoffPath: finish?.handoffPath ?? null,
      followUps: finish?.followUps ?? [],
      usage: result.usage,
      errorText: result.errorText,
    };
    runs.push(run);
    options.onTaskFinish?.(run);
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

  const daemon = await startDaemon(config);

  process.stdout.write(
    [
      `conductor ${VERSION}`,
      `  listening:  http://127.0.0.1:${daemon.port} (loopback only)`,
      `  state root: "${config.stateRoot}"`,
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

  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    logEvent(config, { kind: 'daemon_stop', pid: process.pid, reason });
    void daemon.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

// Only when run as the program. Importing this module (the CLI door, tests, a harness) must not
// boot a daemon as a side effect.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runDaemon();
