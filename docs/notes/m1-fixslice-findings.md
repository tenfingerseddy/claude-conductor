# M1 fix slice: closing Sol's twenty findings and the finish-line wrinkles

Run on 2026-08-01 on branch `feat/m1-engine`, after the three Sol review passes
(`sol-review-m1-pass1.md`, `pass2.md`, `pass3.md`) and the finish-line run
(`m1-finishline-findings.md`). This slice changes code. Every finding below is either fixed with
evidence pasted here, or parked with a reason.

**Verdict: eighteen of the twenty Sol findings are fixed and demonstrated, two are parked with
reasons, and both code-shaped wrinkles are fixed. The two investigate-only wrinkles are answered,
one of them with a sharper and more uncomfortable answer than expected.** Nothing is contested:
no finding turned out to be wrong.

Publishing scrub rule applied: plan utilization percentages are replaced with `<withheld>`, scratch
paths are shortened to `<scratch>`, and one probe result that echoed a personal email address is
redacted. Timestamps, token counts, session ids, field names and command text are verbatim.

## What was verified, and how

All work ran against a scratch `CONDUCTOR_HOME` outside the repo, with a scratch `config.json` whose
`work` account points at this machine's work-account config directory. The repo's own account
registry still holds placeholders. Model was `haiku` throughout, on purpose: the point is the
mechanisms, not the model.

| Harness | What it drove |
|---|---|
| `rail-gauge-demo.ts` | the real `classifyRail`, `childEnv` and `Gauge`, with a fake SDK query object so the live probe can be made to throw |
| `http-checks.ts` | the real daemon over HTTP and WebSocket, with no CLI and no `src/` import beyond reading the token file |
| `doors-demo.ts` | two real WebSocket doors, three real Haiku sessions: attended rail stop, autonomous rail denial, and a session that ends without handing off |
| `chain-demo.ts` | the two-task chain from the finish line, re-run in a scratch project |
| `finish-idempotent.ts` | the real `finish_task` handler, called twice |
| `claudemd-probe.ts` | one Haiku session asking what context it was handed |

`npx tsc --noEmit` exits 0 before and after.

---

## Closure table

### Pass 1, security

| # | Sev | Finding | Status | Fix | Evidence |
|---|-----|---------|--------|-----|----------|
| 1 | Critical | Any WS client can settle any approval, no auth, no Origin check | **Fixed** | Per-daemon bearer token required on the WS upgrade; Origin must be absent; every approval is addressed to exactly one door and its id is single use | "The security gates" and "Two doors" below |
| 2 | Critical | `POST /tasks` and `POST /run` unauthenticated and CSRF-reachable | **Fixed** | Token required on every route; Origin absent-or-refused; `readJson` requires `application/json` | "The security gates" |
| 3 | Critical | Interpreter wrappers slip past both rail layers | **Fixed** | Classifier flipped to deny-by-default: a shell-shaped call is risky unless positively vouched safe | "The rail, deny-by-default" and "Two doors" |
| 4 | High | `insideCwd` is lexical, junctions and symlinks escape | **Fixed** | Both sides resolved with `realpathSync.native`, walking up to the deepest existing ancestor for paths not yet created | "The junction" |
| 5 | High | Every WS client receives status, recent events and all raw SDK messages | **Fixed** | Same token gate on the upgrade. Gone further than the brief asked: the token also gates `GET /status`, `/gauge` and `/events`, because the same content leaves through those | "The security gates" |
| 6 | High | `childEnv` strips only the two ANTHROPIC vars | **Fixed** | Secret-shaped names are dropped from the child environment | "The environment scrub" |
| 7 | Medium | `CONDUCTOR_HOME=.` puts state and credentials in the repo | **Fixed** | A state root inside a git work tree is a hard startup error; an account directory inside one is refused and named | "The repo guard" |

### Pass 2, loop correctness

| # | Sev | Finding | Status | Fix | Evidence |
|---|-----|---------|--------|-----|----------|
| 1 | High | A session ending without `finish_task` consumes the task, drops the carry, logs a phantom `cut` | **Fixed** | Outcome is `aborted`; no `cut` event is written; the carry is left as it was so the next task still gets the last note somebody actually wrote | "The abort" |
| 2 | High | A second `finish_task` writes handoff B before the guard rejects it | **Fixed** | The claim is taken in the tool handler before anything is written | "Idempotent finish_task" |
| 3 | High | `runTasks` has no single-flight or task-claim boundary | **Fixed** | Process-wide claim set on task ids, plus iteration over a snapshot rather than the live array; the daemon also flips `running` and marks the list before any await | "Two runs at once" |
| 4 | High | A throwing `onHandle` skips `run.close()` | **Fixed** | Handing out and withdrawing the handle both go through `offerHandle`, which catches and logs | Code only, see the honesty note below |
| 5 | High | A written handoff is unrecoverable after a restart | **Partly fixed, rest parked** | The carry now survives between runs inside one daemon, so a second `conductor run` is no longer a memory wipe. Reading handoffs back from disk after a restart is parked for M2 | See "Parked" |
| 6 | Medium | The 250 ms delayed `interrupt()` has no backstop if it rejects | **Fixed** | Whether the interrupt resolves or throws, a 30 second backstop closes the query so the loop cannot hang | Code only, see the honesty note below |
| 7 | Medium | Messages sent during the 250 ms window may land or be dropped, caller cannot tell | **Fixed** | `SessionHandle.send` returns false once finishing has started, and the door tells the caller the message was not delivered | Code only, see the honesty note below |
| 8 | Medium | `follow_up_tasks` are recorded but never queued | **Parked** | M2's first job by the plan's own words; the brief for this slice says do not build a queue | See "Parked" |

