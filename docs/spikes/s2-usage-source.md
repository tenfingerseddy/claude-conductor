# S2, official limit percentages outside the official UI

Verdict: **amber**, downgraded from green on 2026-08-01 by S1's refresh test. See the addendum at
the end. The source below is still the right one to read; it is just staler than hoped, so
self-metering carries the load between interactive sessions.

Run 2026-08-01. Read-only research on this machine. No Claude sessions started, no plan usage
spent, no network calls made with credentials.

## The question

Where can Conductor read the official 5-hour and weekly limit percentages, per account, outside
the official Claude Code terminal UI? Self-metering is the guaranteed floor. This spike looks for
anything better and names it precisely.

## Answer in one line

Claude Code writes the official percentages to disk, per account, in
`<configDir>\.claude.json` under `cachedUsageUtilization`. It is readable with no session running,
no install into the account, and no credential handling. It is undocumented, so it ships with a
fallback.

## Candidate sources

### 1. `<configDir>\.claude.json` -> `cachedUsageUtilization`  (recommended)

**Exact path.** `%USERPROFILE%\.claude-work\.claude.json`, and the same file under
`.claude-personal` and `.claude-third`. One file per account, because config directory is account.

**What it actually provides.** Verified live on all three accounts today. The block is
`cachedUsageUtilization` with three members: `fetchedAtMs`, `accountUuid`, `utilization`.
Inside `utilization`:

- `five_hour`: `{ utilization, resets_at, limit_dollars, used_dollars, remaining_dollars }`.
  `utilization` is the official 0 to 100 percentage. `resets_at` is an ISO timestamp or null.
- `seven_day`: same shape. This is the weekly number.
- `limits[]`: an array restating the same windows under different names, plus the per-model window.
  `kind` is `session` (the 5-hour), `weekly_all` (the weekly), or `weekly_scoped`. Each entry
  carries `percent`, `severity` (`normal` / `warning`), `resets_at`, `is_active`, and for scoped
  entries a `scope.model.display_name`. On this machine the scoped entry named Fable and read
  three distinct values across the three accounts (exact percentages withheld from the public
  repo). `scope.model.id` is null, so the model is only
  identifiable by display name.
- `extra_usage` and `spend`: the paid credit pool. Percentage, monthly limit and used amount in
  minor units with a currency and exponent, plus `is_enabled`, `disabled_reason`,
  `spend_limit_reached`.
- `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, `seven_day_cowork` and a set of
  codename keys (`tangelo`, `iguana_necktie`, `nimbus_quill`, `cinder_cove`, `amber_ladder`,
  `omelette_promotional`). All null on all three accounts. Do not build on these; they are either
  unreleased or not applicable to these plans. The per-model number that is actually populated
  comes from `limits[]` `weekly_scoped`, not from these.

**Freshness.** `fetchedAtMs` is Claude's own timestamp for the reading, and it is the only honest
freshness signal. The file's modification time is not: Claude Code rewrites `.claude.json` for
unrelated reasons. Observed today on this machine:

- `.claude-personal`: file mtime 11:37 local, `fetchedAtMs` 10:35 local. Same day, roughly an hour
  old.
- `.claude-third`: `fetchedAtMs` 2026-07-30 19:13 local, which matches that account's newest
  transcript write to the minute. The reading is flushed around session activity.
- `.claude-work`: file mtime 12:05 today, `fetchedAtMs` 2026-07-30 19:13, and `five_hour` reads
  0 with a null reset. That account has been running sessions all of today. The block was two days
  stale while the file itself was rewritten today.

That last case is the fragility. The refresh trigger is not the file write and is not session
start. It looks like it lands on or near session end, or on a poll that did not fire for a
`--output-format stream-json` style launch. This spike could not isolate it without starting
sessions, which the brief forbade. **A percentage from this file must never be trusted without
checking `fetchedAtMs`.** Treat an undated or old reading as ancient, not as current headroom.

**Where the numbers come from.** The `claude.exe` binary (v2.1.220, at
`%USERPROFILE%\.local\bin\claude.exe`) contains the endpoint `/api/oauth/usage` against
`https://api.anthropic.com`, and the string `cachedUsageUtilization` alongside `fetchedAtMs`. The
binary also handles a family of `anthropic-ratelimit-unified-*` response headers, including
`-grace-5h-utilization`, `-grace-7d-utilization`, `-reset`, `-status`, `-overage-*`. So there are
two upstream feeds: a polled endpoint that lands in this file, and live headers on every API
response that stay in process memory.

