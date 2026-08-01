# Conductor working notes for Claude

A self-managing harness for Claude: an Agent SDK daemon that gives Claude live usage numbers, a
rewritable policy file, and memory, so it manages its own context, pacing, and model choice.

**[`SPEC.md`](SPEC.md) is the source of truth.** Read it before non-trivial work. When a decision
changes, change the spec in the same commit as the code. Code that drifts from the spec is a bug
in one of them; say which.

## Response style

Talk to Kane like he is smart but not technical. Short sentences, plain words, answer first, then
brief explanation. Lists only for real lists. No em dashes, ever, in replies or in any file. No
process narration. End with "What you need to do" only when action is actually needed.

## Working style

- **Fable is the architect.** The main thread holds design and sequencing and pushes execution
  down to subagents. Do not build in the main thread.
- **Builder does the tasks.** Delegate bounded work to `subagent_type: "builder"`
  (`.claude/agents/builder.md` pins Opus at medium effort). A good brief names the files it may
  touch, the deliverable, and the finish line. Numbers in briefs are advisory; the builder
  recomputes them.
- **Sol is the adversarial reviewer.** Sol = Codex at extra-high reasoning, via the codex CLI or
  the codex MCP tool. All major work and every spec change goes to Sol before it lands. Scope Sol
  tightly: one dimension per ask, named files, a brief of roughly fifteen lines. Kane ratifies;
  Kane does not review.
- **Every subagent writes findings to a file** and returns roughly ten lines plus the path.

## Golden rules

1. **Subscription only.** `ANTHROPIC_API_KEY` stays unset everywhere. No credentials, tokens, or
   telemetry in this repo or in Conductor's state files, ever. Logins stay where the official
   tools store them.
2. **Simplicity budget.** State is three plain things (playbook, logbook, handoffs) and Claude
   gets one custom tool in v1. Every feature must justify its bytes. When in doubt, leave it out.
3. **Spike before building on platform behavior.** Anything resting on undocumented Claude Code
   or SDK behavior gets a throwaway script and a written verdict first (see SPEC.md M0). Docs
   claims carry a URL.
4. **Verify before claiming done.** A spike is done when its verdict file exists. Code is done
   when you ran it and watched it do the thing. Build success is not verification. Report
   failures verbatim.
5. **This repo may go public.** Write everything, including commit messages and comments, as if
   it already is. The publishing posture in SPEC.md is binding: no hosted version, no bundled
   credentials, no limit-dodging framing.

## Conventions

- TypeScript, Node. Terse modern style; comments explain why, not what.
- Branch off `main`, never commit straight to it once code exists. Prefixes: `feat:` `docs:`
  `chore:` `fix:` `spike:`. End commit messages with the Co-Authored-By: Claude line.
- Windows is the first-class platform. Quote paths; Kane's user directory contains parentheses.
- `AGENTS.md` mirrors this file for Codex. It is a pointer; keep it one.