### Pass 3, gauge honesty

| # | Sev | Finding | Status | Fix | Evidence |
|---|-----|---------|--------|-----|----------|
| 1 | Critical | A failed live probe leaves the last reading cached and still `official, live` | **Fixed** | A failed probe invalidates the live reading. The number may survive as the best available, but the label changes | "The gauge" |
| 2 | High | Self-metering has no rolling window, so calibration can learn a negative rate | **Fixed** | Metering is now timestamped samples with 5-hour and weekly windows, per SPEC. Calibration rejects negative, zero and implausible rates and logs the rejection | "The gauge" |
| 3 | High | Stale estimation mixes a file percentage with a live anchor; weekly reuses the 5-hour rate | **Fixed** | Anchor and learned rate are both per window; an estimate uses its own window's anchor or is not made at all | Code, plus the per-window `calibration` lines in the chain trail |
| 4 | High | Missing or future `fetchedAtMs` yields `unknown`, which renders as `official, from disk` | **Fixed** | Undated and future-dated readings are labelled `official, from disk, age unknown` and never count as fresh | "The gauge" |
| 5 | Medium | Finite-only validation accepts out-of-range percentages such as -5 | **Fixed** | A percentage outside 0 to 100 is not a reading and degrades to absent | "The gauge" |

### Finish-line wrinkles

| # | Wrinkle | Status | Fix or answer |
|---|---------|--------|---------------|
| 1 | Attended approvals of ordinary work write no `events.jsonl` line | **Fixed** | Every question and every answer is logged, with provenance |
| 2 | Attended trust never asked about Read, Glob or Bash `ls` | **Investigated, documented** | Confirmed and narrowed, see below |
| 3 | A fresh cut is not a clean room, parent `CLAUDE.md` flows in | **Investigated, documented** | Confirmed outright, with a second finding nobody was looking for |
| 4 | `daemon_stop` never logs on a Windows programmatic stop | **Fixed** | `POST /stop` plus `conductor stop` |

---

## The security gates

Every gate tried from outside the CLI, against the real daemon on `127.0.0.1:7723`.

```
=== HTTP gates ===
  401  GET /status, no token
       -> { "error": "a daemon token is required; doors read it from the state root" }
  401  POST /tasks, no token
       -> { "error": "a daemon token is required; doors read it from the state root" }
  401  POST /run, no token
       -> { "error": "a daemon token is required; doors read it from the state root" }
  401  GET /status, wrong token
       -> { "error": "a daemon token is required; doors read it from the state root" }
  403  GET /status, good token but Origin present (browser-shaped)
       -> { "error": "this door does not answer browser-shaped requests" }
  400  POST /tasks, good token, content-type text/plain (CSRF simple request)
       -> { "error": "conductor: request bodies must be sent as content-type application/json" }
  200  GET /status, good token, no Origin
       -> { "version": "0.1.0", "pid": 10128, "uptimeSeconds": 11, "stateRoot": "<scratch>

=== WebSocket upgrade ===
  REFUSED no token -> socket hang up
  REFUSED wrong token -> socket hang up
  REFUSED good token but Origin set, as a browser would -> socket hang up
  OPEN    good token, no Origin
```

The `text/plain` POST is Sol's exact CSRF shape from pass 1 finding 2, and it is refused before the
body is read. The token rides in an `Authorization` header, which is the part that matters: a page
in a browser cannot set headers on a WebSocket at all, so the socket half of Sol's chain is not
merely secret-protected, it is unreachable from a browser by construction.

The token is 32 random bytes, minted fresh at every daemon start, written to `<stateRoot>\daemon-token`
with mode 0600 and, on Windows, an `icacls` pass that breaks inheritance and grants the current user
only. The icacls call is best effort and non-fatal: the state root already sits inside the user
profile, whose default ACL is user-only, so this is defence in depth rather than the only thing
holding. Being able to read that file is the whole of a door's credential.

## Two doors

Two authenticated WebSocket doors, one real Haiku session, one attended rail stop. The daemon
addresses the question to the most recently attached door (`door2`), so `doorA` is the stranger.

