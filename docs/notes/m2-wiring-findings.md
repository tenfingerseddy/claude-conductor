# M2 wiring: isolation becomes the way tasks run

Built 2026-08-02 on `feat/m2-isolation`. The isolation module was finished and review-hardened but
nothing used it; the task loop still ran the superseded checkpoint model. This slice makes the
isolated copy the only way a task runs, and deletes the checkpoint model.

**Verdict: wired, and proven on a real run.** A Haiku task edited a tracked file and created a
file in its own copy, the seal commit landed on `conductor/task-t1` with the right two files, the
human's folder came out byte-identical on every measure taken, `conductor undo` discarded the copy
and deleted the branch, and both gates refused what they are meant to refuse. `npx tsc --noEmit`
is clean and the untouched `spikes/isolation/verify.ts` still passes all 205 checks.

Publishing scrub rule applied, same as the M1 finish line: nothing here is withheld except that
the run's plan utilization numbers appear only where the raw logbook line carries them, and the
scratch paths are real because they are throwaway temp folders, not anybody's project.

## What changed

| File | Change |
|---|---|
| `src/main.ts` | `createWorkspace` before the session, session runs in the copy's `workdir`, `sealWorkspace` in the `finally`. No auto-discard. |
| `src/engine/session.ts` | `Task.userCwd`, display only. The trust sentence no longer promises checkpoints. |
| `src/server/http.ts` | Gate is `isolationRefusal`. `GET /undo` previews, `POST /undo` discards. Task start carries `describeWorkspace`. |
| `src/cli.ts` | `undo` follows. `task_started` prints the description. |
| `src/state/logbook.ts` | Five checkpoint-era kinds deleted; `task_start` gained `workdir` and `branch`. |
| `src/engine/checkpoint.ts` | Deleted. |
| `src/engine/isolation.ts` | Untouched. No signature change was needed. |

Six decisions inside that table are worth stating because each one was a fork.

**The seal is in the `finally`, and the copy is never discarded there.** A task that crashes is
exactly the one whose work most needs capturing, so the seal runs on every exit path. Discarding
is not an exit path at all: the branch is the task's output, and removing it is the human's verb.

**A failed seal does not eat the session result.** It is logged by `sealWorkspace` as
`workspace_seal_failed`, printed to stderr, and its reason is joined onto the run's `errorText`
alongside whatever else is there, rather than replacing it. The workspace is left on disk with the
work still in it, because the honest answer to a failed seal is "your work is still in the copy".

**The session's `cwd` is the copy; `userCwd` is display only.** `classifyRail` compares against
`task.cwd` and nothing else, so the boundary the rail enforces is the copy. `userCwd` changes one
sentence, the one a human reads at a tap, and is compared against nothing. Verified live: the
model asked to read `/home/kane/notes.md` and the rail stopped it with
`outside the task's own copy of "...\cwire\repo"`.

**The undo dance collapsed.** The old shape carried a `planId` and a `planHash` because in-place
undo was selective: consent was to a specific list of paths, and that list could go stale against
a folder that had moved on. Discard is total, so there is no list to drift and nothing to pin.
What was kept is the part that still earns its keep: two calls with an explicit confirm, because
discarding sealed work deletes the task's output branch. The confirm binds to the `taskId`, and
the CLI sends back the id the preview resolved rather than saying "the last one" twice, so a copy
created between the two calls cannot become the target.

**The verbs say which half is which.** Preview is `GET /undo`, so it cannot remove anything by
construction. Discard is `POST /undo` and needs both a `taskId` and `confirm: true`.

**`sealed: null` is a real answer.** The preview reads seal state back out of the logbook, and a
task that crashed before the seal ran looks the same from there as a log that could not be read.
Both print "the logbook does not say whether the work was sealed, so assume the branch may hold
work". Unknown must never read as empty; that is the same rule the isolation module spent six
review rounds learning.

## The finish line run

A scratch repo outside this repo, deliberately dirty: one modified tracked file, one untracked
file, one ignored file. Driven through the real daemon and the real CLI by a throwaway harness
that imports nothing from `src/`; it only spawns `node src/cli.ts` and reads what comes back,
including a real `conductor watch` process as the attended door.

