# M2 isolation, fix round 2: Sol's four residuals and the new defect

Branch `feat/m2-isolation`, on top of `f1ad8bd`. Files changed: `src/engine/isolation.ts` and
`spikes/isolation/verify.ts`. No wiring, no `checkpoint.ts`. `src/state/logbook.ts` was not touched
and did not need to be: `logEvent` takes an open record, so the new refusal sentences and the
nullable return from `registeredWorktrees` needed no type change there.

## What changed

**1. Branch deletion is now compare-and-delete (residuals 2 and 3).** Both `git branch -D` calls are
gone. `cleanUpFailedAdd` runs `git update-ref -d refs/heads/<branch> <baseCommit>`. `discardWorkspace`
reads the branch tip inside the same ownership confirmation that reads `git worktree list`, before the
worktree is removed, and deletes with `git update-ref -d refs/heads/<branch> <that tip>`. git takes
the ref lock, checks the tip inside that lock, and refuses if it moved. When it refuses, the branch
stays and the sentence names the tip it found and the tip it expected.

**2. Containment is checked against the resolved path (residual 6).** `createWorkspace` now checks
twice. Lexically first, on `<stateRoot>/workspaces/<id>`, before anything is created, which is what
keeps a hand-built Config pointing inside a repo from creating a directory there at all. Then
`<stateRoot>/workspaces` is created, resolved with `realPath`, the leaf is re-joined, and the same
refusal runs against the resolved path. That resolved path is the one used for `worktree add` and the
one stored in the record. The refusal names the junction when the two spellings differ.

**3. The dirty-count labels claim only what was observed (residual 9).** Past tense, anchored to
creation time: "your folder had no uncommitted changes when the copy was made, so the copy matched it
at that moment", plus "anything you have changed since then is not in the copy"; and "the copy is made
from the commit above, so it did not contain N tracked file(s) you had changed but not committed ... at
that moment". No re-reads, no retries. `headMovedDuringCreate` is unchanged.

**4. `registeredWorktrees` returns null when git could not answer.** Both callers handle null as its
own case. The first gives up before removing anything and says the metadata could not be read. The
post-removal confirmation treats a failed second listing as unconfirmed, not as absence.

**5. The false removal sentence is gone.** When `ours` is false and a directory exists at the recorded
path, discard now says there is a folder there, git does not register a worktree at it, nothing was
removed, and Conductor cannot tell whose it is. The old wording claimed a removal that never ran.

## Evidence

New verify sections 16 to 20. The identical `verify.ts` was run against a detached worktree of
`f1ad8bd` and against the fix.

Against `f1ad8bd`: `18 CHECK(S) FAILED`, every one of them inside sections 16 to 20; sections 1 to 15
passed unchanged. The three that matter:

- 17, junction: `create said: CREATED THROUGH THE JUNCTION`, and `[FAIL] the user's folder is still
  clean` — the copy was physically written inside the user's checkout.
- 18, failed `git worktree list`: `discard said: ok` — a successful discard logged over a repository
  git could not read.
- 19, stranger's folder at the recorded path: `git reported the worktree removed but "...\r11" is
  still on disk, most likely a file lock` — no removal ran.

Against the fix: `ALL CHECKS PASSED`, 20 sections. The same three now read:

- 17: refused, naming the junction, with nothing written through it and the repo still clean.
- 18: `git could not read the worktree metadata in "..." ... Nothing was removed`, and the workspace
  is still findable so a later discard can retry.
- 19: `there is a folder at "...", where Conductor recorded its copy, but git does not register a
  worktree there, so nothing was removed and Conductor cannot tell whose folder it is.`

Item 1, `update-ref -d` demonstrated directly in section 16 against git 2.52.0.windows.1:

- wrong expected tip: `exit 1  error: cannot lock ref 'refs/heads/demo': is at 5661bfa... but expected
  28e62f2...`, and the branch survives.
- right expected tip: exit 0, branch gone, and `.git/logs/refs/heads/demo` gone with it.

Item 3 wording printed in section 20, both the dirty and the clean variant.

`npx tsc --noEmit` clean with `node_modules` present.

## Parked, in writing

**The sub-second same-name-same-tip race remains, and is not worth chasing.** `update-ref -d` closes
the gap between the check and the deletion for every case where the branch moved. What it cannot
distinguish is a human deleting `conductor/task-t1` and recreating it at the exact same commit inside
the window between our two commands. In that case Conductor deletes a ref it did not create. The loss
is a branch name pointing at a commit that still exists in the repository, not work: the commit is
reachable by hash, in the reflog of whatever the human made it from, and recoverable with one
`git branch`. Closing it properly would need a ref transaction spanning `worktree remove`, which git
does not offer. Named here rather than left implied.

**One half of item 4 is verified by construction rather than by reproduction.** Section 18 stages a
failing `git worktree list` at the first call, where the recorded path is absent, by corrupting
`.git/config`. The post-removal confirmation is the second call to the same helper, on the same null
return, and its distinct sentence is in the code, but it cannot be staged from outside: the window is
inside a single `git worktree remove`, which runs no hooks. Reported as such rather than claimed.
