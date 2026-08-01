# M2 slice A-prime, isolation. Build and verification findings

Branch `feat/m2-isolation`. Deliverable `src/engine/isolation.ts`, plus five new event kinds in
`src/state/logbook.ts` and a throwaway verifier in `spikes/isolation/verify.ts`.

Nothing is wired in. `main.ts`, `server/http.ts`, `cli.ts` and `session.ts` are untouched, and
`src/engine/checkpoint.ts` is neither edited nor imported. Wiring and deletion are the next slice.

## What it does

Each task gets its own git worktree of the user's repo, made from a named commit, on its own branch
`conductor/task-<id>`, living at `<stateRoot>/workspaces/<id>/`. The task's output is a branch to
review and merge. Undo is removing the worktree and deleting the branch.

Six exported functions and one record type:

- `isolationRefusal(cwd)` returns the refusal sentence or null.
- `createWorkspace(config, task)` makes the copy or refuses.
- `sealWorkspace(config, workspace)` commits what the task left, on its branch.
- `discardWorkspace(config, workspaceOrTaskId)` removes the worktree and deletes the branch.
- `findWorkspace(config, taskId?)` recovers the record from the logbook.
- `describeWorkspace(workspace)` is the sentence the doors show.
- `branchFor(taskId)` and `gitRepoRoot(dir)` are exported for the wiring slice and the verifier.

## Ported from checkpoint.ts, and nothing else

1. `gitEnv`, which strips the whole `GIT_*` namespace case-insensitively and puts back only what
   Conductor sets. Sol's finding 4 against slice A. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are
   still stripped rather than neutralised, and here that matters more than it did for checkpoints:
   a seal commit is meant to join the user's history, so it has to read the repository the way the
   user's own git reads it.
2. The `git()` argv-array wrapper (`spawnSync`, `shell: false`, never throws) and `realPath()`.
3. The non-git refusal wording and its checks, extended with the no-commits case.

The `input` option and the `indexFile` option were dropped. Isolation never touches the user's index,
so there is no scratch index and no `GIT_INDEX_FILE` anywhere in this file.

## The hazards, one by one

**1. The user's folder must not move.** Verified rather than assumed, on every operation, in two
repositories. Four measures taken before and after each of create, seal and discard:
`git status --porcelain -uall` hashed, the `.git/index` bytes hashed, `rev-parse HEAD` plus
`symbolic-ref HEAD`, and the `.git/logs/HEAD` bytes hashed. All sixteen comparisons identical. Raw
output below.

One wrinkle worth recording: `git status` itself can refresh and rewrite the index, so the verifier
takes a warm-up measurement and discards it. Without that, the baseline would have been the only
measurement taken against a stale index and every later comparison would have looked like a change
Conductor caused. That is a property of the measuring tool, not of the code under test.

**2. The branch is deliberately visible.** `refs/heads/conductor/task-<id>`, so `git log`, `git diff`
and `git merge` all work with no Conductor-specific knowledge. The id is sanitised and then validated
with `git check-ref-format`, not trusted. One real bug came out of that: the first sanitiser filtered
character by character, so the id `a b/../../etc` became `conductor/task-a-b-..-..-etc`, and
`check-ref-format` rejected it, because `..` is illegal anywhere in a refname and not only at the
start. Runs of dots are now collapsed. Five hostile ids are checked in the verifier and all five
produce legal names. Creation refuses rather than reuses when either the branch or the worktree path
already exists; both sentences are below.

**3. Never fall back to running in place.** Every failure in `createWorkspace` returns a refusal, and
the `git worktree add` failure quotes git's stderr verbatim. There is no code path that runs a task
in the user's folder. That fallback is the exact failure mode isolation was chosen to remove.

A related thing found while forcing that failure: `git worktree add` can fail *after* creating the
folder, the metadata and the branch, which left litter that would make the next attempt refuse with
"already exists" and blame the user for our mess. `cleanUpFailedAdd` now removes all three and the
refusal says so if it could not. Verified: after a forced failure, neither the folder nor the branch
exists.

**4. Say what the copy lacks.** Modified-tracked and untracked counts are measured in the user's
folder before the copy exists, stored in the record, written to the logbook and printed by
`describeWorkspace`, which also states plainly that ignored files (local config, build output,
installed packages) are never in a fresh copy. Verified against a repo with one modified tracked
file, one untracked file and one ignored file: counts 1 and 1, and the copy demonstrably contains
none of the three.