| Thing | Value |
|---|---|
| Target repo | `C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\repo`, one commit `a345400` on `main` |
| Dirty state | `keep.md` modified and uncommitted, `scratchpad.txt` untracked, `build/out.txt` ignored |
| State root | `CONDUCTOR_HOME=...\cwire\home` |
| Account | the `work` entry in that scratch `config.json` only; the repo's registry still holds placeholders |
| Port | 7731, then 7732 and 7733 for the two follow-up checks |
| Model | `haiku`, on purpose: the point is the wiring |
| Trust | attended |

### 1. The copy is announced at task start

Verbatim from the real `conductor watch` process, immediately after the task-start line:

```
00:20:41 [watch] === task t1 started: Edit notes and add a file (work, attended) ===
00:20:41 [watch] task t1 runs in its own copy of "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\repo", not in that folder itself.
00:20:41 [watch]   copy:   C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\home\workspaces\t1
00:20:41 [watch]   workdir: C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\home\workspaces\t1  (the repository root)
00:20:41 [watch]   branch: conductor/task-t1
00:20:41 [watch]   from:   a345400e4b33 on refs/heads/main
00:20:41 [watch]
00:20:41 [watch]   the copy is made from the commit above, so it did not contain 1 tracked file(s) you had changed but not committed, and 1 untracked file(s) at that moment.
00:20:41 [watch]   the task starts from that commit. Commit the work first if the task needs to see it.
00:20:41 [watch]   git hides files marked assume-unchanged or skip-worktree, so edits to those are not in that count.
00:20:41 [watch]   files .gitignore covers are never in a fresh copy either: local config, build output, installed
00:20:41 [watch]   packages. A task that needs them has to create or install them inside the copy.
00:20:41 [watch]
00:20:41 [watch]   nothing the task does can reach "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\repo". Its output is the branch "conductor/task-t1",
00:20:41 [watch]   which you can read with "git log conductor/task-t1" and merge normally. Undo is discarding the copy
00:20:41 [watch]   and deleting that branch, which leaves your folder exactly as it is now.
```

The two counts are the real dirty state of the folder, measured before the copy existed. The same
description is on the WebSocket `task_started` frame as the `workspace` field, so any future door
gets it without a second call.

### 2. The session ran in the copy

The SDK's own message, when the model reached for a path outside it:

```
00:20:46 [watch] [t1] tool: Read {"file_path":"/home/kane/notes.md"}
00:20:46 [watch]   ---- Conductor stopped for a tap ----
00:20:46 [watch]   why:   it touches "\home\kane\notes.md", which is outside the task's own copy of "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\repo"
00:20:46 [watch] [t1] result: File does not exist. Note: your current working directory is C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\home\workspaces\t1.
```

Relative paths the model then used resolved into the copy, which the taps show as absolute:

```
00:21:00 [watch]   input: {"file_path":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\cwire\\home\\workspaces\\t1\\notes.md","old_string":"status: draft","new_string":"status: reviewed","replace_all":false}
00:21:02 [watch]   input: {"file_path":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\cwire\\home\\workspaces\\t1\\added.md","content":"Added by Conductor."}
```

### 3. The rail is unchanged

Five taps, all answered at the real watch process. Two were shell commands inside the copy, which
is the rail behaviour the finish line asks to see still firing:

```
00:20:48 [watch]   tool:  Bash
00:20:48 [watch]   input: {"command":"find . -name \"notes.md\" -type f",...}
00:20:48 [watch]   why:   Conductor cannot tell what a shell command will do once the shell has finished rewriting it, so every command goes to a human

00:21:05 [watch]   tool:  Bash
00:21:05 [watch]   input: {"command":"git status --short","description":"Show git status in short format"}
00:21:05 [watch]   why:   Conductor cannot tell what a shell command will do once the shell has finished rewriting it, so every command goes to a human
00:21:08 [watch] [t1] result: M notes.md ?? added.md
```

That last result is the copy talking about itself: `M notes.md` and `?? added.md` are the task's
own two changes, seen from inside the worktree.

Harness caveat, stated because it is the harness and not Conductor: this stand-in answered `y` to
all five taps, including the read outside the copy. A human would have said no to that one. The
read failed anyway because the path does not exist, and the point being measured was that the rail
asked, which it did.

### 4. The user's folder did not move

Snapshot before the run and after it. Every field is byte-compared by the harness.

