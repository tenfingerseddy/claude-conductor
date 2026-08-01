# M1 slice 2: the engine, session runner, finish_task, fresh cut, gauge

Built 2026-08-01 on branch `feat/m1-engine`, on top of slice 1's scaffold and state layer. Scope was
the four engine files, the task loop in `main.ts`, and the first runtime dependency. No server, no
CLI, no playbook injection, no queue.

Publishing scrub rule applied throughout: exact plan utilization percentages are replaced with
`<withheld, low>` and `<withheld, mid>`, so a few pasted JSON lines are no longer valid JSON. Reset
timestamps, token counts, field names, and session ids are kept. No account folder name and no
credential material appears here.

## What landed

| File | What it does |
|---|---|
| `src/engine/session.ts` | One SDK session per task. Account via `CLAUDE_CONFIG_DIR`, trust to permission mode, the permission gate, message streaming to a callback. |
| `src/engine/finish-task.ts` | The `finish_task` in-process MCP tool: handoff note, outcome verdict, follow-ups. Writes the note, logs `task_finish`. |
| `src/engine/cut.ts` | Fresh cut only. Builds the next task's opening prompt from the previous handoff, logs the `cut` event with mode `fresh`. |
| `src/engine/gauge.ts` | The four-layer source stack, the one-line gauge string, `gauge_reading`, `limit_event`, and `calibration` events. |
| `src/main.ts` | `runTasks(tasks)`: the core loop over an ordered in-memory list, carrying the handoff from one task to the next. |
| `package.json` | First runtime dependencies: `@anthropic-ai/claude-agent-sdk` 0.3.220 and `zod` 4.4.3. `package-lock.json` now committed. |

`zod` is the deviation worth naming up front. The SDK's `tool()` helper takes a zod raw shape and
nothing else, and zod is a peer dependency of the SDK rather than a bundled one. Importing it while
it sits in `node_modules` only by npm's peer auto-install would be a silent dependency, so it is
declared. Two runtime dependencies instead of one.

## The gauge line is injected with the `UserPromptSubmit` hook

Asked to pick a documented mechanism and say which: it is the `UserPromptSubmit` hook, returning
`hookSpecificOutput.additionalContext`. That field exists precisely to add context to the turn the
model is about to answer, it is in the SDK's own hook types, and it needs no prompt rewriting by
Conductor. The alternative, prepending the line to each streamed user message, would mean Conductor
editing text Claude was meant to read as the user's, which is worse for no gain.

**The honest limit.** The hook fires once per user prompt submission. M1 sends exactly one prompt
per task, so within a task the gauge lands once, at the top. It is not re-injected after every
assistant turn, because there is no documented per-assistant-turn injection point. For the spec's
mid-task checkpoint this matters: the checkpoint instruction reaches Claude at the start of the
task, carrying the numbers as they were then, and a task that runs long will not see them move. The
closest documented alternative that would move the numbers mid-task is sending a fresh user message
into the streaming input, which is a second mechanism the spec explicitly does not want. Flagging
rather than improvising: this is a real gap between the spec's "injected into every turn" and what
one prompt per task can deliver, and it closes on its own if a task ever spans several prompts.

Proof it reaches the model, from task one's handoff note. The task asked Claude to quote the gauge
line verbatim, and it did:

```
Conductor gauge, account "work" | context: fresh session, still small | 5-hour window:
<withheld, low>% used (official, from disk, resets 12:20Z) | weekly window: <withheld, mid>% used
(official, from disk, resets 09:59Z) | this run has metered 0 tokens on this account. There is
ample room to finish the current step.
```

That is the standing sentence in place, the calm wording, and the source and freshness of every
number stated rather than implied.

## The four layers, and what each one actually did

1. **The experimental usage method on `Query`.** Called at the task boundary only, reached by name,
   wrapped in a presence check, a try/catch and a 15 second timeout. It worked live on both tasks
   and produced the fresh official reading (`source: "official_live"`, `confidence: "fresh"`, with
   ISO reset times for both windows). If it throws, times out, returns `rate_limits_available:
   false`, or returns anything shaped wrong, the result is `null` and the gauge falls through to
   the layer below. No throw ever reaches the session loop.
