# Conductor, a self-managing harness for Claude

Working name: **Conductor**. Placeholder, rename freely. Revision 4, 2026-08-01: revision 3 plus
the inbox, continuous brain dumps, and provenance grading. Revision 3 the same day added the
reversibility model and the permissive default, a fourth state thing (the notebook), subagent
account routing, evidence-backed finish_task, and dropped compact cut. Written after M0's five
spikes and M1's build, so the platform claims here are measured, not assumed. This repo is
Conductor's home.

One line: a small always-on service on the laptop that runs Claude sessions through the Claude
Agent SDK and gives Claude the three things it needs to manage itself: live numbers, rules it can
rewrite, and memory of what happened. The human stops babysitting context, limits, and model
choice.

## The bet

Claude is better than a human at deciding when to cut context, what deserves an expensive model,
and when to slow down before a usage limit. Today it cannot act on that judgment because the
standard apps give it no numbers and no buttons. Conductor supplies both and then stays out of the
way. The intelligence stays in the model. The tool stays small.

## Goals

1. **Context is managed, never endured.** One task, one cut. Claude finishes a bounded task, hands
   off, and the context is cut on purpose. Context never balloons until auto-compact fires on its
   own. Auto-compact remains only as an emergency backstop.
2. **Limits never halt progress, and paid usage never goes to waste.** Claude sees the 5-hour and
   weekly numbers for every account, paces heavy work, queues what can wait for a reset, and spends
   remaining headroom on cheap useful work instead of leaving it unused.
3. **The right model at the right moment.** Claude chooses main-session and subagent model and
   effort per task from a written policy: Fable for the hardest calls, Opus for building, Sonnet or
   Haiku for routine work.
4. **Subagents at every level.** A registry of named subagent profiles, each with default model and
   effort, all overridable per task by policy.
5. **It learns.** Every number and decision is logged. A periodic review turns the log into edits to
   the policy file. Management gets better with use.
6. **Faces where Kane works.** A VS Code panel as the main face, and a phone page over a private
   network to continue or start laptop sessions from an iPhone.
7. **Accounts are first class.** Fast switching between Claude accounts, per-session account choice,
   and usage shown across all accounts in one gauge. Folds in the existing account-switcher
   extension.

## Non-goals for version 1

- No hosted or paid offering of any kind, ever, without Anthropic approval (see Publishing
  posture). The repo may be public; the tool is self-run.
- No visual polish race with the official Claude Code extension. The chat surface starts plain.
- No cloud backend. Everything runs and stays on the user's devices.
- No bundled credentials and no API-key requirement: subscription login, brought by the user.

## Design principles

- **Give Claude eyes, rules, and memory. Do not build a boss.** Conductor never overrides Claude's
  judgment except at a few hard rails written in the policy file.
- **Reversibility buys permission.** The reason to interrupt a human is that a mistake is expensive
  to undo, so Conductor attacks the undo instead of the permission. It checkpoints the work before
  every task, which makes almost everything inside a project folder erasable with one command.
  Work that is reversible runs without asking and is reported afterwards. Work that is not
  reversible stops for a human. The permissive default is earned by the checkpoint, never assumed.
- **Provenance outranks convenience.** What the human said in their own words is the strongest
  input. A pick from options an AI framed is weaker, because the framing is the AI's; such picks
  are marked and re-put later in plain terms. An AI recommendation is marked as one and never
  quietly promoted into the human's position. Losing this distinction is how a plan ends up
  reflecting the assistant's assumptions while everyone believes it reflects the human's.
- **Scope by place, not by command.** Guessing which commands are dangerous is a losing game; an
  adversarial review of v1 walked through the first two attempts. Inside an allowlisted project
  folder, near-total freedom. Outside it, a hard stop regardless of trust level. Place is a
  boundary Conductor can enforce honestly.
- **Simplicity budget.** State lives in four plain things: one policy file, one log file, one
  folder of handoff notes, one notebook of durable findings. Claude gets one custom tool in v1.
  Every feature must justify its bytes, and new ones are paid for by dropping old ones: the
  notebook was paid for by dropping compact cut.
- **The cut point is the control point.** Because context is cut at task boundaries, every boundary
  is also the free moment to change model, effort, and account. One mechanism serves three goals.