```
00:20:37 [snap] --- the human's folder BEFORE the run ---
00:20:37 [snap] status:   "M keep.md\n?? scratchpad.txt"
00:20:37 [snap] HEAD:     a345400e4b337c9fe0cf5a4a78e32e14e40ec5ea on refs/heads/main
00:20:37 [snap] index:    sha256 3a7165d33569386c4d12bf95e91b034d8f3042f44af837f36c6ead32266a7dea
00:20:37 [snap] reflog:   "0000000000000000000000000000000000000000 a345400e4b337c9fe0cf5a4a78e32e14e40ec5ea Scratch User <scratch@localhost> 1785629982 +1000\tcommit (initial): initial scratch commit"
00:20:37 [snap] branches: "* main"
00:20:37 [snap] notes.md: "# Scratch notes\nstatus: draft\nowner: the human\n"

00:21:21 [snap] --- the human's folder AFTER the run ---
00:21:21 [snap] status:   "M keep.md\n?? scratchpad.txt"
00:21:21 [snap] HEAD:     a345400e4b337c9fe0cf5a4a78e32e14e40ec5ea on refs/heads/main
00:21:21 [snap] index:    sha256 3a7165d33569386c4d12bf95e91b034d8f3042f44af837f36c6ead32266a7dea
00:21:21 [snap] reflog:   "0000000000000000000000000000000000000000 a345400e4b337c9fe0cf5a4a78e32e14e40ec5ea Scratch User <scratch@localhost> 1785629982 +1000\tcommit (initial): initial scratch commit"
00:21:21 [snap] notes.md: "# Scratch notes\nstatus: draft\nowner: the human\n"
00:21:21 [snap] added.md exists in the human's folder: false
```

```
00:21:24 [verdict] status     before vs after run:  IDENTICAL
00:21:24 [verdict] head       before vs after run:  IDENTICAL
00:21:24 [verdict] symbolic   before vs after run:  IDENTICAL
00:21:24 [verdict] indexSha   before vs after run:  IDENTICAL
00:21:24 [verdict] reflog     before vs after run:  IDENTICAL
00:21:24 [verdict] keep       before vs after run:  IDENTICAL
00:21:24 [verdict] notes      before vs after run:  IDENTICAL
00:21:24 [verdict] scratchpad before vs after run:  IDENTICAL
```

The one visible difference in the whole folder is the one `git worktree add` is entitled to make:
a second worktree entry and one new branch.

```
00:21:21 [snap] worktrees:
00:21:21 [snap] C:/Users/KaneSnyder(nexwave)/AppData/Local/Temp/cwire/repo                a345400 [main]
00:21:21 [snap] C:/Users/KaneSnyder(nexwave)/AppData/Local/Temp/cwire/home/workspaces/t1  e55e9c5 [conductor/task-t1]
00:21:21 [snap] branches: "+ conductor/task-t1\n* main"
```

### 5. The copy holds the work, and the seal commit is right

```
00:21:21 [git] git log --oneline conductor/task-t1:
00:21:21 [git] e55e9c5 conductor task t1
00:21:21 [git] a345400 initial scratch commit
00:21:21 [git] git show --stat --name-status conductor/task-t1:
00:21:21 [git] e55e9c5ce307b9a014ca9b5192159e9a66d79c03
00:21:21 [git] Conductor <conductor@localhost>
00:21:21 [git] conductor task t1
00:21:21 [git] A	added.md
00:21:21 [git] M	notes.md
00:21:21 [git] files changed by the seal commit: 2
00:21:21 [copy] copy notes.md: "# Scratch notes\r\nstatus: reviewed\r\nowner: the human\r\n"
00:21:21 [copy] copy added.md: "Added by Conductor."
00:21:21 [copy] copy keep.md: "This file is committed and must never change.\r\n"
00:21:21 [copy] copy scratchpad.txt (untracked in the human's folder) present: false
00:21:21 [copy] copy build/ (ignored in the human's folder) present: false
```

Two files, the right two, on the task's own branch, authored by Conductor and not by the user's
git identity. The copy's `keep.md` lacks the human's uncommitted line and the copy has neither the
untracked file nor the ignored folder, which is what `describeWorkspace` said up front and is the
stated cost of a fresh copy rather than a surprise. The CRLF in the copy is the repository's own
`core.autocrlf` behaviour, which is the point of the deliberate reversal in `sealWorkspace`: this
commit is meant to be merged, so it is an ordinary commit.

The logbook line for it:

```
{"ts":"2026-08-02T00:21:18.924Z","kind":"workspace_sealed","taskId":"t1","branch":"conductor/task-t1","commit":"e55e9c5ce307b9a014ca9b5192159e9a66d79c03","committed":true,"files":2}
```