2. **`rate_limit_event`.** Logged as `limit_event`, never read as a percentage, exactly as S3
   concluded. One event per session in practice, right after init, `status: allowed`. When status
   leaves `allowed` the gauge line gains a pressure sentence and the checkpoint advice turns on.
3. **The `.claude.json` file read.** Plain `JSON.parse` per S4 so duplicate drive-letter keys are
   tolerated, gated on `fetchedAtMs` with the 90 minute rule, absent or unparseable means no
   reading and never zero, and the parse never throws. `.credentials.json` is never opened and
   `accountUuid` is never read or stored.
4. **Self-metering.** Summed from every result message's `modelUsage`, per model, kept per account
   for the life of the process so a chain of tasks accumulates. Always on.

**New finding, and it changes part of the S2 picture.** S1 established that an SDK session does not
refresh `cachedUsageUtilization` on disk. That still holds, but *calling the experimental usage
method does refresh it*. The evidence is in the run below: before task one the file read returned a
stale block with a `resets_at` of `06:40`. Task one's boundary probe returned a live reading with
`resets_at` `2026-08-01T12:20:00.138872+00:00`. The file read taken at task two's start then
returned `confidence: "fresh"` with that same timestamp, to the microsecond. The only thing between
those two reads was the probe. So a Conductor-driven account keeps its on-disk official numbers
fresh as a side effect of the gauge doing its job, which is better than S2's amber assumed. Worth
re-checking whenever the SDK updates, since the probe is the unstable surface here.

**Calibration.** The anchor is the last official percentage plus the self-metered token total at
that moment. When a fresh official reading arrives, the gap between the carried-forward prediction
and the new number is logged as a `calibration` event, and the gap divided by the tokens spent
trains a tokens-to-percent rate used for `anchor_plus_delta` estimates while a reading is stale.
The live run logged one calibration event with a gap of 0: the two tasks were small enough that the
five-hour percentage did not move, which is a true reading and not a broken one.

## The two-task chain, end to end

Scratch project folder and scratch state root, both in the session scratchpad. `CONDUCTOR_HOME`
pointed at the scratch state dir, and the `work` entry in **that scratch `config.json` only** was
pointed at this machine's work-account config directory. The repo's seeded registry still holds
placeholders. `ANTHROPIC_API_KEY` was absent from the environment and is stripped from the child
environment by `childEnv()` regardless.

Both tasks: `model: haiku`, `trust: autonomous`.

### Console trail

```
[t1] init model=claude-haiku-4-5-20251001 session=8a44879b-44fc-4116-bd01-953e03c8923f
[t1] rate_limit_event: {"status":"allowed","resetsAt":1785586800,"rateLimitType":"five_hour",
     "overageStatus":"allowed","overageResetsAt":1785571200,"isUsingOverage":false}
[t1] assistant: I'll start by creating the notes.txt file with the required content.
[t1] tool_use: Write {"file_path":"/notes.txt","content":"hello from task one"}
[t1] tool_use: Write {"file_path":"notes.txt","content":"hello from task one"}
[t1] assistant: Perfect! The file has been created. Now I'll call the finish_task tool to complete
     this task and hand off to the next session.
[t1] tool_use: mcp__conductor__finish_task {"what_was_done":"Created notes.txt file containing
     exactly one line: \"hello from task one\"","what_matters":"Conductor gauge, account \"work\" ...
[t1] result: subtype=error_during_execution is_error=true turns=5

[t2] init model=claude-haiku-4-5-20251001 session=68baab25-a1a3-4fb7-ac97-56bac107e528
[t2] rate_limit_event: {"status":"allowed","resetsAt":1785586800,"rateLimitType":"five_hour", ...}
[t2] assistant: I'll start by reading the current notes.txt file to see its state, then append the
     second line as instructed.
[t2] tool_use: Read {"file_path":"notes.txt"}
[t2] assistant: Now I'll append the second line to the file:
[t2] tool_use: Edit {"file_path":"notes.txt","old_string":"hello from task one",
     "new_string":"hello from task one\ntask two was here"}
[t2] assistant: Perfect! I have successfully completed the task. The second line has been appended
     to notes.txt. Now I'll call the finish_task tool to hand off:
[t2] tool_use: mcp__conductor__finish_task {"outcome":"done","what_was_done":"The previous task's
     outcome was done. As stated in the handoff note: ...
[t2] result: subtype=error_during_execution is_error=true turns=5
```

