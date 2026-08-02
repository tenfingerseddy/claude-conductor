# M2 slice L, lost time: build and verification

Built 2026-08-02 on `feat/m2-lost-time`. Kane's dictated ask: if Conductor slows or pauses because
of subscription limits, that has to be measurable, because the number is the argument for adding
another account.

## What landed

- `src/state/playbook.ts`. `readPauseThreshold` parses `pause threshold: N%` leniently and falls
  back to 95 on anything it cannot read, including a number outside 1 to 100. The seeded playbook
  now carries the line, so a fresh state root has the rule written down where Claude reads it.
- `src/engine/gauge.ts`. Three small additions: `extra_usage.is_enabled` is read from the file layer
  as `boolean | null` (null when the file will not say, per S4's two different account shapes);
  `readingFor` and `refreshFile` let a caller outside the gauge look and look again; and
  `usableForPause` is the three-part test for whether a reading is solid enough to idle on.
- `src/state/logbook.ts`. `limit_pause`, `limit_resume`, `limit_reading_unusable`.
- `src/main.ts`. `pauseForLimits`, called before the workspace is created and before a token is
  spent, plus a process-wide registry so a daemon stop closes any open pause as interrupted.
- `src/server/http.ts`. `paused` on `/status`, `limit_pause` and `limit_resume` broadcast to every
  door, and `GET /lost-time?days=N` doing the aggregation.
- `src/cli.ts`. `conductor lost-time [--days N]`, the pause sentence in `status`, the pause and
  resume lines in `watch`.

## Design calls worth recording

**The threshold default is a ladder rung, not a guess.** The gauge already had
`WINDOW_CHECKPOINT_PERCENT` at 70, where the playbook drops subagents to a cheaper model, and the
seeded hard rail at 85, where Fable work stops starting. The pause is the last thing before the
account either stops or starts spending, so 95 is where it sits. Anything lower would idle a tank
the earlier rungs already protect.

**The binding window is the one that clears last.** When both windows are over the threshold,
waiting out the earlier reset leaves the later one still blocking, so the pause names and waits for
the later one. That is also the honest number to report: it is when work can actually resume.

**Not pausing is the safe direction.** A pause on a reading that cannot say when it ends is not a
pause, it is an indefinite stop. Absent, stale by `fetchedAtMs`, or expired by its own `resets_at`
all produce `limit_reading_unusable` and the task starts. The cost of being wrong that way is one
wasted session start. The cost of being wrong the other way is hours of a working machine doing
nothing, which is the failure this project already met by hand on 2026-08-01.

**Three rounds and then start anyway.** Every round after the first is the account telling us a
window we just waited out is still full. At that point the honest reading is that we do not
understand the numbers, not that we should keep waiting. A round that comes back with a reset time
no later than the one already waited out is refused on the same grounds.

**Aggregation lives in the daemon, not the CLI.** The phone page and the VS Code panel have to get
the same figures, and three implementations of "what counts as recoverable" would drift.

## Verification

Everything below ran through the real daemon and the real CLI against a scratch `CONDUCTOR_HOME`
with two synthetic account directories. Real window resets cannot be waited for, so the readings
are synthetic: a `.claude.json` holding a `cachedUsageUtilization` block with the field names S2
documented, written by `reading.mjs` with a `resets_at` about 90 seconds out. That is the file-read
path, layer 3 of the gauge, exercised exactly as it is in production. The live probe path is not
exercised, because it needs a running session on a real login, and it feeds the same `Reading`
shape that `usableForPause` tests.

The synthetic accounts hold no login, so a task that starts fails at authentication rather than
doing work. That is stated rather than hidden: what these runs prove is the pause, the measurement
and the report, and the loop reaching the point of starting a session. No plan usage was spent.

### Setup

Two synthetic account directories `main` and `other`, a scratch git repo, a scratch state root
short enough to clear the isolation path-length guard, and the daemon on port 7792. The seeded
playbook carried the new line at `playbook.md:29`:

```
- pause threshold: 95%. At or above this on the window that is binding, no new task starts; the
```

### A. A queued task does not start, then starts after the reset

`main` written at 97% of its 5-hour window with `resets_at` 90 seconds out, `other` at 12% and 20%.
`conductor run`, with `conductor watch` attached:

```
run started over 1 task(s)

--- Paused: task t1 has not started. Account "main" is at 97% of its 5-hour window and that is at
    or above the 95% pause threshold. Waiting until that window resets at 2026-08-02T01:20:49.896Z,
    then starting. It is the only task waiting.
    Ctrl+C still works, and "conductor stop" ends the wait and logs what it cost.
```

`conductor status` at the same moment:

```
  running:     yes, task null
  paused:      Paused: task t1 has not started. Account "main" is at 97% of its 5-hour window and
               that is at or above the 95% pause threshold. Waiting until that window resets at
               2026-08-02T01:20:49.896Z, then starting. It is the only task waiting.
```

The logbook line, with the other account's tanks captured at pause start:

```json
{"ts":"2026-08-02T01:19:20.245Z","kind":"limit_pause","account":"main","window":"session_5h",
 "utilization":97,"resetsAt":"2026-08-02T01:20:49.896Z","threshold":95,"reason":"threshold",
 "tasksWaiting":1,"otherAccounts":[{"account":"other","fiveHour":12,"weekly":20}]}
```

The account's file was rewritten to 8% partway through the wait, standing in for the window rolling
over. At the reset plus the 60-second grace the wait ended and the task started for real:

```json
{"ts":"2026-08-02T01:21:49.904Z","kind":"limit_resume","account":"main","lostMs":149660,
 "plannedMs":149652,"interrupted":false}
{"ts":"2026-08-02T01:21:50.261Z","kind":"task_start","taskId":"t1","account":"main",
 "workdir":"...\\lt\\home\\workspaces\\t1","branch":"conductor/task-t1",
 "model":"claude-haiku-4-5-20251001"}
```

`lostMs` 149660 against `plannedMs` 149652, eight milliseconds apart. The watch stream showed the
copy being made and the session opening:

```
--- the wait is over; starting the task.

=== task t1 started: Say hello and call finish_task. (main, attended) ===
task t1 runs in its own copy of "...\lt\proj", not in that folder itself.
  branch: conductor/task-t1
  from:   7a6b2fe7c816 on refs/heads/main
[t1] session d87dd4f8-0e4f-4102-a285-c5aae8a0bc36 on claude-haiku-4-5-20251001
[t1] Not logged in · Please run /login
```

"Not logged in" is the synthetic account having no credential, and it is the proof the task started:
the workspace was created, the branch cut, and the SDK session opened on the chosen model.

### B and C. An unusable reading does not pause

Same 97% reading, twice, each failing a different freshness test. Neither paused; both tasks ran
straight through to the same session start.

Stale by `fetchedAtMs`, 100 minutes old, reset still in the future:

```json
{"ts":"2026-08-02T01:23:41.220Z","kind":"limit_reading_unusable","account":"main","taskId":"t1",
 "reason":"the 5-hour window reads 97% but the reading is stale from official_file, so it cannot
 say when a pause would end. Starting the task rather than idling on a guess."}
```

Freshly fetched but describing a window that has already reset, the second freshness test from the
decisions log:

```json
{"ts":"2026-08-02T01:24:07.960Z","kind":"limit_reading_unusable","account":"main","taskId":"t2",
 "reason":"the 5-hour window reads 97% but its reset time 2026-08-02T01:22:07.363Z has already
 passed, leaving it describing a window that is gone, so it cannot say when a pause would end.
 Starting the task rather than idling on a guess."}
```

**A defect the first run of B caught and the code now fixes.** The original message appended "and
its reset time X has passed" to every unusable reading, so the stale case printed a claim that was
simply false: that reset time was an hour in the future. A log line that invents a failing test is
the same class of small lie the gauge's own labels exist to prevent, so the wording is now built
from the tests the reading actually failed and no others. Both transcripts above are from after the
fix.

### D. The paid-credit boundary, with two tasks behind it

`main` at 100% with `extra_usage.is_enabled: true`, `other` at 99% and 97%, two tasks queued:

```json
{"ts":"2026-08-02T01:24:52.759Z","kind":"limit_pause","account":"main","window":"session_5h",
 "utilization":100,"resetsAt":"2026-08-02T01:28:51.735Z","threshold":95,
 "reason":"paid_credit_boundary","tasksWaiting":2,
 "otherAccounts":[{"account":"other","fiveHour":99,"weekly":97}]}
```

The sentence, after a second wording fix that removed a doubled "and":

```
Paused: task t1 has not started. Account "main" is at 100% of its 5-hour window and that is the
plan limit, which this account does not stop at: extra-usage credits are enabled, so more work
would spend real money. Waiting until that window resets at 2026-08-02T01:33:41.496Z, then
starting. It is the only task waiting.
```

### E. A daemon stop mid-pause

`conductor stop` while the pause above was running:

```
conductor: 1 limit pause(s) ended early by the stop; each is logged as interrupted.
```

```json
{"ts":"2026-08-02T01:25:13.558Z","kind":"limit_resume","account":"main","lostMs":20800,
 "plannedMs":298977,"interrupted":true}
{"ts":"2026-08-02T01:25:13.559Z","kind":"daemon_stop","pid":36084,"reason":"stop endpoint"}
{"ts":"2026-08-02T01:25:13.560Z","kind":"task_finish","taskId":"t1","outcome":"blocked"}
```

The resume lands before `daemon_stop`, the interrupted task is recorded as blocked rather than as
having run, and the second queued task was not started.

### F. A pause with no end at all

The daemon was killed with `taskkill /F`, so no shutdown handler ran and no resume was written. The
report counts that pause and lists it, and gives it no duration.

### G. The report, reconciled by hand

```
lost time to usage limits, last 7 day(s), since 2026-07-26T01:29:02.033Z

  account        pauses       lost    longest  recoverable
  main                4      3m 4s     2m 30s       2m 30s
  total               4      3m 4s     2m 30s       2m 30s

  1 pause(s) have no recorded end, so their length is unknown and is not in the totals:
    main at 2026-08-02T01:25:56.933Z, session_5h window, threshold

  Recoverable time is time lost while another account's reading showed room under the same
  threshold. Those readings are taken from each account's file at the moment the pause started, and
  that file can be stale, so treat the recoverable share as an indication rather than a
  measurement. Pauses with no recorded end are counted and listed but contribute no time, because
  their length is unknown and guessing it would inflate the figure this report exists to be trusted
  on.
```

Checked against the raw lines rather than trusted:

- Four `limit_pause` lines in the period, three with a matching resume and one without. Count 4.
- 149660 + 20800 + 13564 = 184024 ms = 184.0 s = 3m 4s. Matches.
- Longest matched pause 149660 ms = 2m 30s. Matches.
- Recoverable: only the first pause had another account under the threshold on both windows
  (12% and 20% against 95). The other two matched pauses saw `other` at 99% and 97%, which is not
  headroom. 149660 ms = 2m 30s. Matches.
- `conductor lost-time --days 0.0002` narrowed the window to 17 seconds and correctly printed
  "no pauses recorded in this period".

### H. Nothing else moved

- `npx tsc --noEmit` clean, run behind an `ls node_modules/typescript/bin/tsc` guard so a missing
  install fails the command instead of silently passing (the M2 slice A process lesson).
- `node spikes/isolation/verify.ts` re-run whole and untouched: **ALL CHECKS PASSED**.
- The scratch state root, both synthetic account directories and the scratch repo were removed.
  `git status --short` shows only the eight intended files.

## What is not covered

- No real window reset was waited out. The timing is proven against a synthetic `resets_at`, and
  the arithmetic is the same either way, but the account's own behaviour at a real reset is not
  something these runs touch.
- The paid-credit reason is exercised with a synthetic `is_enabled: true` at 100%. The real hazard
  on Kane's work account is the one S4 found; nothing here spent money to confirm it.
- A weekly-window pause would wait days. That is what the design says to do and it is what the
  numbers would then measure, but it has never run, and a human watching a multi-day wait would
  reasonably stop it. Slice D, which decides what runs when rather than only whether to wait, is
  where that gets a better answer than a long sleep.
- `otherAccounts` covers usable accounts, not every configured one. A placeholder account has no
  readable file, so including it would add a row of nulls to every pause line and nothing else.