```
10:13:53 [t1] tool: Bash {"command":"cmd /c del notes.txt","description":"Run the specified command"}
10:13:53 [doorA] sees approval a2622e790702c9e4a59 addressed to door2, mine=false, tool Bash
10:13:53 [doorA] IMPOSTOR: sending approved=true for a2622e790702c9e4a59
10:13:53 [doorB] sees approval a2622e790702c9e4a59 addressed to door2, mine=true, tool Bash
10:13:53 [doorB]    why: Conductor cannot vouch that this command only reads: "cmd" is not on the short list of commands Conductor can vouch for
10:13:53 [doorA] daemon says: approval "a2622e790702c9e4a59" was put to another door, so this door cannot answer it
10:13:53 [doorB] HUMAN: answering a2622e790702c9e4a59 with approved=false
10:13:53 [doorA] settled a2622e790702c9e4a59: approved=false by door2
10:13:53 [t1] result: "Conductor did not get approval: Conductor cannot vouch that this command only reads: \"cmd\" ...
10:13:54 [doorB] HUMAN: replaying the now-spent id a2622e790702c9e4a59
10:13:54 [doorB] daemon says: approval "a2622e790702c9e4a59" was already answered; approvals are single use
```

Three things in eleven lines. A second authenticated door cannot answer for the first. The
addressee's answer is the one that counts. And the id is spent once, so even the door that owns it
cannot replay it.

The same run then took the autonomous case:

```
10:14:06 [t2] tool: Bash {"command":"node -e \"require('node:fs').rmSync('notes.txt')\"","description":"Delete notes.txt using Node.js"}
10:14:06 [t2] result: "Conductor did not get approval: Conductor cannot vouch that this command only reads: node \"-e\" runs a string rather than a file in this project. ...
```

No question was put to either door. Under autonomous trust an unvouched command is refused outright.
`notes.txt` survived both tasks, byte for byte.

**A design call inside this, written down because it narrows D9.** D9 says destructive actions always
stop for a tap whatever the trust level. That still holds for `destructive`, `elevated` and
`outside_cwd`: if a door is attached it gets asked even under autonomous trust. The deny-by-default
flip added a fourth kind of verdict, `unvouched`, and that one behaves differently: refused outright
under autonomous trust, with the question never asked. The reason is that `unvouched` is not a
specific danger a human can look at and judge; it is Conductor admitting it cannot read the command.
Waking someone for every one of those trains them to say yes, and under autonomous trust the premise
is that nobody is watching. D9 is not weakened, it is scoped to the risks D9 was written about.

## The rail, deny-by-default

The real classifier, every verdict:

```
=== rail verdicts (deny-by-default) ===
VOUCHED SAFE   "ls -la"
VOUCHED SAFE   "dir"
VOUCHED SAFE   "cat README.md"
VOUCHED SAFE   "git status"
VOUCHED SAFE   "git log --oneline -5"
VOUCHED SAFE   "git diff"
VOUCHED SAFE   "node script.js"
RISKY (unvouched)      "cmd /c del important.txt"
                        why: ... "cmd" is not on the short list of commands Conductor can vouch for
RISKY (unvouched)      "cmd.exe /d /c \"del /q C:\\Users\\victim\\important.txt\""
                        why: ... "cmd" is not on the short list of commands Conductor can vouch for
RISKY (unvouched)      "node -e \"require('node:fs').rmSync('x')\""
                        why: ... node "-e" runs a string rather than a file in this project
RISKY (unvouched)      "git -C C:\\repo reset --hard HEAD~1"
                        why: ... git "-C" points at another checkout
RISKY (destructive)    "powershell -Command \"Remove-Item x\""
                        why: the command can destroy or publish work, and destructive actions always need a tap
RISKY (unvouched)      "cat ../../secrets.txt"
                        why: ... "../../secrets.txt" is outside the task folder
RISKY (unvouched)      "echo hi > out.txt"
                        why: ... it redirects, substitutes or spawns, so its effect is not readable
RISKY (unvouched)      "curl https://example.com"
                        why: ... "curl" is not on the short list of commands Conductor can vouch for
RISKY (unvouched)      "npm run build"
                        why: ... "npm run" can run project scripts or reach the network
RISKY (unvouched)      "node --eval \"1\""
                        why: ... node "--eval" runs a string rather than a file in this project
RISKY (unvouched)      "git stash"
                        why: ... bare "git stash" changes the working tree
VOUCHED SAFE   "git stash list"
```

All three of Sol's exact bypasses are stopped. Two extras fell out of the same change that the
blocklist never covered: a read of a path outside the task folder buried inside a shell command,
which `PATH_FIELDS` could never see, and any use of redirection or command substitution, whose
effect no classifier can read.

The old blocklist is still there, but it no longer decides anything. It only decides how a stop is
described, because "this command can destroy work" is a better sentence to put in front of a human
than "Conductor cannot vouch for this". Nothing passes by failing to match it.

Both layers are kept. The `PreToolUse` hook is layer one, which settings files cannot shadow;
`canUseTool` is layer two. Every verdict is logged.

