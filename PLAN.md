# Conductor build plan

Tracking file for building Conductor from [`SPEC.md`](SPEC.md). The spec says what we are building
and why. This file says what is done, what is next, and what we agreed. Update it in the same
commit as the work. If this file and the spec disagree, the spec wins and this file is wrong.

Status: **M0 complete. S1 green, S2 amber, S3 green, S4 green, S5 amber. Both ambers carry
written fallbacks, so M1 begins per D1.** Last updated 2026-08-01.

## How to read this file

- `[ ]` not started, `[~]` in progress, `[x]` done and verified.
- Nothing is `[x]` until the evidence line under it is filled in with real output. Build success is
  not evidence. "It should work" is not evidence.
- Each milestone has a **finish line**. The milestone is done when the finish line is demonstrated
  end to end, not when the last task is ticked.

## Ratified decisions

Agreed with Kane on 2026-08-01. These are settled. Changing one means changing this list and
saying why.

| # | Decision | Choice |
|---|---|---|
| D1 | Scope of this run | M0 spikes, then M1 engine. Stop and report if a spike comes back red. |
| D2 | Progress tracking | This file, committed. Spike verdicts in `docs/spikes/`. |
| D3 | Autonomy | Branch and commit freely. Merge to main after Sol review plus demonstrated run. Install packages as needed. Start real SDK sessions that spend Kane's usage. Deep research allowed. |
| D4 | Verification | Run it and paste the output. No test framework in v1. |
| D5 | State location | `%USERPROFILE%\.conductor\`, outside the repo, path configurable. Never committed. |
| D6 | Transport | One HTTP plus WebSocket server bound to 127.0.0.1. Tailscale address added at M5. |
| D7 | First real job | Conductor drives work in `C:\Users\KaneSnyder(nexwave)\repos\nexwave-apps`. |
| D8 | Red spike 1 | Stop and tell Kane. Do not build against a mock. Do not silently switch to an API key. |
| D9 | Approvals | Per-task trust level, set when the task is queued. Destructive actions always stop for a tap regardless of trust level. |
| D10 | Accounts | Three live buckets: `.claude-work`, `.claude-personal`, `.claude-third` (real folder name sanitised for the public repo; Kane knows it). Separate config directories already. `.claude` (default) is not a Conductor bucket. |
| D11 | Account switcher | Kane's own extension. Source at `C:\Users\KaneSnyder(nexwave)\Documents\Account Switch Extension`. Rough and buggy. Conductor absorbs the working mechanism and replaces the extension if it does the job better. |
| D12 | Pace | Steady, quality first. Spikes properly verified. Sol reviews every milestone. |

## Ground truth about this machine

Checked 2026-08-01. Re-check if anything stops behaving.

- Node v24.11.1, npm 11.6.2.
- Claude Code 2.1.220. codex-cli 0.144.0. Tailscale 1.94.2.
- `ANTHROPIC_API_KEY` is unset. It stays unset. This is golden rule 1.
- Claude config dirs present: `.claude`, `.claude-work`, `.claude-personal`, `.claude-third`,
  plus non-account folders `.claude-monitor`, `.claude-server-commander`, `.claude-work` project
  state under `.claude-work`.
- `~/.claude-monitor/` exists with `cache/`, `logs/`, `reports/`, `last_used.json`. Likely lead for
  spike 2, the official usage percentages question. Read it before writing any usage code.
- Account switcher installed as a VSIX at
  `~/.vscode/extensions/resonancelattice-semanticus.claude-workspace-account-manager-0.2.0-win32-x64`.
  Source is at the Documents path in D11.
- Target project for the first real job: `~/repos/nexwave-apps`.

## Stop conditions

Stop working, write down what happened, and tell Kane. Do not push through any of these.

1. Any spike verdict comes back red. Especially spike 1.
2. Anything appears to require `ANTHROPIC_API_KEY`, a token, or any credential in the repo.
3. Usage data, logs, handoffs, or account identifiers are about to land in a committed file.
4. Work drifts past the M1 finish line. M2 does not start in this run.
5. A design choice contradicts the spec and the spec looks wrong. Say which is wrong, do not
   quietly pick one.
6. Sol raises a finding that changes the design rather than the code.

## M0, spikes

Five throwaway scripts, five written verdicts. Each verdict is a file in `docs/spikes/` with the
question, what was run, the raw output, and a one-word verdict of green, amber, or red. Scripts
live in `spikes/` and are deleted or left obviously throwaway. Nothing in M1 gets built on an
unanswered spike.

### S1, subscription auth through the SDK

Highest value. Blocks everything.

- [x] Hello-world Agent SDK session runs with `ANTHROPIC_API_KEY` unset, against one of the three
      account config dirs.
- [x] Confirm it draws on plan usage, not an API balance. Say how we know.
- [x] Confirm `CLAUDE_CONFIG_DIR` targeting works, so two sessions can run on two accounts.
- Verdict file: `docs/spikes/s1-subscription-auth.md`
- Evidence: **Green.** `query()` answered "pong" on Haiku with `apiKeySource: none` and the key
  asserted absent from the child env. Auth chain closed by a negative control: an empty config dir
  fails with "Not logged in", so the plan OAuth credential in `CLAUDE_CONFIG_DIR` is the only thing
  authenticating. Both `.claude-work` (team) and `.claude-personal` (max) ran and each run touched
  its own dir's `.claude.json`. Two carries: a cold `query()` costs ~26k cache-creation tokens
  (session startup is the unit of spend, pacing must know this), and two-account concurrency is
  untested (open question, M4). Addendum answered: an SDK session does not refresh
  `cachedUsageUtilization`; `fetchedAtMs` never moved on either account. That downgraded S2 to
  amber.

### S2, official limit percentages outside the official UI

- [x] Read `~/.claude-monitor/` and work out where its numbers come from.
- [x] Read the account switcher source at the D11 path and work out what it reads for cross-account
      usage.
- [x] Check Claude Code's own state files and status line JSON for a readable limit percentage.
- [x] Pick a source. Self-metering is the floor and ships regardless. Anything better is a bonus
      that must be calibrated once against an official number.
- Verdict file: `docs/spikes/s2-usage-source.md`
- Evidence: **Amber** (green until S1's refresh test). Official percentages live in
  `<configDir>\.claude.json` under
  `cachedUsageUtilization`: 5-hour and weekly utilization 0 to 100, reset times, per-model weekly
  in `limits[]` `weekly_scoped`, credit pool in `extra_usage`. Plain file read per account, no
  credentials. Kane's switcher reads exactly this and nothing else. Freshness is `fetchedAtMs`,
  never file mtime (observed two days stale on an active account). `.claude-monitor` is a dead
  end. Gauge design: official reading as anchor plus self-metered delta, gap logged to
  `events.jsonl` as a calibration event; readings over ~90 minutes old are estimated-only; absent
  or unparseable block means no reading, never zero; the parse never throws. Downgraded to amber
  because S1 proved SDK sessions never refresh the block, so for a Conductor-driven account the
  official reading has unbounded staleness. Emphasis flips: self-metering is the primary number,
  the official reading is a calibration anchor applied whenever a fresh one appears.

### S3, `/compact` behaviour through the SDK

- [x] Send `/compact` with focus instructions on a resumed session. Confirm the focus is honoured.
- [x] Confirm the compact boundary is visible to the host program.
- [x] If flaky, verdict is amber and M1 ships fresh cut only, which is the preferred mode anyway.
- Verdict file: `docs/spikes/s3-compact.md`
- Evidence: **Green.** `/compact` sends as a plain prompt in a streaming session; focus
  instructions reach the summarizer (seen verbatim in the PreCompact hook) and steer recall: after
  compacting with "preserve only the codename", the model recalled the codename and reported the
  other two planted facts unknown. Boundary visible four ways: status messages, PreCompact,
  PostCompact (carries the summary), and `compact_boundary` with pre/post token counts and
  `trigger: manual` vs auto. Caveats: focus steers but does not redact (dropped facts were still
  quoted inside the summary text), the summary confabulated a sentence, and the compact turn
  reports zero usage so the gauge must estimate compaction cost from `pre_tokens`. All three
  caveats argue for fresh cut as default, which the spec already chose. Two bonus finds,
  characterized in the addendum: the stream carries an undocumented `rate_limit_event` (typed in
  the SDK's own d.ts) that fires when limit info changes and carries a status of allowed, warning,
  or rejected; and the SDK `Query` object exposes an experimental usage method that returns the
  full official usage data (both windows, per-model buckets, extra-usage credits, `is_active`)
  fresh from the live session on demand.

### S4, usage buckets

- [x] Confirm which bucket SDK usage currently lands in, given Anthropic paused the billing split
      on 2026-06-15.
- [x] Confirm the gauge design holds if a separate SDK credit ships later. Buckets are plural from
      day one.
- Verdict file: `docs/spikes/s4-buckets.md`
- Evidence: **Green.** SDK usage draws from ordinary plan limits today; Anthropic's help article
  (updated 2026-06-16) says so plainly and no later announcement changes it. Bucket model per
  account: `session_5h`, `weekly_all`, `weekly_scoped` (one per model, discovered not hardcoded),
  `extra_usage_credit` when enabled, and `sdk_credit` as a discovery-based placeholder. Hazard
  found: the work account has extra-usage credits enabled, so overrunning the plan limit there
  spends real money instead of stopping; pacing must treat that boundary as hard. Also:
  `is_active` means binding-now, not populated or highest; and `.claude.json` can hold duplicate
  keys differing by drive-letter case, so the gauge parser must tolerate them.

### S5, Windows service ergonomics

- [x] Auto-start at login on Windows 11, without admin rights if possible.
- [x] Keep-awake while sessions run, and released when they stop.
- [x] Bind a server to the Tailscale interface only, and prove nothing else is listening.
- Verdict file: `docs/spikes/s5-windows.md`
- Evidence: **Amber.** All three work without admin, each with a caveat. Auto-start: PowerShell
  `Register-ScheduledTask` at logon works for a standard user on this Azure AD machine while
  `schtasks.exe` and raw COM are denied, so the installer must use the cmdlet; a `wscript` VBS
  wrapper is load-bearing to avoid a visible console window; HKCU Run key is the fallback.
  Keep-awake: `SetThreadExecutionState` from a PowerShell child, proven by the API's own return
  values since `powercfg /requests` needs admin; refcount and release on last session end; ~89 MB
  holder cost suggests an in-process binding at M1; Modern Standby means it beats the idle timer
  but not a lid close. Tailscale bind: single-address `listen` proven (nothing on 0.0.0.0 or
  loopback, other interfaces refused), `EADDRNOTAVAIL` is the down-interface failure mode and the
  daemon must keep the loopback door and retry rather than widen. Caveat: Tailscale on this
  machine is in NoState with no IP, so the bind was proven as a technique, not against a live
  Tailscale address. All test artifacts were removed.

**M0 finish line:** five verdict files exist, all green or amber with a written fallback. Kane
reads the summary. If S1 is red, this run ends here per D8.

**M0 closed 2026-08-01.** S1 green, S2 amber, S3 green, S4 green, S5 amber. No reds. Fallbacks:
S2's staleness is covered by the gauge source stack in the decisions log; S5's caveats are
recorded in its evidence and the Tailscale live-bind check is parked until Kane runs
`tailscale up` (needed before M5, not before M1).

## M1, engine

Build only what the spec lists for M1: daemon, one SDK session, `finish_task`, fresh cut, gauge
line with context fill plus self-metered usage, `events.jsonl`, minimal CLI door. No playbook
enforcement, no pacing, no VS Code panel, no phone page. Those are M2 and later.

### Scaffold

- [x] `package.json`, `tsconfig.json`, TypeScript, Node, terse modern style. Dependency list stays
      short and each unusual one is justified here.
- [x] `src/` layout agreed and written down in this file before code lands. See below.
- [x] `.gitignore` that makes it impossible to commit state, logs, or credentials. (Landed with
      M0: node_modules, `*.jsonl`, `handoffs/`, `.conductor/`, `.env`.)
- Evidence: Slice 1 landed on `feat/m1-engine` with the state layer (below). Zero runtime deps.
  Dev deps: `typescript`, plus `@types/node` because `tsc --noEmit` cannot resolve `node:fs`
  without it; types only. Type stripping confirmed working on Node 24.11.1, `tsc --noEmit` clean.
  `package-lock.json` gets committed in slice 2 for reproducibility. Full output in
  `docs/notes/m1-slice1-findings.md`.

Agreed `src/` layout (architect, 2026-08-01). Runtime deps: `@anthropic-ai/claude-agent-sdk` and
`ws`, nothing else without a justification line here. Node 24 runs TypeScript directly via type
stripping, so no build step and no bundler in v1.

```
src/
  main.ts          entry: daemon bootstrap, wiring, shutdown
  config.ts        paths (%USERPROFILE%\.conductor, env-overridable), account dir registry
  state/
    logbook.ts     events.jsonl append-only writer, one function per event kind
    handoffs.ts    handoffs/ folder, one file per finished task
    playbook.ts    playbook.md read + seed (M1 injects, does not enforce)
  engine/
    session.ts     one SDK session: spawn against an account dir, stream, resume
    finish-task.ts the finish_task in-process tool
    cut.ts         fresh cut: end session, carry handoff into the next
    gauge.ts       source stack: experimental usage method, rate_limit_event,
                   .claude.json file read gated on fetchedAtMs, self-metering floor
  server/
    http.ts        HTTP + WebSocket on 127.0.0.1 only
  cli.ts           thin client: status, gauge, add task, run task, tail log
