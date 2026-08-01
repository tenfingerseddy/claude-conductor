// One Agent SDK session for one task.
//
// Two things here are load-bearing and both come out of M0. First, the account: S1 proved
// CLAUDE_CONFIG_DIR in the child environment is the whole account mechanism, and that the plan
// OAuth credential inside that directory is the only thing authenticating. So the runner sets that
// one variable and strips ANTHROPIC_API_KEY, which is golden rule 1 made executable rather than
// merely intended. Second, streaming input mode: the Query control methods the gauge needs
// (getContextUsage, the experimental usage probe) exist only in streaming input mode.

import { query, type Options, type PermissionResult, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { logEvent, type RailRiskKind, type TokenUsage } from '../state/logbook.ts';
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
  /** Engine-side id for this question. Joins the request and answer lines in the logbook. */
  approvalId: string;
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
}

/** What a door said, and which door said it. `door: null` means nobody was there to ask. */
export interface ApprovalOutcome {
  approved: boolean;
  door: string | null;
  /** How the answer arrived. Doors set this; the engine falls back to reading `door`. */
  via?: 'door' | 'no_door' | 'timeout';
}

/** A door answers this. With no door attached the answer is no, which is the safe default. */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalOutcome>;

const NO_DOOR: ApprovalOutcome = { approved: false, door: null, via: 'no_door' };

/** What a door can do to a session while it runs. Handed out at start, withdrawn at the end. */
export interface SessionHandle {
  taskId: string;
  /**
   * Queue another user message into the running session's streaming input. Returns false when the
   * session will not carry it: input already closed, or finish_task has fired and the cut is in
   * flight. A door that cannot see the difference cannot tell the human anything honest.
   */
  send(text: string): boolean;
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
// trust level says, per the spec's security section and the playbook's hard rails.
//
// This list is no longer the rail. Since the deny-by-default flip (decisions log, 2026-08-01) it
// only decides how a stop is *described*: a command matching this reads as destructive rather than
// merely unvouched, which is a better sentence to put in front of a human. Sol's pass 1 was right
// that a list of bad strings can never be complete, so nothing is allowed through by failing to
// match it.
const DESTRUCTIVE_COMMAND =
  /(^|[\n;&|]\s*)(rm|rmdir|del|erase|rd|unlink|shred|format|mkfs|dd|shutdown|reboot|diskpart)\s|\b(Remove-Item|Remove-ItemProperty|Clear-Content|Clear-Disk|Format-Volume)\b|--force\b|-f\b\s+.*\brm\b|\bgit\s+(push|reset|clean|checkout\s+--|restore|branch\s+-D|filter-branch)\b|\bnpm\s+(publish|unpublish)\b|\|\s*(sh|bash|pwsh|powershell)\b/i;

// Commands asking for more authority than the session has. The SDK also refuses some of these on
// its own; the rail does not depend on that and stops them here regardless.
const ELEVATION_COMMAND = /\b(sudo|doas|runas|takeown|icacls|Start-Process\b[^\n]*-Verb\s+RunAs)\b|\breg(\.exe)?\s+(add|delete)\s+HKLM/i;

// Tool inputs that name a path. Anything outside the task's cwd needs a tap even when autonomous.
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'edit_file_path'];

// Environment variable names that look like a secret. The daemon's own environment is inherited by
// every session, and Sol's pass 1 showed one unflagged command is enough to write GITHUB_TOKEN into
// a repo. Golden rule 1 only ever named the billing keys; third-party credentials are the same
// problem wearing a different name.
//
// Deliberately a deny-pattern rather than an allowlist: an allowlist of environment variables
// breaks the tools a task legitimately needs (proxies, per-language paths, Windows' own dozens) and
// would be discovered as breakage rather than as safety. The named shapes Sol raised are all
// covered. A real allowlist belongs with M2's sandboxing work.
const SECRET_ENV_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|APIKEY|PAT|SESSION)($|_)|(APIKEY|ACCESSKEY|PRIVATEKEY)/i;

// Names that must survive the scrub even though they trip the pattern above.
const ENV_KEEP = new Set(['SESSIONNAME', 'CLAUDE_CONFIG_DIR', 'PATH', 'PATHEXT']);

// Long enough for the finish_task tool result to reach the model, short enough that the cut is
// the next thing that happens.
const CUT_DELAY_MS = 250;

