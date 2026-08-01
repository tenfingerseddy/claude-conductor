# S3: `/compact` behaviour through the Agent SDK

**Verdict: green.**

Date: 2026-08-01. Machine: Kane's Windows 11 box. SDK: `@anthropic-ai/claude-agent-sdk`
0.3.220, Node v24.11.1, Claude Code runtime 2.1.220. Throwaway script:
`spikes/s3/compact.mjs`. Account: `.claude-work`. `ANTHROPIC_API_KEY` unset throughout.

## Question

Does sending `/compact` with focus instructions through the Agent SDK actually work? Two parts:

1. Are the focus instructions honoured in the compacted summary?
2. Is the compact boundary visible to the host program, as a message or a hook event the daemon
   can log?

Answer to both: yes. With one caveat on part 1 that matters for design, in "The caveat" below.

## What was run

One script, one session, four turns, streaming input mode (async generator prompt) so the whole
test costs a single cold start. S1 measured ~26k cache-creation tokens per cold `query()`, so
four separate resumed `query()` calls would have cost about four times as much for the same
answer.

Options: `model: "haiku"`, `permissionMode: "bypassPermissions"`, `allowedTools: []`,
`settingSources: []` (no repo `CLAUDE.md`, keeps the context small and the test clean),
`maxTurns: 30`, and callback hooks registered for `PreCompact` and `PostCompact` with no matcher.

The turns:

1. "The project codename is FALCONRIDGE. The service listens on port 8347." Reply `noted 1`.
2. "The owner is Marguerite Delacroix" plus filler (nightly build 03:15, JSON lines logs, a grey
   heron mascot named Pemberton). Reply `noted 2`.
3. `/compact Preserve ONLY the project codename. Drop the port number, the owner name, and every
   other detail. The codename is the single thing that matters.`
4. "Answer from memory only. Do not use any tool and do not guess." Three lines: CODENAME, PORT,
   OWNER, each a value or UNKNOWN.

The generator waits for each turn's `result` message before sending the next, so these are real
sequential turns in one live session, not four one-shots.

## Raw output (trimmed)

`/compact` is dispatchable. Every turn's init message reported it:

```
[init] model: claude-haiku-4-5-20251001 | session_id: 06c823e3-04f3-4dea-8723-684eef29a09e
[init] compact in slash_commands: true
```

Turns 1 and 2 answered `"noted 1"` and `"noted 2"`.

Turn 3, the compact. Four host-visible things arrive, in this order:

```
[system status] RAW: {"type":"system","subtype":"status","status":"compacting",
  "session_id":"06c823e3-...","uuid":"29fb041e-..."}

[hook PreCompact] {"session_id":"06c823e3-...",
  "transcript_path":"C:\\Users\\...\\.claude-work\\projects\\C--Users-...-spikes-s3\\06c823e3-....jsonl",
  "cwd":"C:\\Users\\KaneSnyder(nexwave)\\repos\\conductor\\spikes\\s3",
  "prompt_id":"c0b0c2c7-...","hook_event_name":"PreCompact","trigger":"manual",
  "custom_instructions":"Preserve ONLY the project codename. Drop the port number, the owner
   name, and every other detail. The codename is the single thing that matters."}

[hook PostCompact] {"session_id":"06c823e3-...","transcript_path":"...","cwd":"...",
  "prompt_id":"c0b0c2c7-...","hook_event_name":"PostCompact","trigger":"manual",
  "compact_summary":"<analysis>...</analysis>\n\n<summary>... full generated summary ...</summary>"}

[system status] RAW: {"type":"system","subtype":"status","status":null,
  "compact_result":"success","session_id":"06c823e3-...","uuid":"e6b3fa07-..."}
```

Then the boundary message itself, after a fresh `init`:

```
[system compact_boundary] RAW: {
  "type":"system","subtype":"compact_boundary",
  "session_id":"06c823e3-04f3-4dea-8723-684eef29a09e",
  "uuid":"a2038b1f-5b1d-4605-8528-3913b8d9b60c",
  "compact_metadata":{
    "trigger":"manual",
    "pre_tokens":25394,
    "post_tokens":1527,
    "cumulative_dropped_tokens":23867,
    "duration_ms":12447,
    "preserved_segment":{"head_uuid":"399c4b79-...","anchor_uuid":"ef29f1b5-...","tail_uuid":"95619696-..."},
    "preserved_messages":{"anchor_uuid":"ef29f1b5-...","uuids":["399c4b79-...","95619696-..."],
                          "all_uuids":["399c4b79-...","95619696-..."]}
  },
  "logical_parent_uuid":"95619696-7ea1-49f4-9494-18878e3a3a10"
}

[user-echo] "<local-command-stdout>Compacted PreCompact [callback] completed successfully
PostCompact [callback] completed successfully</local-command-stdout>"

[result turn 3] subtype: success | is_error: false | session_id: 06c823e3-04f3-4dea-8723-684eef29a09e
[result turn 3] text: ""
[result turn 3] usage: {"input_tokens":0,"cache_creation_input_tokens":0,
  "cache_read_input_tokens":0,"output_tokens":0,...,"iterations":[]}
```

Turn 4, the recall test after the compact:

```
[assistant] "CODENAME: FALCONRIDGE\nPORT: UNKNOWN\nOWNER: UNKNOWN"
[result turn 4] text: "CODENAME: FALCONRIDGE\nPORT: UNKNOWN\nOWNER: UNKNOWN"
```

The named focus survived. Both facts the instructions told it to drop came back UNKNOWN.

Extract from the generated summary carried in `PostCompact.compact_summary`, showing the focus
instruction reached the summarizer and steered it:

```
The user has been clear about what to retain (project codename) and what to discard (all other
details including owner name, port, and all filler information).
...
1. Primary Request and Intent:
   ... The final, overriding instruction specifies that only the project codename should be
   preserved in the summary, with all other details discarded.
```

## What this proves

- **`/compact` can be sent through the SDK.** It appears in `slash_commands` on every init and
  dispatches as an ordinary prompt string in a live streaming session. No special API.
- **Focus instructions reach the summarizer verbatim.** Everything after `/compact ` arrives as
  `custom_instructions` on the `PreCompact` hook, byte for byte, and the generated summary
  visibly reasons about it.
- **The focus is honoured at recall.** The named fact survived, the two named for dropping came
  back UNKNOWN. That is the pass criterion.
- **The boundary is visible four separate ways**, so the daemon has plenty to log:
  1. `system` / `status` with `status: "compacting"`, then `status: null` with
     `compact_result: "success"`. Bracket the operation, good for a spinner or a timer.
  2. `PreCompact` hook: `trigger`, `custom_instructions`, `transcript_path`, `session_id`,
     `prompt_id`.
  3. `PostCompact` hook: same fields plus `compact_summary`, the entire generated summary text.
  4. `system` / `compact_boundary` with `compact_metadata`: `trigger: "manual"`, `pre_tokens`,
     `post_tokens`, `cumulative_dropped_tokens`, `duration_ms`, and the preserved-message uuids,
     plus `logical_parent_uuid` on the message itself.
- **Manual compaction fires both hooks.** `trigger` is `"manual"`, which distinguishes a
  Conductor-driven cut from the auto-compact backstop. The spec's backstop rule (log every
  auto-compact because it means the loop failed) is implementable as a one-line check on
  `trigger`.
- **The session id does not change across a compact.** Same id before, during, and after. The
  daemon keeps its handle.

## The caveat

**The focus instruction shapes behaviour, it does not redact.** Section 6 of the generated
summary, "All user messages", quotes the original turns verbatim, so `port 8347` and
`Marguerite Delacroix` were both still sitting in the post-compact context when turn 4 ran. The
model answered UNKNOWN anyway, honouring the intent rather than reading what was in front of it.

That is the honest reading of a green result. `/compact` focus is a strong steer on what the
summary emphasises and how the model then behaves, not a guarantee that dropped facts are gone.
Anything that must actually leave the context needs a fresh cut, not a compact cut. This is one
more reason the spec is right to make fresh cut the default.

Second, smaller caveat: **the summary is model-written and can invent detail.** The summary
attributes a sentence to turn 2 that was never sent
(`CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`). Harmless here, but it means the
compacted context is a paraphrase with confabulation risk, while a `finish_task` handoff note is
something Claude wrote deliberately and knowingly. Another point for fresh cut as default.

## Implications for the compact-cut mode in M2

1. **Compact cut is buildable as specced.** Send `/compact ` plus the handoff note as focus text
   on the live or resumed session. No new mechanism, no undocumented surface.
2. **Log the boundary from `compact_boundary`, not from the hooks.** `compact_metadata` has the
   numbers a logbook line wants: `trigger`, `pre_tokens`, `post_tokens`,
   `cumulative_dropped_tokens`, `duration_ms`. One `events.jsonl` line per compaction, and
   `trigger` separates a deliberate cut from a backstop firing.