**5. Seal commits use the repository's normal settings. This reverses a slice A decision on purpose.**
Checkpoint commits forced `-c core.autocrlf=false -c core.eol=lf -c core.safecrlf=false`, because a
checkpoint was a byte-for-byte before-image that never joined the user's history, so raw bytes were
exactly right. A seal commit is the opposite: it is meant to be reviewed and merged, so forcing raw
bytes would produce a branch that shows a whole-file diff on every text file the moment it is merged.
`NO_EOL_CONVERSION` is not carried over. Visible in the run: this machine has `core.autocrlf` on
globally, and the checked-out copy holds CRLF, which is correct and is why the verifier compares
content rather than bytes.

Two deliberate exceptions to "ordinary", both stated rather than hidden. The identity is
`Conductor <conductor@localhost>` for both author and committer, so nothing claims a human wrote it.
And `--no-gpg-sign` is passed: signing under Conductor's name with the user's key would misattribute,
and a pinentry prompt would hang a daemon nobody is watching. Hooks are left enabled, because they
are part of the repository's normal settings; a pre-commit hook that fails therefore fails the seal,
and the failure is reported with git's stderr and the workspace is left alone so the work is not lost.

A seal that finds nothing staged makes no commit at all and returns `committed: false`. An empty
commit in a history somebody is going to read is noise.

**6. Refusal list.** All eight have their own sentence and all eight were run. Verbatim below, plus
two more the code adds: a path too long for Windows, and a task id that cannot be made into a legal
refname.

**7. Discard verifies, not assumes.** `git worktree list --porcelain` is read first, and the branch
is deleted only by the exact name in the record and only after that metadata confirms the worktree
was ours and had that branch checked out. Then `git worktree remove --force`, then `existsSync` on
the folder, because on Windows a lock can leave removal reporting success with the folder half gone,
then `git branch -D`, then `git worktree prune`. Tested the adversarial case: somebody checks a
different branch out in our worktree, and discard refuses, leaving both the folder and the branch
alone. Sentence below.

**8. Windows paths.** Both ends go through `realpathSync.native`: the repo root as git reports it,
the state root before the workspace path is built, and the worktree path after creation. This is not
theoretical. The verifier deliberately runs with `CONDUCTOR_HOME` set to the 8.3 short spelling
(`C:\Users\KANESN~1\...`) and the recorded paths all come back as the long spelling
(`C:\Users\KaneSnyder(nexwave)\...`), which is what git reports and therefore the only spelling that
compares correctly. Both test paths contain spaces and parentheses. Total length is checked up front:
a workspace root past 150 characters is refused with the number in the sentence, rather than letting
a checkout fail on file 900 of 1200.

**9. The state root guard is not tripped.** `loadConfig` refuses a state root inside a git checkout
by walking *up* from the state root looking for `.git`. A worktree under `<stateRoot>/workspaces/`
sits below it, so the walk never sees it. Verified by calling `loadConfig()` again with a live
workspace present: it succeeds. Not a blocking finding, and the guard was not weakened.

**10. Zero new dependencies.** Node built-ins only. No credentials, account identifiers or prompt
text is logged or committed. The seal commit message is `conductor task <id>` and carries nothing else.

## Limits, stated rather than hidden

- **Submodules.** A fresh worktree does not initialise submodules. A task in a repo with submodules
  gets empty submodule directories. Not handled here and not detected here; it belongs in the wiring
  slice's description or in a later fix.
- **Concurrency.** Two tasks with the same id at the same time both pass the "branch exists" check
  before either creates it, and the second `git worktree add` then fails and refuses. That is the
  safe outcome, but it comes from git's own locking rather than from anything in this file.
- **Sparse checkout, LFS, and `.git/info/exclude`.** A worktree inherits the common `.git` dir, so
  LFS and excludes behave normally, but sparse-checkout settings are per worktree and a fresh one is
  full. Untested.
- **Disk.** A worktree is a full checkout of the base commit. Ten queued tasks are ten copies. There
  is no quota and no cleanup of workspaces whose task never finished.
- **The seal branch is never pushed and never merged by Conductor.** Merging is the human's, and
  that is deliberate.
- The spike is not in `tsconfig.json`'s `include` (which is `src/**/*.ts`), so `tsc --noEmit` covers
  the deliverable but not the verifier. The verifier is throwaway and was proven by running it.

## Verification

`node spikes/isolation/verify.ts` against scratch repositories under `%TEMP%\cond-iso`, never in the
user's repos. Covers a dirty tree (modified tracked, untracked and ignored files), a task cwd that is
a subfolder two levels down, and a detached-HEAD repository. `ALL CHECKS PASSED`, 65 checks.

