// One Agent SDK session for one task.
//
// Two things here are load-bearing and both come out of M0. First, the account: S1 proved
// CLAUDE_CONFIG_DIR in the child environment is the whole account mechanism, and that the plan
// OAuth credential inside that directory is the only thing authenticating. So the runner sets that
// one variable and strips ANTHROPIC_API_KEY, which is golden rule 1 made executable rather than
// merely intended. Second, streaming input mode: the Query control methods the gauge needs
// (getContextUsage, the experimental usage probe) exist only in streaming input mode.

import { query, type Options, type PermissionResult, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { logEvent, type TokenUsage } from '../state/logbook.ts';
import { createFinishTaskServer, FINISH_SERVER_NAME, FINISH_TOOL_NAME, type FinishTaskCall } from './finish-task.ts';
import type { Gauge } from './gauge.ts';

/** Per-task trust, set when the task is queued. Ratified decision D9. */
export type Trust = 'attended' | 'autonomous';

export interface Task {
  id: string;
  /** Short human title. Becomes the handoff filename and the note's heading. */
  title: string;
  prompt: string;
  cwd: string;
  /** A name in the config.json account registry, not a directory and never an email. */
  account: string;
  trust: Trust;
  model?: string;
}

export interface ApprovalRequest {
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
}

/** A door answers this. With no door attached the answer is no, which is the safe default. */
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

export interface RunSessionOptions {
  configDir: string;
  gauge: Gauge;
  openingPrompt: string;
  onMessage?: (message: SDKMessage) => void;
  approve?: Approver;
  maxTurns?: number;
}

export interface SessionResult {
  sessionId: string | undefined;
  finish: FinishTaskCall | null;
  usage: TokenUsage;
  resultText: string | null;
  errorText: string | null;
}

// Commands that can destroy work or publish it. These always stop for a human tap whatever the
// trust level says, per the spec's security section and the playbook's hard rails. Deliberately
// blunt: a false stop costs a tap, a false pass costs the user's files.
const DESTRUCTIVE_COMMAND =
  /(^|[\n;&|]\s*)(rm|rmdir|del|erase|rd|format|mkfs|dd|shutdown|reboot|diskpart)\s|--force\b|-f\b\s+.*\brm\b|\bgit\s+(push|reset|clean|checkout\s+--|restore)\b|\bnpm\s+(publish|unpublish)\b|\|\s*(sh|bash|pwsh|powershell)\b/i;

// Tool inputs that name a path. Anything outside the task's cwd needs a tap even when autonomous.
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'edit_file_path'];

// Long enough for the finish_task tool result to reach the model, short enough that the cut is
// the next thing that happens.
const CUT_DELAY_MS = 250;

