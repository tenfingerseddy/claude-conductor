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

// The child environment scrub. The daemon's own environment is inherited by every session, and
// Sol's pass 1 showed one unflagged command is enough to write GITHUB_TOKEN into a repo. Golden
// rule 1 only ever named the billing keys; third-party credentials are the same problem wearing a
// different name.
//
// Two mechanisms on purpose. First a pattern on the variable NAME, because the shapes credentials
// take are more predictable than the list of products that issue them: anything carrying KEY,
// TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH or a connection string goes, without anyone having to
// have heard of the tool. Second a named list, because Sol's re-check finding 5 named real
// variables no pattern can see: DATABASE_URL and MYSQL_PWD are secrets that do not say so, and
// KUBECONFIG, DOCKER_CONFIG and AWS_SHARED_CREDENTIALS_FILE are pointers rather than secrets.
// Dropping a pointer does not remove the credential from disk. It stops a redirected pointer being
// read back out of the environment, and it stops the many of these that embed their own password
// (DATABASE_URL, REDIS_URL, AMQP_URL) leaking as plain text.
//
// Still a denylist rather than an allowlist, and that is still a deliberate compromise: an
// allowlist of environment variables breaks the tools a task legitimately needs (proxies,
// per-language paths, Windows' own dozens) and would be discovered as breakage rather than as
// safety. A real allowlist belongs with M2's sandboxing work.
const SECRET_ENV_NAME =
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|CREDS|AUTH|APIKEY|PAT|SESSION|COOKIE|SIGNATURE|PASSPHRASE)($|_)|_PWD($|_)|(APIKEY|ACCESSKEY|PRIVATEKEY|CONNECTIONSTRING|CONNSTR)/i;

// The names the pattern cannot see. Sol's finding 5 list, plus its obvious kin.
const SECRET_ENV_EXACT = new Set([
  'PGPASSWORD', 'PGPASSFILE', 'PGSERVICEFILE', 'MYSQL_PWD', 'MYSQL_HOME',
  'DATABASE_URL', 'DATABASE_URI', 'REDIS_URL', 'MONGODB_URI', 'MONGO_URL', 'AMQP_URL',
  'CELERY_BROKER_URL', 'SENTRY_DSN', 'KUBECONFIG', 'DOCKER_CONFIG', 'DOCKER_AUTH_CONFIG',
  'AZURE_CONFIG_DIR', 'CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE',
  'VAULT_ADDR', 'NETRC', 'GNUPGHOME', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS',
  'NPM_CONFIG_USERCONFIG', 'GH_CONFIG_DIR',
]);