`error_during_execution` on both results is Conductor's own interrupt landing, not a failed task.
See "The cut needed teeth" below. The runner recognises it and does not report it as an error, which
is why both runs come back with `errorText: null`.

The first `Write` to `/notes.txt` is the permission gate working: it resolves outside the task
folder, so it was denied and Claude wrote the correct relative path instead.

### The file the chain was about

```
hello from task one
task two was here
```

### Task one's handoff note, on disk

```
# Create the notes file

Finished 2026-08-01T08:05:31.733Z

## What was done

Created notes.txt file containing exactly one line: "hello from task one"

## What matters

Conductor gauge, account "work" | context: fresh session, still small | 5-hour window:
<withheld, low>% used (official, from disk, resets 12:20Z) | weekly window: <withheld, mid>% used
(official, from disk, resets 09:59Z) | this run has metered 0 tokens on this account. There is
ample room to finish the current step. The notes.txt file has been successfully created with the
first line. The next session should append the second line as specified in the follow-up task.

## Open threads

- none

## Follow-up tasks

- Append a second line to notes.txt saying task two was here
```

### Task two proving the handoff reached it

Task two ran in a brand new session with no shared history, and was asked to quote what it received:

```
## What was done

The previous task's outcome was done. As stated in the handoff note: "The notes.txt file has been
successfully created with the first line." I appended a second line to notes.txt containing "task
two was here", fulfilling the follow-up task that was left pending. The file now contains two
lines: "hello from task one" followed by "task two was here".
```

It quoted the note, named the outcome verdict, and did the follow-up task that only the note could
have told it about. That is the fresh cut working.

### `events.jsonl`, the whole run

Percentages redacted per the scrub rule; everything else verbatim. Paths shortened to `<scratch>`
and `<handoffs>` for width.

