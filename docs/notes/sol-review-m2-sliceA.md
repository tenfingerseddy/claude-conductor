# Sol review, M2 slice A, checkpoints and undo: correctness and safety of reversibility

Raw output from Sol. Not edited, not filtered.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief.txt`
- Run from: repo root, branch `feat/m2-checkpoints`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only
- Files in scope: src/engine/checkpoint.ts, and the undo paths in src/server/http.ts, src/cli.ts, src/main.ts
- Evidence given: docs/notes/m2-sliceA-findings.md
- Dimension: correctness and safety of reversibility only
- Date: 2026-08-01

Note on method: the read-only sandbox could not launch a process on this Windows host
(`CreateProcessAsUserW failed: 5`), so Sol could read no files and declined to review rather than
invent findings. The run below is the retry, with all five files inlined into the brief with line
numbers. Sol reviewed from that text and cited those line numbers.

---

codex
I’m reviewing only the inlined code and stated evidence, with reversibility as the sole criterion. I’ll report reproducible operation sequences and distinguish silent corruption from loud/partial failure.
codex
Verdict: M2 slice A does not yet justify the permissive permission default. There are three critical failures where ordinary undo can destroy unrelated work or act without informed consent, plus several repository/configuration cases that silently defeat byte-exact recovery.

## Critical

1. **Undo cannot distinguish task changes from work created afterward by a human or another process.**

   `src/engine/checkpoint.ts:400-420`, `442-477`, `527-529`

   Reproduction:

   1. Checkpoint records `file.txt = A`.
   2. The task finishes.
   3. A user changes it to `U`, or creates `notes.txt`.
   4. Preview compares only checkpoint-versus-current. It classifies `file.txt` as “changed by the task” and `notes.txt` as “created by the task.”
   5. Confirmation overwrites `U` with `A` and deletes `notes.txt`.

   There is no provenance or task-end snapshot. Sequential post-task user work—not merely a narrow race—is silently treated as task output and destroyed. The same applies to unstaged edits made after a file was staged: the index copy survives, but the newer unstaged bytes do not.

2. **The before-image excludes the user’s index, HEAD/branch changes, and merge/rebase state, so common Git operations by the task are irreversible.**

   `src/engine/checkpoint.ts:198-216`, `259-291`, `440-497`; `src/main.ts:107-140`

   Reproduction:

   1. The user stages blob `S`, or pauses midway through a merge/rebase.
   2. Checkpoint captures only the working-tree tree using a scratch index.
   3. The task runs `git reset --hard`, `git add`, `git commit`, `git checkout`, `git rebase --abort`, or otherwise changes `.git/index`, refs, HEAD, or rebase/merge metadata.
   4. Undo restores selected working-tree paths but deliberately never restores the real index, HEAD, refs, `MERGE_HEAD`, or rebase state.

   The staged state or interrupted operation is not recovered. A staged blob removed from the index can become unreachable and later be pruned. The statement at `checkpoint.ts:540` that staged changes are “not touched” does not mean pre-task staged state survives task activity.

3. **Confirmation is not bound to the preview the human saw.**

   `src/server/http.ts:401-423`; `src/cli.ts:175-203`

   Reproduction:

   1. `POST /undo` with `confirm:false` returns plan P1.
   2. Before confirmation, another actor creates or changes a file.
   3. `POST /undo` with `confirm:true` independently computes plan P2 and immediately applies it.
   4. P2 may delete or overwrite paths absent from P1.

   The CLI makes this worse: it prints P1, sends the second request, then prints only P2’s counts and failures—not P2’s preview or change list. A first and only request with `confirm:true` is also accepted; its preview is returned only after mutation. Therefore the HTTP path does not enforce “preview first,” and the CLI does not verify that the confirmed plan equals the reviewed plan.

## High

4. **Inherited Git environment variables can bypass the non-Git-folder gate and checkpoint an unrelated repository.**

   `src/engine/checkpoint.ts:100-108`, `148-176`, `255-304`; `src/main.ts:107-133`

   Reproduction:

   1. Start Conductor with `GIT_DIR=C:\repo\.git` and `GIT_WORK_TREE=C:\repo`.
   2. Queue a task whose cwd is an unrelated, non-Git folder.
   3. `git rev-parse --show-toplevel` inherits those variables and returns `C:\repo`, so `checkpointRefusal` accepts the task.
   4. Checkpoint objects and the Conductor ref are written into `C:\repo`.
   5. The session starts in the unrelated task folder.
   6. Undo later refuses because the recorded task folder is outside the repository.

   The task therefore runs with no checkpoint of its actual folder, while checkpointing perturbs a different repository.

5. **A case-only rename can cause undo to delete the file it just restored on Windows.**

   `src/engine/checkpoint.ts:400-423`, `442-477`

   Reproduction on a case-insensitive worktree where Git records the new spelling:

   1. Checkpoint contains `foo.txt`.
   2. Task renames it to `FOO.txt`.
   3. With rename detection disabled, the plan contains an addition for `FOO.txt` and possibly a deletion for `foo.txt`.
   4. Undo restores `foo.txt` first.
   5. It then removes `FOO.txt`.
   6. Both spellings name the same filesystem object, so the restored file is deleted.

   If Git’s ignore-case handling instead collapses the two names, the synthetic trees can compare equal and undo silently leaves the wrong casing. Either path violates exact restoration.

6. **The ignored-file limitation is worse than documented: a file ignored at checkpoint time can be deleted.**

   `src/engine/checkpoint.ts:202-205`, `394-420`, `473-477`, `539`; `docs/notes/m2-sliceA-findings.md:23-28`

   Reproduction:

   1. `.gitignore` ignores `cache.bin`; a pre-existing user `cache.bin` is omitted from the checkpoint.
   2. The task removes that ignore rule without changing `cache.bin`.
   3. Current-tree construction now adds `cache.bin`.
   4. The diff classifies it as created after the checkpoint.
   5. Undo restores `.gitignore`, then deletes `cache.bin`.

   Thus “undo neither restores nor deletes ignored files” is false when ignore rules change between checkpoint and undo.

7. **The `.gitattributes` limitation is worse than described, and applies to arbitrary clean/smudge transformations.**

   `src/engine/checkpoint.ts:27-41`, `207-216`, `394-423`, `460-466`; `docs/notes/m2-sliceA-findings.md:29-33`

   Two reproductions:

   - With `file.txt text eol=crlf`, checkpoint an LF working file, then have the task change only its line endings to CRLF. Both working copies clean to the same blob, so preview reports “nothing to change” and undo does not run. This is silent non-detection, not merely conversion during restore.
   - Configure `file.dat filter=lossy`, with a clean filter that maps multiple byte sequences to one value. The checkpoint never contains the original bytes. Current differing bytes can clean to the same blob, producing an empty preview; otherwise checkout applies the smudge filter and can restore different bytes.

   `core.autocrlf=false` does not disable text attributes, `working-tree-encoding`, `ident`, or filter drivers. Filter commands can also have repository-side effects while checkpointing.

8. **Superproject checkpoints do not capture dirty or untracked content inside submodules or embedded repositories.**

   `src/engine/checkpoint.ts:207-216`, `394-423`

   Reproduction:

   1. Task cwd is the superproject and contains submodule `vendor/lib` at commit S.
   2. Before the task, the user has uncommitted bytes `U` inside that submodule.
   3. The checkpoint records only gitlink S.
   4. The task overwrites `U`, without changing the submodule’s checked-out commit.
   5. Current-tree construction again records gitlink S.
   6. Preview is empty and undo does nothing.

   The exact pre-task bytes inside the submodule are permanently absent from the checkpoint.

9. **Symlink referents are outside the before-image, and a path race can make undo delete outside the task folder.**

   `src/engine/checkpoint.ts:207-216`, `360-369`, `440-477`

   Reproductions:

   - A tracked symlink inside the task folder points to a file outside the repository. The task overwrites the referent without changing the symlink. Both trees contain the same link object, preview reports nothing, and undo leaves the outside file damaged.
   - Preview plans to delete `sub/new.txt`. Before application, another process replaces `sub` with a symlink or junction to an outside directory containing `new.txt`. `applyUndo` uses `join(repoRoot, path)` and `rmSync` without re-resolving the parent chain, so it deletes the outside file.

   The lexical task-folder check does not remain valid across symlink replacement.

10. **Putting `config.stateRoot` inside a non-ignored worktree makes the checkpoint include its own scratch index and Conductor state.**

    `src/engine/checkpoint.ts:181-185`, `207-216`, `291-306`, `394-425`; `src/cli.ts:35-42`

    Reproduction:

    1. Configure the state root as `repo\.conductor`, without ignoring it.
    2. `read-tree` creates `.conductor/tmp/index-…`.
    3. `git add -A` scans the repository and adds that active scratch index as an ordinary untracked file.
    4. The `finally` block deletes it after the tree was written.
    5. The working tree therefore differs from the checkpoint immediately after successful checkpointing.
    6. Events, token/config files, and later preview scratch indexes can also enter the plans. Undo can restore an old events file, erasing the checkpoint event used to locate itself.

    Nothing in the scoped code enforces the claim that the scratch index is outside the repository.

11. **Checkpoint construction is not a point-in-time snapshot.**

    `src/engine/checkpoint.ts:207-216`, `259-304`; `src/main.ts:107-133`

    Reproduction:

    1. `git add -A` reads `a.txt` as version 1.
    2. A concurrent writer updates `a.txt` and `b.txt` to version 2 while the scan continues.
    3. Git reads `b.txt` after the update.
    4. The checkpoint can contain `a` version 1 and `b` version 2—a combination that was never the complete working tree at any instant.

    A simpler race exists after checkpoint returns but before `runSession`: an editor can save version 2 in that interval, making version 2 the actual pre-task bytes while undo later restores version 1.

## Medium

12. **Task IDs and checkpoint refs are reused after daemon restart, overwriting older checkpoints.**

    `src/server/http.ts:102-103`, `314-316`; `src/engine/checkpoint.ts:233-236`, `280-286`, `319-348`

    Reproduction:

    1. One daemon creates task `t1` and ref C1.
    2. Restarting resets `nextId` to 1.
    3. The next task is also `t1`; `update-ref` unconditionally overwrites the same ref with C2.
    4. `findCheckpoint("t1")` returns the newest log event, so the supported doors cannot select C1.
    5. C1 is now unreferenced and can be pruned by Git GC.

    `undo t1` is therefore ambiguous across daemon lifetimes, and older reversibility is lost.

13. **Undo removes pre-existing empty directories without previewing them.**

    `src/engine/checkpoint.ts:473-479`, `500-512`, `515-541`

    Reproduction:

    1. Before checkpoint, `keep-empty\` exists but contains no files; Git does not record it.
    2. The task creates `keep-empty\new.txt`.
    3. Preview lists only deletion of `new.txt`.
    4. After deleting it, `pruneEmptyDirs` removes `keep-empty` and may remove further pre-existing empty parents.

    The final filesystem is not the pre-task filesystem, and the preview omits the directory deletions.

14. **Executable-mode changes can be invisible when `core.fileMode=false`.**

    `src/engine/checkpoint.ts:207-216`, `451-466`

    Reproduction on POSIX:

    1. HEAD records `script.sh` as non-executable.
    2. The user makes it executable while `core.fileMode=false`.
    3. The scratch index is seeded with the non-executable HEAD mode, and `git add -A` retains that mode.
    4. The task later changes or removes the file.
    5. Undo checks it out with the non-executable checkpoint mode, not its pre-task executable mode.

    This contradicts the claim that checkpoint modes represent the working tree and that checkout restores them correctly.

15. **Application is non-atomic and can report counts that do not match performed writes.**

    `src/engine/checkpoint.ts:442-480`; `src/server/http.ts:421-423`

    Reproduction:

    1. Checkpoint contains modified `a.txt` and a regular file `z`.
    2. Current state modifies `a.txt` and replaces `z` with non-empty directory `z\child`.
    3. `checkout-index` processes `a.txt`, restoring it, then fails because `z` is a non-empty directory.
    4. Because the Git command exits nonzero, code records `restored = 0`, despite already changing `a.txt`.
    5. It proceeds to delete `z\child` and prune `z`.
    6. HTTP returns `applied:true` with a failure, leaving a partially restored tree and inaccurate restored count.

The first three findings alone break the safety argument: undo can destroy non-task work, cannot recover task-induced Git-state damage, and is not bound to the preview that supposedly authorizes it.

---

# Triage (Fable)

Per finding: real, false positive, or already-known. One clause each.

## Critical

1. **Post-task work destroyed and mislabelled.** Real, merge-blocking. The plan is a diff of
   checkpoint against now, so it has no way to tell task output from a human's later edit, and
   `describePlan` states "created by the task" about files the task never touched.
2. **Index, HEAD, refs and merge/rebase state are outside the before-image.** Real, and the honesty
   half is merge-blocking: capturing only the working tree is a defensible v1 scope, but the preview
   line "your branch, HEAD and staged changes are not touched" reads as a promise that pre-task
   staged state survives, which it does not.
3. **Confirm is not bound to the preview.** Real, merge-blocking. `http.ts:401-423` recomputes the
   plan on the confirming call and applies that one, and it accepts `confirm: true` on a first and
   only request, so the two-call shape does not actually enforce preview first.

## High

4. **Inherited `GIT_DIR` / `GIT_WORK_TREE` redirect the checkpoint.** Real, not blocking. `gitEnv`
   spreads `process.env` wholesale, so the hole is genuine, but it needs a daemon started with those
   variables already set.
5. **Case-only rename deletes the file undo just restored.** Real, merge-blocking on a
   Windows-first project. `applyUndo` restores before it deletes, and on a case-insensitive
   filesystem both spellings are one object, so the file ends up gone.
6. **A changed ignore rule lets undo delete a previously ignored file.** Real, and worse than the
   stated limit, which claims undo neither restores nor deletes ignored files.
7. **`.gitattributes` is worse than described.** Real. The stated limit is about content changing on
   restore; Sol's eol-only case is silent non-detection, where preview reports nothing to change
   while the working file genuinely differs, and clean/smudge filter drivers widen it further.
8. **Submodule contents not captured.** Real, unstated limit; the checkpoint holds the gitlink only,
   so dirty bytes inside a submodule are neither seen nor restorable.
9. **Symlinks.** Split. The referent case is real and is an unstated limit. The junction-swap race
   is real in principle but needs a hostile concurrent actor, so it is low priority.
10. **State root inside the worktree.** False positive as a live risk. `src/config.ts:71-76` refuses
    at startup when the state root sits inside a git checkout, which is outside Sol's file scope so
    it could not see the guard. Worth a pointer comment in `checkpoint.ts`, nothing more.
11. **`git add -A` is not a point-in-time snapshot.** Real, not blocking. No cheap fix exists without
    filesystem snapshots, and the second half, the gap between checkpoint return and session start,
    is inherent to the design; it should be a stated limit rather than a fix.

## Medium

12. **Task ids reused across daemon restarts overwrite refs.** Real. `nextId` resets to 1 in the
    Daemon constructor, so a restart produces a second `t1`, and `update-ref` overwrites the first
    checkpoint unconditionally.
13. **`pruneEmptyDirs` removes pre-existing empty directories the preview never listed.** Real,
    small, and it is a preview-accuracy defect, which is the category that matters most here.
14. **`core.fileMode=false` captures the wrong mode.** Real but POSIX-only, so it is a low priority
    on a Windows-first project.
15. **Non-atomic apply reports counts that do not match what happened.** Real. A partial
    `checkout-index` failure yields `restored: 0` alongside `applied: true` after files were already
    written.

## Verdict

**Not safe to merge.** Four findings are real and merge-blocking: 1 (undo destroys and mislabels
work the task did not do), 3 (confirmation is not bound to the preview a human approved), 5
(case-only rename deletes the restored file on Windows), and 6 (a changed ignore rule lets undo
delete a file the stated limit promises it will never touch).

The pattern under those four is one thing: the before-image is honest, but the plan built from it
guesses at provenance and the preview asserts that guess as fact. The permissive default rests on a
human reading the preview and believing it, so preview accuracy is not a polish item here, it is the
load-bearing claim.

Findings 2, 7, 8, 9a and 11 are real limits rather than bugs. They belong in the stated-limits list
before slice A is called done, because the current list of two reads as exhaustive and is not.
Finding 10 is a false positive. Expect another round after the fixes, the way the rail needed.