### Typecheck, with the no-op guard

The guard exists because a `tsc` that silently does nothing because `node_modules` vanished has
already cost this project a bad commit.

```
> if (-not (Test-Path "node_modules\typescript\bin\tsc")) { Write-Error "node_modules/typescript is MISSING - tsc would be a no-op"; exit 9 }
node_modules/typescript present, tsc version:
Version 5.9.3
tsc exit code: 0

> npx tsc --noEmit --listFiles | Select-String -SimpleMatch "isolation"
C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/isolation.ts
```

The `--listFiles` line is the proof that the new file was actually in the program rather than skipped.

### What failed on the way

Three things, all fixed, all recorded because a clean-looking run that hid them would be worth less.

1. `check-ref-format` rejected `conductor/task-a-b-..-..-etc`. Fixed by collapsing runs of dots.
   Hazard 2.
2. The first attempt to force a `git worktree add` failure used a base commit holding a file named
   `con`. Git refuses to create that index entry at all: `error: Invalid path 'con'` /
   `fatal: git update-index: --cacheinfo cannot add con`. Replaced with a required smudge filter
   pointing at a command that does not exist, which fails the checkout after the folder and branch
   already exist, which is the more interesting case anyway and is what found the litter problem.
3. The verifier's first byte-for-byte comparison of the copied file failed, because `core.autocrlf`
   is on and the checkout wrote CRLF. That was the test being wrong, not the code, and it is the
   observable proof of hazard 5: the copy respects the repository's own settings.

### Full run output