**Fragility.** Undocumented file field. Anthropic can rename or drop it in any release. The parse
must degrade to "no reading" on anything unexpected and never throw, because Claude rewrites the
file underneath a reader and a torn read is normal, not exceptional. Per the spec's trust-but-
verify principle this needs the fallback below.

### 2. Status line JSON, `rate_limits`  (documented, but wrong shape for Conductor)

Documented at https://code.claude.com/docs/en/statusline.md. The JSON handed to a status-line
command on stdin carries:

```
"rate_limits": {
  "five_hour":  { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day":  { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```

`used_percentage` is 0 to 100, `resets_at` is Unix epoch seconds. The docs state it appears only
for Claude.ai subscribers and only after the first API response in the session, and that each
window may be independently absent.

This is the freshest official number that exists outside the app, and it is documented, which is
its whole appeal. It is also the wrong shape here for two reasons. It only fires for a session that
renders a status line, so it covers the account you are actively using and no other. And a session
launched with `--output-format stream-json` renders no status line at all, so it never fires. That
second point is not a guess: it is why Kane's own extension abandoned this route (see below).

Useful to Conductor as an opportunistic calibration signal if Kane also runs terminal Claude Code,
not as the gauge's source.

### 3. Kane's account switcher extension

Source at `C:\Users\KaneSnyder(nexwave)\Documents\Account Switch Extension`.

The relevant file is `src/usage/quotaCache.ts`. It reads exactly the file in candidate 1 and
nothing else, and its own header comment says so: "This is the whole quota source." It parses
`five_hour` and `seven_day` from the dedicated members rather than from `limits[]`, because
`limits[]` names the same two windows `session` and `weekly_all` and counting both would
double-count. It takes only `weekly_scoped` entries out of `limits[]`. Clamps percentages to
0 to 100 with a comment that an overspent pool genuinely reports above 100.

`src/telemetry/statusLineBridgeService.ts` is the older route, kept as a fallback only. Its
CHANGELOG entry is the useful evidence: the status line "could never have worked on the path this
product manages: the official extension launches the CLI with `--output-format stream-json`, which
renders no status line, so `statusLine` was never invoked and quota never arrived." The extension
holds a cache reading to ninety minutes and treats an undated reading as ancient. Conductor should
copy both of those rules.

Authentication for the quota read: **none**. It is a plain file read. The extension never opens
`.credentials.json`. Confirmed by reading the source.

Fragility worth carrying over: the status-line bridge rewrites the user's `settings.json`
`statusLine` command and keeps two backups because it previously blanked people's status lines.
Conductor should not adopt the bridge. If Conductor ever needs a status line it should chain, not
replace, and it should not need one at all.

The extension's other usage path, `src/storage/usageRepository.ts`, collects OpenTelemetry metrics
(`claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.session.count` and friends).
That is self-metering by another name, not official percentages. Checked the full OTEL metric list
in the binary: there is no rate-limit or utilization metric among them.

### 4. `~/.claude-monitor/`  (dead end)

`%USERPROFILE%\.claude-monitor\` holds only `last_used.json`, which is UI preferences (theme,
timezone, refresh rate, view), last written 2025-12-01. `cache/`, `logs/` and `reports/` are all
empty. The tool is the Python `claude-monitor` at
`%LOCALAPPDATA%\Programs\Python\Python312\Scripts\claude-monitor`. It has not been run in eight
months. That family of tools reads local transcript `.jsonl` files and sums tokens, which is
self-metering with a different name and no official percentage in it. Nothing here for Conductor.

### 5. `/api/oauth/usage` called directly  (available, not recommended)

The endpoint exists on `https://api.anthropic.com` and is what feeds candidate 1. Calling it per
account would need the OAuth access token from `<configDir>\.credentials.json` (present for all
three accounts; this spike checked presence and top-level key names only and quoted nothing).

