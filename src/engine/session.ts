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

/** What a door said, and which door said it. `door: null` means nobody was there to ask. */
export interface ApprovalOutcome {
  approved: boolean;
  door: string | null;
}

/** A door answers this. With no door attached the answer is no, which is the safe default. */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalOutcome>;

const NO_DOOR: ApprovalOutcome = { approved: false, door: null };

/** What a door can do to a session while it runs. Handed out at start, withdrawn at the end. */
export interface SessionHandle {
  taskId: string;
  /** Queue another user message into the running session's streaming input. */
  send(text: string): void;
  interrupt(): Promise<void>;
}

export interface RunSessionOptions {
  configDir: string;
  gauge: Gauge;
  openingPrompt: string;
  onMessage?: (message: SDKMessage) => void;
  approve?: Approver;
  maxTurns?: number;
  /** Called with the handle when the session starts and with null when it ends. */
  onHandle?: (handle: SessionHandle | null) => void;
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
  /(^|[\n;&|]\s*)(rm|rmdir|del|erase|rd|unlink|shred|format|mkfs|dd|shutdown|reboot|diskpart)\s|\b(Remove-Item|Remove-ItemProperty|Clear-Content|Clear-Disk|Format-Volume)\b|--force\b|-f\b\s+.*\brm\b|\bgit\s+(push|reset|clean|checkout\s+--|restore|branch\s+-D|filter-branch)\b|\bnpm\s+(publish|unpublish)\b|\|\s*(sh|bash|pwsh|powershell)\b/i;

// Commands asking for more authority than the session has. The SDK also refuses some of these on
// its own; the rail does not depend on that and stops them here regardless.
const ELEVATION_COMMAND = /\b(sudo|doas|runas|takeown|icacls|Start-Process\b[^\n]*-Verb\s+RunAs)\b|\breg(\.exe)?\s+(add|delete)\s+HKLM/i;

// Tool inputs that name a path. Anything outside the task's cwd needs a tap even when autonomous.
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'edit_file_path'];

// Long enough for the finish_task tool result to reach the model, short enough that the cut is
// the next thing that happens.
const CUT_DELAY_MS = 250;

// A rail stop waits on a human, so the hook gets a long leash. If it ever runs out the SDK falls
// back to the permission mode and layer two catches the call, which is why the leash is not
// infinite.
const RAIL_APPROVAL_TIMEOUT_SECONDS = 600;

export async function runSession(config: Config, task: Task, options: RunSessionOptions): Promise<SessionResult> {
  const { gauge, configDir } = options;

  // Boxed because the tool handler assigns it from a closure and the runner reads it afterwards.
  const state: { finish: FinishTaskCall | null } = { finish: null };
  let queryRef: Query | null = null;
  let cutTimer: NodeJS.Timeout | undefined;
  // What the rail already put to a human, in this process, in this session. Layer two consults it
  // so one destructive action costs one tap rather than two. Nothing else may write to it, so a
  // call layer one never saw is still a call layer two stops.
  const approvedAtRail = new Set<string>();

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

  // One opening prompt per task, then the input stays open: the Query control methods the gauge
  // needs only exist while it is, and a door can drop another user message into the queue while
  // the turn is in flight. The runner closes the input when the turn resolves.
  const queued: string[] = [];
  let wake: (() => void) | null = null;
  let inputClosed = false;
  const releaseInput = () => {
    inputClosed = true;
    wake?.();
    wake = null;
  };
  const userMessage = (content: string) => ({
    type: 'user' as const,
    message: { role: 'user' as const, content },
    parent_tool_use_id: null,
    session_id: '',
  });
  async function* prompts() {
    yield userMessage(options.openingPrompt);
    while (!inputClosed) {
      const next = queued.shift();
      if (next !== undefined) {
        yield userMessage(next);
        continue;
      }
      await new Promise<void>((r) => {
        wake = r;
      });
    }
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
    canUseTool: makePermissionGate(config, task, options.approve, approvedAtRail),
    mcpServers: { [FINISH_SERVER_NAME]: finishServer },
    allowedTools: [FINISH_TOOL_NAME], // asking permission to hand off would be silly
    maxTurns: options.maxTurns ?? 40,
    hooks: {
      // The hard rail. It lives here rather than in canUseTool because the SDK is explicit that
      // allow-rules in the user's own settings files shadow canUseTool without telling the host
      // program, while hooks run whatever those rules say. canUseTool stays below as layer two.
      PreToolUse: [
        {
          timeout: RAIL_APPROVAL_TIMEOUT_SECONDS,
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PreToolUse') return {};
              if (input.tool_name === FINISH_TOOL_NAME) return {}; // asking to hand off would be silly
              const toolInput = asRecord(input.tool_input);
              const verdict = classifyRail(task, toolInput);
              if (!verdict) return {}; // ordinary work: falls through to the permission mode and layer two

              const request: ApprovalRequest = { taskId: task.id, toolName: input.tool_name, input: toolInput, reason: verdict.reason };
              const { approved, door } = options.approve ? await options.approve(request).catch(() => NO_DOOR) : NO_DOOR;
              if (approved) approvedAtRail.add(callKey(input.tool_name, toolInput));
              logEvent(config, {
                kind: 'rail_stop',
                taskId: task.id,
                toolName: input.tool_name,
                layer: 'pre_tool_use',
                kindOfRisk: verdict.risk,
                reason: verdict.reason,
                trust: task.trust,
                decision: approved ? 'approved' : 'denied',
                door,
              });

              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: approved ? ('allow' as const) : ('deny' as const),
                  permissionDecisionReason: approved ? `A human approved this: ${verdict.reason}.` : denialMessage(verdict.reason),
                },
              };
            },
          ],
        },
      ],
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
  options.onHandle?.({
    taskId: task.id,
    send: (text: string) => {
      if (inputClosed) return;
      queued.push(text);
      wake?.();
      wake = null;
    },
    interrupt: async () => {
      await run.interrupt();
    },
  });

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
    options.onHandle?.(null);
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
 * Layer two. Trust maps to the permission mode; this gate sits underneath it and is the part trust
 * cannot widen. It repeats the rail on purpose: the hook above is the one settings files cannot
 * shadow, and this one still catches anything that reaches it. bypassPermissions is never used.
 */