And the new task-start line, which now names both folders and the branch:

```
{"ts":"2026-08-02T00:20:41.211Z","kind":"task_start","taskId":"t1","account":"work","cwd":"...\\cwire\\repo","workdir":"...\\cwire\\home\\workspaces\\t1","branch":"conductor/task-t1","model":"haiku"}
```

### 6. Undo

Preview first, verbatim, and it changed nothing:

```
00:21:21 [harness] $ conductor undo
00:21:21 [cli] task t1 runs in its own copy of "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\repo", not in that folder itself.
...
00:21:21 [cli] discarding would:
00:21:21 [cli]   remove the copy    C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\home\workspaces\t1
00:21:21 [cli]   delete the branch  conductor/task-t1
00:21:21 [cli]   seal state         sealed, 2 file(s) committed on that branch
00:21:21 [cli]   leave alone        C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\repo, your own folder
00:21:21 [cli]
00:21:21 [cli] nothing has been changed. Run "conductor undo t1 --yes" to discard exactly this copy.
```

Then the confirm:

```
00:21:22 [harness] $ conductor undo t1 --yes
00:21:22 [cli] discarded: the copy at "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\home\workspaces\t1" is gone and the branch "conductor/task-t1" is deleted.
00:21:22 [snap] --- the human's folder AFTER the undo ---
00:21:22 [snap] status:   "M keep.md\n?? scratchpad.txt"
00:21:22 [snap] HEAD:     a345400e4b337c9fe0cf5a4a78e32e14e40ec5ea on refs/heads/main
00:21:22 [snap] index:    sha256 3a7165d33569386c4d12bf95e91b034d8f3042f44af837f36c6ead32266a7dea
00:21:22 [snap] branches: "* main"
00:21:22 [git] git worktree list:
00:21:22 [git] C:/Users/KaneSnyder(nexwave)/AppData/Local/Temp/cwire/repo  a345400 [main]
00:21:22 [git] git branch --list --all:
00:21:22 [git] * main
00:21:22 [fs] workspace folder still on disk: false
```

```
00:21:24 [verdict] status     before vs after undo: IDENTICAL
00:21:24 [verdict] head       before vs after undo: IDENTICAL
00:21:24 [verdict] symbolic   before vs after undo: IDENTICAL
00:21:24 [verdict] indexSha   before vs after undo: IDENTICAL
00:21:24 [verdict] reflog     before vs after undo: IDENTICAL
00:21:24 [verdict] keep       before vs after undo: IDENTICAL
00:21:24 [verdict] notes      before vs after undo: IDENTICAL
00:21:24 [verdict] scratchpad before vs after undo: IDENTICAL
```

Worktree list and branch list clean, the folder gone, the human's folder in exactly the state it
was in before the daemon ever started. The `workspace_discarded` broadcast reached the attached
watch process too: `(copy for task t1 discarded, branch conductor/task-t1 deleted)`.

Wall clock for the whole run: 48 seconds, one task, five taps.

### 7. Both gates

Re-run against a live daemon on port 7732, because the first attempt made these two calls before
the daemon was up and got a token error instead of a gate answer. That was a harness ordering
mistake, reported here rather than quietly re-cut.

```
00:22:04 [harness] $ conductor add this must never start --cwd ...\cwire\notgit --account work --model haiku --title not a repo
00:22:05 [cli] conductor: the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cwire\notgit" is not inside a git repository, so Conductor cannot make an isolated copy of it and nothing it did there would be reversible. Run "git init" in that folder, or point the task at a folder that is already under version control.
00:22:05 [harness] exit 1

00:22:05 [harness] $ conductor add this must never start either --cwd ...\cwire\repo --trust autonomous ...
00:22:05 [cli] conductor: autonomous trust is unavailable until M2 delivers place enforcement and shell-free execution. Queue this task as attended.
00:22:05 [harness] exit 1

00:22:05 [harness] $ conductor status
00:22:05 [cli]   tasks:       0
00:22:06 [harness] $ conductor run
00:22:06 [cli] conductor: no pending tasks
```

Neither task entered the list, so no session started, and the logbook holds no `workspace_created`
or `task_start` for either. That is the gate doing its job at queue time, which is where a human
hears about it rather than at run time when they have walked away.

### 8. A logbook written by the old build still reads