// Names that survive the scrub, each for a stated reason, because a keep entry is a hole if it is
// wrong. PATH and PATHEXT: without them nothing the session runs can be found at all, and a path is
// not a credential. CLAUDE_CONFIG_DIR: this is the account mechanism and the runner overwrites it
// on the next line anyway. SESSIONNAME: Windows' name for the console session ("Console"), not a
// secret, and some tooling reads it to decide whether it has a terminal.
const ENV_KEEP = new Set(['PATH', 'PATHEXT', 'CLAUDE_CONFIG_DIR', 'SESSIONNAME']);

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
    const upper = name.toUpperCase();
    if (ENV_KEEP.has(upper)) {
      env[name] = value;
      continue;
    }
    if (SECRET_ENV_EXACT.has(upper) || SECRET_ENV_NAME.test(name)) continue;
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
// separators; anything left in a segment that can spawn, substitute, expand or redirect is not
// vouchable.
//
// `$` and `%NAME%` are here rather than only `$(` and `${` because of Sol's re-check bypass six:
// `cat "$HOME/.ssh/id_rsa"` reaches the classifier as the literal relative path `$HOME/.ssh/id_rsa`,
// which resolves inside the task folder, and reaches the shell as the real home directory. A
// classifier that cannot see what a word will become must not vouch for it. A leading `~` is the
// same trick with different spelling. `>` and `<` cover every redirection form, so no vouched
// command can write its output anywhere.
const OPAQUE_SHELL = /[`><$]|%[A-Za-z_][A-Za-z0-9_]*%|(^|\s)~|\bexec\b/;

// Anything that executes a file, a string or a project script. Never vouched safe, no exceptions,
// not even for a script inside the task folder (decisions log, 2026-08-01). The old code vouched
// for `node whatever.js` as long as the file was in the project, which Sol's re-check finding 2
// turned into unrestricted code execution in three steps: Write cleanup.js, put anything in it, run
// it. A session that can write a file can write this file, so "the script is in the project" says
// nothing about what the script does.
//
// They are named rather than merely left off the reader list so the human reading a stop gets a
// sentence that explains itself.
const INTERPRETERS = new Set([
  'node', 'nodejs', 'deno', 'bun', 'bunx', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'tsx', 'ts-node',
  'python', 'python2', 'python3', 'py', 'pip', 'pipx', 'uv', 'uvx', 'ruby', 'perl', 'php', 'lua',
  'r', 'rscript', 'osascript', 'sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'csh', 'tcsh',
  'cmd', 'command', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32',
  'java', 'javaw', 'dotnet', 'go', 'cargo', 'rustc', 'make', 'nmake', 'gradle', 'gradlew', 'mvn',
  'ant', 'msbuild', 'env', 'xargs', 'eval', 'source', 'start', 'call', 'nohup', 'setsid', 'watch',
]);

/**
 * A command Conductor is prepared to vouch for, and the exact shapes of it that it will vouch for.
 *
 * `flags` is an allowlist, not a filter: a flag that does not match makes the whole segment
 * unvouchable. Sol's re-check finding 3 is what forced that round. The old code passed any flag it
 * did not specifically object to, so `sort -o important.txt` and `rg --pre ./evil.cmd` were vouched
 * as reads. There is no way to enumerate the flags that turn a reader into a writer or a launcher;
 * there is a way to enumerate the ones that do not.
 */
interface Reader {
  /** Flags this command may carry. Null means it may carry none. */
  flags: RegExp | null;
  /** Flags that consume the next word as their value, so it is not read as a path. */
  valueFlags?: RegExp;
  /**
   * How bare arguments are read. `paths` are checked against the task folder, `none` are not paths
   * at all, `patternThenPaths` treats the first bare word as a search pattern and the rest as paths.
   */
  args: 'paths' | 'none' | 'patternThenPaths';
  /** DOS-style `/x` switches, which would otherwise read as absolute POSIX paths. */
  slashFlags?: boolean;
}

// Commands whose plain form only reads. Every entry is a promise: no writes, no network, no
// spawning something else. Kept short on purpose, because each addition is a hole if it is wrong.
const VOUCHED_READERS = new Map<string, Reader>([
  ['ls', { flags: /^(-[1AaCFhlrRSt]+|--(all|almost-all|human-readable|reverse|recursive|classify|group-directories-first|no-color|color(=[\w-]+)?|sort=\w+|time=\w+))$/, args: 'paths' }],
  ['dir', { flags: /^\/[abdlnopqswx4](:[\w-]+)?$/i, args: 'paths', slashFlags: true }],
  ['pwd', { flags: /^-[LP]$/, args: 'none' }],
  ['cd', { flags: null, args: 'paths' }],
  ['echo', { flags: /^-[neE]$/, args: 'none' }],
  ['cat', { flags: /^(-[bEnstTv]+|--(number|number-nonblank|show-ends|show-tabs|squeeze-blank))$/, args: 'paths' }],
  ['type', { flags: null, args: 'paths' }],
  ['head', { flags: /^(-\d+|-[nc]\d*|--(lines|bytes)=\d+)$/, valueFlags: /^(-[nc]|--lines|--bytes)$/, args: 'paths' }],
  ['tail', { flags: /^(-\d+|-[nc]\d*|--(lines|bytes)=\d+)$/, valueFlags: /^(-[nc]|--lines|--bytes)$/, args: 'paths' }],
  ['wc', { flags: /^(-[lwcmL]+|--(lines|words|bytes|chars|max-line-length))$/, args: 'paths' }],
  // No -o and no --output: that is Sol's bypass four, a reader that writes a file.
  ['sort', { flags: /^(-[bdfghinrsuVz]+|-k\S+|-t.|--(ignore-case|numeric-sort|human-numeric-sort|reverse|unique|stable|version-sort|key=\S+|field-separator=.))$/, valueFlags: /^(-k|-t|--key|--field-separator)$/, args: 'paths' }],
  ['uniq', { flags: /^(-[cdiuz]+|--(count|repeated|unique|ignore-case))$/, args: 'paths' }],
  ['grep', { flags: /^(-[EFGHhIiLlnoqRrsvwxZ]+|-[ABC]\d+|--(color(=\w+)?|no-color|ignore-case|line-number|recursive|word-regexp|fixed-strings|extended-regexp|invert-match|files-with-matches|files-without-match|only-matching|count|no-messages|include=\S+|exclude=\S+|exclude-dir=\S+|binary-files=\w+|max-count=\d+))$/, valueFlags: /^(-[emABC]|--(regexp|include|exclude|exclude-dir|max-count))$/, args: 'patternThenPaths' }],
  // No --pre and no --pre-glob and no --hostname-bin: that is Sol's bypass five, a reader that
  // launches an arbitrary program on every file it touches.
  ['rg', { flags: /^(-[cFHiILlNnovwx]+|-[ABC]\d+|--(hidden|no-ignore|no-heading|heading|line-number|no-line-number|with-filename|no-filename|files|count|count-matches|fixed-strings|ignore-case|smart-case|case-sensitive|word-regexp|invert-match|json|no-color|color=\w+|max-count=\d+|max-depth=\d+|glob=\S+|type=\S+|type-not=\S+|context=\d+|after-context=\d+|before-context=\d+))$/, valueFlags: /^(-[egt]|--(regexp|glob|type|type-not|max-count|max-depth|context|after-context|before-context))$/, args: 'patternThenPaths' }],
  ['findstr', { flags: /^\/[a-z](:\S*)?$/i, args: 'patternThenPaths', slashFlags: true }],
  ['stat', { flags: /^(-[Lft]|--(format=\S+|printf=\S+|terse|dereference))$/, valueFlags: /^(-c|--format|--printf)$/, args: 'paths' }],
  ['file', { flags: /^-[bhiLz]+$/, args: 'paths' }],
  ['tree', { flags: /^(-[adfilpqsuFL]+|--(dirsfirst|noreport|charset=\S+))$/, valueFlags: /^-L$/, args: 'paths' }],
  ['du', { flags: /^(-[abchksxm]+|--(human-readable|summarize|max-depth=\d+|all|bytes))$/, args: 'paths' }],
  ['df', { flags: /^(-[hikPT]+|--(human-readable|portability))$/, args: 'paths' }],
  ['which', { flags: /^-a$/, args: 'none' }],
  ['where', { flags: null, args: 'none' }],
  ['whoami', { flags: null, args: 'none' }],
  ['hostname', { flags: null, args: 'none' }],
  ['uname', { flags: /^-[amnoprsv]+$/, args: 'none' }],
  ['date', { flags: /^(-u|--utc|\+[^\s`$]+)$/, args: 'none' }],
  ['basename', { flags: null, args: 'none' }],
  ['dirname', { flags: null, args: 'none' }],
  ['true', { flags: null, args: 'none' }],
  ['false', { flags: null, args: 'none' }],
]);

