# Sol review, M2 slice A, round 2: is checkpoint and undo safe enough for a permissive default

Raw output from Sol. Not edited, not filtered. Triage follows under the separator, and that part is
Fable's, not Sol's.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief.md`
- Run from: repo root, branch `feat/m2-checkpoints`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only, session `019fbec6-fb1c-72f1-a7b8-4794b990b11b`, 54,692 tokens
- Files in scope: `src/engine/checkpoint.ts` in full, and the undo surface of `src/server/http.ts`
- Evidence given: both files inlined into the brief with line numbers. The codex sandbox cannot
  launch a process on this host, so Sol cannot read from disk here; the first round's run read
  nothing and refused. Inlining is the workaround, and it worked.
- Dimension: correctness and safety of reversibility only
- Told not to re-report as discoveries: .gitignored files outside the before-image, .gitattributes
  byte transformation, submodule contents, symlink referents, the non-atomic tree scan, the
  junction-swap race. Sol was asked to say if any is worse than described.
- Date: 2026-08-02

The prompt echo has been left out of what follows because the brief was 1,344 lines of inlined
source. Everything below is Sol's answer, verbatim.

---

1. **Critical — confirmation applies a stale plan without verifying the working tree.**  
   [src/server/http.ts:87](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\server\http.ts:87), [src/server/http.ts:449](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\server\http.ts:449), [src/engine/checkpoint.ts:805](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:805), [src/engine/checkpoint.ts:834](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:834)  
   Sequence: the task changes `report.md`; preview schedules it for restoration; the user then edits `report.md` before confirming; confirmation arrives within five minutes; the daemon applies the stored path list without recapturing or comparing the current tree and overwrites the new edit. The fingerprint covers the path/action list but no current-tree identity, and the TTL does not prevent this ordinary race.

2. **Critical — a task can make a captured file invisible to both provenance comparisons by adding an ignore rule.**  
   [src/engine/checkpoint.ts:300](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:300), [src/engine/checkpoint.ts:493](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:493), [src/engine/checkpoint.ts:665](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:665), [src/engine/checkpoint.ts:695](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:695)  
   Sequence: before the task, untracked `notes.txt` is not ignored and is captured with bytes A; the task adds `notes.txt` to `.gitignore` without deleting it; the post-image omits it because `git add -A` honors the new rule; after the task, the user changes the still-present ignored file to bytes B; the current tree omits it too, so `post-image..current` reports no change; undo classifies it as deleted by the task and restores A over B. The checkpoint-time ignore set does not protect it because it was not ignored at checkpoint time.

3. **Critical — the post-image proves timing, not authorship.**  
   [src/engine/checkpoint.ts:486](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:486), [src/engine/checkpoint.ts:675](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:675), [src/engine/checkpoint.ts:711](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:711), [src/engine/checkpoint.ts:945](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:945)  
   Sequence: while a task is running, the user independently edits `report.md`; the task never touches that file; the post-image captures the edit; no later edit occurs; `checkpoint..post-image` contains the path and `post-image..current` does not; undo restores the checkpoint bytes and the preview says “changed by the task.” This is a stable edit between snapshots, not the acknowledged non-atomic scan or hostile-process race.

4. **High — changed-after protection fails across case aliases on Windows.**  
   [src/engine/checkpoint.ts:695](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:695), [src/engine/checkpoint.ts:715](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:715), [src/engine/checkpoint.ts:789](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:789), [src/engine/checkpoint.ts:834](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:834)  
   Sequence: an untracked `foo.txt` exists at checkpoint; the task renames it to `FOO.txt`; after the post-image, the user edits `FOO.txt`; `changedAfter` holds the `FOO.txt` deletion, but the separate `foo.txt` restoration remains approved because map membership is case-sensitive; `checkout-index -f` restores `foo.txt` onto the same Windows filesystem object and overwrites the user’s edit. `caseCollisionsIn` misses this because the colliding deletion is held rather than present in `changes`.

5. **High — the supposedly pinned ignore set can be silently repointed and paired with an older checkpoint.**  
   [src/engine/checkpoint.ts:355](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:355), [src/engine/checkpoint.ts:370](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:370), [src/engine/checkpoint.ts:431](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:431), [src/engine/checkpoint.ts:541](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:541), [src/server/http.ts:114](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\server\http.ts:114)  
   Sequence: daemon one records task `t1`, whose ignore ref points to blob I1 protecting `secret.dat`; after restart, IDs begin at `t1` again; a new checkpoint updates the same checkpoint ref and the same ignore ref to I2; the process dies after those ref updates but before the new checkpoint event is logged; `findCheckpoint` returns the old logged record, while `readIgnored` reads I2 through the reused ref name. A path protected by I1 but absent from I2 can then be deleted. Line 640 merely checks that the reused checkpoint ref resolves, not that it still resolves to the logged commit.

6. **High — renaming and unignoring a pre-existing ignored file causes undo to delete it.**  
   [src/engine/checkpoint.ts:370](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:370), [src/engine/checkpoint.ts:695](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:695), [src/engine/checkpoint.ts:703](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:703), [src/engine/checkpoint.ts:945](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:945)  
   Sequence: `secret.dat` exists before the task and is ignored, so it is absent from the before-image and the recorded set contains only `secret.dat`; the task removes the rule and renames it to `public.dat`; the post-image contains `public.dat`; exact-path lookup does not associate it with the ignored source; undo calls it “created by the task” and deletes it, with no bytes available to recreate `secret.dat`. This is worse than the stated ignored-file limitation because the code promises such files will never be deleted.

7. **High — delete-then-restore cannot undo a file-to-directory replacement.**  
   [src/engine/checkpoint.ts:707](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:707), [src/engine/checkpoint.ts:842](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:842), [src/engine/checkpoint.ts:854](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:854), [src/engine/checkpoint.ts:875](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:875)  
   Sequence: checkpoint contains a regular file `a`; the task replaces it with `a/b`; undo deletes `a/b` but leaves the now-empty directory `a`; restoration of the checkpoint file `a` fails because a directory occupies that path; only afterward does pruning remove the directory. The final state has neither `a` nor `a/b`, and the HTTP surface still reports `applied: true` with the failure list.

8. **High — checkpoint Git plumbing still executes repository-configured programs that can alter the worktree or real index.**  
   [src/engine/checkpoint.ts:182](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:182), [src/engine/checkpoint.ts:300](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:300), [src/engine/checkpoint.ts:370](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:370), [src/engine/checkpoint.ts:431](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:431)  
   Sequence: a repository has a `reference-transaction` hook which runs `git add generated.txt`; `captureIgnored` calls `git update-ref` without an alternate `GIT_INDEX_FILE`; Git invokes the hook, whose nested `git add` stages into the user’s real index. Likewise, line 306 executes configured clean/process filters, which can modify files as side effects. Stripping inherited `GIT_*` variables and avoiding a shell does not disable hooks, filters, or other configured helpers. This is worse than the acknowledged byte-transformation limit because checkpointing can execute code and perturb repository state.

9. **Medium — sparse-checkout paths are recorded as present even when absent from the pre-task working tree.**  
   [src/engine/checkpoint.ts:286](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:286), [src/engine/checkpoint.ts:300](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:300), [src/engine/checkpoint.ts:493](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:493)  
   Sequence: sparse checkout omits tracked `outside.txt`; seeding the scratch index from HEAD nevertheless places its blob in the checkpoint tree, while `git add -A` leaves the skip-worktree entry intact; the task switches to or commits a HEAD where that path is deleted; the post-image lacks it; undo classifies it as deleted and materializes `outside.txt`, although it did not exist on disk before the task.

10. **Medium — pruning destroys pre-existing empty directories.**  
    [src/engine/checkpoint.ts:842](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:842), [src/engine/checkpoint.ts:875](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:875), [src/engine/checkpoint.ts:921](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:921)  
    Sequence: `keep/` is an empty directory before the checkpoint; the task creates `keep/temp.txt`; undo deletes that file and then prunes `keep/`; because Git trees contain no empty-directory provenance, it cannot distinguish the pre-existing directory from one created by the task.

11. **Medium — the preview falsely says held paths are not task work.**  
    [src/engine/checkpoint.ts:987](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:987), [src/engine/checkpoint.ts:992](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:992), [src/engine/checkpoint.ts:1000](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:1000)  
    Sequence: the task appends task content to `x`; after the post-image, the user appends human content to the same file; the path is correctly held, but the preview states that it is “NOT the task’s work” or “somebody else’s changes, not the task’s.” The current file contains both, and an override erases both.

12. **Low — the preview’s opening promise contradicts its actual plan.**  
    [src/engine/checkpoint.ts:955](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:955), [src/engine/checkpoint.ts:971](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:971), [src/engine/checkpoint.ts:987](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:987)  
    Sequence: a post-task edit causes the only differing path to be held; the preview first says the folder “would restore … to the checkpoint,” then says nothing will change and the differing path remains. The first sentence describes an end state the plan will not produce.

**Merge verdict: unsafe to merge as the basis for a permissive permission default.**
tokens used
54,692
1. **Critical — confirmation applies a stale plan without verifying the working tree.**  
   [src/server/http.ts:87](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\server\http.ts:87), [src/server/http.ts:449](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\server\http.ts:449), [src/engine/checkpoint.ts:805](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:805), [src/engine/checkpoint.ts:834](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:834)  
   Sequence: the task changes `report.md`; preview schedules it for restoration; the user then edits `report.md` before confirming; confirmation arrives within five minutes; the daemon applies the stored path list without recapturing or comparing the current tree and overwrites the new edit. The fingerprint covers the path/action list but no current-tree identity, and the TTL does not prevent this ordinary race.

2. **Critical — a task can make a captured file invisible to both provenance comparisons by adding an ignore rule.**  
   [src/engine/checkpoint.ts:300](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:300), [src/engine/checkpoint.ts:493](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:493), [src/engine/checkpoint.ts:665](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:665), [src/engine/checkpoint.ts:695](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:695)  
   Sequence: before the task, untracked `notes.txt` is not ignored and is captured with bytes A; the task adds `notes.txt` to `.gitignore` without deleting it; the post-image omits it because `git add -A` honors the new rule; after the task, the user changes the still-present ignored file to bytes B; the current tree omits it too, so `post-image..current` reports no change; undo classifies it as deleted by the task and restores A over B. The checkpoint-time ignore set does not protect it because it was not ignored at checkpoint time.

3. **Critical — the post-image proves timing, not authorship.**  
   [src/engine/checkpoint.ts:486](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:486), [src/engine/checkpoint.ts:675](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:675), [src/engine/checkpoint.ts:711](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:711), [src/engine/checkpoint.ts:945](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:945)  
   Sequence: while a task is running, the user independently edits `report.md`; the task never touches that file; the post-image captures the edit; no later edit occurs; `checkpoint..post-image` contains the path and `post-image..current` does not; undo restores the checkpoint bytes and the preview says “changed by the task.” This is a stable edit between snapshots, not the acknowledged non-atomic scan or hostile-process race.

4. **High — changed-after protection fails across case aliases on Windows.**  
   [src/engine/checkpoint.ts:695](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:695), [src/engine/checkpoint.ts:715](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:715), [src/engine/checkpoint.ts:789](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:789), [src/engine/checkpoint.ts:834](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:834)  
   Sequence: an untracked `foo.txt` exists at checkpoint; the task renames it to `FOO.txt`; after the post-image, the user edits `FOO.txt`; `changedAfter` holds the `FOO.txt` deletion, but the separate `foo.txt` restoration remains approved because map membership is case-sensitive; `checkout-index -f` restores `foo.txt` onto the same Windows filesystem object and overwrites the user’s edit. `caseCollisionsIn` misses this because the colliding deletion is held rather than present in `changes`.

5. **High — the supposedly pinned ignore set can be silently repointed and paired with an older checkpoint.**  
   [src/engine/checkpoint.ts:355](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:355), [src/engine/checkpoint.ts:370](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:370), [src/engine/checkpoint.ts:431](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:431), [src/engine/checkpoint.ts:541](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:541), [src/server/http.ts:114](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\server\http.ts:114)  
   Sequence: daemon one records task `t1`, whose ignore ref points to blob I1 protecting `secret.dat`; after restart, IDs begin at `t1` again; a new checkpoint updates the same checkpoint ref and the same ignore ref to I2; the process dies after those ref updates but before the new checkpoint event is logged; `findCheckpoint` returns the old logged record, while `readIgnored` reads I2 through the reused ref name. A path protected by I1 but absent from I2 can then be deleted. Line 640 merely checks that the reused checkpoint ref resolves, not that it still resolves to the logged commit.

6. **High — renaming and unignoring a pre-existing ignored file causes undo to delete it.**  
   [src/engine/checkpoint.ts:370](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:370), [src/engine/checkpoint.ts:695](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:695), [src/engine/checkpoint.ts:703](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:703), [src/engine/checkpoint.ts:945](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:945)  
   Sequence: `secret.dat` exists before the task and is ignored, so it is absent from the before-image and the recorded set contains only `secret.dat`; the task removes the rule and renames it to `public.dat`; the post-image contains `public.dat`; exact-path lookup does not associate it with the ignored source; undo calls it “created by the task” and deletes it, with no bytes available to recreate `secret.dat`. This is worse than the stated ignored-file limitation because the code promises such files will never be deleted.

7. **High — delete-then-restore cannot undo a file-to-directory replacement.**  
   [src/engine/checkpoint.ts:707](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:707), [src/engine/checkpoint.ts:842](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:842), [src/engine/checkpoint.ts:854](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:854), [src/engine/checkpoint.ts:875](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:875)  
   Sequence: checkpoint contains a regular file `a`; the task replaces it with `a/b`; undo deletes `a/b` but leaves the now-empty directory `a`; restoration of the checkpoint file `a` fails because a directory occupies that path; only afterward does pruning remove the directory. The final state has neither `a` nor `a/b`, and the HTTP surface still reports `applied: true` with the failure list.

8. **High — checkpoint Git plumbing still executes repository-configured programs that can alter the worktree or real index.**  
   [src/engine/checkpoint.ts:182](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:182), [src/engine/checkpoint.ts:300](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:300), [src/engine/checkpoint.ts:370](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:370), [src/engine/checkpoint.ts:431](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:431)  
   Sequence: a repository has a `reference-transaction` hook which runs `git add generated.txt`; `captureIgnored` calls `git update-ref` without an alternate `GIT_INDEX_FILE`; Git invokes the hook, whose nested `git add` stages into the user’s real index. Likewise, line 306 executes configured clean/process filters, which can modify files as side effects. Stripping inherited `GIT_*` variables and avoiding a shell does not disable hooks, filters, or other configured helpers. This is worse than the acknowledged byte-transformation limit because checkpointing can execute code and perturb repository state.

9. **Medium — sparse-checkout paths are recorded as present even when absent from the pre-task working tree.**  
   [src/engine/checkpoint.ts:286](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:286), [src/engine/checkpoint.ts:300](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:300), [src/engine/checkpoint.ts:493](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:493)  
   Sequence: sparse checkout omits tracked `outside.txt`; seeding the scratch index from HEAD nevertheless places its blob in the checkpoint tree, while `git add -A` leaves the skip-worktree entry intact; the task switches to or commits a HEAD where that path is deleted; the post-image lacks it; undo classifies it as deleted and materializes `outside.txt`, although it did not exist on disk before the task.

10. **Medium — pruning destroys pre-existing empty directories.**  
    [src/engine/checkpoint.ts:842](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:842), [src/engine/checkpoint.ts:875](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:875), [src/engine/checkpoint.ts:921](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:921)  
    Sequence: `keep/` is an empty directory before the checkpoint; the task creates `keep/temp.txt`; undo deletes that file and then prunes `keep/`; because Git trees contain no empty-directory provenance, it cannot distinguish the pre-existing directory from one created by the task.

11. **Medium — the preview falsely says held paths are not task work.**  
    [src/engine/checkpoint.ts:987](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:987), [src/engine/checkpoint.ts:992](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:992), [src/engine/checkpoint.ts:1000](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:1000)  
    Sequence: the task appends task content to `x`; after the post-image, the user appends human content to the same file; the path is correctly held, but the preview states that it is “NOT the task’s work” or “somebody else’s changes, not the task’s.” The current file contains both, and an override erases both.

12. **Low — the preview’s opening promise contradicts its actual plan.**  
    [src/engine/checkpoint.ts:955](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:955), [src/engine/checkpoint.ts:971](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:971), [src/engine/checkpoint.ts:987](C:\Users\KaneSnyder(nexwave)\repos\conductor\src\engine\checkpoint.ts:987)  
    Sequence: a post-task edit causes the only differing path to be held; the preview first says the folder “would restore … to the checkpoint,” then says nothing will change and the differing path remains. The first sentence describes an end state the plan will not produce.

**Merge verdict: unsafe to merge as the basis for a permissive permission default.**

---

## Fable's triage

Sol found twelve, down from fifteen. Nothing from round one came back, so the post-image, the plan
fingerprint, the delete-before-restore ordering, the pinned ignore blob and the stripped `GIT_*`
namespace all held. What Sol found this round is a different and mostly deeper class: the fixes are
correct in themselves, and the holes are in what they do not cover.

I read every cited line before writing this.

1. Stale plan applied without re-checking the tree. **Real, merge-blocking.** The fingerprint at
   `checkpoint.ts:805` covers the plan's own contents and nothing about the disk, and `applyUndo` at
   :834 never re-reads the tree, so an edit landing inside the five minute window is overwritten
   without a word.
2. A task adding an ignore rule hides a captured file from both comparisons. **Real,
   merge-blocking.** Traced it: the checkpoint-time set at :703 cannot contain a path that was not
   ignored at checkpoint time, so nothing holds it back and checkout-index writes the old bytes over
   the user's new ones.
3. The post-image proves timing, not authorship. **Real, merge-blocking.** A human edit made while
   the task runs lands inside `checkpoint..post-image` and comes out labelled "changed by the task"
   at :948. This is the exact failure that sank round one, narrowed rather than closed.
4. Case aliasing defeats the changed-after hold. **Real, merge-blocking.** Confirmed at :789, where
   `caseCollisionsIn` reads only `changes` and so cannot see a colliding delete that got held.
5. The ignore ref can be repointed and paired with an older checkpoint. **Real, cheap to fix.** Line
   640 checks that the ref resolves and never checks that it resolves to `record.commit`. Needs id
   reuse plus a crash between `update-ref` and the log write, so it is narrow, but the guard is one
   comparison.
6. Renaming an unignored file out of the ignore set gets it deleted. **Real, merge-blocking.** Worse
   than the known limit, and Sol was right to say so: the preview at :1024 flatly promises undo never
   deletes ignored files, and this path deletes one with no bytes anywhere to put it back.
7. File-to-directory replacement leaves neither. **Real, not blocking on its own.** The end state
   loses the file from disk, though the bytes survive in the checkpoint commit, and the failure does
   reach the caller in `failures`.
8. Hooks and filters still run. **Real, and worse than the known limit says.** `update-ref` at :378
   and :432 fires `reference-transaction`, and `add -A` at :306 runs configured filters. The
   acknowledged limit is about bytes being transformed; this is Conductor executing repository code
   and possibly writing the user's real index, which the file's own comment says cannot happen.
9. Sparse checkout records paths that are not on disk. **Real but unverified mechanism.** The
   reasoning holds if `read-tree` seeds skip-worktree entries that `add -A` then leaves alone. I did
   not confirm that against git's behaviour, and it deserves a spike rather than a straight fix.
10. Pruning removes pre-existing empty directories. **Real, low.** Unfixable in a git-tree
    before-image, since trees carry no empty directories. Belongs in the stated limits, not the
    backlog.
11. The preview calls held paths "not the task's work". **Real, medium.** Lines 993 and 1003 say it
    outright, and a file both the task and the human touched is held for a reason that makes the
    sentence false. Wording, but wording is what the human consents against.
12. The opening line promises a restore the plan will not perform. **Real, low.** Line 958 is
    unconditional and lines 971 to 972 can contradict it in the very next breath.

No false positives. Nothing here is a re-report of a known limit; findings 6 and 8 are known limits
that turned out to be worse than the note describing them, which is what Sol was asked to check.

**Verdict: not safe to merge.** Six of the twelve are merge-blocking, and four of those destroy work
the undo was supposed to protect. The slice is closer than round one and the architecture is now
right, but a permissive permission default cannot rest on it until 1, 2, 3, 4 and 6 are closed and 8
is either fixed or honestly stated.