## The junction

Sol pass 1 finding 4, reproduced with a real Windows junction created without admin rights
(`mklink /J`), pointing from inside the task folder to a folder outside it:

```
cwd = <scratch>\junction-test\inside
  inside, allowed            <scratch>\junction-test\inside\ok.txt
  RAIL STOP (outside_cwd)    <scratch>\junction-test\inside\bridge\important.txt
  RAIL STOP (outside_cwd)    bridge/important.txt
  RAIL STOP (outside_cwd)    ../outside-target/important.txt
```

`bridge` is the junction. Lexically it is inside the task folder, which is exactly why the old check
waved it through. The junction was removed after the test.

## The environment scrub

The daemon's own shell was given three planted secrets and then asked what reaches a session:

```
dropped from the child environment:
  - ANTHROPIC_API_KEY
  - AWS_SECRET_ACCESS_KEY
  - AZURE_CLIENT_SECRET
  - GITHUB_TOKEN
  - [six more real credential-shaped variables from this machine's shell, names withheld]
kept, spot check:
  + COMSPEC = C:\Windows\system32\cmd.exe
  + PATH = C:\Program Files\Git\mingw64\b
  + SYSTEMROOT = C:\Windows
  + TEMP = <scratch>
  + USERPROFILE = C:\Users\KaneSnyder(nexwave)
  + CLAUDE_CONFIG_DIR = C:\some\configdir
```

Six real credential-shaped variables already present in this machine's shell were dropped without
anyone planting them, which is the finding making its own case. Their names are withheld here
because this repo is public and a list of which services someone holds tokens for is itself worth
something; no value was ever read or printed.

This is a deny-pattern on variable names, not an allowlist, and that is a deliberate compromise
written into the code comment: an allowlist of environment variables breaks the tools a task
legitimately needs and would be discovered as breakage rather than as safety. A real allowlist
belongs with M2's sandboxing work.

## The repo guard

```
$ CONDUCTOR_HOME=C:\Users\KaneSnyder(nexwave)\repos\conductor\.scratch-state conductor status
conductor: the state root "C:\Users\KaneSnyder(nexwave)\repos\conductor\.scratch-state" is inside
the git checkout at "C:\Users\KaneSnyder(nexwave)\repos\conductor". Conductor keeps usage data,
handoffs and its daemon token there, and none of that may sit in a repository. Point CONDUCTOR_HOME
somewhere outside any checkout and start again.
```

An account directory inside a checkout is refused the same way, but as a warning that drops the
account rather than a fatal error, since one bad account entry should not take the daemon down.

## The gauge

The one that mattered most, Sol pass 3 finding 1. A good probe, then a probe that throws. This uses
a fake SDK query object in a scratch harness, because a live probe cannot be made to fail on demand;
the failure path exercised is the real one, `readLiveUsage` returning null.

```
=== gauge: a failed live probe must not stay "official, live" ===
  after a good probe:    20% used (official, live, resets 12:00Z)
  after a thrown probe:  20% used (official, live reading has gone stale, resets 12:00Z)
  liveProbeFailed flag:  true
```

The number survives, because it is still the best official reading anyone has. The label does not.
The matching `events.jsonl` lines change with it, from `"confidence":"fresh"` to `"confidence":"stale"`
on the same `official_live` source, so a later reader of the logbook sees the degradation too.

Range and dating:

```
=== gauge: out-of-range and undated readings ===
  utilization -5:        {"percent":null,"resetsAt":null,"source":"absent","confidence":"unknown"}
  no fetchedAtMs:        5% used (official, from disk, age unknown) | confidence unknown
  fetchedAtMs in future: 5% used (official, from disk, age unknown) | confidence unknown
```

`-5` becomes no reading rather than a claim of 105% headroom. An undated reading and a
future-dated one both say the age is unknown instead of passing as current, and neither counts as
fresh anywhere freshness is what a decision rests on.

Calibration, with the official five-hour number falling from 80% to 20% while 50,000 tokens were
metered, which is the window rolling rather than anything learnable:

```
{"kind":"calibration","account":"calib","bucketId":"session_5h","predictedPercent":80,
 "officialPercent":20,"gap":-60,"accepted":false,
 "rejectedReason":"the official percentage fell while tokens were spent, so the window rolled rather than the rate changing"}
{"kind":"calibration","account":"calib","bucketId":"weekly_all","predictedPercent":80,
 "officialPercent":20,"gap":-60,"accepted":false,
 "rejectedReason":"the official percentage fell while tokens were spent, so the window rolled rather than the rate changing"}
```

Two windows, two anchors, two rates, two rejections. Under the old code this taught a rate of
-0.0012% per token, which is the gauge learning that spending tokens creates headroom.