// Global git flags, meaning the ones that may appear before the subcommand. Only one, because the
// rest of them relocate git (-C, --git-dir, --work-tree) or make it run a program of the caller's
// choosing (-c core.pager=..., --exec-path).
const GIT_GLOBAL_FLAG = /^--no-pager$/;

// Flags a read-only git subcommand may carry. Every one of these changes how git reports; none of
// them changes anything on disk. --output is absent, which is Sol's bypass three: `git diff
// --output=C:/Users/victim/important.txt` overwrites a file outside the task folder while looking
// like the most ordinary read in the list.
const GIT_READ_FLAG =
  /^(-\d+|-[psuv]|--(oneline|stat|numstat|shortstat|summary|patch|no-patch|raw|name-only|name-status|graph|decorate(=\w+)?|no-decorate|abbrev-commit|no-abbrev|short|porcelain(=\S+)?|no-color|color(=\w+)?|cached|staged|all|branches|tags|remotes|reverse|first-parent|no-merges|merges|follow|find-renames|no-renames|full-index|unified=\d+|word-diff(=\w+)?|ignore-all-space|ignore-space-change|text|stat-width=\d+|pretty(=\S+)?|format(=\S+)?|date=\S+|since=\S+|until=\S+|author=\S+|committer=\S+|grep=\S+|max-count=\d+|skip=\d+|verbose|quiet|show-toplevel|git-dir|abbrev-ref|symbolic-full-name|is-inside-work-tree|verify|others|modified|deleted|ignored|stage|exclude-standard|error-unmatch|full-name|line-porcelain|line-number|tags-only|contains|long|always|dirty(=\S+)?))$/;

const GIT_VALUE_FLAG = /^(-[nSGL]|--(max-count|skip|pretty|format|date|grep|author|committer|since|until|unified|contains))$/;

// git subcommands that only report. The value is the set of second words allowed after it, or null
// when the subcommand takes no second word that changes what it does. `git remote` is the reason
// this map is not a set: `git remote -v` reports, and `git remote remove origin` rewrites
// .git/config, which is Sol's bypass two.
const VOUCHED_GIT = new Map<string, Set<string> | null>([
  ['status', null],
  ['log', null],
  ['diff', null],
  ['show', null],
  ['rev-parse', null],
  ['ls-files', null],
  ['describe', null],
  ['blame', null],
  ['shortlog', null],
  ['remote', new Set(['', 'show', 'get-url'])],
  ['stash', new Set(['list', 'show'])],
]);

/**
 * The vouching half of deny-by-default. Returns null when the whole command is positively safe, or
 * a sentence saying which part could not be vouched for.
 */
