# M2 slice L, lost time: fix round after Sol's accounting review

Sol blocked `322ed4c` on seven findings, all accepted in triage. Review record and raw output:
`docs/notes/sol-review-m2-losttime.md`. This file is the closure record: what changed, why, and the
run that proves each one. Files touched are the same box as the first round.

## The seven, and what closed each

**1. The retry ceiling ended by starting the task.** The worst of the seven and the only design
error among them. Three rounds of fresh at-limit readings fell out of the loop and ran the task, so
"never cross into paid credits without a human" was really "cross it on the fourth attempt". The
ceiling now ends in a refusal: the task is blocked with a logged reason, in exactly the shape the
trust gate and the account gate already use, and the loop moves to the next task rather than
breaking the run. A ceiling exists so Conductor stops waiting on numbers it cannot make sense of. It
was never a grant of passage, and the fix is to make the code say what the design meant.

**2. Recoverable time rested on evidence the gauge would have refused.** A week-old file reading 0%
counted as headroom, so a six-hour hold became six recoverable hours on the weakest evidence in the
feature backing its strongest claim. The snapshot now records, per window and per account, the age
of that account's block and whether the reading was usable by `usableForPause`, the same test the
pause gate applies to the account it is about to hold. The report counts an account as headroom only
when both windows were usable and both were under the threshold. A snapshot written before those
flags existed cannot qualify, which is the right default: an old line cannot prove freshness it
never recorded. The claim is also capped in the output rather than only in the prose: it says the
measurement is at hold start and says plainly that it implies nothing about whether the room lasted
or whether the other account could have done the work.

**3. Wall-clock arithmetic could invent or erase time.** `lostMs` came from `Date.now()`
subtraction, so a backward clock correction during a real hour-long hold produced a negative number
that the report would then subtract from the total, and a forward one invented time nobody waited.
Elapsed time now comes from `performance.now()` deltas. The aggregator still rejects a duration it
cannot believe, and lists it as malformed rather than summing it, because a writer being fixed today
does not make yesterday's lines true. The expired-reading race is closed too: the reset is
revalidated against the clock at the instant the wait actually starts, so a window that expires
between reading the gate and beginning the wait no longer produces a 60-second hold and a hold
count.

**4. The report dropped the part of a hold that crossed the cutoff.** Filtering on the start
timestamp meant a hold beginning one minute before a seven-day cutoff and running four hours past it
contributed nothing, so "last seven days" could answer zero for a week that lost hours. Both events
now carry `startedAt` as an instant, and the report intersects each hold with the window it is
reporting on. `longest` is deliberately not clipped: the worst single halt is a fact about the halt,
and trimming it to the window would understate the incident.

**5. Pairing by account, and rounds counted as incidents.** Two overlapping holds on one account
swapped durations and produced one wrong number plus one unknown. And a task that stayed blocked for
three re-read rounds was reported as three separate incidents, which inflated the count, shortened
the worst case to its longest single round, and dropped the gaps between rounds even though the task
was held throughout. A hold now has a `holdId` and a `taskId` on both of its events, spans every
round, and reports the round count on its resume. Pairing is by id. The report also says in its own
output that the total is account-hours rather than elapsed downtime, so two accounts held an hour
each reads as two account-hours and not as two hours of a stopped machine.

**6. The threshold parser accepted what it promised to reject.** The pattern did not terminate after
the digits, so `1000%` matched its first three characters and silently became 100, which is a
threshold at which almost nothing pauses and the lost-time report reads as a clean bill of health.
`1e2` became 1, which pauses nearly everything. `0.5` passed a documented 1-to-100 range. The number
must now stand alone: digits, an optional percent sign, then end or punctuation, integers only, 1 to
100 inclusive, and a rejected value is named on stderr with the default that replaced it. A value
with a decimal point and no percent sign is rejected outright rather than truncated, so `95.5`
fails rather than quietly becoming 95.

**7. Paid-credit pauses could be logged as ordinary threshold pauses.** With credits enabled, a
five-hour window at 100% resetting in an hour and a weekly window at 96% resetting in two days makes
the weekly window binding, and the event then recorded `reason: threshold` and hid the fact that the
stop also prevented real spending. Causes are now collected per window before a binding window is
chosen and recorded as a list, so both appear; `reason` reports the strongest cause across all
windows rather than the binding window's own. The credit setting rides with `creditsFresh`, the
freshness of the block it was read from. The classification still leans toward naming money at risk
when the credit reading is stale, because that is the safe direction, and `creditsFresh: false`
lets a reader discount it.

## Verification

Same method as the first round: real daemon, real CLI, scratch `CONDUCTOR_HOME`, two synthetic
account directories, and a scratch git repo. Synthetic accounts hold no login, so a task that starts
fails at authentication; what these runs prove is the gate, the measurement and the report, and the
loop reaching the point of opening a session. No plan usage was spent.

Four aggregator cases cannot be produced live in a few minutes: an eight-day-old hold straddling the
cutoff, two overlapping holds on one account, a negative duration, and a stale other-account
snapshot. Those were driven by appending synthesized event lines to the scratch logbook, which is
the same input the report reads in production. Everything else ran through the daemon.

TRANSCRIPTS

## Sol's what-holds list, re-verified after the changes

These are the six things Sol confirmed were already sound. The fixes must not have cost any of them.

WHATHOLDS

## What is still not covered

- No real window reset was waited out, in this round or the first. The synthetic `resets_at` proves
  the arithmetic, not the account's own behaviour at a real reset.
- The monotonic clock closes the writer side of finding 3. It cannot repair durations already
  written by the old code; those are handled by the malformed path, which is the honest treatment
  rather than a repair.
- The recoverable share remains a claim about one instant. Nothing here measures whether the other
  account kept its headroom, and the report says so in its own output rather than in a footnote
  somewhere else.
- A weekly-window hold would still wait days, refusing at the ceiling rather than passing. That is
  the correct direction now, but a multi-day hold has never run.
