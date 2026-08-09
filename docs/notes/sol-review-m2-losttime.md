# Sol review, lost-time measurement: can these numbers be trusted?

Raw output below, triage after the separator. One dimension: the accounting, because the numbers
exist to justify a purchasing decision and a wrong number is worse than none.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief.md`
- Run from: repo root, branch `feat/m2-lost-time`, diff of `322ed4c` inlined (src/ and SPEC.md)
- Model: `gpt-5.6-sol`, effort `xhigh`
- Date: 2026-08-02

---

The accounting does not hold. I would block `322ed4c` on the following findings.

1. **Critical — the paid-credit hard boundary eventually opens itself.**  
   `src/main.ts:181-278`, especially `270-277`; task execution continues at `src/main.ts:387`.

   Sequence: an extra-usage account reports three successive fresh 100% readings with advancing reset times. Conductor waits three rounds, then exits the loop without a fourth re-read and starts the task. The later gauge refresh does not reapply the pause decision.

   Leadership is told that paid-credit spending is a hard boundary and that three limit pauses were measured, while Conductor can actually proceed into paid usage. This also weakens an existing rail. **Merge blocker.**

2. **High — “recoverable” time can be based on arbitrarily stale evidence and is extrapolated across the entire pause.**  
   `src/main.ts:150-162`; `src/server/http.ts:393-408, 441-443`.

   Sequence: account B’s week-old file says 0%/0%. Account A pauses for six hours. B’s stale numbers are logged without `fetchedAtMs`, confidence, or reset validity, and all six hours become `recoverableMs`. Even a genuinely fresh snapshot only proves headroom at pause start, not that B retained enough capacity for six hours or could complete the task.

   Absent readings are handled correctly—they cannot qualify because both values must be numbers. Stale readings can qualify, however. The general caveat does not repair a precise duration computed from evidence the code could identify as unusable.

   Leadership could be told “six hours were recoverable with another account” when no trustworthy evidence supports that. **Merge blocker.**

3. **High — clock changes can make actual lost time negative or greatly inflated.**  
   `src/engine/gauge.ts:664-669`; `src/main.ts:197, 231-233, 289-295`; `src/server/http.ts:420-443`.

   `lostMs` uses `Date.now() - startedAt`, while the timer runs on elapsed-time semantics. If the system clock moves backward during a real one-hour pause, `lostMs` can be negative; a forward correction inflates it. The aggregator accepts either without validation, so negative time can reduce account and total figures.

   There is also a boundary race: the reset is validated against one `Date.now()`, then the pause starts later. A reset that expires between those points can still generate a roughly 60-second pause and pause count, contrary to the “expired never pauses” rule.

   Leadership could see understated, negative, or exaggerated lost time caused by clock correction rather than capacity. Use a monotonic clock for elapsed duration and revalidate the reset at the actual pause start. **Merge blocker.**

4. **High — the report drops the portion of a pause crossing the `days=N` cutoff.**  
   `src/server/http.ts:354-355, 428-431`.

   Sequence: a pause starts one minute before the seven-day cutoff and ends four hours afterward. Filtering solely on the pause-start timestamp excludes the entire pause, including almost four hours inside the requested period. An unmatched pause that began before the cutoff is also omitted even if the machine remains paused now.

   Leadership’s “last seven days” result can say zero when hours were lost during those seven days. The events need identifiable start and end instants, with duration intersected against the reporting window. **Merge blocker.**

5. **High — pairing by account cannot safely account for overlaps, and retry rounds distort incident metrics.**  
   `src/state/logbook.ts:119-147`; `src/server/http.ts:375-426, 433-449`; `src/main.ts:181-278`.

   Same-account overlap:

   - Pause P1 starts for account A.
   - Pause P2 starts for A.
   - P2 causes P1 to be emitted as unmatched.
   - P1’s resume is assigned to P2.
   - P2’s resume is ignored.

   The report can therefore show one incorrect duration plus one unknown instead of both real durations. `runTasks` is exported and its process-wide claim mechanism prevents duplicate task IDs, not concurrent different tasks using the same account.

   Separately, consecutive retry rounds for one continuously blocked task are reported as multiple pauses, and `longestMs` is the longest round rather than the longest uninterrupted halt. The durations themselves do not overlap, but leadership sees inflated incident frequency and a shortened worst incident. Re-read gaps are omitted from lost time even though the task remains held.

   Different-account overlaps are summed into “total,” producing two hours for two simultaneous one-hour pauses. That is defensible only if explicitly defined as account-delay-hours rather than elapsed system downtime.

   Add a unique pause/hold ID and task ID to both events, group rounds under one hold, and define whether total means interval union or account-hours. **Merge blocker.**

6. **High — the lenient threshold parser accepts inputs it promises to reject.**  
   `src/state/playbook.ts:96-99`.

   The regex is not terminated after the numeric token, and the range check is `> 0` rather than `>= 1`.

   - `pause threshold: 1000%` is parsed as `100`, not rejected to the 95% default.
   - `pause threshold: 1e2` is parsed as `1`.
   - `pause threshold: 0.5%` is accepted despite the documented 1–100 range.

   Leadership could see no measured loss because an invalid value silently raised the threshold to 100%, or enormous artificial loss because a typo made almost every task pause. **Merge blocker.**

7. **High — paid-credit pauses can be logged with the wrong reason.**  
   `src/engine/gauge.ts:299-306`; `src/main.ts:183, 210-212, 234-259`.

   Sequence: credits are enabled, the five-hour window is 100% and resets in one hour, while the weekly window is 96% and resets in two days. The weekly window becomes binding; because its percentage is below 100, the event records `reason: threshold`, completely hiding the simultaneous paid-credit boundary.

   Additionally, `extraUsageEnabled` comes from the file without freshness qualification, so a recently changed credit setting can also misclassify the reason.

   Leadership may conclude that a conservative 95% policy caused the stop and decide to raise it, when the event also prevented real paid usage. The trigger causes should be recorded independently from the binding wait window. **Merge blocker.**

What does hold:

- A reading already absent, non-fresh, invalid, or expired when `usableForPause` evaluates it does not cause a pause.
- An actionable 100% reading initially fires regardless of the configured threshold; the defect is the three-round escape and cause attribution.
- `finish` is idempotent, so timer completion and graceful interruption cannot log the same resume twice.
- A hard process death leaves an in-window pause unmatched, counted, and listed without a guessed duration.
- Report timestamps and cutoff arithmetic use absolute UTC instants consistently. It is a rolling 24-hour-day report, not a local-calendar-day report.
- I see no weakening of the trust gate, workspace isolation/undo door, or scrub rule. The new logged account fields contain configured names rather than config directories, emails, or raw account identifiers.

---

## Triage, Fable

All seven accepted, none contested, none parked. Finding 1 is the one that matters most: a retry
ceiling that ends by starting the task turns a hard rail into a three-strikes rule, which is a
design error, not a bug, and it must end by refusing. The rest are exactly the class the brief
asked Sol to hunt: numbers that can overstate (4, 5), understate (3, 4), misattribute (7), rest on
stale evidence (2) or amplify a typo (6). The recoverable-share fix follows Sol's own logic: a
share computed from a reading the gauge would call unusable is not a share, and freshness rides
with the snapshot. Fix round booked; the six what-holds lines are kept as the baseline the fixes
must not regress.