Do not do this in v1. It means Conductor handling a live credential, dealing with token refresh
that is properly Claude Code's job, and depending on an undocumented endpoint with no fallback.
The file in candidate 1 gives the same numbers for a plain file read. Revisit only if the file
field disappears.

## Recommendation

**Gauge source order, highest trust first:**

1. `<configDir>\.claude.json` -> `cachedUsageUtilization`, one read per account, polled on a short
   interval. Take `five_hour.utilization` and `seven_day.utilization` as the official percentages,
   `resets_at` as the reset times, `limits[]` `weekly_scoped` as the per-model weekly, and
   `extra_usage` as the credit pool. Always carry `fetchedAtMs` alongside.
2. Self-metering, summed from every SDK result message per model, per account, per rolling window.
   This is the floor and it ships regardless of anything above.

**Calibration plan.** Store the official reading with its `fetchedAtMs` as an anchor. Self-meter
everything Conductor spends after that timestamp and add it to the anchor. When a fresher official
reading arrives, log the gap between predicted and official, reset the anchor, and let the ratio
train the self-metering conversion. That gap is the calibration, and it belongs in `events.jsonl`
as a first-class event.

**Rules the gauge must obey:**

- Freshness is `fetchedAtMs`, never file mtime. Show the age.
- A reading older than about ninety minutes is stale. Fall back to anchor plus self-metered delta
  and label the line as estimated.
- An absent, unparseable or unexpected block means no official reading, never zero. Zero headroom
  reported as full headroom is the failure mode that matters.
- Never claim a per-model number from the `seven_day_opus` style keys. They are null here.
- The parse never throws. Claude rewrites this file underneath us.
- Read only `cachedUsageUtilization`. Never open `.credentials.json`. Never persist the account
  email or UUID into Conductor state.

**Fallback if the field disappears:** self-metering alone, clearly labelled as estimated, plus an
optional opportunistic read of the documented status-line `rate_limits` if Kane runs a terminal
session. Ship M1 so that removing the official source degrades the gauge rather than breaking it.

## Open questions this spike could not close

1. **What triggers the refresh of `cachedUsageUtilization`?** Observed staleness of two days on an
   actively used account is the one real risk to this source. Answering it needs a session, so it
   belongs to S1. Cheap test: note `fetchedAtMs`, run the S1 hello-world SDK session against that
   config dir, note it again. If an SDK session never refreshes it, Conductor's own work is
   invisible to its own gauge until a terminal session runs, and self-metering carries more weight
   than planned. That would move this verdict to amber.
2. Whether the Agent SDK surfaces `anthropic-ratelimit-unified-*` headers or a `rate_limits` field
   in-band on any message. Nothing in the docs or the binary's stream-json field names suggests it
   does. If it does, it beats every source here and should replace candidate 1.

## Verdict

**Amber.** A real official-percentage source exists, per account, on disk, with no credential
handling and no session required. It is undocumented, so it ships with self-metering as the floor
and the staleness rules above. Open question 1 was the thing that could downgrade this, and it did;
see the addendum.

## Addendum, 2026-08-01: S1 answered open question 1, and the answer downgrades this

S1 ran SDK sessions against `.claude-work` and `.claude-personal` and re-read
`cachedUsageUtilization` afterwards. **`fetchedAtMs` did not advance on either account.** The
work account's block stayed byte-identical at its two-day-old reading. Only interactive Claude
Code sessions refresh the block; SDK sessions do not.

Consequence: for an account driven mostly by Conductor, the official reading has an unbounded
staleness window. So the recommendation flips emphasis: **self-metering is the primary gauge
number, and the official reading is a calibration anchor applied whenever a fresh one happens to
appear** (Kane running terminal Claude Code on that account). The staleness rules above stop
being edge-case handling and become the normal path. Everything else in this verdict stands.
