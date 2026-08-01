# Sol review, M1 engine, final gate: the command classifier and the rail

Raw output from Sol below the header, then the orchestrator's triage under a separator. Two edits
to Sol's text, both cosmetic and both the same ones the re-check note made: Sol's markdown links
embedded absolute paths on this machine and are collapsed to `session.ts:NNN`, and Sol printed its
report twice (streamed, then final) so one copy is kept. No finding is added, removed or reworded.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief.txt`
- Run from: repo root, branch `feat/m1-engine`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only
- Files in scope: src/engine/session.ts only
- Dimension: the Bash command classifier and both rail layers, false negatives only
- Date: 2026-08-01

Two notes on the run. The first attempt was refused by the provider's cybersecurity filter, because
the brief asked for "the exact command string that bypasses". The brief was rewritten to ask the
same question as a correctness audit of an allowlist against its own stated rule, which is what the
review needed anyway, and that ran. Sol was also told that three re-check findings (token file
same-user readability, hard links, icacls fail-open) are parked under the written v1 threat model
and must not be re-reported. It did not re-report them.

---

It does not match the stated rule. Five false-safe implementation points, worst first:

1. `session.ts:632` omits active expansion and expression syntax.

   - PowerShell input: `echo ([IO.File]::WriteAllText('pwned.txt','x'))`
   - The classifier vouches this because `echo` accepts unchecked positional arguments at `session.ts:682` and `session.ts:805`. PowerShell evaluates the parenthesized expression, which writes the file. Parentheses, braces, commas, pipes and ampersands are PowerShell metacharacters, and `echo` is a `Write-Output` alias. [PowerShell parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing?view=powershell-7.5), [echo alias](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/write-output?view=powershell-7.5)
   - Bash input: `rg {--pre,./evil.cmd,needle,.}`
   - Brace expansion produces `rg --pre ./evil.cmd needle .`, starting the forbidden preprocessor.
   - Cmd input: `echo %CD:~0,3%`
   - Cmd expands the substring expression, but the regex only recognizes `%NAME%`.
   - Breaks Rule 4. The Bash case also defeats Rule 3.

2. `session.ts:864` loses shell word boundaries between adjacent quoted fragments.

   - `git diff "--""output=C:/Users/victim/important.txt"` becomes one `--output=...` argument in Bash. The classifier instead sees `--` followed by a bare word and stops checking flags at `session.ts:850`. Git overwrites the target.
   - `rg "--""pre" ./evil.cmd needle .` becomes `rg --pre ./evil.cmd needle .`. The classifier treats `--` as end-of-flags and vouches the remaining words.
   - `sort "-""o" important.txt` becomes `sort -o important.txt`, creating or truncating the output file. The classifier sees `-`, `o`, and `important.txt` as paths.
   - Breaks Rule 3.

3. The same tokenizer bypasses executable-suffix checking at `session.ts:864`.

   - Input: `"ls".exe`
   - Bash forms the single command word `ls.exe`. The classifier sees command `ls` plus path argument `.exe`, so `session.ts:894` never examines the real command word.
   - Breaks Rule 2.

4. `session.ts:754` treats shell metacharacters as acceptable separators.

   - Inputs: `ls && git status`, `ls | sort`, and `ls & pwd`
   - Each segment is checked independently and the complete command is vouched. The presence of `&&`, `|`, or `&` should itself force escalation.
   - Breaks Rule 4.

5. Two command-specific allowlists contain launching forms.

   - `session.ts:697`: `file -z archive.gz`. `-z` is explicitly allowlisted, but `file` may execute an external decompressor when a built-in one is unavailable. [file manual](https://github.com/file/file/blob/master/doc/file.man)
   - `session.ts:741`: `git remote show origin`. `show` is vouched, but without `-n` Git queries the remote through `git ls-remote`, potentially starting a transport helper. [Git remote documentation](https://git-scm.com/docs/git-remote)
   - Breaks Rule 3.

Both rail layers inherit these results: `PreToolUse` falls through on a null verdict at `session.ts:259`, and the autonomous permission gate explicitly allows it at `session.ts:541`.

---

# Orchestrator triage

Every finding was re-run against the real exported `vouchSafe` from `src/engine/session.ts`, not
read off the page. All eleven probe strings below came back `VOUCHED SAFE`, which means no tap in
attended mode and allowed in autonomous mode:

```
VOUCHED SAFE "git diff \"--\"\"output=C:/Users/victim/important.txt\""
VOUCHED SAFE "rg \"--\"\"pre\" ./evil.cmd needle ."
VOUCHED SAFE "sort \"-\"\"o\" important.txt"
VOUCHED SAFE "\"ls\".exe"
VOUCHED SAFE "rg {--pre,./evil.cmd,needle,.}"
VOUCHED SAFE "echo %CD:~0,3%"
VOUCHED SAFE "echo ([IO.File]::WriteAllText('pwned.txt','x'))"
VOUCHED SAFE "file -z archive.gz"
VOUCHED SAFE "git remote show origin"
```

The shell half was checked too, because a classifier finding only matters if the shell really forms
the word Sol says it forms. `bash -c 'printf "[%s]" ...'` on this machine:

```
"--""output=C:/x/important.txt"   -> [--output=C:/x/important.txt]
{--pre,./evil.cmd,needle,.}       -> [--pre][./evil.cmd][needle][.]
"-""o" important.txt              -> [-o][important.txt]
"ls".exe                          -> [ls.exe]
```

And the worst one end to end, in a throwaway git repo with a victim file outside the task folder:

```
$ git diff "--""output=<outside>/important.txt"
--- victim file now:
diff --git a/f.txt b/f.txt
index 7898192..422c2b7 100644
...
```

`important.txt` held `PRECIOUS ORIGINAL`. It does not any more. A command the rail vouches as a
read overwrote a file outside the task folder with no human asked.

| # | Sol's finding | Call | Why |
|---|---|---|---|
| 1 | Expansion and expression syntax missing from `OPAQUE_SHELL` | **Real, in part** | the bash brace case `rg {--pre,./evil.cmd,needle,.}` is unconditional and runs an arbitrary program, confirmed at both layers; the PowerShell and cmd cases depend on a shell the sessions do not currently use, so they are hardening rather than live holes |
| 2 | `splitArgs` loses word boundaries between adjacent quoted fragments | **Real, worst of the set** | proven end to end above; the same trick re-opens `sort -o` and `rg --pre`, which are two of the six bypasses round 2 claimed closed |
| 3 | The same tokenizer hides an executable suffix, `"ls".exe` | **Real, lower impact** | rule 2 is genuinely broken, but under bash a bare `ls.exe` resolves through PATH and not the task folder, so on its own it is a weaker path to execution than 1 or 2 |
| 4 | `&&`, `\|` and `&` accepted as segment separators | **False positive** | deliberate and documented; each segment is independently vouched, and two vouched reads composed are still a read. Rule 4's wording, not the code, is what is wrong here |
| 5 | `file -z` and `git remote show origin` can launch a helper | **Real, and understated** | `git remote show` reads the remote URL from `.git/config`, which is inside the task folder and which a session may Write, and a git remote URL can name a transport that runs a command. `file -z` is minor by comparison |

One more instance of finding 5's class, found while verifying and recorded as the orchestrator's,
not Sol's: `git diff` is vouched unconditionally, and a session that writes `.git/config` inside the
task folder can set a `diff.external` or `textconv` entry there, which makes the vouched read run a
program of its choosing. Same shape as finding 5, same root, and it needs the same fix.

The parked three were not re-reported, so nothing here is parked.

## Verdict

**This does not pass.** Four of the five findings are real, and three of them (1, 2, 5) each let a
session write outside the task folder or run a program of its own choosing with no human asked and
no denial in autonomous mode. Finding 2 is demonstrated end to end and is merge-blocking on its own.
The common root is that `splitArgs` and `OPAQUE_SHELL` classify a string the shell has not finished
transforming yet, which is the same mistake in kind as the `$HOME` case round 2 fixed by refusing
expansion: the classifier must refuse anything whose final argv it cannot see, including adjacent
quotes, brace lists and a lone `-`. The per-command allowlists also need the config-driven launch
paths (`git remote show`, `git diff` with a written `.git/config`) closed.

Round 2's other closures still stand; nothing above touches the interpreter rule, the environment
scrub, the account resolution or the two-daemon fix. This is the classifier and the classifier only.
