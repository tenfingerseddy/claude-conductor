# M1 slice 3: the loopback server, the CLI door, and the rail moved to a hook

Built 2026-08-01 on branch `feat/m1-engine`, on top of slices 1 and 2. Scope was three things: one
HTTP plus WebSocket server on 127.0.0.1, a thin CLI over it, and the destructive-action rail moved
from `canUseTool` to a `PreToolUse` hook.

Publishing scrub rule applied: plan utilization percentages are replaced with `<withheld, low>` and
`<withheld, mid>`, and the scratch state path is shortened to `<scratch>`. Timestamps, token counts,
session ids and field names are verbatim. No account folder name and no credential material appears
here.

## What landed

| File | What it does |
|---|---|
| `src/server/http.ts` | One server on `127.0.0.1` only. `GET /status`, `GET /gauge`, `GET /events?tail=N`, `POST /tasks`, `POST /run`, and a WebSocket at `/ws` carrying session messages and approval requests both ways. |
| `src/cli.ts` | The terminal door. `daemon`, `status`, `gauge`, `add`, `run`, `tail`, `watch`. HTTP and WebSocket only; it never touches state directly. Argv parsed by hand, no CLI framework. |
| `src/engine/session.ts` | The rail is now a `PreToolUse` hook. `canUseTool` stays as layer two. Streaming input now accepts extra messages from a door, and hands the door a session handle. |
| `src/state/logbook.ts` | New event kind `rail_stop`: layer, risk kind, reason, trust, decision, and which door answered. |
| `src/engine/gauge.ts` | `snapshot()`, a read-only view for the doors that logs nothing. |
| `src/main.ts` | `runDaemon()` boots the server and logs `daemon_start` and `daemon_stop`. `runTasks` gained caller-owned gauges and task lifecycle callbacks. |
| `package.json` | Third and last M1 runtime dependency: `ws` 8.21.1. Plus `@types/ws` as a dev dependency, types only, because `ws` ships no types of its own and `tsc --noEmit` cannot resolve it otherwise. |

## The bind, proven

The daemon listens on one address, named explicitly. `netstat` with the daemon up:

```
=== netstat -ano | findstr 7719 ===
  TCP    127.0.0.1:7719         0.0.0.0:0              LISTENING       28504
=== any 0.0.0.0 or :: listener on this port? ===
none
```

The machine's LAN address refuses, loopback answers:

```
ip=172.20.10.9
refused on the LAN address: Unable to connect to the remote server

curl http://127.0.0.1:7719/status
{
  "version": "0.1.0",
  "pid": 28504,
  "uptimeSeconds": 30,
  ...
```

The S5 failure-mode rule is enforced rather than intended. A second daemon on the same port:

```
conductor: could not bind 127.0.0.1:7719 (EADDRINUSE). Another daemon may already be running.
Conductor never widens the bind address, so it is stopping.
conductor: listen EADDRINUSE: address already in use 127.0.0.1:7719
```

```
{"ts":"2026-08-01T08:32:14.684Z","kind":"daemon_stop","pid":28576,"reason":"bind failed on 127.0.0.1:7719: EADDRINUSE"}
```

There is no fallback port and no retry on a wider address. There is also a Host header check on
every request, because a name that resolves to loopback is the one way a browser on this machine
could reach a loopback-only bind.

## The rail moved from `canUseTool` to `PreToolUse`

Slice 2 named the hole: the SDK warns that allow-rules in the user's own settings files shadow
`canUseTool` invisibly, so the rail was strong against the model and weak against settings. The
classifier now runs in a `PreToolUse` hook, which runs whatever those rules say. `canUseTool` keeps
the same classifier underneath it, so a call that somehow skips the hook is still stopped.

What counts as a stop, all of it blunt on purpose: file deletion and the delete commands
(`rm`, `rmdir`, `del`, `erase`, `rd`, `unlink`, `shred`, `Remove-Item`, `Clear-Content`,
`format`, `mkfs`, `dd`, `diskpart`), `git push`, `git reset`, `git clean`, `git checkout --`,
`git restore`, `git branch -D`, `git filter-branch`, `npm publish` and `unpublish`, piping anything
into a shell, a notebook edit whose `edit_mode` is `delete`, any path outside the task folder, and
anything asking for elevated permission (`sudo`, `runas`, `takeown`, `icacls`,
`Start-Process -Verb RunAs`, writes to `HKLM`). Commands are read whether they arrive as a string
or an argv array.

Behaviour by trust, per D9: attended and autonomous both stop. The difference is only what a door
is expected to do about it. With no door attached the answer is no, immediately, and the stop is
logged. `bypassPermissions` appears nowhere in the codebase.

