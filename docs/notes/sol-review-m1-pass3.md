# Sol review, M1 engine, pass 3: gauge honesty

Raw output from Sol. Not edited, not filtered.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief3.txt`
- Run from: repo root, branch `feat/m1-engine`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only (override of the config default)
- Files in scope: src/engine/gauge.ts, src/state/logbook.ts
- Dimension: gauge honesty only
- Date: 2026-08-01

---

# GAUGE HONESTY

**Verdict: No. The gauge can report headroom it does not have.**

## Findings

1. **Critical: a failed live probe leaves the previous reading permanently “official, live.”**

   [gauge.ts:249](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:249>) only replaces `this.live` when the probe succeeds. On failure, timeout, or malformed partial response, the previous value survives. [gauge.ts:328](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:328>) always prefers that cached value, and [gauge.ts:395](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:395>) still labels it `official, live`.

   Exact trigger: one boundary successfully reads 20% used; subsequent usage raises the real value to 80%; the next experimental probe throws or times out. The gauge continues reporting 20% used and 80% headroom as live. `refreshBeforeTask()` at [gauge.ts:182](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:182>) refreshes only the file and does not invalidate the cached live reading.

2. **High: calibration can learn that spending tokens creates headroom.**

   Self-metering only accumulates totals at [gauge.ts:190](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:190>) and [gauge.ts:230](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:230>); it has no timestamps or rolling-window expiry despite the requirement in [SPEC.md:133](<C:/Users/KaneSnyder(nexwave)/repos/conductor/SPEC.md:133>). Calibration then divides the net official percentage movement by newly metered tokens at [gauge.ts:372](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:372>).

   Exact trigger: the official five-hour reading falls from 80% to 20% because older usage rolls out while 1,000 new tokens are metered. Calibration stores `(20 - 80) / 1000 = -0.06%` per token. Later, [gauge.ts:345](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:345>) subtracts usage as more tokens are spent, eventually clamping the estimate to 0% used. An unchanged rounded official percentage similarly learns a zero rate and freezes future usage. The output is labelled estimated, but its number can still materially overstate headroom.

3. **High: stale estimation combines a file percentage with an unrelated live anchor.**

   [gauge.ts:334](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:334>) passes the stale file percentage into `estimateFrom()`, but [gauge.ts:343](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:343>) calculates token delta from `anchorTokens`, which belongs to the last live percentage stored at [gauge.ts:375](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:375>).

   Exact trigger: calibration establishes 0.01% per token and anchors a live reading of 40% at 10,000 tokens. The stale file still contains 10%. At 11,000 tokens the estimate becomes `10 + 1,000 × 0.01 = 20%`, although the matching live-anchor projection is 50%. The gauge therefore reports 80% headroom instead of 50%.

   The same estimator is also used for `weekly` through [gauge.ts:327](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:327>), although the only calibration input is `live.fiveHour` at [gauge.ts:269](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:269>). Any difference between five-hour and weekly percent-per-token rates makes the weekly estimate wrong.

4. **High: the staleness gate fails open for undated or future-dated file readings.**

   A missing or nonnumeric `fetchedAtMs` becomes `confidence: unknown` at [gauge.ts:113](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:113>) and [gauge.ts:116](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:116>). [gauge.ts:333](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:333>) accepts every confidence except `stale`, while [gauge.ts:398](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:398>) renders `unknown` as `official, from disk`.

   Exact trigger: `cachedUsageUtilization` contains 5% utilization but no valid `fetchedAtMs`. An arbitrarily old reading is presented without an unknown or stale label. Separately, `fetchedAtMs > now` is clamped to age zero at [gauge.ts:114](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:114>), so clock skew or a future timestamp marks the reading fresh.

5. **Medium: malformed finite official percentages are accepted as live readings.**

   [gauge.ts:414](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:414>) checks only that utilization is finite. It does not enforce the valid 0% to 100% range.

   Exact trigger: the experimental probe or file returns `{ utilization: -5 }`. The gauge reports `-5% used (official, live/from disk)`, implying 105% headroom instead of degrading to no reading.

## Clean checks

`src/state/logbook.ts` is clean for this dimension. It explicitly represents unknown as `null` at [logbook.ts:36](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/state/logbook.ts:36>) and preserves the source and confidence labels. Zero is also handled correctly end to end: [gauge.ts:416](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:416>) rejects only `null`, and [gauge.ts:384](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/gauge.ts:384>) logs numeric zero rather than converting it to absence.