- **One engine, many doors.** VS Code, phone, and terminal are thin faces over the same service.
  No capability lives in only one face.
- **Trust but verify the platform.** Anything resting on undocumented behavior is marked, spiked
  first, and given a fallback.

## Architecture

```mermaid
flowchart LR
    subgraph laptop [Laptop, always on]
        D[Conductor service\nTypeScript daemon]
        SDK[Claude Agent SDK\nClaude Code engine]
        P[playbook.md\npolicy, 1 page]
        L[events.jsonl\nlogbook]
        H[handoffs/\ntask notes]
        N[notebook.md\ndurable findings]
        I[inbox/\nraw brain dumps]
        D --> SDK
        D --- P
        D --- L
        D --- H
        D --- N
        D --- I
    end
    VS[VS Code panel] --> D
    CLI[Terminal] --> D
    subgraph phone [iPhone, via Tailscale only]
        M[Mobile web page]
    end
    M --> D
    SDK --> A1[(Account 1 login)]
    SDK --> A2[(Account 2 login)]
```

The **service** is a single TypeScript daemon (Node) started at login. It owns all sessions, all
state files, and the local web server for the doors. VS Code talks to it over a local socket. The
phone talks to it only over the Tailscale interface.

The **engine** inside each session is the Claude Agent SDK: full Claude Code (tools, skills,
CLAUDE.md, MCP, subagents, hooks) as a library. Conductor adds its own pieces around it.

## The core loop: one task, one cut

```mermaid
sequenceDiagram
    participant K as Kane (any door)
    participant C as Conductor
    participant CL as Claude (SDK session)
    K->>C: add task (or Claude queued it earlier)
    C->>C: pick account, model, effort from playbook + gauge
    C->>CL: start or resume session, inject gauge line + handoff note
    CL->>CL: works the task (subagents per policy)
    CL->>C: finish_task(handoff, outcome, next tasks)
    C->>C: log everything to events.jsonl
    C->>CL: cut context (fresh session, or /compact with Claude's notes)
    C->>C: next task begins small and clean
```

Mechanics, all on documented SDK surface:

- **The tool.** Claude gets one custom in-process tool, `finish_task`. Input: a handoff note (what
  was done, what matters, open threads), an outcome verdict, evidence backing that verdict, and
  optional follow-up tasks for the queue. Calling it is how Claude asks for the cut.
- **Evidence, not claims.** A verdict of done must carry a pointer to what was run and what was
  seen; the service rejects a bare claim and asks again. This is the "verify before claiming done"
  rule moved out of the culture and into the mechanism, after a v1 review found twenty defects in
  work that had already been reported as finished.
- **The cut.** One mode in v1: **fresh cut**. The service ends the session and starts the next task
  in a new one, feeding back only the handoff note and pointers. Claude wrote that summary
  deliberately, which beats any automatic compaction. Compact cut was specced in revision 2 and
  dropped in revision 3: the spike found that focus instructions steer the summary without
  removing anything, that summaries invent details, and that compaction's own token cost is
  invisible to usage reporting. It was a second mechanism earning its keep on nothing.
- **The checkpoint.** Before each task in a git project, the service commits the working tree to a
  Conductor branch. This is what makes the permissive default safe, and it gives every door a
  one-command undo of the last task.
- **Mid-task checkpoint.** If the gauge runs high mid-task, the injected gauge line tells Claude to
  call `finish_task` early with a checkpoint handoff. Same tool, no second mechanism.
- **Backstop.** Auto-compact stays enabled as the emergency floor. A PreCompact hook logs every
  time it fires, because each firing means the loop failed and the playbook should learn.

## The organs

### Gauge

A one-line status injected into every turn plus a panel in each face. Contents: context fill %,
5-hour % and reset time, weekly % and reset time, per account, and per model where the data allows.
Sources, in order of trust:

1. **Context fill:** the SDK's context usage reading. Documented, per session.
2. **Self-metered usage:** the service sums token usage from every SDK result message it sees,
   per model, per account, per rolling window. Always available, never lies about what we spent,
   but must be calibrated against the official percentages.
3. **Official limit %:** the number Claude Code shows its status line. Getting this outside the
   official UI is the main open technical question (see Risks). The existing account-switcher
   extension already reads cross-account usage somewhere; its source gets absorbed here.