```
state root: C:\Users\KANESN~1\AppData\Local\Temp\cond-iso\state
scratch repo: C:\Users\KANESN~1\AppData\Local\Temp\cond-iso\my repo (test)
base commit: 776495e7a2994f22945803680a65fc8a71aa0c3d

=== 1. create in a dirty repo, task cwd = sub/deep ===
{
  "taskId": "t1",
  "repoRoot": "C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\cond-iso\\my repo (test)",
  "baseCommit": "776495e7a2994f22945803680a65fc8a71aa0c3d",
  "baseRef": "refs/heads/main",
  "branch": "conductor/task-t1",
  "worktreePath": "C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\cond-iso\\state\\workspaces\\t1",
  "relPath": "sub/deep",
  "workdir": "C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\cond-iso\\state\\workspaces\\t1\\sub\\deep",
  "modifiedTracked": 1,
  "untracked": 1,
  "workdirCreated": false
}

--- describeWorkspace ---
task t1 runs in its own copy of "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\my repo (test)", not in that folder itself.
  copy:   C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\state\workspaces\t1
  workdir: C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\state\workspaces\t1\sub\deep
  branch: conductor/task-t1
  from:   776495e7a299 on refs/heads/main

  the copy is made from the commit above, so it does NOT contain 1 tracked file(s) you have changed but not committed, and 1 untracked file(s).
  the task starts from that commit. Commit the work first if the task needs to see it.
  files .gitignore covers are never in a fresh copy either: local config, build output, installed
  packages. A task that needs them has to create or install them inside the copy.

  nothing the task does can reach "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\my repo (test)". Its output is the branch "conductor/task-t1",
  which you can read with "git log conductor/task-t1" and merge normally. Undo is discarding the copy
  and deleting that branch, which leaves your folder exactly as it is now.
---

  [PASS] after create: git status --porcelain identical  2656c045f07119f8 -> 2656c045f07119f8
  [PASS] after create: .git/index hash identical  d8872f657b92078e -> d8872f657b92078e
  [PASS] after create: HEAD unmoved  776495e7a2994f22945803680a65fc8a71aa0c3d refs/heads/main -> 776495e7a2994f22945803680a65fc8a71aa0c3d refs/heads/main
  [PASS] after create: HEAD reflog identical  b45e7f4a28efb773 -> b45e7f4a28efb773
  [PASS] baseCommit is the user HEAD
  [PASS] baseRef recorded  refs/heads/main
  [PASS] relPath is the subfolder  sub/deep
  [PASS] workdir is inside the copy  C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\state\workspaces\t1\sub\deep
  [PASS] modifiedTracked counted  1
  [PASS] untracked counted  1

--- what the copy contains ---
copy tracked.txt: "committed content\r\n"
  [PASS] copy does NOT have the uncommitted edit
  [PASS] copy does NOT have the untracked file
  [PASS] copy does NOT have the ignored file
  [PASS] copy has the tracked nested file
C:/Users/KaneSnyder(nexwave)/AppData/Local/Temp/cond-iso/my repo (test)       776495e [main]
C:/Users/KaneSnyder(nexwave)/AppData/Local/Temp/cond-iso/state/workspaces/t1  776495e [conductor/task-t1]

--- hazard 9: loadConfig with a workspace present ---
  [PASS] loadConfig still succeeds

=== 2. task writes in the copy, then seal ===
  [PASS] seal ok
  [PASS] after seal: git status --porcelain identical  2656c045f07119f8 -> 2656c045f07119f8
  [PASS] after seal: .git/index hash identical  d8872f657b92078e -> d8872f657b92078e
  [PASS] after seal: HEAD unmoved  776495e7a2994f22945803680a65fc8a71aa0c3d refs/heads/main -> 776495e7a2994f22945803680a65fc8a71aa0c3d refs/heads/main
  [PASS] after seal: HEAD reflog identical  b45e7f4a28efb773 -> b45e7f4a28efb773
  [PASS] branch exists in the user repo  b6195eb8f5142ba3a829e06f3998ea8abe5168bb
  [PASS] branch tip is the seal commit  b6195eb8f5142ba3a829e06f3998ea8abe5168bb vs b6195eb8f5142ba3a829e06f3998ea8abe5168bb
  [PASS] seal commit parent is the base commit
b6195eb conductor task t1
A	sub/deep/made-by-task.txt
M	tracked.txt

author=Conductor <conductor@localhost>
committer=Conductor <conductor@localhost>
subject=conductor task t1

  [PASS] files counted  2
--- an unchanged copy seals to nothing ---
  [PASS] second seal makes no empty commit  {"committed":false}

=== 3. findWorkspace and discard ===
  [PASS] findWorkspace recovers the record
  [PASS] discard ok
  [PASS] after discard: git status --porcelain identical  2656c045f07119f8 -> 2656c045f07119f8
  [PASS] after discard: .git/index hash identical  d8872f657b92078e -> d8872f657b92078e
  [PASS] after discard: HEAD unmoved  776495e7a2994f22945803680a65fc8a71aa0c3d refs/heads/main -> 776495e7a2994f22945803680a65fc8a71aa0c3d refs/heads/main
  [PASS] after discard: HEAD reflog identical  b45e7f4a28efb773 -> b45e7f4a28efb773
  [PASS] worktree folder is gone
  [PASS] branch is gone
C:/Users/KaneSnyder(nexwave)/AppData/Local/Temp/cond-iso/my repo (test)  776495e [main]

  [PASS] worktree list has only the user checkout
  [PASS] findWorkspace no longer returns it
the human's tracked.txt is still: "HUMAN EDIT not committed\n"
  [PASS] the human edit survived everything
  [PASS] the human untracked file survived
  [PASS] the ignored file survived

=== 4. detached HEAD repo ===
  [PASS] create ok on detached HEAD
  [PASS] baseRef is null when detached  null
task t2 runs in its own copy of "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\detached", not in that folder itself.
  copy:   C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\state\workspaces\t2
  workdir: C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\state\workspaces\t2  (the repository root)
  branch: conductor/task-t2
  from:   1c0d47e4d7d9 (your HEAD was detached)

  [PASS] detached, after create: git status --porcelain identical  e3b0c44298fc1c14 -> e3b0c44298fc1c14
  [PASS] detached, after create: .git/index hash identical  d8ce23ad451bd06c -> d8ce23ad451bd06c
  [PASS] detached, after create: HEAD unmoved  1c0d47e4d7d9ebd96a78810d05ab4659c52637d4 (detached) -> 1c0d47e4d7d9ebd96a78810d05ab4659c52637d4 (detached)
  [PASS] detached, after create: HEAD reflog identical  d057dbc4d86ee8eb -> d057dbc4d86ee8eb
  [PASS] seal ok on detached HEAD
  [PASS] detached, after seal: git status --porcelain identical  e3b0c44298fc1c14 -> e3b0c44298fc1c14
  [PASS] detached, after seal: .git/index hash identical  d8ce23ad451bd06c -> d8ce23ad451bd06c
  [PASS] detached, after seal: HEAD unmoved  1c0d47e4d7d9ebd96a78810d05ab4659c52637d4 (detached) -> 1c0d47e4d7d9ebd96a78810d05ab4659c52637d4 (detached)
  [PASS] detached, after seal: HEAD reflog identical  d057dbc4d86ee8eb -> d057dbc4d86ee8eb
  [PASS] discard ok on detached HEAD
  [PASS] detached, after discard: git status --porcelain identical  e3b0c44298fc1c14 -> e3b0c44298fc1c14
  [PASS] detached, after discard: .git/index hash identical  d8ce23ad451bd06c -> d8ce23ad451bd06c
  [PASS] detached, after discard: HEAD unmoved  1c0d47e4d7d9ebd96a78810d05ab4659c52637d4 (detached) -> 1c0d47e4d7d9ebd96a78810d05ab4659c52637d4 (detached)
  [PASS] detached, after discard: HEAD reflog identical  d057dbc4d86ee8eb -> d057dbc4d86ee8eb
  [PASS] detached repo worktree list clean

=== 5. refusals ===
  path not absolute:
    the task folder "some\relative\path" is not an absolute path
  does not exist:
    the task folder "C:\Users\KANESN~1\AppData\Local\Temp\cond-iso\my repo (test)\nope" does not exist
  not a directory:
    the task folder "C:\Users\KANESN~1\AppData\Local\Temp\cond-iso\my repo (test)\tracked.txt" is not a directory
  not inside a git repository:
    the folder "C:\Users\KANESN~1\AppData\Local\Temp\cond-iso\plain" is not inside a git repository, so Conductor cannot make an isolated copy of it and nothing it did there would be reversible. Run "git init" in that folder, or point the task at a folder that is already under version control.
  repository has no commits:
    the repository "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\empty" has no commits yet, so there is nothing to copy from. An isolated copy is made from a named commit. Make one commit in that repository and try again.
  branch already exists:
    the branch "conductor/task-r6" already exists in "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\my repo (test)". Conductor will not reuse or overwrite it, because it may hold work from an earlier run of task r6. Merge or delete that branch, or give the task a new id.
  worktree path already exists:
    the workspace folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\state\workspaces\r7" already exists. Conductor will not reuse or overwrite it. Discard the old workspace, or give the task a new id.
  path too long:
    the workspace folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\state\workspaces\xxxxx...xxxxx" is 274 characters long, past the 150 Conductor allows. Files inside a repository add to that and Windows stops at 260, so the copy would fail part way through. Point CONDUCTOR_HOME at a shorter path, or shorten the task id.
  id ".." -> branch "conductor/task-task"  check-ref-format ok
  [PASS] sanitised id ".." is a legal refname
  id "a b/../../etc" -> branch "conductor/task-a-b-.-.-etc"  check-ref-format ok
  [PASS] sanitised id "a b/../../etc" is a legal refname
  id "HEAD.lock" -> branch "conductor/task-HEAD-lock"  check-ref-format ok
  [PASS] sanitised id "HEAD.lock" is a legal refname
  id "-dashes-" -> branch "conductor/task-dashes"  check-ref-format ok
  [PASS] sanitised id "-dashes-" is a legal refname
  id "a~b^c:d?e*f[g\h" -> branch "conductor/task-a-b-c-d-e-f-g-h"  check-ref-format ok
  [PASS] sanitised id "a~b^c:d?e*f[g\h" is a legal refname
  git worktree add fails:
    git worktree add failed, so there is no isolated copy and the task will not run: Preparing worktree (new branch 'conductor/task-r8')
error: cannot spawn conductor-no-such-filter-command: No such file or directory
error: cannot fork to run external filter 'conductor-no-such-filter-command'
error: external filter 'conductor-no-such-filter-command' failed
fatal: ok.txt: smudge filter boom failed
    litter check: workspaces/r8 exists? false
    litter check: branch conductor/task-r8 exists? false
  [PASS] no litter after a failed create

=== 6. discard verifies rather than assumes ===
  the worktree at "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\cond-iso\state\workspaces\t3" now has "refs/heads/someone-elses" checked out, not "refs/heads/conductor/task-t3". Conductor will not remove a worktree or delete a branch it cannot account for.
  [PASS] discard refuses a worktree it cannot account for
  [PASS] the workspace is still there
  [PASS] our branch still exists
  [PASS] discard works once it adds up again

ALL CHECKS PASSED
```

The `workspace_*` lines the run wrote to `events.jsonl` are in the full console capture and match the
record shape above. No credential, account identifier or prompt text appears in any of them.

## What the next slice has to decide

- Where `sealWorkspace` is called from, and what happens to the branch when the task fails rather
  than finishes. Right now the branch survives a failed seal with the work uncommitted in the copy,
  which is deliberate but is not a policy.
- Whether a workspace whose task never finished is ever cleaned up automatically, and by what rule.
- Whether `describeWorkspace` is shown at queue time (the spec says "when queueing") or at start.
- Submodules, per the limits above.