export async function runSession(config: Config, task: Task, options: RunSessionOptions): Promise<SessionResult> {
  const { gauge, configDir } = options;

  // Boxed because the tool handler assigns it from a closure and the runner reads it afterwards.
  const state: { finish: FinishTaskCall | null } = { finish: null };
  let queryRef: Query | null = null;
  let cutTimer: NodeJS.Timeout | undefined;

  const finishServer = createFinishTaskServer(config, task.title, (call) => {
    if (state.finish) return; // the first call is the cut; a second one changes nothing
    state.finish = call;
    // Calling finish_task IS the cut, so the session has to end here rather than whenever the
    // model runs out of things to say. Measured: without this, a task that had handed off carried
    // straight on into the follow-up it had just queued for the next session. The short delay lets
    // the tool result reach the model first, so the transcript ends cleanly.
    cutTimer = setTimeout(() => {
      void queryRef?.interrupt().catch(() => {});
    }, CUT_DELAY_MS);
  });

  // One prompt per task in M1. The generator stays open after yielding it so the Query control
  // methods remain usable at the boundary; the runner closes the query when the turn resolves.
  let releaseInput: () => void = () => {};
  const inputClosed = new Promise<void>((r) => {
    releaseInput = r;
  });
  async function* prompts() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: options.openingPrompt },
      parent_tool_use_id: null,
      session_id: '',
    };
    await inputClosed;
  }

  let pendingAutoCompact: string | null = null;
  let loggedCompact = false;

  const sdkOptions: Options = {
    cwd: task.cwd,
    ...(task.model ? { model: task.model } : {}),
    // The whole account mechanism (S1). env replaces the child environment when set, so process.env
    // is spread first for PATH and friends, then the key that must never be present is removed.
    env: childEnv(configDir),
    permissionMode: task.trust === 'autonomous' ? 'acceptEdits' : 'default',
    canUseTool: makePermissionGate(task, options.approve),
    mcpServers: { [FINISH_SERVER_NAME]: finishServer },
    allowedTools: [FINISH_TOOL_NAME], // asking permission to hand off would be silly
    maxTurns: options.maxTurns ?? 40,
    hooks: {
      // The documented per-turn injection point: whatever this returns as additionalContext is
      // added to the turn the model is about to answer.
      UserPromptSubmit: [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: gauge.line() },
            }),
          ],
        },
      ],
      // Auto-compact is the emergency floor. Every firing means the one-task-one-cut loop failed.
      PreCompact: [
        {
          hooks: [
            async (input) => {
              if ('trigger' in input && typeof input.trigger === 'string') pendingAutoCompact = input.trigger;
              return {};
            },
          ],
        },
      ],
    },
  };

  const run = query({ prompt: prompts(), options: sdkOptions });
  queryRef = run;

  const usage: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let sessionId: string | undefined;
  let resultText: string | null = null;
  let errorText: string | null = null;

  try {
    for await (const message of run) {
      options.onMessage?.(message);

      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
      } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
        const meta = message.compact_metadata;
        logEvent(config, {
          kind: 'backstop_compact',
          taskId: task.id,
          ...(sessionId ? { sessionId } : {}),
          trigger: meta.trigger,
          preTokens: meta.pre_tokens,
          postTokens: meta.post_tokens,
        });
        loggedCompact = true;
      } else if (message.type === 'rate_limit_event') {
        gauge.noteRateLimitEvent(message.rate_limit_info);
      } else if (message.type === 'result') {
        sessionId = message.session_id;
        addUsage(usage, message.usage);
        gauge.noteResult(message.modelUsage);
        resultText = message.subtype === 'success' ? message.result : null;
        // An error result after a finish_task call is Conductor's own interrupt landing, not a
        // failure of the task, so it is not reported as one.
        if (message.is_error && !state.finish) {
          errorText = message.subtype === 'success' ? 'result flagged is_error' : message.subtype;
        }
        // The boundary readings happen here, inside the loop, and not after it: breaking a
        // for-await calls return() on the generator, which tears the query down and takes the
        // control methods with it. Measured, not assumed; the first run of this got null readings.
        await gauge.refreshAtBoundary(run);
        break; // one prompt, one turn, one task: the result message is the end of the task
      }
    }
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
  } finally {
    if (pendingAutoCompact && !loggedCompact) {
      logEvent(config, { kind: 'backstop_compact', taskId: task.id, ...(sessionId ? { sessionId } : {}), trigger: pendingAutoCompact });
    }
    if (cutTimer) clearTimeout(cutTimer);
    releaseInput();
    try {
      run.close();
    } catch {
      // A query that already ended has nothing to close; never let cleanup mask the real result.
    }
  }

  return { sessionId, finish: state.finish, usage, resultText, errorText };
}

/** process.env plus this task's account, minus the key that would move billing off the plan. */
function childEnv(configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  return env;
}

/**
 * Trust maps to the permission mode; this gate sits underneath it and is the part trust cannot
 * widen. Destructive commands and anything reaching outside the task's own folder stop for a tap
 * whether the task is attended or autonomous. bypassPermissions is never used anywhere.
 */
function makePermissionGate(task: Task, approve: Approver | undefined) {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const reason = classify(task, toolName, input);
    if (reason === null && task.trust === 'autonomous') return { behavior: 'allow', updatedInput: input };

    const ask = reason ?? 'this task is attended, so tool use is confirmed by a human';
    const approved = approve ? await approve({ taskId: task.id, toolName, input, reason: ask }) : false;
    return approved
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `Conductor did not get approval: ${ask}. Try a different approach or finish the task and say what is blocked.` };
  };
}

/** Returns why an action needs a human, or null when it is ordinary work inside the task folder. */
function classify(task: Task, toolName: string, input: Record<string, unknown>): string | null {
  const outside = PATH_FIELDS.map((field) => input[field]).find(
    (value) => typeof value === 'string' && !insideCwd(task.cwd, value),
  );
  if (typeof outside === 'string') return `it touches "${outside}", which is outside the task folder`;

  const command = input['command'];
  if (typeof command === 'string' && DESTRUCTIVE_COMMAND.test(command)) {
    return 'the command can destroy or publish work, and destructive actions always need a tap';
  }
  return null;
}

function insideCwd(cwd: string, candidate: string): boolean {
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  const rel = relative(resolve(cwd), target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function addUsage(totals: TokenUsage, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const u = raw as Record<string, unknown>;
  totals.input = (totals.input ?? 0) + numberOf(u['input_tokens']);
  totals.output = (totals.output ?? 0) + numberOf(u['output_tokens']);
  totals.cacheCreation = (totals.cacheCreation ?? 0) + numberOf(u['cache_creation_input_tokens']);
  totals.cacheRead = (totals.cacheRead ?? 0) + numberOf(u['cache_read_input_tokens']);
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