3. **Use `PostCompact.compact_summary` as the record of what survived.** It is the full summary
   text. Worth writing next to the handoff note so a later review can compare what Claude asked
   to keep against what the summarizer actually kept.
4. **A compact is not free and is not fast.** 12.4 seconds here, on Haiku, on a 25k-token
   context. Post-compact context was 1527 tokens against 25394 before, so the saving is real, but
   the pacing brain should treat a compact as a chargeable operation and not do it casually.
5. **Self-metering has a hole here.** The compact turn's `result.usage` was all zeros with an
   empty `iterations` array, yet the summarizer plainly consumed a 25k-token context and produced
   a long summary. The tokens spent generating the summary are not reported in-band. Conductor's
   self-metered gauge will undercount every compaction. Use `pre_tokens` from `compact_metadata`
   as the estimate of the summarizer's input, and note the estimate in the logbook so the S2
   calibration event can see it. This should be flagged in the gauge work in M1.
6. **Never rely on compaction to remove sensitive or misleading context.** See the caveat. If
   something must be gone, end the session.

## Bonus finding, relevant to S2 and to an open question in PLAN.md

The stream carries a message type nobody had seen yet:

```
[rate_limit_event] {"type":"rate_limit_event",
  "rate_limit_info":{"status":"allowed","resetsAt":1785566400,"rateLimitType":"five_hour",
                     "overageStatus":"allowed","overageResetsAt":1785550800,
                     "isUsingOverage":false},
  "uuid":"5963ef40-...","session_id":"06c823e3-..."}
```

It arrived once, right after init on the first turn. PLAN.md asks under Open questions whether
the SDK surfaces rate-limit information in-band. It does, at least partially. There is no
percentage, but there is a live `status` (`allowed`), a `rateLimitType` (`five_hour`), a
`resetsAt` unix timestamp, and overage fields. `resetsAt` 1785566400 is a real forward-dated
reset time, and unlike `cachedUsageUtilization` it came from the session itself, so it is fresh
by construction.

This does not replace self-metering on its own, because the observed event carried no consumed
figure. It was worth pinning down before the gauge gets designed on it, which the next section
does.

## rate_limit_event characterization

Follow-up to the bonus finding above, run the same day. Throwaway script:
`spikes/s3/ratelimit.mjs`. One Haiku session, three trivial turns ("Reply with exactly: one",
then two, then three), against `.claude-work`, `ANTHROPIC_API_KEY` unset. Plus a read of the
SDK's own type declarations at
`spikes/s3/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, which is authoritative for the
field list and costs nothing.

### 1. Full shape, and what it does and does not carry

The declared type, quoted from `sdk.d.ts`:

```ts
/** Rate limit event emitted when rate limit info changes. */
export declare type SDKRateLimitEvent = {
    type: 'rate_limit_event';
    rate_limit_info: SDKRateLimitInfo;
    uuid: UUID;
    session_id: string;
};

export declare type SDKRateLimitInfo = {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'
                  | 'seven_day_overage_included' | 'overage';
    utilization?: number;
    overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
    overageResetsAt?: number;
    overageDisabledReason?: 'overage_not_provisioned' | 'org_level_disabled' | ... | 'unknown';
    isUsingOverage?: boolean;
    overageInUse?: boolean;
    surpassedThreshold?: number;
    errorCode?: 'credits_required';
    canUserPurchaseCredits?: boolean;
    hasChargeableSavedPaymentMethod?: boolean;
};
```

So the answers are split.

- **Does it carry a utilization percentage?** The type says yes, `utilization?: number`. The
  observed event did not include it. Every field except `status` is optional, so a consumer must
  treat the whole payload as best-effort.
- **Does it cover the weekly window?** The type says yes, via `rateLimitType`, which enumerates
  `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, and `overage`
  alongside `five_hour`. But one event describes **one** window, not all of them. The observed
  event was `five_hour` only. There is no shape here that gives you five-hour and weekly in a
  single message.

The only event observed, verbatim except for the ids:

```
{"type":"rate_limit_event",
 "rate_limit_info":{"status":"allowed","resetsAt":1785566400,"rateLimitType":"five_hour",
                    "overageStatus":"allowed","overageResetsAt":1785550800,
                    "isUsingOverage":false},
 "uuid":"e248db0c-...","session_id":"46848091-..."}
```