```

### State layer

- [x] Resolve `%USERPROFILE%\.conductor\` and create it on first run. Path overridable by env var.
- [x] `events.jsonl` append-only writer. One line per meaningful event, per the spec's Logbook
      section.
- [x] `handoffs/` folder, one file per finished task.
- [x] `playbook.md` seeded with a starter page. M1 reads and injects it. M1 does not enforce it.
- Evidence: Slice 1, commit `5f338e4` on `feat/m1-engine`. `CONDUCTOR_HOME` override works; two
  runs against a scratch home proved idempotent seeding (a hand-edited playbook survived run two,
  `events.jsonl` grew to two `daemon_start` lines). Handoff write/read round trip lossless on all
  five fields. Logbook survived a forced write failure (EISDIR) by logging to stderr and
  continuing. Gauge readings type absent-vs-zero correctly (`percent: number | null`) per the S2
  and S4 rules. Account registry seeds placeholders only; real account dir names stay out of the
  repo per the scrub rule. Verification output in `docs/notes/m1-slice1-findings.md`.

### Session runner

- [x] Start one Agent SDK session against a chosen account config dir.
- [x] Stream turns out to whoever is connected.
- [x] Per-task trust level controls the permission mode, per D9. Destructive actions always stop.
- Evidence: Slice 2, commit `b721536` on `feat/m1-engine`. Sessions run per task with
  `CLAUDE_CONFIG_DIR` from the account registry and the API key stripped from the child env.
  Trust maps attended to default permissions and autonomous to acceptEdits scoped to the task
  cwd, never bypassPermissions. Messages stream to a callback for the doors. The destructive rail
  is enforced in `canUseTool`, which the SDK warns can be shadowed by allow-rules in the user's
  own settings files: strong against the model, weak against settings. Slice 3 (commit `3a767e0`)
  moved the rail to a `PreToolUse` hook with `canUseTool` kept as layer two, every stop logged as
  a `rail_stop` event. Proven live: an attended task's file deletion stopped until y was typed at
  the CLI; the same action under autonomous trust with no door attached was denied, logged with
  `door: null`, and the file survived. One SDK wrinkle measured and fixed: `canUseTool` still
  fires after a hook allow, which double-prompted the human until a one-shot ticket was added.

### The cut

- [x] `finish_task` in-process tool. Input: handoff note, outcome verdict, optional follow-up tasks.
- [x] Fresh cut. End the session, start the next task in a new one, feed back only the handoff note
      and pointers.
- [~] Mid-task checkpoint works through the same tool, no second mechanism.
- [x] PreCompact hook logs every backstop auto-compact, because each firing means the loop failed.
- Evidence: Slice 2. A two-task Haiku chain ran end to end: task 1 called `finish_task` with a
  real handoff and one follow-up, the cut fired (`finish_task` returning does not end a session,
  so the tool schedules `query.interrupt()`), task 2 started in a new session and quoted the
  handoff it received. The tool loads with `alwaysLoad` so no turn is wasted finding it.
  Checkpoint is `[~]`: the mechanism is the same tool as specced, but the trigger signal has a
  gap, see the open question on mid-task gauge refresh.

### Gauge

- [x] Context fill percentage from the SDK, per session.
- [x] Self-metered token usage summed from every SDK result message, per model, per account, per
      rolling window.
- [x] Official percentage source if S2 found one. Otherwise self-metering only, clearly labelled.
- [~] One-line status injected into every turn. Calm wording. Includes the standing sentence that
      there is ample room to finish the current step.
- Evidence: Slice 2. Four-layer stack live: the experimental usage probe returned real
  `official_live` readings with reset times during the chain run, `rate_limit_event` is logged as
  `limit_event`, the file read is gated on `fetchedAtMs`, self-metering always on, and a
  calibration event fired comparing prediction to official. Injection is the documented
  `UserPromptSubmit` hook (`additionalContext`), which fires per user prompt; M1 sends one prompt
  per task, so the line lands at task top and does not refresh mid-task. Box stays `[~]`; see the
  open question.

### Doors

- [x] HTTP plus WebSocket server on 127.0.0.1 only.
- [x] CLI: start the daemon, show status and gauge, add a task, run a task, tail the log.
- Evidence: Slice 3, commit `3a767e0`. Endpoints: `/status`, `/gauge`, `/events?tail=N`,
  `POST /tasks`, `POST /run`, `/ws` for streamed turns, approvals both ways, and messages into a
  running session (documented streaming-input surface; honest limit: a task still ends at its
  first result message, so mid-turn only, not a chat channel yet). `netstat` shows
  `127.0.0.1:7719` only, the LAN address refuses, a second daemon exits `EADDRINUSE`, and bind
  failure exits loudly rather than widening. CLI has all five commands plus `daemon` and `watch`;
  pure HTTP/WS client with no direct state access, per one-engine-many-doors. Transcripts in
  `docs/notes/m1-slice3-findings.md`.

### Review and land

- [x] Sol review, scoped tightly, one dimension per ask. Findings written to a file.
- [~] Findings resolved or explicitly parked with a reason. Fix slice landed: 18 of 20 fixed and
      mechanically demonstrated, 2 parked (handoff disk recovery and follow-up queueing, both
      belong to M2's durable queue), none contested. Closure table with evidence per finding in
      `docs/notes/m1-fixslice-findings.md`. Box closes when the Sol re-check passes.
- [x] Sol re-check of the security fixes (one pass, diff-focused). **Failed**, eight findings,
      only one pass 1 item closed on its own terms. Raw output and triage:
      `docs/notes/sol-review-m1-recheck.md`. Merge blocked; fix round 2 below.
- [ ] Fix round 2: close the re-check findings under the v1 threat model, then a final Sol pass
      on the classifier alone.
- [ ] Merge to main.
- Evidence: Three passes run 2026-08-01 (security, loop correctness, gauge honesty), raw output
  and a triaged summary in `docs/notes/sol-review-m1-*.md`, commit `574bf90`. Twenty findings,
  none judged false positive, one already known. The serious five: (1) the WS/HTTP channel has no
  auth, no Origin check, and content-type-blind JSON parsing, so a loopback-reachable page could
  queue, start, and self-approve an autonomous task; (2) interpreter wrappers (`cmd /c del`,
  `node -e`, `git -C x reset --hard`) classify as safe and defeat the destructive rail;
  (3) a failed live probe leaves the last reading cached and still labelled `official, live`, the
  gauge's one unforgivable lie; (4) self-metering has no rolling window, letting calibration
  learn nonsense; (5) a session that dies without `finish_task` still consumes the task, drops
  the carry, and logs a cut that never happened. Fix slice covers all twenty plus the four
  finish-line wrinkles.

**M1 finish line:** a real task runs end to end in `~/repos/nexwave-apps`. Claude works it, calls
`finish_task`, the context is cut on purpose, the next task starts clean with the handoff note, the
gauge line appears on every turn, and `events.jsonl` holds the full story. Raw terminal output
pasted into this file.

**Run 2026-08-01, the loop held.** Two Haiku tasks through the real daemon and CLI, 92 seconds,
one tap. Task 1 (attended) indexed `fieldbook/` and wrote `conductor-demo/index.md` only after a
real approval was answered y at `conductor watch`. Fresh cut fired, task 2 started on a new
session 1.5 seconds later, autonomous, confined to the demo folder, and wrote `summary.md` from
the handoff alone; its own handoff names all four things it used from the note. Gauge moved as
designed: task 1 opened on `official, from disk` at 0 self-metered tokens, task 2 saw
`official, live` on both windows with 212.2k self-metered, and one calibration event fired with
gap 0. No backstop compacts, no rail stops. Nothing in nexwave-apps changed except the two new
files; no git ran there. Full transcripts and events trail:
`docs/notes/m1-finishline-findings.md`. Four wrinkles captured, not patched, listed under open
questions; they go to the Sol review and one fix slice.

## Parked for later milestones

Written down so they do not leak into M1.

- M2: playbook enforcement and hard rails, task queue with pacing, subagent registry, compact cut.
- M3: VS Code panel.
- M4: account layer proper, switcher replacement, cross-account gauge.
- M5: Tailscale phone page.
- M6: scheduled review task that edits the playbook with evidence.
- M7: external runners, headless Codex first, cross-vendor gauge buckets.

## Open questions

Things not settled. Add to this list rather than guessing.

- Do two simultaneous SDK sessions on two different `CLAUDE_CONFIG_DIR` values interfere? S1 only
  ran them sequentially. Must be answered before M4, ideally as a two-minute test during M1.
- Answered 2026-08-01: the SDK stream DOES surface limit data in-band, two ways (S3 addendum).
  `rate_limit_event` is too thin to anchor the gauge (optional fields, one window per event, once
  per session at flat usage); use it as a pressure interrupt when `status` leaves `allowed`. The
  experimental usage method on `Query` is the fresh official anchor for the running account,
  called at task boundaries and wrapped defensively since the SDK's own name says not to rely on
  it. Watch item: both are undocumented; if either breaks in an SDK update the gauge must degrade
  to file read plus self-metering without erroring.
- The two accounts have different bucket shapes: work has usage credits enabled with a monthly
  limit, personal has them disabled. The cross-account gauge cannot assume one layout.
- Tailscale is installed but in NoState with no IP on this machine. The live Tailscale bind check
  from S5 re-runs once Kane logs Tailscale in. Blocks M5 only.
- From the finish line run, four wrinkles for the fix slice: (1) attended approvals of ordinary
  work write no events.jsonl line, only rail verdicts log, which breaks "every decision is
  logged"; (2) attended trust never asked about Read, Glob, or two Bash ls calls, and it is not a
  settings shadow, so the SDK's default-mode auto-allows need mapping before D9 can be called
  fully honest; (3) task 2 credited a CLAUDE.md above its cwd, so a fresh cut is not a clean
  room, parent CLAUDE.md files flow in (platform behavior; document it, decide if the playbook
  should mention it); (4) `daemon_stop` never logs because Windows cannot deliver SIGINT to the
  child, needs a Windows-appropriate shutdown path. Update: 1 and 4 fixed in the fix slice; 2
  documented in the fix-slice findings; 3 investigated and found worse than expected, see next.
- The platform injects the logged-in account's email address into every session prompt, and a
  parent CLAUDE.md reaches a fresh session verbatim. Conductor keeps identities out of its own
  state and the platform puts one in the prompt anyway. Needs an explicit `settingSources`
  decision in M2: which setting sources a Conductor session loads, balancing clean cuts against
  genuinely wanted project CLAUDE.md files. Conductor must never log prompt text in the meantime.
- Follow-up tasks from `finish_task` are recorded but not auto-queued; the carry lives inside one
  `runTasks` call. Known M1 shape; the real queue is M2's first job.
- Mid-task gauge refresh. The spec says the gauge line is injected every turn; the documented
  injection point fires per user prompt, and the one-task-one-prompt loop means once per task.
  So the mid-task checkpoint currently has no live trigger between prompts. Candidate fixes for
  M2, in preference order: a PostToolUse-style hook if it can carry additionalContext, or the
  service watching gauge state and calling `interrupt()` plus a checkpoint instruction when a
  threshold trips. Spec wording may need a revision 3 touch here; flag for Sol.

## Decisions log

Append here when a design call is made during the build. Date, decision, reason, one line each.

- 2026-08-01. Plan created from SPEC.md revision 2 after a decision round with Kane. See the
  ratified decisions table.
- 2026-08-01. Gauge emphasis flipped: self-metering primary, official `cachedUsageUtilization`
  reading as calibration anchor only. Reason: S1 proved SDK sessions never refresh the block.
- 2026-08-01. Pacing must treat session startup as a unit of spend, not just conversation. Reason:
  S1 measured ~26k cache-creation tokens for a cold 10-token `query()`. Session reuse and cut
  cadence are cost levers, and a fresh cut is not free.
- 2026-08-01. Publishing scrub rule for this repo, which is public: committed docs never carry
  exact personal utilization percentages (characterise as low, mid, high, or withheld) and never
  name the third account folder; it is `.claude-third` in all committed text. Timestamps, token
  counts, and field names are fine. Ratified by Kane before first push.
- 2026-08-01. Extra-usage credits are a hard pacing rail, not a soft one. Reason: S4 found the
  work account overruns into paid credits instead of stopping. The playbook's hard rails must
  include never crossing from plan usage into paid credits without a human tap.
- 2026-08-01. Fresh cut confirmed as default cut mode with evidence, not just preference. Reason:
  S3 showed compact focus steers but does not redact, summaries can confabulate, and compaction
  cost is invisible to usage reporting.
- 2026-08-01. Gauge source stack settled: (1) the SDK's experimental usage method for the account
  running a session, at task boundaries, defensively wrapped; (2) `rate_limit_event` as a live
  pressure interrupt; (3) `.claude.json` file read for idle accounts, gated on `fetchedAtMs`;
  (4) self-metering always on as the floor and calibration substrate. Every layer degrades to the
  next without erroring.
- 2026-08-01. `zod` accepted as the second runtime dependency. Reason: the SDK's `tool()` takes a
  zod schema and ships zod only as a peer dependency; declaring it beats silently relying on
  hoisting. Runtime deps are now exactly two: the SDK and zod.
- 2026-08-01. `ws` accepted as the third and final M1 runtime dependency (D6 transport), with
  `@types/ws` dev-only because `ws` ships no types. M1 runtime deps are closed at three.
- 2026-08-01. Approvals carry provenance: an approval result records which door answered, and a
  denial with no door attached logs `door: null`. Reason: the engine cannot know a door is real;
  logging the difference between "denied by human" and "denied because nobody was watching" is
  what the review loop will need.
- 2026-08-01. The destructive rail flips from blocklist to deny-by-default (architect call after
  Sol pass 1). Any command whose effect the classifier cannot positively vouch for is treated as
  risky: approval in attended, denied in autonomous. Reason: Sol showed interpreter wrappers walk
  through any blocklist; a list of bad strings can never be complete, a list of vouched-safe
  shapes can be honest. D9 stands unweakened.
- 2026-08-01. v1 threat model written down (architect call after the Sol re-check): Conductor
  defends against a hostile page reaching loopback and against the model misusing tools. It does
  NOT defend against a hostile process already running as Kane's user, because such a process can
  read Claude Code's own credential files directly and owns the account regardless of anything
  Conductor does; OS-level user isolation is the real boundary there. Sol's token-hardening
  findings that assume a same-user attacker (token file readable, hard links, icacls fail-open)
  are parked under this call, revisit if Conductor ever runs multi-user.
- 2026-08-01. Interpreters are never vouched safe, no exceptions (architect call closing the
  re-check's worst hole). `node x.js`, `python`, `deno`, anything that executes a file the
  session can write, is always risky: tap in attended, denied in autonomous. Vouched-safe shell
  shapes shrink to bare known command names only (no paths, no .cmd/.bat/.ps1 resolution, no
  redirection, arguments checked against per-command safe-flag lists). Convenience lost is the
  price of a rail that means something.
- 2026-08-01. First real queue content after M1 merges: the assessment program in nexwave-apps
  (`assessment-program/VISION.md`). Blocked on Kane answering the five blocking questions in
  `assessment-program/QUESTIONS.md`; the vision then goes to Sol per its own header before an
  implementation plan exists.