**Measured, not assumed: the SDK still consults `canUseTool` after a `PreToolUse` allow.** The
first attended run asked the human the identical question twice and logged two `rail_stop` lines,
`pre_tool_use` then `can_use_tool`, 500 ms apart. Fix: when the rail gets a yes it writes a
one-shot ticket for that exact tool call, and layer two spends the ticket instead of asking again.
The ticket is deleted when used, so a second identical call gets a fresh tap at the rail. Nothing
else can write a ticket, so a call layer one never saw is still stopped by layer two.

**Measured, not assumed: "a door is attached" is not something the engine can know.** The first
autonomous run logged `doorAttached: true` while `status` showed `doors open: 0`, because the
approver function exists whether or not anyone is on the other end of it. The `Approver` type now
returns `{ approved, door }` and the daemon answers `door: null` when no WebSocket is connected or
when the ten minute wait runs out. The event field is `door`, and a null there means nobody was
asked, which is the line that matters when reading the log later.

## An attended task, end to end through the CLI

Scratch project folder and scratch state root, both in the session scratchpad. `CONDUCTOR_HOME`
pointed at the scratch state dir and the `work` entry in **that scratch `config.json` only** pointed
at this machine's work-account config directory. The repo's registry still holds placeholders.
Haiku, attended trust, one task: delete a scratch file with `rm`, then hand off.

The approval was answered by typing `y` into the real `conductor watch` process. A scratch harness
did the typing (there is no human at this terminal), and it waited five seconds first, on purpose,
so the log shows the work stopped and stayed stopped until the answer arrived.

```
08:28:24 $ conductor status   accounts:    work
08:28:24 $ conductor status   tasks:       0
08:28:24 [watch] watching http://127.0.0.1:7719. Ctrl+C to detach.
08:28:26 $ conductor add ... --cwd <scratch>/proj --trust attended --model haiku
                          added t1: Attended rail demo
                          cwd "<scratch>/proj", account work, trust attended, model haiku
08:28:26 [watch] run started over 1 task(s)
08:28:26 [watch] === task t1 started: Attended rail demo (work, attended) ===
08:28:26 $ conductor run  run started over 1 task(s). Attach with "conductor watch" to see turns
                          and answer approval stops.
08:28:27 [watch] [t1] session 1f648344-cd85-421a-a2b9-e6b7d222ed52 on claude-haiku-4-5-20251001
08:28:30 [watch] [t1] tool: Bash {"command":"rm doomed.txt","description":"Delete the scratch file doomed.txt"}
08:28:30 [watch]   ---- Conductor stopped for a tap ----
08:28:30 [watch]   task:  t1
08:28:30 [watch]   tool:  Bash
08:28:30 [watch]   input: {"command":"rm doomed.txt","description":"Delete the scratch file doomed.txt"}
08:28:30 [watch]   why:   the command can destroy or publish work, and destructive actions always need a tap
08:28:30 [watch]   approve? [y/N]
08:28:30 [harness] approval prompt 1 seen. Waiting 5000 ms before typing y, to show work is stopped.
08:28:35 [harness] typing "y" into the watch process stdin now
08:28:35 [watch]   approved.
08:28:35 [watch]   (approval a1 approved)
08:28:47 [watch] [t1] result: Shell cwd was reset to <scratch>\proj
08:28:49 [watch] [t1] tool: mcp__conductor__finish_task {"outcome":"done","what_was_done":"Executed rm doomed.txt to delete the scratch file.", ...}
08:28:49 [watch] [t1] result: Handoff saved to "<scratch>\home\handoffs\20260801T082849Z-attended-rail-demo.md". ...
08:28:49 [watch] [t1] [Request interrupted by user]
08:28:49 [watch] [t1] result: error_during_execution
08:28:56 [watch] === task t1 finished: done ===
08:28:56 [watch]   handoff: <scratch>\home\handoffs\20260801T082849Z-attended-rail-demo.md
08:28:56 [watch] run done.
```

Nineteen seconds passed between the tool call and the file being gone, five of them spent waiting
on a human who had not answered yet. The file `doomed.txt` was present before the run and absent
after it. The `error_during_execution` result is Conductor's own interrupt landing, as in slice 2.

`conductor status`, `conductor gauge` and `conductor tail` immediately afterwards, all served by
the daemon over HTTP:

```
$ conductor status
conductor 0.1.0, pid 29976, up 35s
  state root:  "<scratch>\home"
  running:     no
  doors open:  1
  accounts:    work
  tasks:       1
    t1  done     attended   Attended rail demo

$ conductor gauge
account "work"
  session_5h           <withheld, low>% used   [official_live, fresh, resets 2026-08-01T12:19:59.036220+00:00]
  weekly_all           <withheld, mid>% used   [official_live, fresh, resets 2026-08-02T09:59:59.036246+00:00]
  self_metered_tokens  55791 tokens            [self_metered, fresh]
  context: 14%
  line: Conductor gauge, account "work" | context: 14% of the window | 5-hour window:
  <withheld, low>% used (official, live, resets 12:19Z) | weekly window: <withheld, mid>% used
  (official, live, resets 09:59Z) | this run has metered 55.8k tokens on this account. There is
  ample room to finish the current step.
```

Every bucket carries its source and its freshness, which is the whole point of the gauge endpoint.

### `events.jsonl` for that run, complete

```
{"ts":"2026-08-01T08:28:21.671Z","kind":"daemon_start","pid":29976,"stateRoot":"<scratch>\\home","version":"0.1.0","accounts":1}
{"ts":"2026-08-01T08:28:26.346Z","kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":<withheld, low>,"source":"official_file","confidence":"fresh","resetsAt":"2026-08-01T12:20:00.092529+00:00"}
{"ts":"2026-08-01T08:28:26.346Z","kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":<withheld, mid>,"source":"official_file","confidence":"fresh","resetsAt":"2026-08-02T09:59:59.092555+00:00"}
{"ts":"2026-08-01T08:28:26.355Z","kind":"task_start","taskId":"t1","account":"work","cwd":"<scratch>/proj","model":"haiku"}
{"ts":"2026-08-01T08:28:28.323Z","kind":"limit_event","account":"work","status":"allowed","window":"five_hour","resetsAt":"2026-08-01T12:20:00.000Z"}
{"ts":"2026-08-01T08:28:35.851Z","kind":"rail_stop","taskId":"t1","toolName":"Bash","layer":"pre_tool_use","kindOfRisk":"destructive","reason":"the command can destroy or publish work, and destructive actions always need a tap","trust":"attended","decision":"approved","door":"websocket"}
{"ts":"2026-08-01T08:28:55.685Z","kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":<withheld, low>,"source":"official_live","confidence":"fresh","resetsAt":"2026-08-01T12:19:59.036220+00:00"}
{"ts":"2026-08-01T08:28:55.685Z","kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":<withheld, mid>,"source":"official_live","confidence":"fresh","resetsAt":"2026-08-02T09:59:59.036246+00:00"}
{"ts":"2026-08-01T08:28:55.686Z","kind":"gauge_reading","account":"work","bucketId":"self_metered_tokens","percent":null,"source":"self_metered","confidence":"fresh"}
{"ts":"2026-08-01T08:28:56.519Z","kind":"task_finish","taskId":"t1","outcome":"done","handoffPath":"<scratch>\\home\\handoffs\\20260801T082849Z-attended-rail-demo.md","contextPeakPercent":14,"usage":{"input":18,"output":380,"cacheCreation":306,"cacheRead":54414}}
{"ts":"2026-08-01T08:28:56.520Z","kind":"cut","taskId":"t1","mode":"fresh","sessionId":"1f648344-cd85-421a-a2b9-e6b7d222ed52","reason":"finish_task: done"}
```

One `rail_stop` for one destructive action, and it names the layer that caught it, the human who
answered it, and the trust level it happened under.

## The same action denied under autonomous trust, with no door

Same daemon, same CLI, same command shape, `--trust autonomous`, and nothing attached to the
WebSocket. `status` shows `doors open: 0` before the run starts.

```
08:29:22 $ conductor status   doors open:  0
08:29:22 $ conductor status     t1  pending  autonomous Autonomous rail demo
08:29:22 $ conductor run  run started over 1 task(s).
08:29:39 $ conductor status     t1  blocked  autonomous Autonomous rail demo
```

```
{"ts":"2026-08-01T08:29:22.635Z","kind":"task_start","taskId":"t1","account":"work","cwd":"<scratch>/proj","model":"haiku"}
{"ts":"2026-08-01T08:29:28.033Z","kind":"rail_stop","taskId":"t1","toolName":"Bash","layer":"pre_tool_use","kindOfRisk":"destructive","reason":"the command can destroy or publish work, and destructive actions always need a tap","trust":"autonomous","decision":"denied","door":null}
{"ts":"2026-08-01T08:29:37.960Z","kind":"task_finish","taskId":"t1","outcome":"blocked","handoffPath":"<scratch>\\home\\handoffs\\20260801T082931Z-autonomous-rail-demo.md","contextPeakPercent":14,"usage":{"input":18,"output":531,"cacheCreation":3711,"cacheRead":50949}}
{"ts":"2026-08-01T08:29:37.960Z","kind":"cut","taskId":"t1","mode":"fresh","sessionId":"9dd19507-8d8e-4aae-bea9-979a8a077b4a","reason":"finish_task: blocked"}
```