Union of `rate_limit_info` keys actually seen: `status`, `resetsAt`, `rateLimitType`,
`overageStatus`, `overageResetsAt`, `isUsingOverage`. No `utilization`, no
`surpassedThreshold`.

### 2. When it fires

**Once per session at normal usage, not per API response.** Three turns produced exactly one
event, during turn 1, immediately after init.

```
turns run: 3
rate_limit_event count: 1
fired during turns: 1
```

The doc comment on the type explains it: "emitted when rate limit info changes." At a low,
unremarkable utilization nothing changes between turns, so nothing is emitted. The presence of
`status: 'allowed_warning'` and `surpassedThreshold` in the type strongly implies further events
arrive when a threshold is crossed, but this run stayed well below any threshold and could not
provoke one. **That is the load-bearing gap: the behaviour under pressure is exactly the
behaviour Conductor cares about, and it is untested.** Deliberately provoking it would mean
burning a real window, which is not worth doing on purpose.

### 3. Documented?

**Undocumented.** Checked https://code.claude.com/docs/en/agent-sdk/typescript.md (the message
type reference, where it would live if anywhere) and
https://code.claude.com/docs/en/agent-sdk/overview.md. Neither mentions `rate_limit_event`,
`SDKRateLimitEvent`, `SDKRateLimitInfo`, or rate limits at all. The type ships in the SDK's
`.d.ts`, so it is typed and exported but not written up. Per the spec's trust-but-verify
principle this is undocumented platform behaviour and needs a fallback, not a foundation.

### 4. Relation to the `anthropic-ratelimit-unified-*` headers

Almost certainly the same feed, surfaced in-band. Reasoning, no reverse engineering needed: S2
found the binary handling a header family including `-grace-5h-utilization`,
`-grace-7d-utilization`, `-reset`, `-status`, `-overage-*`. The event's field set is a
near one-to-one map onto that list: `status`, `resetsAt`, `utilization`, `overageStatus`,
`overageResetsAt`, `isUsingOverage`. The word "unified" matches a single `rateLimitType`
discriminator naming which window the reading is for, rather than a struct holding all windows
at once, which is exactly the shape observed. The reasonable read is that the CLI parses the
response headers into `SDKRateLimitInfo` and emits an event when the parsed value differs from
the last one. That also explains once-per-session at flat usage.

### The bigger find: the experimental `get_usage` control method

While characterizing the event, the typings turned up something that answers the gauge question
far better than `rate_limit_event` does. The `Query` object has:

```ts
/**
 * Get the structured data behind the `/usage` command: session cost and
 * token usage totals plus claude.ai plan rate-limit utilization windows
 * (5-hour, 7-day, per-model) when available. ...
 * EXPERIMENTAL: this API is unstable and may change or be removed in any
 * release without notice — do not rely on it yet. The method name will
 * change when the API is stabilized.
 */
usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse>;
```

It was called on the live session after turn 1 and **it works**:

```
[usage-probe] method present: true
[usage-probe] subscription_type: team
[usage-probe] rate_limits_available: true
[usage-probe] top-level keys: session, subscription_type, rate_limits_available, rate_limits, behaviors
```

The `rate_limits` block that came back, with every percentage and money figure withheld per the
publishing rule and field names kept:

```
{"five_hour":{"utilization":<withheld, low>,"resets_at":"2026-08-01T06:40:00.662278+00:00",
              "limit_dollars":null,"used_dollars":null,"remaining_dollars":null},
 "seven_day":{"utilization":<withheld, mid>,"resets_at":"2026-08-02T10:00:00.662298+00:00",
              "limit_dollars":null,"used_dollars":null,"remaining_dollars":null},
 "seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,
 ... several further null bucket keys, some of which read as unreleased internal codenames and
     are not reproduced here ...
 "extra_usage":{"is_enabled":true,"monthly_limit":<withheld>,"used_credits":<withheld>,
                "utilization":null,"currency":"AUD","decimal_places":2,"disabled_reason":null,
                "user_disabled":false,"spend_limit_reached":false,"credits_ever_enabled":true,
                "daily":null,"weekly":null},
 "limits":[{"kind":"session","group":"session","percent":<withheld>,"severity":"normal",
            "resets_at":"2026-08-01T06:40:00.662278+00:00","scope":null,"is_active":false},
           {"kind":"weekly_all","group":"weekly","percent":<withheld>,"severity":"normal",
            "resets_at":"2026-08-02T10:00:00.662298+00:00","scope":null,"is_active":true},
           {"kind":"weekly_scoped","group":"weekly","percent":<withheld>,"severity":"normal",
            "resets_at":"2026-08-02T09:59:59.662590+00:00",
            "scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}],
 "spend":{"used":{...},"limit":{...},"percent":<withheld>,"severity":"normal","enabled":true,
          "cap":{...},"can_purchase_credits":false,"can_toggle":false,"disclaimer":"..."},
 "member_dashboard_available":false,
 "model_scoped":[{"display_name":"Fable","utilization":<withheld>,
                  "resets_at":"2026-08-02T09:59:59.662590+00:00"}]}
```

