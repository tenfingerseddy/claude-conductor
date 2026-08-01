# S4, usage buckets

**Verdict: green.**

Run 2026-08-01. Research only. No Claude sessions started, no plan usage spent, no credentials
read. Local evidence came from read-only parses of `cachedUsageUtilization` in the three account
config files, plus the finished S1 and S2 verdicts.

## The question

Which usage bucket does Agent SDK usage land in today, plan limits or a separate SDK credit, given
Anthropic paused the split on 2026-06-15? And does the gauge design hold if the split ships later?

## Answer in one line

SDK usage draws from ordinary Claude plan limits today, confirmed by Anthropic's own help article
and by the fact that no SDK-shaped bucket exists in the on-disk utilization data. The plural-bucket
design holds, and the schema already carries a null slot that a future SDK bucket would most likely
fill.

## Finding 1: the official story, today

https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

Operative line, quoted from the article as fetched today:

> Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For now,
> nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from
> your subscription's usage limits.

Article last updated **2026-06-16**. The monthly credits that the rest of the article describes are
stated as not currently available, and Anthropic says it is reworking the plan before anything takes
effect.

So today: **plan limits, the same 5-hour and weekly windows as interactive Claude Code.** There is
no separate SDK credit to read, because there is no separate SDK credit.

## Finding 2: nothing newer has shipped

Searched for any announcement after 2026-06-16 that the split shipped, changed, or was formally
cancelled. Nothing found. The coverage all clusters in May and June 2026 and all lands on the same
conclusion.

- https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/ (the pause)
- https://thenewstack.io/anthropic-agent-sdk-credits/ (the original announcement: Pro $20, Max 5x
  $100, Max 20x $200, credits do not roll over, no pooling across a team). This one is the May
  announcement despite the "splits billing again" headline. It is not a second, newer split.
- https://zed.dev/blog/anthropic-subscription-changes (a third-party SDK consumer, same story)

The commitment reported consistently across sources is that Anthropic will give **advance notice**
before any future change. That is the watch signal, and it means Conductor is not at risk of the
bucket layout changing overnight without warning.

Secondary blogs also claim mid-2026 movements on adjacent things: Claude Code weekly limits held
50% higher until 2026-08-19, and Pro and Team Standard accounts moved onto usage credits with a
one-time cushion. These are secondary sources only and I could not confirm them against an
Anthropic page, so treat them as unverified. They do not change the SDK bucket answer, but the
second one is the likely reason the work account has extra usage credits enabled (see Finding 4).

## Finding 3: local evidence agrees, from three directions

1. **S1.** SDK sessions ran with `ANTHROPIC_API_KEY` absent and reported `apiKeySource: none`. The
   only credential in the config directory is a `claudeAiOauth` entry with `subscriptionType`
   `team` or `max`. An empty config directory fails with "Not logged in". There is no API billing
   relationship in play at all, so the spend has nowhere to go except the plan.
2. **The on-disk buckets.** Parsed `cachedUsageUtilization.utilization` on all three accounts today.
   Every account has exactly three `limits[]` entries and no more: `session`, `weekly_all`,
   `weekly_scoped` (Fable). There is no SDK entry, no programmatic entry, no fourth kind.
3. **The null slots.** `seven_day_oauth_apps` exists as a top-level key on all three accounts and is
   null on all three. "OAuth apps" is Anthropic's own term for third-party apps on a Claude login,
   which is exactly the population the paused split targeted. That key is the most likely landing
   spot if the split ships, alongside a new `limits[]` kind. Other null keys present: `seven_day_opus`,
   `seven_day_sonnet`, `seven_day_cowork`, `seven_day_omelette`, `tangelo`, `iguana_necktie`,
   `nimbus_quill`, `cinder_cove`, `amber_ladder`, `omelette_promotional`.

The honest limit on this evidence: S1 proved SDK sessions never refresh `cachedUsageUtilization`, so
we cannot watch an SDK session move a number on disk. The argument is a closed auth chain plus an
official statement, not a before-and-after reading. That is enough for green, but it is why the
gauge's primary number stays self-metered.

## Finding 4: the bucket shapes genuinely differ per account

Confirmed today, and this is the design constraint that matters more than the SDK question.

- `extra_usage` is **enabled** on the work (team) account with a monthly limit and a low-to-mid
  share already used (exact percentage withheld from the public repo), and **disabled** on the
  personal (max) account with `disabled_reason:
  "out_of_credits"`. Same key, opposite meaning.
- `spend` is the paid credit pool in currency terms and mirrors that: enabled on one account,
  zeroed and disabled on the other. Fields: `used`, `limit`, `percent`, `severity`, `enabled`,
  `disabled_reason`, `cap`, `balance`, `auto_reload`, `disclaimer`, `can_purchase_credits`,
  `can_toggle`.
- `extra_usage` carries `daily` and `weekly` sub-objects, null everywhere here. More sub-buckets are
  clearly anticipated by the schema.
- `is_active` does not mean "populated" and does not mean "highest". On the personal account the
  5-hour bucket read a mid-range percentage and was `is_active: false`, while `weekly_all` read
  higher with `severity: warning` and was `is_active: true` (exact values withheld from the public
  repo). Read `is_active` as "this is the binding
  constraint right now", and never as a filter for which buckets to display.

