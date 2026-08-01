# Sol review, M1 engine, re-check: security

Raw output from Sol. Not filtered. The only edit is that Sol's markdown links, which embedded
absolute paths on this machine, are collapsed to plain `file.ts:line`. Sol printed its report twice
(streamed, then final); one copy is kept.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief.txt`
- Run from: repo root, branch `feat/m1-engine`, HEAD `2917192`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only
- Files in scope: src/server/http.ts, src/engine/session.ts, src/cli.ts, src/config.ts, src/state/token.ts
- Dimension: security only, re-check of pass 1 after commit 52dcf9f
- Date: 2026-08-01

Sol's own shell was blocked by the Windows sandbox, so it read the files directly and probed the
classifier through a node REPL rather than by running the daemon.

---

## Pass 1 closure

| # | Finding | Status | Code basis |
|---|---|---|---|
| 1 | WebSocket approval spoofing | **Not closed** | The bearer is readable by same-user processes, including agent-launched code. Approval ownership goes to the newest socket at `http.ts:193`, so a token-holding helper can make itself the addressee. |
| 2 | Unauthenticated CSRF POSTs | **Closed** | Authentication and Origin checks precede routing at `http.ts:470`; JSON bodies are enforced at `http.ts:547`. |
| 3 | Interpreter wrappers bypass rails | **Not closed** | In-project Node scripts are explicitly vouched safe at `session.ts:668`, regardless of their contents. Git and reader argument handling has further bypasses below. |
| 4 | Junction/symlink outside-cwd bypass | **Not closed** | The realpath check at `session.ts:742` remains vulnerable to hard links and check/use junction replacement. |
| 5 | WebSocket data exposure | **Not closed** | A same-user process or escaped agent can read the bearer, attach, then receive status and replay at `http.ts:117` and all later session messages at `http.ts:385`. |
| 6 | Child environment leaks secrets | **Not closed** | The name denylist at `session.ts:113` misses common credential variables. |
| 7 | State/credential roots inside repos | **Not closed** | Rejected accounts can still be explicitly selected and executed through the raw account registry at `main.ts:77`. The repository check is also lexical. |

## Critical findings

1. **The bearer does not represent a human door, and newest-socket addressing permits self-approval.**

   The token is an owner-readable file at `token.ts:29`. Any process running as the same Windows user can read it. The daemon then chooses the most recently attached socket as the approval owner at `http.ts:193` and accepts its response at `http.ts:161`.

   Trigger: read `daemon-token`, attach a WebSocket after the human watcher, queue and run an autonomous task, then approve every request. An autonomous agent can do the same by reading `$CONDUCTOR_HOME/daemon-token` or `$HOME/.conductor/daemon-token`, launching a detached WebSocket helper, and then requesting the destructive action. Single-use IDs do not help because the attacker is selected as the legitimate addressee.

2. **An in-project Node file is treated as read-only even though it can perform arbitrary operations.**

   `vouchSegment` dispatches `node` to `vouchNode` at `session.ts:646`. `vouchNode` only rejects eval-style flags or an outside-cwd script path, then returns safe at `session.ts:668`. Autonomous safe verdicts are allowed at `session.ts:513`.

   Trigger:

   1. Use `Write` to create `cleanup.js` inside the task folder.
   2. Put `rmSync("C:\\Users\\victim\\important.txt")` or token-reading/WebSocket code in it.
   3. Run `node cleanup.js`.

   Both rail layers allow the command without a tap.

   Executable aliases have the same problem. `commandName` trusts only the basename at `session.ts:706`. A repository containing an executable `git`, `git.cmd`, or `node.cmd` can run `./git.cmd status`; Conductor classifies the attacker-controlled executable as Git.

3. **The reader and Git allowlists approve mutating and code-launching argument forms.**

   The allowlists are at `session.ts:599`. Git validation checks only the first non-option subcommand at `session.ts:655`, while path validation skips options at `session.ts:683`.

   Concrete safe-classified triggers include:

   - `git diff --output=C:/Users/victim/important.txt`: overwrites an outside-cwd file.
   - `git remote remove origin`: mutates `.git/config`.
   - `find . -delete`: deletes the task tree on POSIX/Git-Bash implementations.
   - `sort README.md -o important.txt`: overwrites a file.
   - `rg --pre ./evil.cmd needle .`: launches an arbitrary preprocessor.
   - `cat "$HOME/.ssh/id_rsa"`: `$HOME` is treated as a literal relative path during classification, then expanded outside cwd by the shell.

## High findings

4. **`insideCwd` cannot contain hard links and remains TOCTOU-raceable.**

   `realish` resolves pathname links once at `session.ts:749`. It cannot determine that an in-repository hard link names the same file as an outside path.

   Trigger: create `C:\repo\bridge.txt` as a hard link to `C:\outside\important.txt`, then perform autonomous `Edit` on `bridge.txt`. The check sees an in-cwd path; modifying it changes the outside file. A helper can alternatively replace a checked directory with a junction after the final classification but before the SDK tool opens the file.

5. **The environment scrub still passes common secrets and credential capabilities.**

   `childEnv` drops only names matching `SECRET_ENV_NAME` at `session.ts:483`. Examples not matched include `PGPASSWORD`, `MYSQL_PWD`, `DATABASE_URL`, `REDIS_URL`, `KUBECONFIG`, `AZURE_CONFIG_DIR`, and `DOCKER_CONFIG`.

   Trigger: start the daemon with `DATABASE_URL=postgres://user:password@host/db`; an autonomous task runs `echo $DATABASE_URL`, which the reader allowlist approves, and receives the credential.

