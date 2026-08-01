# Conductor

A self-managing harness for Claude. A small always-on service runs Claude sessions through the
Claude Agent SDK and gives Claude live usage numbers, a policy file it can rewrite, and a log of
what happened, so it manages its own context, pacing, and model choice. One task, one deliberate
context cut.

Status: spec stage. Read [SPEC.md](SPEC.md).

Bring your own Claude: Conductor is self-run tooling around your own Claude Code install and your
own login. Your usage runs under your own agreement with Anthropic. There is no hosted version, no
paid tier, and no bundled credentials.