Wording rule for the injected line: calm, no countdown alarm. Include a standing sentence that
there is ample room to finish the current step, because models told they are near a limit can
panic and wrap up early.

### Playbook

`playbook.md`, hard-capped at roughly one page. Plain-language rules Claude reads every turn and
may propose edits to. Examples of the kind of rule it holds:

- Above 70% of the 5-hour window: subagents drop to Sonnet, effort medium; queue Fable work.
- Fable is for design decisions, gnarly debugging, and final review. Never for file sweeps.
- Above 60% context mid-task: checkpoint at the next natural boundary.
- Account rotation order and what each account is reserved for, and the line that separates
  routing work to the account it belongs to from stretching one account's limits.
- Which project folders are allowlisted, since place is the real permission boundary.
- Hard rails the service enforces itself, not just advises: e.g. never start a Fable task above
  85% of its window; the irreversible set in the security section always requires a human tap.

### Inbox

`inbox/`, where raw brain dumps land. The working method this serves: the human dictates a dump
whenever a thought arrives, and keeps doing it for the life of the project. Dumps are the richest
input Conductor gets, because they are the human's own framing rather than a pick from a menu an
AI wrote. So they are treated as source, not as chatter.

Rules that make continuous dumping safe:

- **Raw is kept forever, verbatim.** A dump file is never edited. Everything derived from it,
  vision text, decisions, tasks, points back at the dump it came from. Traceability is what makes
  provenance grading enforceable rather than aspirational.
- **Absorbed at cut points.** A new dump is read at the next task boundary, never mid-task. The
  cut point is already the moment model, effort and account can change; new direction is the
  fourth thing it carries. No new mechanism.
- **Triaged into typed items.** One pass over a dump splits it into new intent, an answer to an
  open question, a reversal of a previous decision, a constraint, a durable fact for the notebook,
  or noise. Each type has one place it goes. Nothing is left as prose to be re-read later.
- **Reversals are loud.** A dump that contradicts a ratified decision never quietly edits it. It
  produces a stated reversal: which decision, what it unwinds, what work is now superseded. This
  is what lets the human dump freely without fear of silently breaking agreed direction.
- **Work in flight is superseded, not deleted.** A queued task the dump invalidates is marked with
  the reason and kept. Running work checkpoints at its boundary and is re-briefed.
- **Order is preserved.** Five dumps overnight process oldest first, and a later one may supersede
  an earlier one. Timestamps are the record.
- **Capture happens away from the laptop.** Most dumps will not be typed at a desk, so the phone
  door takes them from day one, and the inbox accepts a file dropped from anywhere.

### Notebook

`notebook.md`, the fourth state thing, added in revision 3. Durable findings about the world that
outlive any one task: how the platform actually behaves, what a spike proved, what a rail must
never vouch for, where a project keeps the thing everyone looks for. The playbook holds rules, the
logbook holds events, handoffs hold task context; none of them hold facts, so today those facts
live in build notes that only survive because a human keeps updating them.

Claude writes entries as it learns them. Each entry is one fact and its evidence pointer, so a
future session can trust it or re-check it. The review loop prunes the notebook the same way it
prunes the playbook, and for the same reason: an unpruned memory becomes noise, and a page cap
forces the ranking that makes it useful.

### Logbook

`events.jsonl`, append-only. One line per meaningful event: task start and finish with model,
effort, account, token usage, context peak, cut mode, gauge readings, playbook rule fired,
backstop auto-compacts, limit hits, deferrals. Cheap to write, easy to mine.

### Review (the learning loop)

A scheduled Conductor task like any other, run on a cheap model: read the last week of
`events.jsonl`, compare against the playbook, propose playbook edits with evidence, apply the
reversible ones, park the rest for the human. Merge duplicates, drop rules that never fire,
strengthen rules that keep proving right. The playbook page cap forces ruthlessness.

### Task queue

Ordered list of tasks with: prompt, project folder, wanted-by, weight (how heavy it is expected to
be), and any pinned model or account. Sources: the human from any door, and Claude itself via
`finish_task` follow-ups. The service schedules from the queue using playbook and gauge: heavy
tasks wait for resets, light tasks mop up remaining headroom. This is how limits stop halting
progress and paid usage stops going unused.