Five lines of the deleted kinds (`checkpoint`, `checkpoint_refused`, `postimage`,
`postimage_failed`, `undo`) were appended to a live `events.jsonl` and every reader was asked to
walk past them, on port 7733.

```
00:22:42 [harness] $ conductor tail 8
00:22:42 [cli] {"ts":"2026-08-01T10:00:00.000Z","kind":"checkpoint","taskId":"old1",...}
00:22:42 [cli] {"ts":"2026-08-01T10:00:01.000Z","kind":"checkpoint_refused","taskId":"old2",...}
00:22:42 [cli] {"ts":"2026-08-01T10:00:02.000Z","kind":"postimage","taskId":"old1",...}
00:22:42 [cli] {"ts":"2026-08-01T10:00:03.000Z","kind":"postimage_failed","taskId":"old3",...}
00:22:42 [cli] {"ts":"2026-08-01T10:00:04.000Z","kind":"undo","taskId":"old1",...}
00:22:42 [harness] exit 0
00:22:43 [harness] $ conductor status        -> exit 0, tasks: 0
00:22:43 [harness] $ conductor undo          -> "no copy has been made yet, so there is nothing to discard", exit 1
00:22:43 [harness] $ conductor undo old1     -> "no copy is recorded for task \"old1\"; it may never have run, or it may already have been discarded", exit 1
```

Every reader tolerates them. `/events` and `conductor tail` never inspect `kind` at all, they pass
whole lines through and fall back to `{raw: line}` on a line that will not parse. `findWorkspace`
and the new seal-state reader both skip anything that is not the kind they are looking for. The
`undo old1` answer is the right one: a `checkpoint` line is not a copy, and saying so beats
inventing a workspace from a record of a different mechanism.

## Checkpoint references left in the tree

`grep -rn "checkpoint" src/ --include=*.ts` after the deletion returns thirteen lines and none of
them is code:

- `src/engine/isolation.ts`, five comments describing why checkpoint-and-undo was replaced and
  which of its decisions were deliberately reversed. History that explains the current design.
- `src/state/logbook.ts`, two lines of the new comment naming the deleted kinds, so a reader who
  meets one of them in an old `events.jsonl` knows what it was.
- `src/engine/cut.ts`, `src/engine/finish-task.ts` (twice), `src/engine/gauge.ts` (twice) and
  `src/state/playbook.ts`:
  the words "checkpoint handoff" and "checkpoint at the next natural boundary". These are the
  spec's *mid-task checkpoint*, which is a `finish_task` call made early because the gauge is high.
  Same word, different mechanism, and that one is alive. Left alone, and those four files were out
  of scope for this slice anyway.

Trimmed because they had started to mislead: `main.ts`'s before-image and post-image comments are
gone with the code, `http.ts` no longer says "the task loop checkpoints again", and
`session.ts`'s autonomous refusal no longer promises checkpoints as the thing that will unlock it.

## Verification summary

- `npx tsc --noEmit` exit 0, run behind the node_modules guard (`typescript` present, 5.9.3), so a
  silent no-op cannot pass for a clean typecheck.
- `node spikes/isolation/verify.ts`: `ALL CHECKS PASSED`, 205 checks, file untouched by this slice.
- One real task through the real daemon and the real CLI on Haiku, with a real `conductor watch`
  process answering five taps.
- The user's folder byte-identical across the run and across the undo on all eight compared
  measures, including the `.git/index` sha256 and the HEAD reflog.
- Seal commit verified by `git show --name-status`: two files, the right two, Conductor's identity.
- Discard verified by `git worktree list`, `git branch --list --all` and the folder being gone.
- Both gates refused, with the isolation sentence and the trust sentence, and nothing was queued.
- Legacy checkpoint-era logbook lines walked past by every reader.
- `ANTHROPIC_API_KEY` unset in this shell and deleted from the harness environment as well; the
  repo's account registry still holds placeholders and the real config directory was named only in
  the scratch `config.json` outside the repo.

## Left for the next slice

- Nothing in `isolation.ts` needed a signature change, so the module is exactly as reviewed.
- The task list is still in memory, so a restarted daemon shows no tasks, but undo survives:
  `findWorkspace` reads the logbook, and the two follow-up runs above asked for an undo on fresh
  daemons and got correct answers about a copy created by an earlier one. A restart with a live
  copy still on disk was not exercised, and belongs in slice D's finish line.
- Slice B can now say "the task may only write inside its worktree" as a filesystem fact, because
  `task.cwd` is that worktree for every session Conductor starts.
