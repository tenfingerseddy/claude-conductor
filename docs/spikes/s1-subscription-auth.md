# S1: subscription auth through the Agent SDK

**Verdict: green.**

Date: 2026-08-01. Machine: Kane's Windows 11 box. SDK: `@anthropic-ai/claude-agent-sdk`
0.3.220, Node v24.11.1. Throwaway script: `spikes/s1/hello.mjs`.

## Question

Does a Claude Agent SDK `query()` session run on a subscription (Claude plan) login with
`ANTHROPIC_API_KEY` unset, and can `CLAUDE_CONFIG_DIR` target a specific account's config
directory?

Answer to both: yes.

## What was run

`spikes/s1/hello.mjs` calls `query()` with one tiny prompt ("Reply with exactly the word:
pong."), `model: "haiku"`, `maxTurns: 1`, no tools, and **no `apiKey` passed anywhere**. It
prints the auth-related environment, the init message, the reply, and the result metadata.

Three runs, all with `ANTHROPIC_API_KEY` absent from the child environment (the script asserts
this itself with an `in process.env` check, so an empty-string key would have shown as PRESENT):

1. `CLAUDE_CONFIG_DIR=C:/Users/KaneSnyder(nexwave)/.claude-work`
2. `CLAUDE_CONFIG_DIR=C:/Users/KaneSnyder(nexwave)/.claude-personal`
3. Negative control: `CLAUDE_CONFIG_DIR` pointed at a freshly created empty scratch directory

## Raw output (trimmed)

Run 1, work account:

```
ANTHROPIC_API_KEY: UNSET (not in process.env)
ANTHROPIC_AUTH_TOKEN: UNSET
ANTHROPIC_BASE_URL: (unset)
CLAUDE_CONFIG_DIR: c:/Users/KaneSnyder(nexwave)/.claude-work
---
[init] model: claude-haiku-4-5-20251001 | cwd: C:\Users\KaneSnyder(nexwave)\repos\conductor\spikes\s1
[init] apiKeySource: none
[assistant] "pong"
[result] subtype: success | is_error: false
[result] total_cost_usd: 0.052829
[result] usage: {"input_tokens":10,"cache_creation_input_tokens":25993,"cache_read_input_tokens":0,"output_tokens":48,...}
[result] modelUsage: {"claude-haiku-4-5-20251001":{"inputTokens":538,"outputTokens":61,...,"canonicalModel":"claude-haiku-4-5","provider":"firstParty"}}
```

Run 2, personal account: identical shape.

```
CLAUDE_CONFIG_DIR: c:/Users/KaneSnyder(nexwave)/.claude-personal
[init] apiKeySource: none
[assistant] "pong"
[result] subtype: success | is_error: false
[result] total_cost_usd: 0.052743000000000005
[result] usage: {"input_tokens":10,"cache_creation_input_tokens":25960,...,"output_tokens":44,...}
```

Run 3, negative control, empty config dir:

```
CLAUDE_CONFIG_DIR: .../scratchpad/empty-config
[init] apiKeySource: none
[assistant] "Not logged in · Please run /login"
[result] subtype: success | is_error: true
[result] total_cost_usd: 0
[result] usage: {"input_tokens":0,...,"output_tokens":0,...,"iterations":[]}
Error: Claude Code returned an error result: Not logged in · Please run /login
```

## How we know it drew on plan usage, not an API balance

Four pieces of evidence, taken together:

1. **No key was available to use.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` were both
   absent from the child environment (asserted by the script, printed above), `ANTHROPIC_BASE_URL`
   was unset, and the script passes no `apiKey` option. There was nothing an API-billed path
   could have authenticated with.
2. **The SDK says so.** The init message reports `apiKeySource: none`. That field exists to
   name where a key came from (env, helper, config). "none" means the session is not running on
   an API key at all.
3. **The config dir holds an OAuth subscription credential, and nothing else.** Each account
   directory has a `.credentials.json` whose only Anthropic entry is `claudeAiOauth`, with
   `accessToken` / `refreshToken` / `expiresAt` / `refreshTokenExpiresAt`, scopes
   `["user:file_upload","user:inference","user:mcp_servers","user:profile","user:sessions:claude_code"]`,
   and a `subscriptionType`: **`team`** in `.claude-work`, **`max`** in `.claude-personal`.
   These are consumer-plan OAuth tokens, not API keys. (No token values are recorded here.)
4. **Remove the credential and the session cannot authenticate.** The negative control with an
   empty config dir failed with "Not logged in · Please run /login" and zero tokens. So the
   OAuth credential inside `CLAUDE_CONFIG_DIR` is the sole thing making the request work. There
   is no ambient fallback and no hidden key.

The chain is therefore closed: the only credential in play is a plan OAuth token, and removing
it breaks the session. Usage lands against the Claude plan for whichever account's directory was
named.

Note on `total_cost_usd`: this is a computed dollar price for the tokens, not a bill. On a
subscription login there is no dollar charge; the number is a self-metering signal, which is what
S2 and S4 will need.

## How we know config-dir targeting works

- The two directories hold different OAuth tokens with different `subscriptionType` values, so
  choosing a directory necessarily chooses an account.
- Both runs succeeded, and each run touched the `.claude.json` inside the directory it was
  pointed at, in run order: `.claude-work/.claude.json` at 12:10:18, `.claude-personal/.claude.json`
  at 12:10:33, roughly 15 seconds apart, matching the two invocations.
- The negative control proves the variable is actually read and is load-bearing.

Per-session targeting works. Set `CLAUDE_CONFIG_DIR` in the child environment per session and
the session runs on that account.

## Caveats and things worth knowing

- **A hello-world costs about 5 cents of metered usage.** Both real runs reported ~26,000
  cache-creation input tokens for a 10-token prompt, because each `query()` spawns a full Claude
  Code process with its whole system prompt and writes a fresh 1-hour cache entry
  (`cache_read_input_tokens: 0` on a cold start). Conductor's pacing model has to treat session
  startup, not just conversation, as the unit of spend. Reusing a session should turn that into
  cache reads.
- **Concurrency across two accounts was not tested.** The two runs were sequential. Whether two
  simultaneous sessions on two different `CLAUDE_CONFIG_DIR` values interfere is still open, and
  matters for M4. Worth a follow-up before the account layer.
- **`query()` spawns a child Claude Code CLI process** rather than talking to the API in-process.
  That is how `CLAUDE_CONFIG_DIR` reaches it, and it explains the per-session startup cost above.
- The failed negative-control run threw an unhandled rejection that dumped a large minified stack
  trace. Real code should wrap the iteration in try/catch and surface the result message's error
  text instead.
- `.claude-work` also contains `policy-limits.json` and `remote-settings.json`, both touched
  during the run. Those are candidate reading material for S2.

## cachedUsageUtilization refresh

Question handed over from S2: does an SDK session refresh the `cachedUsageUtilization` block in
`<configDir>\.claude.json`?

**Answer: no, for both accounts.** Neither session's `fetchedAtMs` advanced.

Session run times were 12:10:18 (work) and 12:10:33 (personal) on 2026-08-01 local. Values read
at 12:12:47, roughly two minutes after both sessions ended:

| Config dir | `fetchedAtMs` after session | Advanced past session? | `five_hour.utilization` |
|---|---|---|---|
| `.claude-work` | 2026-07-30 19:13:30 local | **No.** Two days stale. | 0, `resets_at: null` |
| `.claude-personal` | 2026-08-01 10:35:46 local | **No.** About 95 minutes before the session. | a mid-range percentage, unchanged (exact value withheld from the public repo), same-day reset |

`.claude-work`'s value is byte-identical to the timestamp S2 recorded earlier today
(2026-07-30 19:13), so it did not move across either spike. `.claude-personal`'s is newer but
still predates the session by an hour and a half, and almost certainly came from an interactive
Claude Code session on that account this morning, not from the SDK run.

Because `fetchedAtMs` did not advance, the block was not rewritten at all, so no utilization
value changed as a result of these sessions. Both `five_hour` figures above are the pre-session
values, still in place afterwards.

What this means for the gauge: **an SDK session is not enough to keep the official numbers
fresh.** `cachedUsageUtilization` is written by whatever refreshes it in interactive Claude Code,
and the SDK path does not trigger it. Reading the file gives you the last interactive session's
snapshot, with an unbounded staleness window. `.claude-work` shows how bad that gets: two days
old, `five_hour.utilization: 0` with a null `resets_at`, which is not a current reading of
anything. Any design that reads this block must treat `fetchedAtMs` as a hard freshness gate and
fall back to self-metering when the value is stale, which on the evidence here is most of the
time for an SDK-driven account. This strengthens the S2 conclusion that self-metering is the
floor.

Two related observations while the file was open, both useful to S2 and S4:

- The block carries far more than a five-hour percentage. There is a `utilization.limits` array
  of `{kind, group, percent, severity, resets_at, scope, is_active}` entries covering session,
  weekly-all, and weekly-scoped buckets, plus a separate `spend` object with a credit balance and
  percentage. If a cross-account gauge ever reads this file, `limits` is the richer surface, and
  `is_active` tells you which bucket is the binding one.
- The two accounts have genuinely different shapes. The work account has extra usage credits
  enabled with a monthly limit; the personal account has them disabled with
  `disabled_reason: "out_of_credits"`. A gauge cannot assume one bucket layout across accounts.

No account identifiers or credential material are recorded here. `accountUuid` sits alongside
`fetchedAtMs` in that block and was redacted at read time.

## Reproduce

```
cd spikes/s1
CLAUDE_CONFIG_DIR="c:/Users/KaneSnyder(nexwave)/.claude-work" node hello.mjs
```