This is the whole gauge in one call, from the live session, on demand:

- Five-hour utilization 0 to 100 with an ISO reset time.
- Seven-day utilization with its own reset time.
- `limits[]` with `is_active` naming which bucket is actually binding right now.
- `model_scoped[]` giving per-model weekly utilization with a server-supplied `display_name`
  (Fable appeared as its own bucket, which is exactly what the playbook's Fable rules need).
- `extra_usage` for the credit pool, with the shape difference between accounts S1 flagged.
- `subscription_type` and `rate_limits_available`, so a non-subscription session is detectable
  rather than silently reporting zeros.

It is the same field vocabulary as the `cachedUsageUtilization` block S2 read out of
`<configDir>\.claude.json`, which makes sense: both come from the `/api/oauth/usage` endpoint.
The difference is freshness. S1 proved the file is never refreshed by an SDK session and can sit
days stale. This call is answered by the live session, in process, when asked.

The catch is in the method name. It is explicitly experimental, explicitly "do not rely on it
yet", and the name itself is promised to change. That is a stronger warning than an undocumented
field; it is a documented instruction not to depend on it.

### Verdict implication for the gauge

**No, do not build the gauge on `rate_limit_event`.** It is undocumented, every field but
`status` is optional, it did not carry a utilization figure at all in practice, it describes one
window per event rather than all of them, and it fires roughly once per session at flat usage.
As a fresh official source it is too thin to anchor anything. What it is genuinely good for is a
**pressure signal**: watch it, and when `status` turns `allowed_warning` or `rejected`, or
`surpassedThreshold` appears, log it and let the pacing rules react. Treat it as an interrupt,
not as a reading.

The layered answer the coordinator asked about does hold, but with `get_usage` in the slot, not
`rate_limit_event`:

1. **Self-metering is the floor and ships regardless.** Unchanged from S2. It is the only source
   that always exists, and it is the primary number.
2. **`get_usage` on the live session is the fresh official anchor for the account currently
   running a session.** Call it once per task boundary, not per turn, and write the reading to
   `events.jsonl` as a calibration event against the self-metered figure. Because it is
   experimental, wrap it: check the method exists before calling, wrap the call in try/catch,
   treat any unexpected shape as no reading rather than zero, and never let it throw into the
   session loop. If a future SDK release renames or removes it, Conductor degrades to
   self-metering and logs that the anchor went away.
3. **The `.claude.json` file read stays for idle accounts**, exactly as S2 concluded, gated hard
   on `fetchedAtMs` and labelled estimated-only past about 90 minutes.
4. **`rate_limit_event` is logged as an event, not read as a gauge.**

That is a better answer than S2 or the first half of this spike had, and it changes the M1 gauge
work: there is now a real fresh official reading for the active account. It does not change the
"self-metering is primary" decision in PLAN.md, because the anchor rests on an API the SDK tells
you not to rely on.

Two things still open, both worth naming rather than guessing: the behaviour of
`rate_limit_event` under actual pressure is untested, and `get_usage` has not been checked for
cost (it looked instant and free, but no result message accounted for it, so a token cost cannot
be ruled out).

## Reproduce

```
cd spikes/s3
CLAUDE_CONFIG_DIR="C:\Users\KaneSnyder(nexwave)\.claude-work" node compact.mjs
CLAUDE_CONFIG_DIR="C:\Users\KaneSnyder(nexwave)\.claude-work" node ratelimit.mjs
```

Cost of the compact run: one cold start (~22k cache read, ~2.8k cache creation on turn 1) plus
three cheap turns and one compaction. The rate-limit run is one more cold start plus three
one-word turns. No account identifiers, credential material, or exact utilization percentages
are recorded here.
