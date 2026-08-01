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
import { runSession, type Approver, type Task } from './engine/session.ts';
import { logEvent, type TokenUsage } from './state/logbook.ts';
import { readPlaybook } from './state/playbook.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const VERSION = '0.1.0';

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
  /** Every SDK message, tagged with its task, so later slices can fan out to doors. */
  onMessage?: (taskId: string, message: SDKMessage) => void;
  approve?: Approver;
}

export async function runTasks(tasks: Task[], options: RunTasksOptions = {}): Promise<TaskRun[]> {
  const config = options.config ?? loadConfig();
  const gauges = new Map<string, Gauge>(); // one per account, so self-metering accumulates
  const runs: TaskRun[] = [];
  let carry: Carry | null = null;

  for (const task of tasks) {
    const account = config.accounts.find((a) => a.name === task.account);
    if (!account || account.placeholder || !existsSync(account.configDir)) {
      const problem = `account "${task.account}" is not configured in "${config.configFilePath}"`;
      runs.push({ taskId: task.id, sessionId: undefined, outcome: 'blocked', handoffPath: null, followUps: [], usage: {}, errorText: problem });
      logTaskFinish(config, task.id, 'blocked', null, null, {});
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

    const result = await runSession(config, task, {
      configDir: account.configDir,
      gauge,
      openingPrompt: buildOpeningPrompt(task.prompt, carry),
      ...(options.onMessage ? { onMessage: (message: SDKMessage) => options.onMessage?.(task.id, message) } : {}),
      ...(options.approve ? { approve: options.approve } : {}),
    });

    const finish: FinishTaskCall | null = result.finish;
    // No finish_task means the loop did not close properly: record it plainly rather than
    // inventing a handoff, and let the next task start with nothing carried over.
    const outcome = finish?.outcome ?? (result.errorText ? 'error' : 'no_finish_task');
    logTaskFinish(config, task.id, outcome, finish?.handoffPath ?? null, gauge.contextPeakPercent, result.usage);
    logCut(config, task.id, result.sessionId, finish ? `finish_task: ${finish.outcome}` : `session ended without finish_task (${outcome})`);

    carry = finish ? { handoff: finish.handoff, handoffPath: finish.handoffPath, outcome: finish.outcome } : null;
    runs.push({
      taskId: task.id,
      sessionId: result.sessionId,
      outcome,
      handoffPath: finish?.handoffPath ?? null,
      followUps: finish?.followUps ?? [],
      usage: result.usage,
      errorText: result.errorText,
    });
  }

  return runs;
}

function main(): void {
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

  process.stdout.write(
    [
      `conductor ${VERSION}`,
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
  // daemon_stop belongs to the real shutdown path, which arrives with the server door.
}

// Only when run as the program. Importing this module (the CLI door, tests, a harness) must not
// boot a daemon as a side effect.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