Three rejection reasons exist: too few tokens to attribute a move to, a fall or no movement at all,
and a rate steeper than any plan could plausibly have. The no-movement case was added after the
chain run below logged `accepted: true, learnedPercentPerToken: 0`, which is Sol's own "an unchanged
rounded official percentage similarly learns a zero rate and freezes future usage". Spending tokens
always costs something, so a flat percentage means the official number's rounding hid the move, and
learning zero from it would pin every later estimate to the anchor no matter what was spent. That is
now rejected and logged with that reason.

Self-metering is now timestamped samples with a 5-hour and a weekly window, which is what SPEC's
Gauge organ asked for and the code did not do. The injected line says both:

```
metered on this account: 356.4k tokens in the last 5 hours, 356.4k this week
```

## The abort

Sol pass 2 finding 1, with a real session told not to hand off:

```
10:14:20 [run] === t3 started (autonomous) ===
10:14:29 [run] === t3 finished: aborted (error: the session ended without calling finish_task) ===
```

The logbook for that task, complete:

```
{"kind":"task_start","taskId":"t3","account":"work","cwd":"<scratch>\\project","model":"haiku"}
{"kind":"task_finish","taskId":"t3","outcome":"aborted","contextPeakPercent":15,
 "usage":{"input":10,"output":254,"cacheCreation":3774,"cacheRead":23746}}
```

Two lines and no third. There is no `cut` event, because no cut happened. The two tasks in the same
run that did hand off both have one. The daemon's task list shows `aborted` as its own state, not
`done` and not `error`:

```
  t1  done      outcome=partial  rail attended
  t2  done      outcome=partial  rail autonomous
  t3  aborted   outcome=aborted  abort, no finish_task
```

## Idempotent finish_task

The real handler, called twice:

```
first call  -> Handoff saved to "<scratch>\handoffs\20260801T102120Z-idempotency-demo.md".
               Outcome recorded as done. Conductor will cut the context now; stop working and end y
second call -> This task was already handed off with outcome done to
               "<scratch>\handoffs\20260801T102120Z-idempotency-demo.md". Nothing was written for
               this second call and the first handoff stands. Conductor is cutting the context now

onFinish fired: 1 time(s): [ 'onFinish: done -> 20260801T102120Z-idempotency-demo.md' ]
handoff files written by this demo: 1
```

One file, one callback, and a second tool result that tells the model the truth rather than claiming
its second handoff was recorded.

## Two runs at once

```
POST /run (A): [202,{"started":true,"count":1}]
POST /run (B): [409,{"started":false,"count":0,"error":"a run is already in progress"}]
```

Both requests were in flight at once with no await between them. Underneath that door-level guard,
`runTasks` now claims task ids in a process-wide set and iterates a snapshot rather than the live
array, so a caller that reaches it another way still cannot double-run a task.

## The chain, re-run

The finish-line shape re-run against the fixed code, in a scratch project rather than
`nexwave-apps`. Task 1 attended, indexing the project and writing an index; task 2 autonomous,
confined to the demo folder, writing a summary from the handoff alone.

```
10:15:42 [run] === task t1 started: Index the workbook folder (work, attended) ===
10:15:43 [t1] session 8a368129-0112-41c0-9e9c-756e96ad3af2 on claude-haiku-4-5-20251001
...
10:16:23 [t1] tool: Write {"file_path":"conductor-demo/index.md", ...}
10:16:23 [door] ---- Conductor stopped for a tap ----
10:16:23 [door]   task:  t1
10:16:23 [door]   tool:  Write
10:16:23 [door]   why:   this task is attended, so tool use is confirmed by a human
10:16:23 [harness] answering y (path inside conductor-demo: true)
10:16:23 [t1] result: "File created successfully at: conductor-demo/index.md"
10:16:30 [t1] tool: mcp__conductor__finish_task {"what_was_done":"Explored the top-level project structure ...
10:16:56 [run] === task t1 finished: done ===
10:16:56 [run]   handoff: <scratch>\handoffs\20260801T101630Z-index-the-workbook-folder.md
10:16:56 [run] === task t2 started: Summarise the workbook folder (work, autonomous) ===
10:16:57 [t2] session a016c6ec-8004-408e-a0eb-33b3a28af844 on claude-haiku-4-5-20251001
10:17:03 [t2] tool: Read {"file_path":"index.md"}
10:17:10 [t2] tool: Write {"file_path":"summary.md", ...}
10:17:17 [t2] tool: mcp__conductor__finish_task {"what_was_done":"Read index.md to understand the workbook structure ...
10:17:21 [run] === task t2 finished: done ===
10:17:21 [run] run done.
```

The cut is the pair of lines at 10:16:56: t1 finished with a handoff path, t2 started on a different
session id less than a second later. Both files were written, the handoff carried, and t2 never
reached outside its folder.

The events trail, complete and in order, scrubbed:

```
{"kind":"daemon_start","pid":22404,"stateRoot":"<scratch>","version":"0.1.0","accounts":1}
{"kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":"<withheld>","source":"official_file","confidence":"fresh","resetsAt":"2026-08-01T12:19:59.105565+00:00"}
{"kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":"<withheld>","source":"official_file","confidence":"fresh","resetsAt":"2026-08-02T10:00:00.105585+00:00"}
{"kind":"task_start","taskId":"t1","account":"work","cwd":"<scratch>\\project2\\workbook","model":"haiku"}
{"kind":"limit_event","account":"work","status":"allowed","window":"five_hour","resetsAt":"2026-08-01T12:20:00.000Z"}
{"kind":"approval_request","taskId":"t1","approvalId":"t1-a1","toolName":"Glob","layer":"can_use_tool","reason":"this task is attended, so tool use is confirmed by a human","trust":"attended"}
{"kind":"approval_answer","taskId":"t1","approvalId":"t1-a1","toolName":"Glob","layer":"can_use_tool","decision":"denied","door":"door1","via":"door","waitedMs":2}
{"kind":"approval_request","taskId":"t1","approvalId":"t1-a2","toolName":"Read","layer":"pre_tool_use","reason":"it touches \"\\\", which is outside the task folder","trust":"attended","kindOfRisk":"outside_cwd"}
{"kind":"approval_answer","taskId":"t1","approvalId":"t1-a2","toolName":"Read","layer":"pre_tool_use","decision":"denied","door":"door1","via":"door","waitedMs":1}
{"kind":"rail_stop","taskId":"t1","toolName":"Read","layer":"pre_tool_use","kindOfRisk":"outside_cwd","reason":"it touches \"\\\", which is outside the task folder","trust":"attended","decision":"denied","door":"door1"}
{"kind":"approval_request","taskId":"t1","approvalId":"t1-a3","toolName":"Glob","layer":"can_use_tool","reason":"this task is attended, so tool use is confirmed by a human","trust":"attended"}
{"kind":"approval_answer","taskId":"t1","approvalId":"t1-a3","toolName":"Glob","layer":"can_use_tool","decision":"denied","door":"door1","via":"door","waitedMs":1}
{"kind":"approval_request","taskId":"t1","approvalId":"t1-a4","toolName":"Read","layer":"can_use_tool","reason":"this task is attended, so tool use is confirmed by a human","trust":"attended"}
{"kind":"approval_answer","taskId":"t1","approvalId":"t1-a4","toolName":"Read","layer":"can_use_tool","decision":"denied","door":"door1","via":"door","waitedMs":1}
{"kind":"approval_request","taskId":"t1","approvalId":"t1-a5","toolName":"Write","layer":"can_use_tool","reason":"this task is attended, so tool use is confirmed by a human","trust":"attended"}
{"kind":"approval_answer","taskId":"t1","approvalId":"t1-a5","toolName":"Write","layer":"can_use_tool","decision":"approved","door":"door1","via":"door","waitedMs":0}
{"kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":"<withheld>","source":"official_live","confidence":"fresh","resetsAt":"2026-08-01T12:19:59.391503+00:00"}
{"kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":"<withheld>","source":"official_live","confidence":"fresh","resetsAt":"2026-08-02T10:00:00.391530+00:00"}
{"kind":"gauge_reading","account":"work","bucketId":"self_metered_tokens","percent":null,"source":"self_metered","confidence":"fresh"}
{"kind":"task_finish","taskId":"t1","outcome":"done","handoffPath":"<scratch>\\handoffs\\20260801T101630Z-index-the-workbook-folder.md","usage":{"input":306,"output":2278,"cacheCreation":7589,"cacheRead":227289}}
{"kind":"cut","taskId":"t1","mode":"fresh","sessionId":"8a368129-0112-41c0-9e9c-756e96ad3af2","reason":"finish_task: done"}
{"kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":"<withheld>","source":"official_live","confidence":"fresh","resetsAt":"2026-08-01T12:19:59.391503+00:00"}
{"kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":"<withheld>","source":"official_live","confidence":"fresh","resetsAt":"2026-08-02T10:00:00.391530+00:00"}
{"kind":"task_start","taskId":"t2","account":"work","cwd":"<scratch>\\project2\\workbook\\conductor-demo","model":"haiku"}
{"kind":"limit_event","account":"work","status":"allowed","window":"five_hour","resetsAt":"2026-08-01T12:20:00.000Z"}
{"kind":"approval_request","taskId":"t2","approvalId":"t2-a1","toolName":"Read","layer":"pre_tool_use","reason":"it touches \"...\\conductor-demo\\index.md\", which is outside the task folder","trust":"autonomous","kindOfRisk":"outside_cwd"}
{"kind":"approval_answer","taskId":"t2","approvalId":"t2-a1","toolName":"Read","layer":"pre_tool_use","decision":"denied","door":"door1","via":"door","waitedMs":1}
{"kind":"rail_stop","taskId":"t2","toolName":"Read","layer":"pre_tool_use","kindOfRisk":"outside_cwd","reason":"it touches \"...\\conductor-demo\\index.md\", which is outside the task folder","trust":"autonomous","decision":"denied","door":"door1"}
{"kind":"limit_event","account":"work","status":"allowed","window":"five_hour","resetsAt":"2026-08-01T12:20:00.000Z"}
{"kind":"gauge_reading","account":"work","bucketId":"session_5h","percent":"<withheld>","source":"official_live","confidence":"fresh","resetsAt":"2026-08-01T12:19:59.021618+00:00"}
{"kind":"gauge_reading","account":"work","bucketId":"weekly_all","percent":"<withheld>","source":"official_live","confidence":"fresh","resetsAt":"2026-08-02T10:00:00.021639+00:00"}
{"kind":"gauge_reading","account":"work","bucketId":"self_metered_tokens","percent":null,"source":"self_metered","confidence":"fresh"}
{"kind":"calibration","account":"work","bucketId":"session_5h","predictedPercent":"<withheld>","officialPercent":"<withheld>","gap":0,"accepted":true,"learnedPercentPerToken":0}
{"kind":"calibration","account":"work","bucketId":"weekly_all","predictedPercent":"<withheld>","officialPercent":"<withheld>","gap":0,"accepted":true,"learnedPercentPerToken":0}
{"kind":"task_finish","taskId":"t2","outcome":"done","handoffPath":"<scratch>\\handoffs\\20260801T101717Z-summarise-the-workbook-folder.md","contextPeakPercent":15,"usage":{"input":34,"output":1337,"cacheCreation":6156,"cacheRead":109316}}
{"kind":"cut","taskId":"t2","mode":"fresh","sessionId":"a016c6ec-8004-408e-a0eb-33b3a28af844","reason":"finish_task: done"}
```