// If the interrupt does not land, the session must still end. Sol's pass 2 finding 6: a rejected
// interrupt left the for-await pending forever with the input still open, so the task loop hung
// with no finish and no cut logged. This is the backstop that makes that a delay, not a hang.
const CUT_BACKSTOP_MS = 30_000;

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
  let cutBackstop: NodeJS.Timeout | undefined;
  let finishing = false;
  // What the rail already put to a human, in this process, in this session. Layer two consults it
  // so one destructive action costs one tap rather than two. Nothing else may write to it, so a
  // call layer one never saw is still a call layer two stops.
  const approvedAtRail = new Set<string>();
  // One counter per session, so every question this session asks has a name the logbook can join on.
  let approvalSeq = 0;
  const nextApprovalId = () => `${task.id}-a${++approvalSeq}`;

  const finishServer = createFinishTaskServer(config, task.title, (call) => {
    if (state.finish) return; // the tool already refuses a second call; this is the belt to that brace
    state.finish = call;
    finishing = true;
    // Calling finish_task IS the cut, so the session has to end here rather than whenever the
    // model runs out of things to say. Measured: without this, a task that had handed off carried
    // straight on into the follow-up it had just queued for the next session. The short delay lets
    // the tool result reach the model first, so the transcript ends cleanly.
    cutTimer = setTimeout(() => {
      const attempt = queryRef?.interrupt() ?? Promise.resolve();
      void attempt.catch(() => {}).finally(() => {
        // Whether the interrupt landed or threw, the session gets a bounded time to end on its own
        // before the query is closed underneath it.
        cutBackstop = setTimeout(() => {
          releaseInput();
          try {
            queryRef?.close();
          } catch {
            // Already gone. The for-await ends either way, which is the only thing that matters.
          }
        }, CUT_BACKSTOP_MS);
      });
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

  const gate = makePermissionGate(config, task, options.approve, approvedAtRail, nextApprovalId);

  const sdkOptions: Options = {
    cwd: task.cwd,
    ...(task.model ? { model: task.model } : {}),
    // The whole account mechanism (S1). env replaces the child environment when set, so process.env
    // is spread first for PATH and friends, then the key that must never be present is removed.
    env: childEnv(configDir),
    permissionMode: task.trust === 'autonomous' ? 'acceptEdits' : 'default',
    canUseTool: gate,
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
              const verdict = classifyRail(task, input.tool_name, toolInput);
              if (!verdict) return {}; // ordinary work: falls through to the permission mode and layer two

              const { approved, door } = await settleRail(config, task, 'pre_tool_use', nextApprovalId(), input.tool_name, toolInput, verdict, options.approve);
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
  // A door callback that throws must not cost the session its cleanup. Sol's pass 2 finding 4: the
  // handle is handed out before the try block, so a throw here used to leave the query unclosed.
  offerHandle(options.onHandle, {
    taskId: task.id,
    send: (text: string) => {
      if (inputClosed || finishing) return false;
      queued.push(text);
      wake?.();
      wake = null;
      return true;
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
    if (cutBackstop) clearTimeout(cutBackstop);
    releaseInput();
    // Withdrawing the handle comes before closing the query, and neither may skip the other.
    offerHandle(options.onHandle, null);
    try {
      run.close();
    } catch {
      // A query that already ended has nothing to close; never let cleanup mask the real result.
    }
  }

  return { sessionId, finish: state.finish, usage, resultText, errorText };
}

/** Hands the handle out, or withdraws it, without letting a door's callback break the session. */
function offerHandle(onHandle: ((handle: SessionHandle | null) => void) | undefined, handle: SessionHandle | null): void {
  try {
    onHandle?.(handle);
  } catch (err) {
    process.stderr.write(`conductor: a door threw while taking the session handle: ${String(err)}\n`);
  }
}

/**
 * What happens to a rail verdict, which is not the same question for every kind of risk.
 *
 * D9 is ratified and stands: a destructive, elevated or outside-the-folder action always stops for
 * a tap, whatever the trust level says, so if a door is attached it gets asked even under
 * autonomous trust. The deny-by-default flip added a fourth kind, `unvouched`, and that one is
 * different. It is not a specific danger anyone can look at and judge; it is the honest admission
 * that Conductor cannot read the command. Waking a human for every one of those trains them to say
 * yes, and under autonomous trust the whole premise is that nobody is watching. So an unvouched
 * command under autonomous trust is refused outright, and the question is never asked.
 */
async function settleRail(
  config: Config,
  task: Task,
  layer: 'pre_tool_use' | 'can_use_tool',
  approvalId: string,
  toolName: string,
  input: Record<string, unknown>,
  verdict: RailVerdict,
  approve: Approver | undefined,
): Promise<ApprovalOutcome> {
  if (verdict.risk === 'unvouched' && task.trust === 'autonomous') {
    logEvent(config, {
      kind: 'approval_request',
      taskId: task.id,
      approvalId,
      toolName,
      layer,
      reason: verdict.reason,
      trust: task.trust,
      kindOfRisk: verdict.risk,
    });
    logEvent(config, {
      kind: 'approval_answer',
      taskId: task.id,
      approvalId,
      toolName,
      layer,
      decision: 'denied',
      door: null,
      via: 'no_door',
      waitedMs: 0,
    });
    return NO_DOOR;
  }
  return askApproval(config, task, layer, approvalId, toolName, input, verdict.reason, approve, verdict.risk);
}

/**
 * Every question Conductor puts to a human goes through here, so every one of them lands in the
 * logbook with who asked, what about, who answered and how long it took.
 *
 * Wrinkle 1 from the M1 finish line run: an attended tap on an ordinary write left no trace at all,
 * because only rail verdicts logged. "A human approved a write to Kane's repo" is exactly what the
 * review loop needs to see later, so the request and the answer are now two lines each time.
 */
async function askApproval(
  config: Config,
  task: Task,
  layer: 'pre_tool_use' | 'can_use_tool',
  approvalId: string,
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  approve: Approver | undefined,
  kindOfRisk?: RailRiskKind,
): Promise<ApprovalOutcome> {
  logEvent(config, {
    kind: 'approval_request',
    taskId: task.id,
    approvalId,
    toolName,
    layer,
    reason,
    trust: task.trust,
    ...(kindOfRisk ? { kindOfRisk } : {}),
  });

  const startedAt = Date.now();
  let outcome: ApprovalOutcome = NO_DOOR;
  let via: 'door' | 'no_door' | 'timeout' | 'error' = 'no_door';

  if (approve) {
    try {
      outcome = await approve({ taskId: task.id, approvalId, toolName, input, reason });
      via = outcome.via ?? (outcome.door === null ? 'no_door' : 'door');
    } catch {
      outcome = NO_DOOR;
      via = 'error';
    }
  }

  logEvent(config, {
    kind: 'approval_answer',
    taskId: task.id,
    approvalId,
    toolName,
    layer,
    decision: outcome.approved ? 'approved' : 'denied',
    door: outcome.door,
    via,
    waitedMs: Date.now() - startedAt,
  });

  return outcome;
}

/** process.env plus this task's account, minus the key that would move billing off the plan. */
export function childEnv(configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (ENV_KEEP.has(name.toUpperCase())) {
      env[name] = value;
      continue;
    }
    if (SECRET_ENV_NAME.test(name)) continue;
    env[name] = value;
  }
  env['CLAUDE_CONFIG_DIR'] = configDir;
  // Named explicitly as well as caught by the pattern, because golden rule 1 is about these two and
  // a reader should be able to see it here rather than infer it from a regex.
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  return env;
}

/**
 * Layer two. Trust maps to the permission mode; this gate sits underneath it and is the part trust
 * cannot widen. It repeats the rail on purpose: the hook above is the one settings files cannot
 * shadow, and this one still catches anything that reaches it. bypassPermissions is never used.
 */
function makePermissionGate(
  config: Config,
  task: Task,
  approve: Approver | undefined,
  approvedAtRail: Set<string>,
  nextApprovalId: () => string,
) {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const verdict = classifyRail(task, toolName, input);
    if (verdict === null && task.trust === 'autonomous') return { behavior: 'allow', updatedInput: input };
    // Measured: the SDK still consults canUseTool after a PreToolUse allow, so without this one
    // destructive action costs the human two identical taps.
    // The ticket is spent when it is used, so it covers exactly the call the human looked at.
    if (verdict && approvedAtRail.delete(callKey(toolName, input))) return { behavior: 'allow', updatedInput: input };

    const ask = verdict?.reason ?? 'this task is attended, so tool use is confirmed by a human';
    const { approved, door } = verdict
      ? await settleRail(config, task, 'can_use_tool', nextApprovalId(), toolName, input, verdict, approve)
      : await askApproval(config, task, 'can_use_tool', nextApprovalId(), toolName, input, ask, approve);
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

export type RailRisk = RailRiskKind;

export interface RailVerdict {
  risk: RailRisk;
  reason: string;
}

// Tools that hand a string to an interpreter. Everything one of these runs is risky unless the
// classifier can positively vouch for it. Matching is on the name because the SDK's Bash tool is
// the one that exists today and a renamed or added shell tool must not silently fall out of scope.
const SHELL_TOOL = /(^|_)(bash|sh|shell|zsh|cmd|powershell|pwsh|exec|execute|terminal|run_command|command)($|_)/i;

/**
 * Returns why an action needs a human, or null when it is ordinary work inside the task folder.
 *
 * Deny-by-default since the decisions log entry of 2026-08-01. For anything that reaches a shell
 * the question is no longer "does this look bad" but "can we say plainly that this is safe". Sol's
 * pass 1 finding 3 is why: `cmd.exe /c "del ..."`, `node -e "...rmSync..."` and `git -C other reset
 * --hard` all walked through the blocklist untouched. A list of bad strings can never be complete.
 * A list of vouched-safe shapes can at least be honest about what it does not cover.
 */
export function classifyRail(task: Task, toolName: string, input: Record<string, unknown>): RailVerdict | null {
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
  const shellShaped = SHELL_TOOL.test(toolName) || command !== null;
  if (!shellShaped) return null;

  if (command === null) {
    return { risk: 'unvouched', reason: `the ${toolName} tool runs commands and this call does not carry one Conductor can read` };
  }
  if (ELEVATION_COMMAND.test(command)) {
    return { risk: 'elevated', reason: 'the command asks for elevated permission, which a session never gets on its own' };
  }
  if (DESTRUCTIVE_COMMAND.test(command)) {
    return { risk: 'destructive', reason: 'the command can destroy or publish work, and destructive actions always need a tap' };
  }

  const doubt = vouchSafe(task.cwd, command);
  if (doubt === null) return null;
  return { risk: 'unvouched', reason: `Conductor cannot vouch that this command only reads: ${doubt}` };
}

// Shapes that hide what a command does from any reader, this one included. Splitting handles the
// separators; anything left in a segment that can spawn, substitute or redirect is not vouchable.
const OPAQUE_SHELL = /[`><]|\$\(|\$\{|\bexec\b/;

// Commands whose plain form only reads. Every entry is a promise: no writes, no network, no
// spawning something else. Kept short on purpose, because each addition is a hole if it is wrong.
const VOUCHED_READERS = new Set([
  'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'type', 'head', 'tail', 'wc', 'sort', 'uniq',
  'grep', 'findstr', 'rg', 'stat', 'file', 'tree', 'du', 'df', 'which', 'where', 'whoami',
  'hostname', 'date', 'uname', 'basename', 'dirname', 'true', 'false',
]);

// Vouched readers whose bare arguments are paths, so an argument leaving the task folder is a read
// outside the rail. Sol noted PATH_FIELDS never sees a path buried in a shell command; this does.
const PATH_ARG_READERS = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'stat', 'file', 'tree', 'du', 'cd']);

// git subcommands that only report. Anything not named here is unvouched, including config.
const VOUCHED_GIT = new Set(['status', 'log', 'diff', 'show', 'remote', 'rev-parse', 'ls-files', 'describe', 'blame', 'shortlog', 'stash']);

// node flags that turn "run this file" into "run whatever string I hand you".
const NODE_EVAL_FLAG = /^--?(e|p|eval|print|require|r|import|experimental-loader)(=|$)/i;

/**
 * The vouching half of deny-by-default. Returns null when the whole command is positively safe, or
 * a sentence saying which part could not be vouched for.
 */
export function vouchSafe(cwd: string, command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return 'it is empty';
  if (OPAQUE_SHELL.test(trimmed)) return 'it redirects, substitutes or spawns, so its effect is not readable';

  const segments = trimmed.split(/\s*(?:\|\||&&|[;|&\n])\s*/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return 'it is empty';

  for (const segment of segments) {
    const doubt = vouchSegment(cwd, segment);
    if (doubt !== null) return doubt;
  }
  return null;
}

function vouchSegment(cwd: string, segment: string): string | null {
  const parts = splitArgs(segment);
  const head = parts[0];
  if (!head) return 'it is empty';
  // A leading VAR=value assignment can change what the next word resolves to.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return `"${head}" sets an environment variable inline`;

  const name = commandName(head);
  const args = parts.slice(1);

  if (name === 'git') return vouchGit(cwd, args);
  if (name === 'node') return vouchNode(cwd, args);
  if (name === 'npm') return vouchNpm(args);

  if (!VOUCHED_READERS.has(name)) return `"${name}" is not on the short list of commands Conductor can vouch for`;
  if (PATH_ARG_READERS.has(name)) return pathArgsInsideCwd(cwd, args);
  return null;
}

function vouchGit(cwd: string, args: string[]): string | null {
  // -C and --git-dir point git at another checkout, which is how a vouched-looking read becomes a
  // write somewhere nobody is watching.
  const escape = args.find((a) => a === '-C' || a.startsWith('--git-dir') || a.startsWith('--work-tree'));
  if (escape) return `git "${escape}" points at another checkout`;
  const sub = args.find((a) => !a.startsWith('-'));
  if (!sub) return 'git with no subcommand';
  if (!VOUCHED_GIT.has(sub)) return `"git ${sub}" is not one of the read-only git subcommands`;
  // `git stash` with no argument stashes; only `git stash list` reads.
  if (sub === 'stash' && args[args.indexOf(sub) + 1] !== 'list') return 'bare "git stash" changes the working tree';
  return null;
}

function vouchNode(cwd: string, args: string[]): string | null {
  const evalFlag = args.find((a) => NODE_EVAL_FLAG.test(a));
  if (evalFlag) return `node "${evalFlag}" runs a string rather than a file in this project`;
  const script = args.find((a) => !a.startsWith('-'));
  if (!script) return 'node with no script runs an interactive interpreter';
  if (!insideCwd(cwd, script)) return `the script "${script}" is outside the task folder`;
  return null;
}

function vouchNpm(args: string[]): string | null {
  const sub = args.find((a) => !a.startsWith('-'));
  if (sub === 'ls' || sub === 'view' || sub === 'outdated' || sub === 'why') return null;
  return `"npm ${sub ?? ''}" can run project scripts or reach the network`;
}

/** Any bare argument that resolves outside the task folder makes the whole segment unvouchable. */
function pathArgsInsideCwd(cwd: string, args: string[]): string | null {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (!insideCwd(cwd, stripQuotes(arg))) return `"${arg}" is outside the task folder`;
  }
  return null;
}

/** Splits on whitespace, keeping quoted runs together. Enough for classification, not a shell. */
function splitArgs(segment: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = pattern.exec(segment); m !== null; m = pattern.exec(segment)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

/** `C:\\Windows\\System32\\cmd.exe` and `/bin/ls` both reduce to the name the allowlist knows. */
function commandName(head: string): string {
  const bare = basename(stripQuotes(head)).toLowerCase();
  return bare.endsWith('.exe') || bare.endsWith('.cmd') || bare.endsWith('.bat') ? bare.slice(0, bare.lastIndexOf('.')) : bare;
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

/**
 * Is this path inside the task folder, once the filesystem has had its say?
 *
 * Sol's pass 1 finding 4: the old check was lexical only, so a junction inside the task folder
 * pointing at Documents read as inside it. Junctions need no privilege on Windows, which is the
 * first-class platform, so this resolves links on both sides before comparing. The path being
 * checked usually does not exist yet (it is about to be written), so resolution walks up to the
 * deepest ancestor that does and re-attaches the rest.
 */
function insideCwd(cwd: string, candidate: string): boolean {
  const target = realish(isAbsolute(candidate) ? candidate : resolve(cwd, candidate));
  const root = realish(cwd);
  const rel = relative(caseFold(root), caseFold(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Real path of the deepest existing ancestor, with the not-yet-existing tail put back on. */
function realish(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path); // nothing on this path exists; lexical is all there is
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Windows paths differ in case and mean the same folder; POSIX paths do not. */
function caseFold(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
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