function makePermissionGate(config: Config, task: Task, approve: Approver | undefined, approvedAtRail: Set<string>) {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const verdict = classifyRail(task, input);
    if (verdict === null && task.trust === 'autonomous') return { behavior: 'allow', updatedInput: input };
    // Measured: the SDK still consults canUseTool after a PreToolUse allow, so without this one
    // destructive action costs the human two identical taps.
    // The ticket is spent when it is used, so it covers exactly the call the human looked at.
    if (verdict && approvedAtRail.delete(callKey(toolName, input))) return { behavior: 'allow', updatedInput: input };

    const ask = verdict?.reason ?? 'this task is attended, so tool use is confirmed by a human';
    const { approved, door } = approve ? await approve({ taskId: task.id, toolName, input, reason: ask }).catch(() => NO_DOOR) : NO_DOOR;
    if (verdict) {
      logEvent(config, {
        kind: 'rail_stop',
        taskId: task.id,
        toolName,
        layer: 'can_use_tool',
        kindOfRisk: verdict.risk,
        reason: verdict.reason,
        trust: task.trust,
        decision: approved ? 'approved' : 'denied',
        door,
      });
    }
    return approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: denialMessage(ask) };
  };
}

export type RailRisk = 'destructive' | 'elevated' | 'outside_cwd';

export interface RailVerdict {
  risk: RailRisk;
  reason: string;
}

/** Returns why an action needs a human, or null when it is ordinary work inside the task folder. */
export function classifyRail(task: Task, input: Record<string, unknown>): RailVerdict | null {
  const outside = PATH_FIELDS.map((field) => input[field]).find(
    (value) => typeof value === 'string' && !insideCwd(task.cwd, value),
  );
  if (typeof outside === 'string') {
    return { risk: 'outside_cwd', reason: `it touches "${outside}", which is outside the task folder` };
  }

  // A notebook edit that removes a cell is a deletion in everything but name.
  if (input['edit_mode'] === 'delete') {
    return { risk: 'destructive', reason: 'it deletes content, and deletions always need a tap' };
  }

  const command = commandText(input);
  if (command === null) return null;
  if (ELEVATION_COMMAND.test(command)) {
    return { risk: 'elevated', reason: 'the command asks for elevated permission, which a session never gets on its own' };
  }
  if (DESTRUCTIVE_COMMAND.test(command)) {
    return { risk: 'destructive', reason: 'the command can destroy or publish work, and destructive actions always need a tap' };
  }
  return null;
}

/** Tool inputs spell a command as a string or as an argv array. Both get read. */
function commandText(input: Record<string, unknown>): string | null {
  const raw = input['command'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((part) => typeof part === 'string').join(' ');
  return null;
}

/** Identity of one tool call, so an approval covers that call and not the next one like it. */
function callKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(input)}`;
}

function denialMessage(reason: string): string {
  return `Conductor did not get approval: ${reason}. Try a different approach or finish the task and say what is blocked.`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
