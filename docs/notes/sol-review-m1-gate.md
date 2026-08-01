# Sol review, M1 engine, gate pass: the simplified rail

Raw output from Sol below the first separator. Not edited, not filtered. The orchestrator's triage
is under the second separator.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief-gate.txt`
- Run from: repo root, branch `feat/m1-engine`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only (override of the config default)
- Files in scope: src/engine/session.ts, src/server/http.ts, src/main.ts
- Claimed evidence handed to Sol: docs/notes/m1-railsimplify-findings.md
- Question: can a shell-shaped tool call reach execution without a tap, and can an autonomous task
  start a session
- Parked and excluded from the brief: the three same-user local-token findings, and the `&&` / `|`
  segment point already judged a false positive
- Date: 2026-08-01

---

2026-08-01T11:36:49.823950Z ERROR codex_models_manager::cache: failed to load models cache: missing field `supports_reasoning_summaries` at line 86 column 5
OpenAI Codex v0.144.0
--------
workdir: C:\Users\KaneSnyder(nexwave)\repos\conductor
model: gpt-5.6-sol
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019fbd1c-d549-70f0-90b8-01793bdba9ab
--------
user
Adversarial security review, one narrow question. Repo root is the cwd, branch feat/m1-engine.

Context: this rail failed your review three times. Each time the cause was the same shape: the classifier judged a shell string that bash then kept transforming. The architect stopped patching and deleted the entire vouched-safe mechanism, 285 lines out of src/engine/session.ts. There is now no allowlist at all. Anything shell-shaped is risky, always, so every shell command stops for a human tap. Autonomous trust is refused at queue time and at run time, so nothing runs unattended at all.

Claimed evidence: docs/notes/m1-railsimplify-findings.md. Read it, then verify against the code rather than trusting it.

Files in scope: src/engine/session.ts (classifyRail and both rail layers), src/server/http.ts and src/main.ts (the autonomous refusal gates). Nothing else unless the trail leads there.

The question, deliberately different from last time. It is not "is the allowlist too generous", because there is no allowlist. It is two questions:
1. Is there any path by which a shell-shaped tool call reaches execution without a human answering a tap?
2. Is there any path by which an autonomous task starts a session?

Look specifically for: tool names that are shell-flavored but not matched as shell (aliases the Agent SDK exposes, MCP tools that shell out, anything that spawns a process); a rail layer that can be skipped entirely rather than bypassed; approval auto-answering or a default-allow branch; the refusal gates being reachable around rather than through.

Do not re-report these: the three same-user local-token findings are parked under a written v1 threat model. The && and | escalation point was already judged a false positive.

Concrete findings only. Rank them by severity. Give file and line, and the exact path to execution. If you find nothing, say so plainly.

warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.
codex
I’ll treat the findings note as a claim set, not evidence. I’ll first load the repo’s working rules and the narrow rail/gate implementation, then trace every route from tool call or autonomous request to actual session/process execution. I’ll report only concrete, reproducible paths.
  → Read repo rules, prior findings, and relevant memory index
  • Trace shell-shaped tool calls through classification, tap handling, and execution
  • Trace every autonomous entry point to session creation/start
  • Validate exact lines and report concrete findings only
exec
"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command '$files = @('"'CLAUDE.md','docs/notes/m1-railsimplify-findings.md','src/engine/session.ts','src/server/http.ts','src/main.ts','C:\\Users\\KaneSnyder(nexwave)\\.codex\\memories\\MEMORY.md'); foreach ("'$f in $files) { if (Test-Path -LiteralPath $f) { $item = Get-Item -LiteralPath $f; Write-Output ("{0}`t{1}" -f $item.FullName,$item.Length) } else { Write-Output ("MISSING`t{0}" -f $f) } }; git branch --show-current; git status --short' in C:\Users\KaneSnyder(nexwave)\repos\conductor
2026-08-01T11:37:03.201872Z ERROR codex_core::exec: exec error: windows sandbox: runner failed during SpawnChild: CreateProcessAsUserW failed: 5 (Access is denied.) | cwd=C:\Users\KaneSnyder(nexwave)\repos\conductor | cmd=C:\Users\KaneSnyder(nexwave)\AppData\Local\Microsoft\WindowsApps\pwsh.exe -NoProfile -Command "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}
$files = @('CLAUDE.md','docs/notes/m1-railsimplify-findings.md','src/engine/session.ts','src/server/http.ts','src/main.ts','C:\Users\KaneSnyder(nexwave)\.codex\memories\MEMORY.md'); foreach ($f in $files) { if (Test-Path -LiteralPath $f) { $item = Get-Item -LiteralPath $f; Write-Output (\"{0}`t{1}\" -f $item.FullName,$item.Length) } else { Write-Output (\"MISSING`t{0}\" -f $f) } }; git branch --show-current; git status --short" | env_u16_len=9842 | si_flags=256 | creation_flags=525312 (Windows error 5)
2026-08-01T11:37:03.202442Z ERROR codex_core::tools::router: error=execution error: Io(Custom { kind: Other, error: "windows sandbox: runner failed during SpawnChild: CreateProcessAsUserW failed: 5 (Access is denied.) | cwd=C:\\Users\\KaneSnyder(nexwave)\\repos\\conductor | cmd=C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe -NoProfile -Command \"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n$files = @('CLAUDE.md','docs/notes/m1-railsimplify-findings.md','src/engine/session.ts','src/server/http.ts','src/main.ts','C:\\Users\\KaneSnyder(nexwave)\\.codex\\memories\\MEMORY.md'); foreach ($f in $files) { if (Test-Path -LiteralPath $f) { $item = Get-Item -LiteralPath $f; Write-Output (\\\"{0}`t{1}\\\" -f $item.FullName,$item.Length) } else { Write-Output (\\\"MISSING`t{0}\\\" -f $f) } }; git branch --show-current; git status --short\" | env_u16_len=9842 | si_flags=256 | creation_flags=525312 (Windows error 5)" })
 exited -1 in 0ms:
execution error: Io(Custom { kind: Other, error: "windows sandbox: runner failed during SpawnChild: CreateProcessAsUserW failed: 5 (Access is denied.) | cwd=C:\\Users\\KaneSnyder(nexwave)\\repos\\conductor | cmd=C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe -NoProfile -Command \"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n$files = @('CLAUDE.md','docs/notes/m1-railsimplify-findings.md','src/engine/session.ts','src/server/http.ts','src/main.ts','C:\\Users\\KaneSnyder(nexwave)\\.codex\\memories\\MEMORY.md'); foreach ($f in $files) { if (Test-Path -LiteralPath $f) { $item = Get-Item -LiteralPath $f; Write-Output (\\\"{0}`t{1}\\\" -f $item.FullName,$item.Length) } else { Write-Output (\\\"MISSING`t{0}\\\" -f $f) } }; git branch --show-current; git status --short\" | env_u16_len=9842 | si_flags=256 | creation_flags=525312 (Windows error 5)" })
codex
The managed PowerShell launcher hit Windows error 5 before any command ran. This machine has a known launcher quirk, so I’m pivoting to the Windows command processor for read-only inspection and continuing the same review scope.
exec
"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -NoProfile -Command "C:\\Windows\\System32\\cmd.exe /d /c \"dir CLAUDE.md & dir docs\\notes\\m1-railsimplify-findings.md & dir src\\engine\\session.ts & dir src\\server\\http.ts & dir src\\main.ts & git branch --show-current & git status --short\"" in C:\Users\KaneSnyder(nexwave)\repos\conductor
2026-08-01T11:37:09.170380Z ERROR codex_core::exec: exec error: windows sandbox: runner failed during SpawnChild: CreateProcessAsUserW failed: 5 (Access is denied.) | cwd=C:\Users\KaneSnyder(nexwave)\repos\conductor | cmd=C:\Users\KaneSnyder(nexwave)\AppData\Local\Microsoft\WindowsApps\pwsh.exe -NoProfile -Command "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}
C:\Windows\System32\cmd.exe /d /c \"dir CLAUDE.md & dir docs\notes\m1-railsimplify-findings.md & dir src\engine\session.ts & dir src\server\http.ts & dir src\main.ts & git branch --show-current & git status --short\"" | env_u16_len=9842 | si_flags=256 | creation_flags=525312 (Windows error 5)
2026-08-01T11:37:09.170683Z ERROR codex_core::tools::router: error=execution error: Io(Custom { kind: Other, error: "windows sandbox: runner failed during SpawnChild: CreateProcessAsUserW failed: 5 (Access is denied.) | cwd=C:\\Users\\KaneSnyder(nexwave)\\repos\\conductor | cmd=C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe -NoProfile -Command \"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nC:\\Windows\\System32\\cmd.exe /d /c \\\"dir CLAUDE.md & dir docs\\notes\\m1-railsimplify-findings.md & dir src\\engine\\session.ts & dir src\\server\\http.ts & dir src\\main.ts & git branch --show-current & git status --short\\\"\" | env_u16_len=9842 | si_flags=256 | creation_flags=525312 (Windows error 5)" })
 exited -1 in 0ms:
execution error: Io(Custom { kind: Other, error: "windows sandbox: runner failed during SpawnChild: CreateProcessAsUserW failed: 5 (Access is denied.) | cwd=C:\\Users\\KaneSnyder(nexwave)\\repos\\conductor | cmd=C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe -NoProfile -Command \"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nC:\\Windows\\System32\\cmd.exe /d /c \\\"dir CLAUDE.md & dir docs\\notes\\m1-railsimplify-findings.md & dir src\\engine\\session.ts & dir src\\server\\http.ts & dir src\\main.ts & git branch --show-current & git status --short\\\"\" | env_u16_len=9842 | si_flags=256 | creation_flags=525312 (Windows error 5)" })
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
codex
The written evidence matches the intended policy, but the review now turns on two implementation details: how broadly `classifyRail` recognizes process-capable tools, and whether either SDK permission layer can be omitted or default through. I’m tracing those exact call sites next, including the SDK tool surface the session actually enables.
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (failed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
codex
One concrete seam has appeared: the session leaves the SDK’s filesystem settings and MCP discovery at their defaults. In this SDK version, that means project/user settings are loaded and non-explicit MCP configs are accepted. I’m checking whether this creates startup-time process execution, and separately whether built-in `Skill` or subagent aliases can execute shell outside the two tool gates.
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
2026-08-01T11:39:42.274222Z ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `supports_reasoning_summaries` at line 86 column 5
mcp: node_repl/js started
mcp: node_repl/js (completed)
2026-08-01T11:39:47.935528Z ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `supports_reasoning_summaries` at line 86 column 5
mcp: node_repl/js started
mcp: node_repl/js (failed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
mcp: node_repl/js started
mcp: node_repl/js (completed)
codex
The two advertised HTTP/task-loop gates do work on their own path. The review still found two ways around the shell-tap invariant in the SDK surface, plus one direct way around the autonomous start invariant. I’m pinning the final report to the exact call chain and separating daemon reachability from the exported engine API.
Completed the narrow review. Verified the branch, traced all scoped entry points, and followed the SDK configuration/tool trail where the session options made it relevant.
  ✓ Read repo rules, prior findings, and relevant memory index
  ✓ Trace shell-shaped tool calls through classification, tap handling, and execution
  ✓ Trace every autonomous entry point to session creation/start
  ✓ Validate exact lines and report concrete findings only
codex
Yes to both.

1. **High: SDK hooks and MCP startup processes skip both rail layers.**

   [session.ts:255](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:255>) passes `cwd` and an MCP server but does not set `settingSources: []` or `strictMcpConfig: true`. In SDK 0.3.220, omitting `settingSources` loads user, project, and local settings, while omitting `strictMcpConfig` permits other MCP configurations ([SDK declarations:1900](</C:/Users/KaneSnyder(nexwave)/repos/conductor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1900>), [SDK declarations:1953](</C:/Users/KaneSnyder(nexwave)/repos/conductor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1953>)).

   Exact path:

   `POST /tasks` accepts any nonempty `cwd` at [http.ts:290](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/server/http.ts:290>) → attended task reaches `runSession` → `query()` at [session.ts:331](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:331>) loads that folder’s enabled settings → a `SessionStart` or `UserPromptSubmit` command hook runs through a shell, or an approved stdio MCP configuration spawns its configured executable.

   These are process launches, not tool calls. Therefore neither `PreToolUse` nor `canUseTool` runs, and there is no Conductor tap. The installed SDK explicitly defines shell command hooks and stdio MCP process commands at [sdk.d.ts:5159](</C:/Users/KaneSnyder(nexwave)/repos/conductor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5159>) and [sdk.d.ts:1167](</C:/Users/KaneSnyder(nexwave)/repos/conductor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1167>).

2. **High: a shelling MCP tool can be auto-allowed without matching `classifyRail`.**

   [session.ts:602](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:602>) recognizes only particular underscore-delimited name segments. [commandText at line 661](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:661>) recognizes only the `command` field.

   Exact path:

   An enabled MCP tool named `mcp__ops__run_script`, `mcp__ops__python`, or `mcp__ops__spawn` takes `script`, `code`, or `program` plus `args` → `SHELL_TOOL` does not match and `commandText` returns null → `classifyRail` returns null at [session.ts:639](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:639>) → the hard hook returns no decision at [session.ts:279](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:279>) → an SDK permission allow-rule can shadow `canUseTool`, exactly as the comment at [session.ts:267](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:267>) acknowledges → the MCP handler shells out with no tap.

   I confirmed the real matcher returns false for `mcp__local__run_script`, `mcp__local__python`, and `mcp__local__spawn`. The findings note’s claim that a renamed or added shell tool cannot fall out of scope is false.

3. **Medium: `runSession` itself starts autonomous tasks.**

   The two advertised gates protect the daemon path, but the session boundary does not enforce the invariant. `runSession` is exported at [session.ts:177](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:177>) and never calls `trustRefusal`.

   Exact path:

   A caller imports `runSession` and supplies `task.trust = 'autonomous'` → line 261 selects `acceptEdits` → line 331 starts the SDK query. Structured in-folder tools are then auto-allowed by [session.ts:565](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:565>).

   The current HTTP route does not expose this path: [http.ts:296](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/server/http.ts:296>) rejects autonomous queue entries, and [main.ts:76](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/main.ts:76>) blocks them before calling `runSession`. The bypass is the exported engine API.

I found no default-allow branch in the daemon approver. Missing doors, errors, and timeouts deny. `BashOutput` and `KillShell` are unmatched aliases, but they only read or stop an already-started background task and do not independently launch a command.
tokens used
199,515
Yes to both.

1. **High: SDK hooks and MCP startup processes skip both rail layers.**

   [session.ts:255](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:255>) passes `cwd` and an MCP server but does not set `settingSources: []` or `strictMcpConfig: true`. In SDK 0.3.220, omitting `settingSources` loads user, project, and local settings, while omitting `strictMcpConfig` permits other MCP configurations ([SDK declarations:1900](</C:/Users/KaneSnyder(nexwave)/repos/conductor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1900>), [SDK declarations:1953](</C:/Users/KaneSnyder(nexwave)/repos/conductor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1953>)).

   Exact path:

   `POST /tasks` accepts any nonempty `cwd` at [http.ts:290](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/server/http.ts:290>) → attended task reaches `runSession` → `query()` at [session.ts:331](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:331>) loads that folder’s enabled settings → a `SessionStart` or `UserPromptSubmit` command hook runs through a shell, or an approved stdio MCP configuration spawns its configured executable.

   These are process launches, not tool calls. Therefore neither `PreToolUse` nor `canUseTool` runs, and there is no Conductor tap. The installed SDK explicitly defines shell command hooks and stdio MCP process commands at [sdk.d.ts:5159](</C:/Users/KaneSnyder(nexwave)/repos/conductor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5159>) and [sdk.d.ts:1167](</C:/Users/KaneSnyder(nexwave)/repos/conductor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1167>).

2. **High: a shelling MCP tool can be auto-allowed without matching `classifyRail`.**

   [session.ts:602](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:602>) recognizes only particular underscore-delimited name segments. [commandText at line 661](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:661>) recognizes only the `command` field.

   Exact path:

   An enabled MCP tool named `mcp__ops__run_script`, `mcp__ops__python`, or `mcp__ops__spawn` takes `script`, `code`, or `program` plus `args` → `SHELL_TOOL` does not match and `commandText` returns null → `classifyRail` returns null at [session.ts:639](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:639>) → the hard hook returns no decision at [session.ts:279](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:279>) → an SDK permission allow-rule can shadow `canUseTool`, exactly as the comment at [session.ts:267](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:267>) acknowledges → the MCP handler shells out with no tap.

   I confirmed the real matcher returns false for `mcp__local__run_script`, `mcp__local__python`, and `mcp__local__spawn`. The findings note’s claim that a renamed or added shell tool cannot fall out of scope is false.

3. **Medium: `runSession` itself starts autonomous tasks.**

   The two advertised gates protect the daemon path, but the session boundary does not enforce the invariant. `runSession` is exported at [session.ts:177](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:177>) and never calls `trustRefusal`.

   Exact path:

   A caller imports `runSession` and supplies `task.trust = 'autonomous'` → line 261 selects `acceptEdits` → line 331 starts the SDK query. Structured in-folder tools are then auto-allowed by [session.ts:565](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:565>).

   The current HTTP route does not expose this path: [http.ts:296](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/server/http.ts:296>) rejects autonomous queue entries, and [main.ts:76](</C:/Users/KaneSnyder(nexwave)/repos/conductor/src/main.ts:76>) blocks them before calling `runSession`. The bypass is the exported engine API.

I found no default-allow branch in the daemon approver. Missing doors, errors, and timeouts deny. `BashOutput` and `KillShell` are unmatched aliases, but they only read or stop an already-started background task and do not independently launch a command.

---

# Orchestrator triage

Every claim below was checked against the code before it was labelled. Line numbers re-read, not
taken from Sol.

| # | Sol's finding | Call |
|---|---|---|
| 1 | SDK hooks and MCP startup processes skip both rail layers, because `settingSources` and `strictMcpConfig` are unset | **Real** |
| 2 | A shelling MCP tool named outside the `SHELL_TOOL` pattern is not classified as shell | **Real, and downstream of 1** |
| 3 | `runSession` is exported and never calls `trustRefusal`, so an in-process caller can start an autonomous session | **Real, low** |

**1. Real.** Confirmed: `src/engine/session.ts:255-329` builds `sdkOptions` with no `settingSources`
and no `strictMcpConfig`, and the installed SDK is 0.3.220 as Sol says. Omitting them means the
session loads whatever settings and MCP config the task folder and the user profile carry, and a
`SessionStart` or `UserPromptSubmit` command hook is a process launch rather than a tool call, so
neither the `PreToolUse` rail nor `canUseTool` ever sees it. This is a live path from a session to a
shell with no tap, which is exactly the invariant the round was supposed to establish. It is not a
classifier bug and it is not the token threat model: it fires on the operator's own machine with the
operator's own settings file. Two lines close it.

**2. Real, and downstream of 1.** Confirmed: `SHELL_TOOL` at `session.ts:602` matches `run_command`
and `command` but not `run_script`, `python`, `spawn` or `script`, and `commandText` at
`session.ts:661` reads only the `command` field. So such a tool returns a null verdict at
`session.ts:639`. Two things temper it. Today no third-party MCP server is configured, so the only
way one arrives is the missing `strictMcpConfig` from finding 1. And with a null verdict in attended
mode the call still reaches `session.ts:574` and still costs a generic tap; the silent-allow step in
Sol's chain needs a settings allow-rule, which again needs finding 1. So this is not an independent
escape today. What is independently true is that `m1-railsimplify-findings.md` claims a renamed or
added shell tool cannot fall out of scope, and that claim is too strong. Widen the pattern and the
field list, and correct the note.

**3. Real, low.** Confirmed: `runSession` is exported at `session.ts:177`, never calls
`trustRefusal`, and `session.ts:261` selects `acceptEdits` for autonomous trust. The two advertised
gates are where the note says they are, `src/server/http.ts:296` and `src/main.ts:76`, and no HTTP
path reaches around them. So the only caller who can trip this is code inside this repo. That is a
defence-in-depth gap rather than an attack path, but the note's sentence "nothing runs unattended at
all" is a claim about the system and the engine boundary does not hold it. One call at the top of
`runSession` closes it.

**Not re-reported and confirmed absent:** Sol found no default-allow branch in the daemon approver,
and confirmed missing doors, errors and timeouts all deny. `BashOutput` and `KillShell` are
unmatched by `SHELL_TOOL` but only read or stop a task a matched call already started, so they are
not a launch path. Agreed on all three.

**Verdict: fail.** Finding 1 is a real path from a session to a running process with no human tap,
which is the thing this round exists to rule out. It does not undo the deletion, which held up: no
shell-shaped tool call got through, and the two autonomous gates work. The rail is sound and the
session's SDK configuration is not. Findings 1 and 2 block the merge and are cheap. Finding 3 should
ride along in the same commit, with the two overstated sentences in
`m1-railsimplify-findings.md` corrected.
