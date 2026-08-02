# M2 isolation, fix round 3: unknown must not read as done

Branch `feat/m2-isolation`, on top of `6bf04f1`. Files changed: `src/engine/isolation.ts` and
`spikes/isolation/verify.ts`. `src/state/logbook.ts` untouched and not forced. No wiring, no
`checkpoint.ts`.

Sol closed items 3, 4 and 5 from the last round and left items 1 and 2 partial. Both residuals are
the same sentence in two places: a question git or the operating system refused to answer was being
recorded as the answer "no".

## What changed

**1. A tip that cannot be read is not an absent branch.** `rev-parse --verify --quiet` exits non-zero
for both "no such branch" and "this repository will not answer", so `.stdout.trim()` flattened the
second into the first. New tri-state `branchTip` separates them: an absent ref exits 1 with nothing on
either stream, and anything git complains about arrives on stderr.

- `discardWorkspace`: an unreadable tip refuses **before** the worktree is removed, so nothing is half
  done. Undo is one operation, and removing the copy while the branch half is unknown would be a
  half-finished job reported as a whole one.
- `discardWorkspace`: when `update-ref -d` fails **and** the follow-up read also fails, that is now a
  failed discard naming the copy as gone and the branch as unchecked. It used to fall through to
  success.
- `discardWorkspace`, the not-ours path: an unreadable `show-ref` for the leftover branch is a
  refusal rather than a silent clean success.
- `cleanUpFailedAdd`: an unreadable tip, and a delete whose outcome cannot be confirmed, are each a
  named leftover in the refusal sentence instead of silence.

**2. A path that could not be canonicalised is not a containment answer.** `realPath` had one
behaviour: fall back to lexical `resolve()`. Split into `realPathStrict` (null on failure) and
`realPath` (the lenient wrapper, kept for log lines, messages and paths handed straight to git). The
two containment-critical resolutions in `createWorkspace` now use the strict one and refuse on null:
the repository root, checked before anything is created, and the resolved workspaces directory.
`resolve()` cannot see a junction, so the old fallback answered "outside the repository" about a path
nobody had resolved.

**3. The comment about a recreated branch is corrected.** It claimed a branch recreated at the same
name survives. Under the parked ABA case it does not. The comment now states the limit exactly: a
branch that moved, or was replaced at a different commit, survives; one deleted and recreated at the
same commit inside the window does not, and what is lost there is a name pointing at a commit that
still exists, not work.

## Evidence

Sections 21 and 22 are new. **Said plainly: they are not end-to-end reproductions.** Neither case can
be staged against real git or the real filesystem on this machine, and here is what was tried:

- A broken loose ref does make `rev-parse` fail with stderr, but `git worktree list --porcelain` then
  drops the `branch` line for that worktree, so ownership is never confirmed and the code lands in
  the mismatch refusal instead of the tip read. Corrupting `.git/config` fails `worktree list` first.
- A `git.cmd` shim on PATH is not picked up: `spawnSync` with `shell: false` finds the real `git.exe`.
- A dangling junction fails at `mkdirSync` with ENOENT; a junction loop fails at `existsSync` with
  ELOOP. Neither reaches the resolution the containment check uses.

So both run through a stub harness, which Sol's brief allowed for exactly this. The harness is a copy
of `isolation.ts` with two seams cut by exact-text replacement (the `spawnSync` call in `git()` and
the `realpathSync.native` call), written to the scratch tree and imported as its own module. The
shipped file is untouched, the control flow under test is the real one byte for byte apart from those
two lines, and the same patch applies cleanly to `6bf04f1` and to the fix. Each seam is asserted to
appear exactly once before it is replaced, and an unhooked harness run is checked to create and
discard a workspace normally.

The identical `verify.ts` run against a detached worktree of `6bf04f1` and against the fix.

Against `6bf04f1`: `11 CHECK(S) FAILED`, all inside sections 21 and 22; the 150 checks in sections 1
to 20 passed unchanged.

- 21, unreadable tip: `discard said: ok`. The worktree was removed, the branch left behind, a clean
  success logged, and `findWorkspace` no longer returned the workspace, so no retry was possible.
  That is the half-done job Sol described, verbatim.
- 21, unconfirmable deletion: `tip reads seen: 2`, then `discard said: ok`.
- 22, failed canonicalisation: `create said: CREATED ON AN UNRESOLVED PATH`.

Against the fix: `ALL CHECKS PASSED`, 22 sections.

- 21: `git would not say what the branch "conductor/task-h1" points at (fatal: cannot read refs), so
  Conductor cannot delete it safely and will not remove the copy ... while half the job is unknown.
  Nothing was changed.` The copy is still on disk, the branch is still there, the workspace is still
  findable, and a second discard with git answering again succeeds.
- 21, second half: `the copy at "..." is gone, but deleting the branch "conductor/task-h2" failed and
  git would not then say whether that branch is still there (fatal: cannot read refs), so the discard
  is unconfirmed.`
- 22: `the workspace folder "..." could not be resolved to a real path, so Conductor cannot tell where
  it actually leads and cannot prove the copy would live outside "..." . Nothing was created.` No
  copy, no branch, repo clean.

Section 22 also keeps one real-filesystem check that both revisions pass: a dangling junction under
the state root never ends in a copy. It is a safety check, not a reproduction, and is labelled so.

`npx tsc --noEmit` clean with `node_modules` present.

## Still parked

**The same-tip ABA race**, now stated accurately in the code comment rather than overclaimed. A branch
deleted and recreated at the same commit inside the window between the ownership check and
`update-ref -d` is deleted by Conductor. The tip git compares is the only evidence available and it
matches. The loss is a branch name pointing at a commit that still exists and is one `git branch`
away; closing it would need a ref transaction spanning `git worktree remove`, which git does not
offer.

**One lenient resolution remains on purpose.** `realPath(worktreePath)` after a successful
`git worktree add` still falls back lexically. No containment decision depends on it, the folder
provably exists by then, and refusing there would mean unwinding a copy that was already made. Named
here rather than left for the next pass to find.