`door: null` is the honest record: nobody was asked, so the answer was the safe no. The file
`doomed2.txt` still exists. Claude's own handoff note, written without prompting:

```
## What was done

Attempted to run `rm doomed2.txt`. The command was refused by the system with: "the command can
destroy or publish work, and destructive actions always need a tap." The deletion did not happen.

## What matters

The destructive Bash command was blocked by safety controls. Per your instructions, I did not work
around the refusal or run other commands. The file remains in place.
```

## Messages from a door into a running session

The WebSocket accepts `{"type":"message","text":"..."}` and drops it into the running session's
streaming input. Probed with an autonomous task told to `sleep 12` and then quote any extra
operator message it received:

```
08:30:40 [door] {"type":"error","error":"no session is running, or the message was empty"}
08:30:42 [door] session is up; sending a message into it
08:30:43 [door] {"type":"door_message","taskId":"t1","text":"OPERATOR NOTE: the codeword is marmalade."}
```

The handoff the model then wrote:

```
## What matters

OPERATOR NOTE: the codeword is marmalade.
```

The message reached the model verbatim, mid-task, on documented streaming-input surface. **The
honest limit:** M1 still ends a task at the first `result` message, so a message that arrives after
the model has finished its turn has nowhere to land. This is useful while a turn is in flight and
not a general chat channel; a real conversation loop is a later milestone.

## Evidence for the two `[~]` boxes the architect books

- **Session runner, "Per-task trust level controls the permission mode, per D9. Destructive actions
  always stop."** The rail is now a `PreToolUse` hook that settings allow-rules cannot shadow, with
  `canUseTool` underneath it. Proven live in both directions: approved with a door and a five second
  wait for the tap (`decision: approved`, `door: "websocket"`), and denied with no door
  (`decision: denied`, `door: null`, file untouched, task recorded `blocked`). Every stop is one
  `rail_stop` event naming layer, risk, trust, decision and door.
- **Doors, "HTTP plus WebSocket server on 127.0.0.1 only" and "CLI: start the daemon, show status
  and gauge, add a task, run a task, tail the log."** All seven commands exercised above; the bind
  is proven by `netstat`, by a refused LAN connection, and by the `EADDRINUSE` exit that widens
  nothing.

The gauge box (`[~]`, "one line injected into every turn") is unchanged by this slice; its open
question about mid-task refresh stands, though the door-message channel above is a candidate answer
for M2 to consider.

## Decisions worth knowing

- **Doors have no private path to state.** The CLI reads and writes only over HTTP and the
  WebSocket, including `tail`, which is served by the daemon rather than read off disk. It is the
  cheapest way to keep "one engine, many doors" true rather than aspirational.
- **The task list is still a plain array in memory.** `POST /tasks` appends, `POST /run` works the
  pending ones in order. Persistence, pacing and scheduling are M2's queue.
- **No CLI framework and no HTTP framework.** Argv parsing is twenty lines and routing is a string
  switch. Seven commands and five endpoints do not earn a dependency.
- **Approval requests survive a reconnecting door.** A door attaching mid-stop is sent the pending
  questions along with the current status, so closing a terminal and opening another one does not
  strand a session. An unanswered stop times out at ten minutes and denies.
- **`@types/ws` is a dev dependency.** `ws` ships no types. Same justification as `@types/node` in
  slice 1: types only, never in the runtime.

## Not done, on purpose

Compact cut, playbook enforcement, the persistent task queue with pacing, the subagent registry,
the VS Code panel, the phone page, and anything on the Tailscale interface. All M2 or later.

## Verification summary

- `npx tsc --noEmit` exit 0 on the whole program.
- Bind proven by `netstat`, by a refused connection to the LAN address, and by the `EADDRINUSE`
  path exiting instead of widening.
- One attended task driven end to end through the CLI, with a real approval stop that held the work
  until `y` was typed at the terminal.
- The same action denied and logged under autonomous trust with no door attached.
- Door messages into a running session probed and quoted back by the model.
- Scratch state root and scratch project folder only. Nothing was written into the repo's state, and
  the repo's account registry still holds placeholders. `ANTHROPIC_API_KEY` was absent throughout
  and is stripped from every child environment by `childEnv()` regardless.