export function vouchSafe(cwd: string, command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return 'it is empty';
  if (OPAQUE_SHELL.test(trimmed)) return 'it redirects, substitutes, expands or spawns, so its effect is not readable';

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

  const named = commandWord(head);
  if (typeof named !== 'string') return named.doubt;
  const args = parts.slice(1);

  if (INTERPRETERS.has(named)) return `"${named}" runs code, and Conductor never vouches for an interpreter whatever it is pointed at`;
  if (named === 'git') return vouchGit(args);

  const reader = VOUCHED_READERS.get(named);
  if (!reader) return `"${named}" is not on the short list of commands Conductor can vouch for`;
  return vouchReader(cwd, named, reader, args);
}

/** Walks one vouched reader's arguments: every flag allowlisted, every path inside the folder. */
function vouchReader(cwd: string, name: string, reader: Reader, args: string[]): string | null {
  let bare = 0;
  let flagsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && looksLikeFlag(arg, reader)) {
      // valueFlags is itself an allowlist, and it is checked first because these flags are spelled
      // both ways: `--glob "*.ts"` and `--glob=*.ts` are the same flag, and only the first form
      // swallows the word after it.
      if (reader.valueFlags?.test(arg)) {
        i++; // its value is a value, not a path
        continue;
      }
      if (!reader.flags || !reader.flags.test(arg)) return `"${name} ${arg}" is not a flag Conductor can vouch for`;
      continue;
    }
    bare++;
    if (reader.args === 'none') continue;
    if (reader.args === 'patternThenPaths' && bare === 1) continue;
    const path = stripQuotes(arg);
    if (!insideCwd(cwd, path)) return `"${arg}" is outside the task folder`;
  }
  return null;
}

function looksLikeFlag(arg: string, reader: Reader): boolean {
  if (arg.length > 1 && arg.startsWith('-')) return true;
  return reader.slashFlags === true && arg.length > 1 && arg.startsWith('/');
}

/**
 * git, split at the subcommand: words before it are global flags that can relocate git or make it
 * run a program, words after it belong to a subcommand that must be a reporting one.
 */
function vouchGit(args: string[]): string | null {
  let sub: string | null = null;
  let subAt = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.startsWith('-')) {
      if (!GIT_GLOBAL_FLAG.test(arg)) return `git "${arg}" before the subcommand can relocate git or make it run a program`;
      continue;
    }
    sub = arg;
    subAt = i;
    break;
  }
  if (sub === null) return 'git with no subcommand';
  if (!VOUCHED_GIT.has(sub)) return `"git ${sub}" is not one of the read-only git subcommands`;

  const rest = args.slice(subAt + 1);
  const allowedSecond = VOUCHED_GIT.get(sub);
  if (allowedSecond) {
    const second = rest.find((a) => !a.startsWith('-')) ?? '';
    if (!allowedSecond.has(second)) return `"${`git ${sub} ${second}`.trim()}" is not one of the read-only forms of "git ${sub}"`;
  }

  // Bare words after the subcommand are refs and pathspecs. They are not path-checked, because git
  // resolves a pathspec against the repository and reports rather than writes; the flags above are
  // where a reporting subcommand could have been turned into a writing one, and they are allowlisted.
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg === '--') break;
    if (!arg.startsWith('-')) continue;
    if (GIT_VALUE_FLAG.test(arg)) {
      i++;
      continue;
    }
    if (!GIT_READ_FLAG.test(arg)) return `"git ${sub} ${arg}" is not a flag Conductor can vouch for`;
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

// An executable spelled as a file rather than as a name. `.js` and `.py` are here too: on Windows
// PATHEXT and file associations make them runnable words in their own right.
const EXECUTABLE_SUFFIX = /\.(exe|com|cmd|bat|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msc|scr|py|sh)$/i;

/**
 * The word at the head of a segment, if it is a bare command name Conductor can look up. Anything
 * else is refused rather than reduced.
 *
 * The old version took the basename and dropped the extension, so `./git.cmd status` and
 * `C:\evil\git.exe log` both classified as git. Sol's re-check finding 2b: a repository can contain
 * an executable called git, and a session can write one. A name resolved through PATH is a
 * different thing from a file the session can control, and the classifier cannot tell them apart
 * once it has thrown the path away, so it does not throw the path away. It refuses.
 */
function commandWord(head: string): string | { doubt: string } {
  const raw = stripQuotes(head);
  if (raw.includes('/') || raw.includes('\\')) {
    return { doubt: `"${raw}" names a file to run rather than a known command, so Conductor cannot tell what it is` };
  }
  if (EXECUTABLE_SUFFIX.test(raw)) {
    return { doubt: `"${raw}" is an executable file, and a file in reach of the session is not a command Conductor can vouch for` };
  }
  return raw.toLowerCase();
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