```
{"ts":"2026-08-01T08:05:16.503Z","kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":<withheld, low>,"source":"official_file","confidence":"fresh","resetsAt":"2026-08-01T12:20:00.138872+00:00"}
{"ts":"2026-08-01T08:05:16.504Z","kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":<withheld, mid>,"source":"official_file","confidence":"fresh","resetsAt":"2026-08-02T09:59:59.138894+00:00"}
{"ts":"2026-08-01T08:05:16.504Z","kind":"task_start","taskId":"t1","account":"work","cwd":"<scratch>/proj","model":"haiku"}
{"ts":"2026-08-01T08:05:18.864Z","kind":"limit_event","account":"work","status":"allowed","window":"five_hour","resetsAt":"2026-08-01T12:20:00.000Z"}
{"ts":"2026-08-01T08:05:36.218Z","kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":<withheld, low>,"source":"official_live","confidence":"fresh","resetsAt":"2026-08-01T12:20:00.805339+00:00"}
{"ts":"2026-08-01T08:05:36.218Z","kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":<withheld, mid>,"source":"official_live","confidence":"fresh","resetsAt":"2026-08-02T09:59:59.805361+00:00"}
{"ts":"2026-08-01T08:05:36.219Z","kind":"gauge_reading","account":"work","bucketId":"self_metered_tokens","percent":null,"source":"self_metered","confidence":"fresh"}
{"ts":"2026-08-01T08:05:37.293Z","kind":"task_finish","taskId":"t1","outcome":"done","handoffPath":"<handoffs>\\20260801T080531Z-create-the-notes-file.md","contextPeakPercent":14,"usage":{"input":26,"output":1326,"cacheCreation":5109,"cacheRead":78678}}
{"ts":"2026-08-01T08:05:37.293Z","kind":"cut","taskId":"t1","mode":"fresh","sessionId":"8a44879b-44fc-4116-bd01-953e03c8923f","reason":"finish_task: done"}
{"ts":"2026-08-01T08:05:37.295Z","kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":<withheld, low>,"source":"official_file","confidence":"fresh","resetsAt":"2026-08-01T12:20:00.138872+00:00"}
{"ts":"2026-08-01T08:05:37.296Z","kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":<withheld, mid>,"source":"official_file","confidence":"fresh","resetsAt":"2026-08-02T09:59:59.138894+00:00"}
{"ts":"2026-08-01T08:05:37.296Z","kind":"task_start","taskId":"t2","account":"work","cwd":"<scratch>/proj","model":"haiku"}
{"ts":"2026-08-01T08:05:39.181Z","kind":"limit_event","account":"work","status":"allowed","window":"five_hour","resetsAt":"2026-08-01T12:20:00.000Z"}
{"ts":"2026-08-01T08:05:53.795Z","kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":<withheld, low>,"source":"official_live","confidence":"fresh","resetsAt":"2026-08-01T12:20:00.458304+00:00"}
{"ts":"2026-08-01T08:05:53.795Z","kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":<withheld, mid>,"source":"official_live","confidence":"fresh","resetsAt":"2026-08-02T09:59:59.458332+00:00"}
{"ts":"2026-08-01T08:05:53.795Z","kind":"gauge_reading","account":"work","bucketId":"self_metered_tokens","percent":null,"source":"self_metered","confidence":"fresh"}
{"ts":"2026-08-01T08:05:53.795Z","kind":"calibration","account":"work","bucketId":"session_5h","predictedPercent":<withheld, low>,"officialPercent":<withheld, low>,"gap":0,"fetchedAt":"2026-08-01T08:05:53.795Z"}
{"ts":"2026-08-01T08:05:54.626Z","kind":"task_finish","taskId":"t2","outcome":"done","handoffPath":"<handoffs>\\20260801T080549Z-do-the-follow-up-on-the-notes-file.md","contextPeakPercent":15,"usage":{"input":26,"output":922,"cacheCreation":5326,"cacheRead":79169}}
{"ts":"2026-08-01T08:05:54.626Z","kind":"cut","taskId":"t2","mode":"fresh","sessionId":"68baab25-a1a3-4fb7-ac97-56bac107e528","reason":"finish_task: done"}
```

Everything the spec's Logbook section asks for is in there: task start with account and model, task
finish with outcome, handoff path, context peak and token usage, the cut with its mode and session
id, gauge readings with source and confidence on every layer, the limit event, and the calibration.

Cost of the whole chain: about 10k cache-creation and about 158k cache-read tokens across two cold
Haiku sessions, plus roughly 2.2k output. Two cold starts, which is the fresh cut's price and the
reason the playbook says not to cut for the sake of cutting.

## The permission rails, proven separately

Same runner, one autonomous task, told to run `rm -rf ./doomed-folder` and to write a file outside
its own folder, and told not to work around a refusal. Autonomous is the *loose* trust level, so
this is the case that matters.

```
[p1] tool_use: Bash {"command":"rm -rf ./doomed-folder", ...}
[p1] tool_result: "Conductor did not get approval: the command can destroy or publish work, and
     destructive actions always need a tap. Try a different approach or finish the task and say
     what is blocked."
[p1] tool_use: Write {"file_path":"C:/Users/.../outside-the-task.txt","content":"nope"}
[p1] tool_result: "Conductor did not get approval: it touches \"C:\\Users\\...\\outside-the-task.txt\",
     which is outside the task folder. Try a different approach or finish the task and say what is
     blocked."
[p1] permission_denials: [{"tool_name":"Bash","tool_use_id":"toolu_01G2...","tool_input":{...}},
                          {"tool_name":"Write","tool_use_id":"toolu_011f...","tool_input":{...}}]
outcome: "blocked"
```