6. **Windows token permissions fail open.**

   The Windows ACL operation is best effort and failures are silently ignored at `token.ts:54`. `USERNAME` being absent also skips it. The daemon starts regardless.

   Trigger: place `CONDUCTOR_HOME` on a permissive shared directory, FAT/exFAT volume, or ACL where the Azure AD username cannot be resolved. If `icacls` fails, the token retains inherited permissions. Another local user can read it and obtain every HTTP, WebSocket, task, data, and approval capability.

## Medium findings

7. **The repository credential guard is bypassed during task execution.**

   `usableAccounts` rejects repository-contained accounts at `config.ts:128`, but `addTask` accepts any supplied account name at `http.ts:299`. `runTasks` returns to `config.accounts` and checks only placeholder status and existence at `main.ts:77`.

   Trigger: configure `leaky` with `configDir` inside a repository, then submit a task with `"account":"leaky"`. The account is excluded from `usableAccounts` but is still passed to `CLAUDE_CONFIG_DIR`.

   Separately, `gitWorkTreeAbove` uses lexical `resolve` without `realpath` at `config.ts:59`. A junction outside a checkout pointing into a repository subdirectory also passes.

8. **A failed second daemon start invalidates the running daemon’s credential.**

   `startDaemon` overwrites the token before attempting the bind at `http.ts:419`. The overwrite occurs at `token.ts:29`.

   Trigger: start a second daemon with the same state root while the first is running. The token file is replaced, then the second bind fails. The first daemon retains its old in-memory token while every new CLI invocation reads the new unusable token and receives 401 until the daemon is restarted.

---

## Triage (Fable, orchestrator)

Sol's ranking is not adopted wholesale. Sol widened the threat model from pass 1's "a page or process
that can reach loopback" to "any process running as the same user", and several "not closed" verdicts
rest on that widening rather than on the fix failing. Where that is what happened, it is said.

Each finding, judged against the code as read at HEAD `2917192`.

| # | Sev per Sol | Verdict | Why |
|---|---|---|---|
| 1 | Critical | **Real, but narrower than stated** | the token file cannot stop a same-user process, which was never the boundary pass 1 named; what is genuinely new is that a session can chain finding 2 to read the token and self-approve |
| 2 | Critical | **Real** | `vouchNode` returns safe for any in-cwd script, so Write-then-`node x.js` is unrestricted code execution with no tap, which is pass 1 finding 3 reopened by the fix itself |
| 2b | Critical | **Real** | `commandName` trusts the basename, so a checked-in `git.cmd` is classified as git |
| 3 | Critical | **Real, four of six** | `git diff --output=`, `git remote remove`, `sort -o`, `rg --pre` and `cat "$HOME/..."` all classify safe as claimed |
| 3 | -- | **False positive** | `find . -delete` is not exploitable: `find` is not in `VOUCHED_READERS`, so the segment is already unvouched |
| 4 | High | **Real, low reach** | hard links defeat `realish` as described; the junction-swap race needs a second colluding process, which is the same-user premise again |
| 5 | High | **Real** | `SECRET_ENV_NAME` does miss `PGPASSWORD`, `MYSQL_PWD`, `DATABASE_URL`, `KUBECONFIG`; the fix slice called the denylist a deliberate compromise, so this is known in kind but the named misses are cheap to close |
| 6 | High | **Pre-existing and known** | the fix slice already documents icacls as best effort and non-fatal; Sol's shared-volume trigger is a real widening of it, not a contradiction of it |
| 7 | Medium | **Real** | confirmed independently: `main.ts:77` reads `config.accounts` and checks only placeholder and existence, so `usableAccounts`' repo guard never runs on the execution path |
| 8 | Medium | **Real, availability only** | `mintDaemonToken` runs before `server.listen`, so a failed second start locks every door out of the live daemon; no confidentiality loss |

Nothing here contradicts the fix slice's evidence. The gates it demonstrated do hold against the
attacker pass 1 described. What the re-check found is a different attacker and one fix that opened a
hole while closing another.

The blocking items are 2, 2b and 3. Findings 1, 4 and 6 rest on the same-user premise and want a
written threat-model decision before code. Findings 5, 7 and 8 are small and self-contained.