**Hazard worth naming.** On an account with `extra_usage` enabled, work that runs past the plan
limit does not stop, it spends real money out of the credit pool. Conductor's pacing brain must
treat that pool as a bucket with a cost, not as extra headroom. This is a bigger live risk than the
paused SDK split.

**Parser wrinkle found today.** `.claude.json` contains project-path keys that differ only by
drive-letter case (`c:/...` and `C:/...` as separate keys). Strict parsers reject the file outright;
PowerShell's `ConvertFrom-Json` fails without `-AsHashtable`. Node's `JSON.parse` accepts it and
keeps the last occurrence, which is fine for us because Conductor only reads
`cachedUsageUtilization`. Do not add a strict or duplicate-key-checking JSON parser to the gauge.

## The proposed bucket model

One flat list of buckets per account. The gauge never hardcodes a fixed set.

```
Bucket {
  account_ref   // Conductor's own local label, never an email or accountUuid
  id            // stable: "session" | "weekly_all" | "weekly:<model>" | "extra_usage" | "sdk_credit" | "unknown:<key>"
  kind          // session | weekly_all | weekly_scoped | credit_pool | unknown
  label         // human text for the gauge line
  scope         // model display name for weekly_scoped, else null
  percent       // 0..100, may exceed 100 on an overspent pool, clamp for display only
  resets_at     // ISO timestamp or null
  severity      // normal | warning | unknown, as reported
  is_binding    // upstream is_active, "the constraint that bites right now"
  source        // official_file | self_metered | anchor_plus_delta | absent
  fetched_at    // fetchedAtMs for official, now() for self-metered
  age_ms        // derived, shown to the user
  confidence    // fresh | stale | estimated | unknown
  costs_money   // true only for credit_pool buckets
}
```

Buckets per account, in the order the gauge shows them:

1. **session_5h.** From `limits[]` kind `session`, cross-checked against `five_hour`. Present on all
   three accounts today.
2. **weekly_all.** From `limits[]` kind `weekly_all`, cross-checked against `seven_day`.
3. **weekly_scoped, zero or more.** One per `limits[]` entry of kind `weekly_scoped`, keyed by
   `scope.model.display_name`. Today that is exactly one, Fable, on every account. `scope.model.id`
   is null, so the display name is the only key available. Never assume the count is one.
4. **extra_usage_credit.** From `extra_usage` plus `spend`. Only emitted when `is_enabled` is true.
   `costs_money: true`. When disabled, emit nothing and record the `disabled_reason`, do not emit a
   zero.
5. **sdk_credit, placeholder.** Absent today. Emitted only if a bucket appears. Detection is by
   discovery, not by a hardcoded name: any new `limits[]` kind, or `seven_day_oauth_apps` turning
   non-null, becomes a bucket.

Two things that are deliberately not buckets: **context fill** is per session, not per account, and
lives on its own axis of the gauge line. **Self-metered usage** is not a separate bucket either. It
is a `source` value that fills the same bucket shapes when the official reading is stale, which per
S1 is most of the time on a Conductor-driven account.

At M7 the same shape carries other vendors. A Codex subscription window is a bucket with a different
`account_ref` and `source`, and the pacing brain compares tanks without new plumbing. This is what
the spec's "designed for plural buckets" line was buying.

### Degradation rules

- **Bucket absent** means unknown, never zero. Zero headroom shown as full headroom is the failure
  that matters, and `.claude-work` demonstrates it live: a two-day-stale block reads
  `five_hour: 0` with a null reset, which is not a reading of anything.
- **Unknown bucket appears.** Carry it through as `kind: unknown` with its key as the id, show it
  with a plain label, and write one `unknown_bucket` event to `events.jsonl` the first time each new
  key is seen. Discovery is logged, not swallowed, and not fatal.
- **Whole block missing or unparseable.** All official buckets go to `source: absent`, the gauge
  falls back to self-metered buckets labelled estimated, and the parse never throws.
- **Stale reading.** Older than about ninety minutes by `fetchedAtMs` becomes anchor plus
  self-metered delta, `confidence: estimated`, and the age is shown.
- **Picking the headline number.** Take the binding bucket as the highest percent among fresh
  buckets, and use upstream `is_active` only as a tiebreaker and a label. Do not trust `is_active`
  alone, because a stale block's `is_active` is stale too.
- **If the split ships.** The playbook gets one line, the gauge gets one more bucket by discovery,
  and self-metering splits its counters by session origin so SDK spend is attributed to the new
  bucket. No structural change. That is the design holding.

## What to watch

1. Anthropic's own article, https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan.
   If the "Update June 15" paragraph disappears, the split is back on. Advance notice was promised,
   so this should never be a surprise.
2. `seven_day_oauth_apps` turning non-null on any account, or a fourth `limits[]` kind appearing.
   The `unknown_bucket` event above is the alarm, and it costs nothing to have running from M1.
3. The `extra_usage` pool on the work account. That one spends money today, split or no split.

## Verdict

**Green.** Today's destination is confirmed with a source: Agent SDK and `claude -p` usage draws
from the subscription's plan limits, per Anthropic's help article as updated 2026-06-16, corroborated
by a closed auth chain in S1 and by the absence of any SDK-shaped bucket in the on-disk data. The
plural-bucket model above holds if the split ships later, because buckets are discovered rather than
hardcoded and every consumer of the gauge already handles a bucket being absent, stale, or new.