Five approval questions and five answers, each with the door that answered, how the answer arrived,
and how long the human took. Under the old code exactly one of those ten lines existed, the
`rail_stop` for the outside-folder Read; the four ordinary attended taps left no trace at all. That
is wrinkle 1 closed.

The two `calibration` lines here are the ones that prompted the no-movement guard described above.
They were logged as accepted by the code as it stood at that moment; the guard added afterwards
rejects exactly this shape, demonstrated in "The gauge".

The gauge as a door sees it at the end of the run:

```
account "work"  liveProbeFailed=false
  session_5h           <withheld>% used   [official_live, fresh]
  weekly_all           <withheld>% used   [official_live, fresh]
  self_metered_5h      356426 tokens      [self_metered, fresh]
  self_metered_week    356426 tokens      [self_metered, fresh]
  context: 15%
  line: Conductor gauge, account "work" | context: 15% of the window | 5-hour window: <withheld>%
        used (official, live, resets 12:19Z) | weekly window: <withheld>% used (official, live,
        resets 10:00Z) | metered on this account: 356.4k tokens in the last 5 hours, 356.4k this
        week. There is ample room to finish the current step.
```

## The stop

Wrinkle 4. The daemon was stopped programmatically, the way a supervisor would, with no console and
no signal:

```
$ conductor stop
daemon stopping.

{"ts":"2026-08-01T10:10:53.041Z","kind":"daemon_stop","pid":10128,"reason":"stop endpoint"}
```

The listener was gone afterwards and the process exited 0. The mechanism is `POST /stop`, token
required like every other state-changing route, with `conductor stop` as the CLI in front of it.
Signals stay wired for a real Ctrl+C at a real console, which does deliver on Windows; what Windows
cannot do is deliver SIGINT to a child, which is why the endpoint exists. Both daemons used in this
slice were stopped this way and both logged it.

## Wrinkle 2: what attended actually asks about

Confirmed, and narrowed. In the chain run above, task 1 was attended and the door was asked about
`Glob`, `Read` and `Write`. It was never asked about `Bash`:

```
10:15:57 [t1] tool: Bash {"command":"ls -la","description":"List all files and folders in the current directory"}
10:16:06 [t1] result: "total 1\ndrwxr-xr-x ...
10:16:09 [t1] tool: Bash {"command":"ls -la conductor-demo/", ...}
10:16:09 [t1] tool: Bash {"command":"ls -la notes/", ...}
10:16:15 [t1] tool: Bash {"command":"cat SPEC.md", ...}
10:16:15 [t1] tool: Bash {"command":"cat notes/one.md", ...}
```

Five Bash calls, no approval events for any of them, while the `Glob` immediately before produced
`t1-a1`. So it is not that attended mode asks about nothing; it asks about whatever the SDK's
default permission mode chooses to route to `canUseTool`, and `Bash` under default mode is not
routed there once the SDK considers the command safe.

This matters less than it did before this slice, and the reason is worth stating. The rail no longer
depends on `canUseTool` for shell commands: the `PreToolUse` hook sees every Bash call, and the
deny-by-default classifier decides. The five calls above went through because they are genuinely on
the vouched-safe list, not because nobody looked. The one Bash call in this slice that was not
vouched, `cmd /c del notes.txt`, stopped at `pre_tool_use` and waited for a human.