The file outside the task folder does not exist afterwards. With no door attached the approver is
absent and the answer is no, which is the safe default and the reason a missing door cannot become
an accidental yes. `bypassPermissions` is used nowhere in the codebase.

**Caveat found while doing this, and it is a real one.** The SDK warns:

```
[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for:
mcp__conductor__finish_task. Bare allowedTools entries auto-approve the whole tool before the
callback is consulted. To gate every tool call, use a PreToolUse hook; or remove the bare names
from allowedTools so they fall through to canUseTool. Allow rules from settings files can also
shadow the callback but are not visible here.
```

For `finish_task` that shadowing is deliberate: asking permission to hand off would be silly. The
sentence that matters is the last one. A permission allow rule in the user's own settings files can
shadow `canUseTool` for any tool, including a destructive Bash rule, and Conductor cannot see it.
So the destructive rail as built is strong against the model and weak against the user's own
settings. Moving the classifier into a `PreToolUse` hook would close that, since hooks run whatever
the allow rules say. Parked for the slice that adds the approval door, and named here so it is not
forgotten.

## Three things measured, not assumed

1. **The boundary probes must run inside the message loop.** The first live run returned no live
   usage and no context reading at all. Cause: `break` out of a `for await` calls `return()` on the
   iterator, which tears the query down, and the control methods die with it. Moving
   `refreshAtBoundary` above the `break` turned every `official_live` reading on. The gauge would
   have silently shipped as file-plus-self-metering only.
2. **The cut needed teeth.** In the second run, task one wrote its handoff, called `finish_task`,
   and then carried straight on and did the follow-up task it had just queued for the next session,
   calling `finish_task` a second time and overwriting its own note. The tool returning is not an
   ending. Now the first `finish_task` call is the only one that counts, and it schedules
   `query.interrupt()` 250 ms later so the tool result reaches the model and then the session stops.
   That is what produces the `error_during_execution` result subtype, which the runner treats as the
   expected end of a finished task rather than a failure.
3. **`finish_task` needed `alwaysLoad`.** Without it the tool sat behind tool search and Claude
   burned a whole turn on `ToolSearch` before it could hand off, on every single task. One flag,
   one fewer turn per task, in a design whose whole shape is handing off.

## Decisions worth knowing

- **`runTasks` carries the handoff between consecutive tasks in the list and returns each task's
  follow-ups.** It does not queue them. Follow-ups are recorded in the handoff note and returned to
  the caller, and M2's queue is what will consume them.
- **A task whose session ends without `finish_task`** is recorded with outcome `no_finish_task` and
  carries nothing forward. No handoff is invented on Claude's behalf.
- **The playbook is not injected.** SPEC lists playbook injection under M2, and slice 1 seeds the
  page. The gauge line is the only thing Conductor adds to a turn in M1.
- **Checkpoint thresholds are constants in `gauge.ts`** (60% context, 70% five-hour) with a comment
  saying the playbook page owns them from M2. They are advisory in M1, as the brief says.
- **Auto-compact logging is in place.** The `compact_boundary` message is the logger because it
  carries `trigger`, `pre_tokens` and `post_tokens`; a `PreCompact` hook is registered as a backup
  so a compaction that never produces a boundary message is still logged once. Neither fired in
  these runs, which is what should happen when the loop works.
- **The account mechanism is one line of code** (`CLAUDE_CONFIG_DIR` in the child environment) plus
  a deletion of `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from it. Golden rule 1 is enforced by
  the runner rather than assumed from the ambient environment.

## Not done, on purpose

The HTTP and WebSocket server, the CLI door, the approval door the permission gate is waiting for,
compact cut, playbook enforcement, the task queue, and the subagent registry. All later slices or
later milestones.

## Verification summary

- `npx tsc --noEmit` exit 0 with all four engine files and the rewritten `main.ts` in the program.
- Two-task chain ran end to end on Haiku against the work account, output above.
- Permission probe ran, both rails held, output above.
- Scratch state root and scratch project folder only. Nothing was written into the repo's state, and
  the repo's account registry still holds placeholders.