### Subagent registry

Named profiles passed to the SDK's agents option on every session: e.g. scout (Haiku, low),
builder (Opus, medium), reviewer (Opus, high), advisor (Fable, high, rare). The playbook maps task
types and gauge states to profiles. Claude picks per call; the registry just makes the choices
consistent and loggable.

A profile may also name an account, so subagents do not all drain whichever tank the main session
sits on. This is the point of the plural gauge: parallel work on a full account while another
rests. The honest line, and it belongs in the playbook rather than the code: route work to the
account it belongs to, and use separate accounts because they are separate, never as a scheme to
stretch one account's limits. Pacing and queueing are the legitimate levers, per the publishing
posture.

### Account layer

Each account is a stored login the service can point a session at (config-directory switching, the
same mechanism the existing switcher extension uses). Per task, the service picks the account by
playbook rule. The gauge shows all accounts side by side. Note the policy line below before ever
letting rules move work between accounts automatically.

## Other engines (Sol and friends)

Conductor can orchestrate models beyond Claude, at two levels:

- **Level one, inside sessions, free on day one.** Every Conductor session is full Claude Code, so
  Claude can call other models as tools: the codex CLI from bash, or a codex MCP server, for
  adversarial review (the Sol pattern). The playbook makes it policy ("major work gets a Sol
  review before finish_task"); Conductor just logs that it happened.
- **Level two, Conductor-level runners, a later milestone.** The subagent registry and task queue
  treat a runner as a profile, and a profile may map to an external engine instead of a Claude
  session: a task tagged adversarial-review runs headless Codex directly. The gauge was designed
  for plural buckets, so other vendors' subscription limits sit beside the Claude ones, and the
  pacing brain can shift review work onto whichever tank has fuel.

The boundary: the brain inside a Claude session's loop is always Claude. Other models take part as
tools Claude calls, or as separate jobs Conductor runs beside the Claude ones. In practice this
costs nothing; those are the two shapes the Sol pattern already uses.

## Doors

### VS Code panel (first face)

Webview panel. V1 contents: session list, chat with tool-call display and approve/deny buttons,
the gauge strip, task queue view, and the playbook opened as a normal editable file. Status-bar
item shows the two most urgent numbers. Later: diffs, session history browser, log charts.

### Phone door (iPhone)

A small mobile web page served only on the Tailscale interface. V1 contents: gauge, session list,
continue a session (read latest turns, send a message, approve or deny), start a new session
(pick from an allowlist of project folders, pick account, type the task), the task queue, and a
dump box that drops dictated notes straight into the inbox. Push-style nudges can come later; v1
is pull only.

### Terminal

Thin CLI over the same service for scripting and for headless overnight queues. Lowest priority,
kept alive so no capability becomes VS Code-only.

## Security

- The phone page binds to the Tailscale address only. Nothing listens on the open internet, no
  port forwarding, no third-party relay, content never leaves the user's devices.
- A PIN (or passkey) on the phone page as a second lock on top of device membership.
- Every door authenticates to the service with a per-daemon token, and only the door that was
  asked may answer an approval. A page that merely reaches the local port is not a door.
- **Threat model, stated so the rails can be judged.** Conductor defends against a hostile page
  reaching the local service, and against the model misusing its own tools. It does not defend
  against a hostile process already running as the user, because such a process can read the
  official tools' credential files directly and owns the account regardless. OS user isolation is
  the boundary there, and pretending otherwise would buy theatre instead of safety.
- Approvals: the same permission model Claude Code uses, surfaced as buttons. What stops for a tap
  is decided by reversibility, not by a list of scary commands. The irreversible set is short and
  always stops, on every door, regardless of playbook or trust level: writing outside the
  allowlisted folders, deleting what version control never saw, pushing to a remote, sending
  anything outward, and crossing from plan usage into paid credits.
- Interpreters are never treated as safe, whatever they point at. A session can write a script and
  then run it, so vouching for the runner vouches for anything. Two review rounds of v1 were failed
  on exactly this.
- Project folders reachable from the phone are an explicit allowlist.
- Secrets: no Anthropic credentials in the repo or the state files. Logins stay where the official
  tools store them. `ANTHROPIC_API_KEY` stays unset everywhere so subscription auth is used.
- The laptop must be awake for remote use: setup includes a keep-awake step while sessions run.

## Publishing posture

This repo may be public. Publishing source code is not the thing Anthropic's SDK rule restricts;
the rule is about offering claude.ai login as part of a product or service you provide. Conductor
stays clearly on the safe side of that line:

- Users bring their own Claude Code install and their own login; their usage runs under their own
  agreement with Anthropic. The README says this plainly.
- No hosted version, no paid tier, no bundled or proxied credentials, no telemetry.
- No marketing framed as getting more out of usage limits. Conductor is self-management and
  efficiency: better cuts, better pacing, better model choice.
- The account layer is for managing your own legitimately separate accounts. The playbook must not
  automate schemes whose only purpose is dodging a single account's limits; pacing and queueing
  are the honest levers.
- If Conductor ever grows a real audience or any commercial shape, ask Anthropic first, before
  shipping, using a short plain-language description of what it does.

## Grounding (verified against docs, July 2026)

- The Agent SDK is Claude Code as a library: tools, skills, hooks, subagents, sessions.
  https://code.claude.com/docs/en/agent-sdk/overview.md
- A host program can send `/compact` (with focus instructions) and `/clear` programmatically on a
  continued or resumed session. This is the compact trigger.
  https://code.claude.com/docs/en/agent-sdk/slash-commands.md
- Sessions can be resumed and forked; context usage is readable; PreCompact and PostCompact hooks
  exist (PreCompact can block an auto-compact, neither can start one).
  https://code.claude.com/docs/en/agent-sdk/sessions.md
  https://code.claude.com/docs/en/agent-sdk/hooks.md
- Inside the stock Claude Code apps the model cannot press /compact; that is why Conductor owns
  the loop via the SDK.
- Subscription: SDK and `claude -p` usage currently draws from Claude plan limits. Anthropic
  planned to split this into a separate monthly credit on 2026-06-15 and paused the change on the
  day it was due. Either world works for Conductor; the gauge just tracks the right bucket.
  https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

## Risks and open questions (spike before building)

1. **Subscription auth through the SDK on this machine.** Confirm a hello-world SDK session runs
   on the Max login with `ANTHROPIC_API_KEY` unset and shows up against plan usage. Highest value,
   one hour.
2. **Official limit percentages outside the official UI.** Candidate sources: whatever the
   account-switcher extension reads today, the status-line JSON of a parallel Claude Code process,
   or self-metering calibrated once against the official numbers. Pick in the spike, ship with
   self-metering as the floor.
3. **`/compact` behavior through the SDK in practice.** Answered by the spike: it works, focus
   instructions are honored, and the boundary is visible four ways. Resolved by dropping the
   feature anyway, for the reasons in the core loop section. Kept here because the finding matters
   if compact cut is ever reconsidered.
4. **Billing split returns.** If the separate SDK credit ships later, add it as a bucket in the
   gauge and a line in the playbook. Design assumption: buckets are plural from day one.
5. **Windows service ergonomics.** Auto-start, keep-awake, and Tailscale bind on Windows need one
   honest afternoon of verification.

## Milestones

- **M0, spikes (days):** the five risk items above, each a throwaway script and a written verdict.
- **M1, engine (week 1):** daemon, one SDK session, `finish_task`, fresh cut, gauge line with
  context fill + self-metered usage, `events.jsonl`, minimal CLI door.
- **M2, brain (week 2):** playbook injection and hard rails, task queue with pacing, subagent
  registry with account routing, the notebook, the inbox with dump triage and loud reversals, task
  checkpoints with per-task undo, the permissive default, backstop logging.
- **M3, faces:** VS Code panel v1 (chat, gauge, queue, approvals).
- **M4, accounts:** account layer, switcher-extension merge, cross-account gauge.
- **M5, phone:** Tailscale page with continue, start, approve.
- **M6, learning:** scheduled review task that edits the playbook with evidence.
- **M7, other engines:** external runners in the registry (headless Codex first) and cross-vendor
  gauge buckets.

Ship one milestone at a time. After M1 the tool is already useful: one task, one cut, numbers on
every turn.