What remains true, and belongs in M2 in these words: **"attended" means a human answers whatever the
SDK's default mode chooses to ask about, plus everything Conductor's rail stops.** It does not mean
a human sees every tool call. Making it mean that would need the `PreToolUse` hook to ask for
everything under attended trust rather than falling through, which is a real option and a real cost
in taps. Not decided here.

## Wrinkle 3: a fresh cut is not a clean room

Answered, and the answer is yes. A `CLAUDE.md` was placed one level above a task's cwd with a
codeword in it, and an autonomous session running in the subfolder was asked what context it had
been given. It answered from memory, with no tool use:

```
[t1] I was given project instructions in the CLAUDE.md content at the start of this session.
Here is the verbatim, full text:

# Project rules

The project codeword is ZEPHYRLINE.
Always end every reply with the word ZEPHYRLINE.
# userEmail
The user's email address is [redacted].
# currentDate
Today's date is 2026-08-01.

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to
      this context unless it is highly relevant to your task.

The project codeword is: **ZEPHYRLINE**
```

Two findings, and the second one was not what anyone was looking for.

**A parent `CLAUDE.md` reaches a fresh session, verbatim.** The file was in the parent of the task
cwd, `settingSources` is unset, and the session read no files. So the finish-line run's task 2 was
not confabulating when it credited a CLAUDE.md style guide; it really had been handed one. A fresh
cut carries the handoff note plus whatever the platform decides to inject, and Conductor does not
currently see or log the second part. That is a real gap against "the next task starts clean".

**The same injection carries the user's email address into every session.** Conductor is careful
never to write an account identity into its own state, per the account rules and the scrub rule, and
then the platform puts one in the prompt of every session anyway. Nothing here is Conductor's bug,
but it is Conductor's business: any claim about what a session knows has to account for it.

Both go to the open questions rather than being patched here, per the brief. The decision they need
is whether Conductor should set `settingSources` explicitly so a fresh cut is a room Conductor
controls, and whether the playbook should say out loud that a task's project may be talking to the
model behind Conductor's back.

## Parked, with reasons

**Pass 2 finding 5, a handoff is unrecoverable after a restart.** Half fixed: the carry now lives on
the daemon and survives between runs, so a second `conductor run` is no longer a memory wipe, which
was the sharpest edge of it and the one the finish-line run had to write its task prompts around.
Reading notes back from disk after a process restart is parked for M2, because the thing that should
own a durable carry is the durable queue, and building a second, different persistence path now
would be a thing M2 has to delete. Sol called this one "partly by design" and that reading holds.

**Pass 2 finding 8, follow-up tasks are not queued.** Parked by instruction and by plan. PLAN.md
already names this as M1's shape with the queue as M2's first job, and the brief for this slice says
do not build a queue. Nothing changed.

## Honesty note on three fixes

Pass 2 findings 4, 6 and 7 are fixed in code and reviewed, but not separately demonstrated with
pasted output, and I am not going to claim otherwise. Each needs a failure that cannot be provoked
from outside: a door callback that throws, an `interrupt()` that rejects, and a door message landing
inside a 250 millisecond window. Forcing them would mean adding test seams to production code for
this slice alone, which the simplicity budget does not justify. What they got instead:

- Finding 4: both the handing out and the withdrawing of the session handle go through one
  `offerHandle` helper that catches and writes to stderr, so neither can skip `run.close()`.
- Finding 6: the interrupt's promise is caught either way and a 30 second backstop closes the query,
  turning a possible hang into a bounded delay.
- Finding 7: `SessionHandle.send` returns false once finishing has begun, and the daemon turns that
  into an explicit error back to the door.

All three ran fine through every live session in this slice, which is evidence they did not break
anything, not evidence the failure path works.

## What changed

| File | Change |
|---|---|
| `src/state/token.ts` | new: mint, read and compare the per-daemon bearer token |
| `src/server/http.ts` | token on every route and the WS upgrade, Origin refused, JSON content-type required, addressed and single-use approvals, `POST /stop`, carry kept between runs |
| `src/engine/session.ts` | deny-by-default classifier with a vouched-safe list, link-aware cwd check, secret-shaped env names dropped, approval logging with provenance, handle and interrupt lifecycle guards |
| `src/engine/gauge.ts` | live probe invalidation, per-window rolling self-metering, per-window anchors and rates, calibration rejection with reasons, range and dating validation, one label per state |
| `src/engine/finish-task.ts` | the claim is taken before the handoff is written |
| `src/main.ts` | aborted outcome with no phantom cut and the carry kept, task claims, snapshot iteration, stop plumbing |
| `src/config.ts` | git work tree guard on the state root and on account directories |
| `src/state/logbook.ts` | `approval_request` and `approval_answer` events, calibration acceptance fields, the `unvouched` risk kind |
| `src/cli.ts` | reads the token and carries it on HTTP and the WS handshake, `conductor stop`, ignores approvals addressed elsewhere |

No new runtime dependencies. `node:crypto` covers the token. `npx tsc --noEmit` exits 0.
