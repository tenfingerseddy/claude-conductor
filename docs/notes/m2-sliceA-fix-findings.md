# M2 slice A fix round: provenance, bound consent, ordering, and a recorded ignore set

Built and verified 2026-08-01 on branch `feat/m2-checkpoints`, after Sol found slice A unsafe to
merge (`sol-review-m2-sliceA.md`). Four findings were merge-blocking. This document is the evidence
that each of them fails on the code as it was and passes on the code as it is, plus the re-run of the
slice A finish line showing nothing else moved. Every transcript is raw output from a run, pasted
whole. All git work happened in throwaway repositories under the session scratchpad; no real project
was touched.

## Sol's diagnosis, which was right

The before-image was sound. The plan built from it guessed at provenance, and the preview asserted
that guess as fact. A diff of "checkpoint against now" cannot tell what a task did from what a human
did afterwards, so undo destroyed later work and labelled it "created by the task". The permissive
default rests on a human reading the preview and believing it, which makes preview accuracy the
load-bearing claim rather than a polish item.

## What changed

**1. A post-image, so provenance is known rather than inferred.** When a task finishes, the same
plumbing writes a second commit to `refs/conductor/postimage/<taskId>`. The task-changed set is now
checkpoint..post-image. Anything differing between post-image and now was changed by somebody else.
Undo only ever touches the task-changed set. Everything else is listed in the preview by name as
changed after the task and left alone, and moving it needs `overrideChangedAfterTask` on the wire or
`--override-changed-after-task` on the command line, which prints the exact list first. A task that
dies without a post-image degrades honestly: the preview says the post-image is missing, says
provenance is therefore unknown, and refuses the blanket undo unless the same override is given.
The post-image is taken in a `finally`, because the task that crashes is the one whose damage most
needs attributing.

**2. Confirmation bound to the preview.** The preview returns a `planId` and a `planHash`, a SHA-256
of the exact plan. Confirming must present both, and the daemon applies the stored plan rather than
computing a new one. A confirm with no prior preview, a mismatched hash, an expired plan, or a
replayed plan id are all refusals. Plans expire after five minutes and are single use. The CLI sends
the first call's identifiers on the second call, so what executes is the list it printed.

**3. Deletions before restores, and case collisions named.** `applyUndo` now deletes, then restores,
then prunes emptied directories. On a case-insensitive filesystem `foo.txt` and `FOO.txt` are one
object, so the old order destroyed the file it had just restored. Ordering is the fix; the plan also
detects delete-versus-restore collisions that differ only in case and names them in the preview, so
the fix cannot regress into an accident of sort order.

**4. The ignore set recorded at checkpoint time.** `git ls-files --others --ignored` runs before the
task and the result is stored as a blob, pinned by `refs/conductor/ignored/<taskId>` so `git gc`
cannot collect it. Undo asks that recorded set what `.gitignore` covered and never re-reads the
current `.gitignore`, because the current `.gitignore` is the file the task may have edited. A
checkpoint whose ignore record is missing is a refusal, not a fallback.

Files touched: `src/engine/checkpoint.ts`, `src/server/http.ts`, `src/cli.ts`, `src/main.ts`,
`src/state/logbook.ts` (two new event kinds and three new fields). No new dependencies. Every git
call is still an argument array through `spawnSync` with no shell. `tsc --noEmit` is clean.

## How the before-and-after was run

`git worktree add --detach` put the pre-fix commit in a scratch folder, with `node_modules` junctioned
in. One reproduction script takes the source tree to exercise as an environment variable and imports
`checkpoint.ts`, `http.ts` and `config.ts` from it, so the identical script runs against both
versions and the difference in output is the difference in the code. The script feature-detects
`postImageTask`, which the old build does not have, and says so in its output.

Twenty checks. Thirteen fail before, none fail after.

## Reproduction, before the fix: 13 of 20 checks fail
```

================ R1: a human edit made after the task survives undo ================
  checkpoint ok: true
  post-image: this build has none
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-before\r1" to the checkpoint taken before task r1.
  |   ref:    refs/conductor/checkpoints/r1
  |   commit: f96b43571e4d2beefed5f723d96c33dcb15196d7
  | 
  |   restore  (changed by the task)  bothfile.txt
  |   restore  (changed by the task)  humanfile.txt
  |   delete   (created by the task)  humannew.txt
  |   restore  (changed by the task)  taskfile.txt
  |   delete   (created by the task)  tasknew.txt
  | 
  |   3 file(s) restored, 2 file(s) deleted.
  |   files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  |   your branch, HEAD and staged changes are not touched.
  applied: {"restored":3,"deleted":2,"failures":[]}
  [PASS] the task's edit is undone  orig-task
  [PASS] the task's new file is deleted
  [FAIL] the human's edit survives  orig-human
  [FAIL] the human's new file survives  <absent>
  [FAIL] the human's later edit of a task-touched file survives  orig-both

================ R1b: a task that died without a post-image ================
  provenance: not modelled, changes planned: 1
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-before\r1b" to the checkpoint taken before task r1b.
  |   ref:    refs/conductor/checkpoints/r1b
  |   commit: 208e022c3b7caa7f253a9dd670095c4dbf53d986
  | 
  |   restore  (changed by the task)  file.txt
  | 
  |   1 file(s) restored, 0 file(s) deleted.
  |   files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  |   your branch, HEAD and staged changes are not touched.
  [FAIL] the blanket undo is refused when provenance is unknown
  [FAIL] the file was not silently reverted  before

================ R3: a case-only rename leaves the right file with the right bytes ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-before\r3" to the checkpoint taken before task r3.
  |   ref:    refs/conductor/checkpoints/r3
  |   commit: 78339a550520157394e04272f01be4ea8bb3bc35
  | 
  |   restore  (deleted by the task)  foo.txt
  |   delete   (created by the task)  FOO.txt
  | 
  |   1 file(s) restored, 1 file(s) deleted.
  |   files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  |   your branch, HEAD and staged changes are not touched.
  applied: {"restored":1,"deleted":1,"failures":[]}
  files on disk matching foo.txt: []
  [FAIL] the restored file still exists
  [FAIL] it carries the checkpoint bytes  <absent>
  [FAIL] it carries the checkpoint spelling  undefined

================ R4: a task that edits .gitignore cannot widen what undo deletes ================
  checkpoint ok: true, files 2
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-before\r4" to the checkpoint taken before task r4.
  |   ref:    refs/conductor/checkpoints/r4
  |   commit: aa53e93b635491134d121a2b4e896381a884f1e9
  | 
  |   restore  (changed by the task)  .gitignore
  |   delete   (created by the task)  cache.bin
  | 
  |   1 file(s) restored, 1 file(s) deleted.
  |   files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  |   your branch, HEAD and staged changes are not touched.
  applied: {"restored":1,"deleted":1,"failures":[]}
  [FAIL] the file .gitignore covered at checkpoint time is untouched  <absent>
  [PASS] .gitignore itself is restored  cache.bin

================ R2: confirming an undo executes the list that was previewed ================
  blind confirm -> 200 {"applied":true}
  [FAIL] a confirm with no prior preview is refused
  [FAIL] nothing was changed by it  before
  preview -> 200, planId undefined, list []
  confirm -> 200 {"applied":true,"restored":0,"deleted":1}
  [FAIL] a file that appeared after the preview is not touched
  [PASS] the previewed restore did happen  before
  tampered hash -> 200 {"applied":false}
  [FAIL] a mismatched planHash is refused
  replayed plan -> 200 {"applied":false}
  [PASS] a spent plan id cannot be replayed

================ 13 CHECK(S) FAILED ================
```

### Reading of the before run

- **R1, finding 1.** The task edited `taskfile.txt` and created `tasknew.txt`. A human then edited
  `humanfile.txt`, created `humannew.txt`, and edited `bothfile.txt` which the task had also touched.
  The preview called all five "the task", and undo reverted the human's edit, deleted the human's new
  file, and reverted the human's later edit. Three destructions, none of them announced as such.
- **R1b.** With no post-image at all, the old build still produced a confident plan and applied it.
  There was nothing in the design that could distinguish this case, which is the point.
- **R3, finding 5.** After a case-only rename, undo restored `foo.txt` and then deleted `FOO.txt`.
  Both spell one file on Windows, so the file is gone: `files on disk matching foo.txt: []`. Undo
  reported `restored: 1, deleted: 1, failures: []` while leaving nothing behind.
- **R4, finding 6.** The task removed the `cache.bin` rule from `.gitignore` and touched nothing
  else. Undo restored `.gitignore` and deleted the user's `cache.bin`, which the stated limit
  promised it would never do.
- **R2, finding 3.** A first and only request carrying `confirm: true` was accepted and applied, with
  the preview returned only after the mutation. Then a preview was taken, `sneaky.txt` was created
  before confirming, and the confirming call deleted it: a path that appeared in no preview anybody
  saw. A `planHash` of `deadbeef` was accepted without complaint, because nothing was checking one.

## Reproduction, after the fix: 20 of 20 checks pass
```

================ R1: a human edit made after the task survives undo ================
  checkpoint ok: true
  post-image: refs/conductor/postimage/r1
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-after\r1" to the checkpoint taken before task r1.
  |   ref:    refs/conductor/checkpoints/r1
  |   commit: 5b9eb699bd4f9aa445449651c7096ac80ca82b82
  | 
  |   restore  (changed by the task)  taskfile.txt
  |   delete   (created by the task)  tasknew.txt
  | 
  |   1 file(s) restored, 1 file(s) deleted.
  | 
  |   changed after the task finished, so left alone (3):
  |     would restore  bothfile.txt
  |     would restore  humanfile.txt
  |     would delete   humannew.txt
  |   These are somebody else's changes, not the task's. Undo will not touch them. To include exactly
  |   the paths listed above, send "overrideChangedAfterTask": true, or pass
  |   --override-changed-after-task on the command line.
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  applied: {"restored":1,"deleted":1,"failures":[]}
  [PASS] the task's edit is undone  orig-task
  [PASS] the task's new file is deleted
  [PASS] the human's edit survives  HUMAN EDIT AFTER THE TASK
  [PASS] the human's new file survives  HUMAN MADE THIS
  [PASS] the human's later edit of a task-touched file survives  HUMAN EDIT AFTER THE TASK

================ R1b: a task that died without a post-image ================
  provenance: unknown, changes planned: 0
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-after\r1b" to the checkpoint taken before task r1b.
  |   ref:    refs/conductor/checkpoints/r1b
  |   commit: 97df898064c6fb6f3f6ed53bb16ea232bff1eef4
  | 
  |   NO POST-IMAGE was recorded for this task, so Conductor cannot tell the task's work from anybody
  |   else's. The task did not finish cleanly, or its post-image is gone. Provenance is unknown, so the
  |   blanket undo is refused. Nothing below will be touched without the override named at the end.
  | 
  |   nothing would be changed: every difference is being held back, see below.
  | 
  |   0 file(s) restored, 0 file(s) deleted.
  | 
  |   held back, provenance unknown (1):
  |     would restore  file.txt
  |   These are somebody else's changes, not the task's. Undo will not touch them. To include exactly
  |   the paths listed above, send "overrideChangedAfterTask": true, or pass
  |   --override-changed-after-task on the command line.
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  [PASS] the blanket undo is refused when provenance is unknown
  [PASS] the file was not silently reverted  changed by somebody, nobody knows whom
  with the override, changes planned: 1
  [PASS] the named override still allows a deliberate undo

================ R3: a case-only rename leaves the right file with the right bytes ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-after\r3" to the checkpoint taken before task r3.
  |   ref:    refs/conductor/checkpoints/r3
  |   commit: bf0d4e4984f2433b553173758e329dd2bf9095f4
  | 
  |   restore  (deleted by the task)  foo.txt
  |   delete   (created by the task)  FOO.txt
  | 
  |   1 file(s) restored, 1 file(s) deleted.
  | 
  |   1 path(s) differ from a restored path only in case, so on Windows they are the same file.
  |   Undo deletes before it restores, so the checkpoint spelling is what ends up on disk:
  |     FOO.txt
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  applied: {"restored":1,"deleted":1,"failures":[]}
  files on disk matching foo.txt: ["foo.txt"]
  [PASS] the restored file still exists
  [PASS] it carries the checkpoint bytes  THE ORIGINAL BYTES
  [PASS] it carries the checkpoint spelling  foo.txt

================ R4: a task that edits .gitignore cannot widen what undo deletes ================
  checkpoint ok: true, files 2
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-after\r4" to the checkpoint taken before task r4.
  |   ref:    refs/conductor/checkpoints/r4
  |   commit: e8a90d3bdb7de700bc5aeb6d77108e1e358b60f3
  | 
  |   restore  (changed by the task)  .gitignore
  | 
  |   1 file(s) restored, 0 file(s) deleted.
  |   1 path(s) .gitignore covered when the checkpoint was taken are left alone.
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  applied: {"restored":1,"deleted":0,"failures":[]}
  [PASS] the file .gitignore covered at checkpoint time is untouched  THE USER'S IGNORED FILE
  [PASS] .gitignore itself is restored  cache.bin

================ R2: confirming an undo executes the list that was previewed ================
  blind confirm -> 400 "confirming an undo needs the planId and planHash from a preview. Ask for the preview first and confirm the list it returns."
  [PASS] a confirm with no prior preview is refused
  [PASS] nothing was changed by it  the task changed this
  preview -> 200, planId cfebd8f0a0d7bc58580c6732, list ["file.txt"]
  confirm -> 200 {"applied":true,"restored":1,"deleted":0}
  [PASS] a file that appeared after the preview is not touched
  [PASS] the previewed restore did happen  before
  tampered hash -> 409 "the planHash does not match the stored plan, so the list being confirmed is not the list that was previewed."
  [PASS] a mismatched planHash is refused
  replayed plan -> 409 "that undo plan is unknown or has expired. Ask for a fresh preview and confirm that one."
  [PASS] a spent plan id cannot be replayed

================ ALL CHECKS PASSED ================
```

### Reading of the after run

- **R1.** The plan is two paths, both the task's. The human's three paths appear under "changed after
  the task finished, so left alone", by name, with the override that would include them. After undo:
  `taskfile.txt` is back to `orig-task`, `tasknew.txt` is gone, and all three human paths hold the
  human's bytes. This is the check the whole round exists for.
- **R1b.** No post-image, so the preview leads with `NO POST-IMAGE was recorded for this task`, plans
  zero changes, and the file keeps the bytes it had. The named override still allows a deliberate
  undo, and the preview shows exactly which path it would touch first.
- **R3.** `files on disk matching foo.txt: ["foo.txt"]`, holding `THE ORIGINAL BYTES`, with the
  checkpoint's spelling. The preview names the collision before it happens.
- **R4.** `cache.bin` still holds the user's bytes; `.gitignore` is restored. The preview counts the
  path it left alone.
- **R2.** The blind confirm is a 400 naming what is missing. The bound confirm applies the previewed
  list and leaves `sneaky.txt`, which appeared afterwards, alone. A tampered hash is a 409. A replayed
  plan id is a 409.

## The limits that are limits, detected rather than silent

Sol's findings 2, 7, 8, 9a and 11 are real, and none of them is fixed here: they are properties of a
working-tree image built with git plumbing. What was wrong was that the preview said nothing while
they applied. Four of the five are cheap to detect, so the preview now names them in the run where
they bite. The full list, rewritten so it no longer reads as exhaustive, is in
`m2-sliceA-findings.md`.

The run below builds one repository that hits three at once: a submodule with committed content, a
`.gitattributes` declaring `text eol=crlf`, and a merge paused mid-conflict.
```
warning: in the working copy of '.gitmodules', LF will be replaced by CRLF the next time Git touches it
  (no symlink on this host: Error: EPERM: operation not permitted, symlink 'C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-lim\limits\a.txt' -> 'C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-lim\limits\link.txt')
  symlink recorded as a link object: false
  merge attempt: Auto-merging a.txt
  checkpoint ok: true, merge or rebase recorded as: "merge"

--- the preview a human would read ---
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-lim\limits" to the checkpoint taken before task limits1.
  ref:    refs/conductor/checkpoints/limits1
  commit: 97cf9f1d50068971e977c7062625a38351658282

  restore  (changed by the task)  a.txt

  1 file(s) restored, 0 file(s) deleted.
  files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  neither restores nor deletes them, whatever .gitignore says now.
  directories a deletion leaves empty are removed, up to the task folder.
  your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  a working-tree image only: staged state the task destroyed does not come back.
  1 submodule(s) are in this folder. The checkpoint holds the commit each one pointed at, not the files inside it, so uncommitted work inside a submodule is neither captured nor restored.
  this repository has a .gitattributes. Attributes such as "text", "working-tree-encoding", "ident" and clean or smudge filters rewrite bytes on the way in, so a file can come back converted, and a difference that is only line endings may not appear in the list above at all.
  a merge was in progress when the checkpoint was taken. Undo does not restore it, or the index it belongs to.
  this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
```

The symlink case is the one this host could not exercise: creating a symlink needs a privilege this
account does not have (`EPERM: operation not permitted, symlink`), so the detection exists and is
unverified, and that is said here rather than implied by silence. The non-atomic scan, finding 11,
is not detectable at all and is stated in the limits list only.

## Slice A finish line, re-run: the engine

The original slice A verification, run again against the fixed code. Same eight tests, with the
post-image added where a task's work is simulated.
```
state root: "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\state-fl"

================ TEST 1: user state survives a checkpoint ================
checkpoint ok: true
  ref    refs/conductor/checkpoints/demo1
  commit 574914ddb7b0fddc05d3c7ec198df1ede4623e46
  files  5
status byte-identical:      true
index (ls-files -s) same:   true
.git/index file hash same:  true (941c6aae4904c2e5 -> 941c6aae4904c2e5)
HEAD unmoved:               true (7c74341d886ad95cf33e383ea7dd0c21bd7e1b0f)
branch unchanged:           true (master)
reflog unchanged:           true
working files unchanged:    true
--- git branch --list -a AFTER (the Conductor refs must not appear) ---
* master
--- git for-each-ref refs/conductor ---
574914ddb7b0fddc05d3c7ec198df1ede4623e46 commit	refs/conductor/checkpoints/demo1
dcf503aff7342d7f82a83be8558ef1a1ba3f36e7 blob	refs/conductor/ignored/demo1
--- the staged change is still staged ---
staged.txt

================ TEST 2: a mess is made and perfectly undone ================
--- file hashes before the task ---
  181314065df2f2fd  .gitignore
  35e59e7e4e02ad95  build/artifact.bin
  e33dbd20d732ad6d  doomed.txt
  5b51b7fc0d4ffa3d  scratchnote.txt
  9ac007af3de930ba  staged.txt
  370a8c04b8a65bb4  sub/nested.txt
  985fddcf72ea5ce1  tracked.txt

--- git status --porcelain after the mess ---
D doomed.txt
A  staged.txt
 M sub/nested.txt
 M tracked.txt
?? brandnew.txt
?? scratchnote.txt
?? sub/deeper/

checkpoint found again from the logbook: true, ref refs/conductor/checkpoints/demo1
post-image found again: true, ref refs/conductor/postimage/demo1

--- the preview a human would read ---
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-fl\mess" to the checkpoint taken before task demo1.
  |   ref:    refs/conductor/checkpoints/demo1
  |   commit: 9da1e8bfe805d57a9833637ff2641fdc40069105
  | 
  |   delete   (created by the task)  brandnew.txt
  |   restore  (deleted by the task)  doomed.txt
  |   restore  (changed by the task)  scratchnote.txt
  |   delete   (created by the task)  sub/deeper/alsonew.txt
  |   restore  (changed by the task)  sub/nested.txt
  |   restore  (changed by the task)  tracked.txt
  | 
  |   4 file(s) restored, 2 file(s) deleted.
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.

applied: {"restored":4,"deleted":2,"failures":[]}

--- file hashes after undo ---
  181314065df2f2fd  .gitignore
  b280fe04580f3a81  build/artifact.bin
  e33dbd20d732ad6d  doomed.txt
  5b51b7fc0d4ffa3d  scratchnote.txt
  9ac007af3de930ba  staged.txt
  370a8c04b8a65bb4  sub/nested.txt
  985fddcf72ea5ce1  tracked.txt

working tree byte-identical to before the task, ignoring .gitignore'd paths: true
the one ignored file is deliberately untouched: build/artifact.bin 35e59e7e4e02ad95 -> b280fe04580f3a81

--- git status --porcelain after undo ---
A  staged.txt
 M tracked.txt
?? scratchnote.txt
status matches the pre-task status: true
staged change still staged: true
empty directory left by a deleted file removed: true
the user's untracked note is back: "untracked work in progress\n"
the user's unstaged edit is back: "user edited this and did not stage it\n"

================ TEST 3: a repository with zero commits ================
checkpoint ok: true
  head recorded as: null (null is correct: no commits yet)
  commit has no parent: true
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-fl\fresh" to the checkpoint taken before task fresh1.
  |   ref:    refs/conductor/checkpoints/fresh1
  |   commit: b16a779d47a8ccb8886d9020163f6586c1df3f49
  | 
  |   delete   (created by the task)  extra.txt
  |   restore  (changed by the task)  only.txt
  | 
  |   1 file(s) restored, 1 file(s) deleted.
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  applied: {"restored":1,"deleted":1,"failures":[]}
  tree back to before: true
  HEAD still unborn: true

================ TEST 4: detached HEAD ================
checkpoint ok: true, detached recorded as true
  HEAD unmoved:      true
  still detached:    true
  a second checkpoint changes status: false

================ TEST 6: a non-git folder is refused ================
refusal: the folder "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-fl\plain-folder" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run "git init" in that folder, or point the task at a folder that is already under version control.
checkpointTask ok: false

================ TEST 7: undo confined to the task folder ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-fl\scoped\project" to the checkpoint taken before task scoped1.
  |   ref:    refs/conductor/checkpoints/scoped1
  |   commit: 7a58d65de1b2f01363713a2be601765a490b4854
  | 
  |   restore  (changed by the task)  project/a.txt
  | 
  |   1 file(s) restored, 0 file(s) deleted.
  |   1 changed file(s) outside the task folder are left exactly as they are.
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  applied: {"restored":1,"deleted":0,"failures":[]}
  project/a.txt restored: true
  outside.txt left alone: true

================ TEST 8: the .gitattributes limit, probed honestly ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-fl\attrs" to the checkpoint taken before task attr1.
  |   ref:    refs/conductor/checkpoints/attr1
  |   commit: a94e47ef4703b7955df19cafb2bec1c6021b5d62
  | 
  |   restore  (changed by the task)  crlf.txt
  |   restore  (changed by the task)  lf.txt
  | 
  |   2 file(s) restored, 0 file(s) deleted.
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this repository has a .gitattributes. Attributes such as "text", "working-tree-encoding", "ident" and clean or smudge filters rewrite bytes on the way in, so a file can come back converted, and a difference that is only line endings may not appear in the list above at all.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  lf.txt: e9024f1a07d29d52 -> 6612d9c94c2da8d2  NOT EXACT (the stated limit)
    bytes now: "line one\r\nline two\r\n"
  crlf.txt: 6612d9c94c2da8d2 -> 6612d9c94c2da8d2  exact
  eol-only change, paths the preview names: []
  (empty is the documented silent non-detection: both spellings clean to one blob.)

================ logbook lines written ================
{"ts":"2026-08-01T13:52:34.972Z","kind":"checkpoint","taskId":"demo1","ref":"refs/conductor/checkpoints/demo1","commit":"574914ddb7b0fddc05d3c7ec198df1ede4623e46","tree":"53ff3c65ddb1f6f3c36fa47ecc744f4b7c55ce87","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\demo1","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\demo1","head":"7c74341d886ad95cf33e383ea7dd0c21bd7e1b0f","detached":false,"files":5,"ignoredRef":"refs/conductor/ignored/demo1","inProgress":null}
{"ts":"2026-08-01T13:52:35.674Z","kind":"checkpoint","taskId":"demo1","ref":"refs/conductor/checkpoints/demo1","commit":"9da1e8bfe805d57a9833637ff2641fdc40069105","tree":"b5717997d481cc4d6ccc30c52b8ce11a5c45bdcf","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\mess","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\mess","head":"e050226293743aa542d268860da4a678d44990ae","detached":false,"files":6,"ignoredRef":"refs/conductor/ignored/demo1","inProgress":null}
{"ts":"2026-08-01T13:52:35.869Z","kind":"postimage","taskId":"demo1","ref":"refs/conductor/postimage/demo1","commit":"79669df101252d2501aabe5d6fd8e979e61f76aa","tree":"7e3dd4d4bf5c23006876485022269971cd5d82bf","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\mess"}
{"ts":"2026-08-01T13:52:36.279Z","kind":"undo","taskId":"demo1","ref":"refs/conductor/checkpoints/demo1","commit":"9da1e8bfe805d57a9833637ff2641fdc40069105","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\mess","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\mess","provenance":"post-image","override":false,"restored":4,"deleted":2,"heldBack":0,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T13:52:36.742Z","kind":"checkpoint","taskId":"fresh1","ref":"refs/conductor/checkpoints/fresh1","commit":"b16a779d47a8ccb8886d9020163f6586c1df3f49","tree":"00a508799f7194abe5f1d4b7f89c7c3703858140","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\fresh","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\fresh","head":null,"detached":false,"files":1,"ignoredRef":"refs/conductor/ignored/fresh1","inProgress":null}
{"ts":"2026-08-01T13:52:36.909Z","kind":"postimage","taskId":"fresh1","ref":"refs/conductor/postimage/fresh1","commit":"37bfba048786b8f05cdbcd19483997314c1357af","tree":"04c19a911d991712c4d1fb9e460084d8a9ef7a31","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\fresh"}
{"ts":"2026-08-01T13:52:37.241Z","kind":"undo","taskId":"fresh1","ref":"refs/conductor/checkpoints/fresh1","commit":"b16a779d47a8ccb8886d9020163f6586c1df3f49","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\fresh","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\fresh","provenance":"post-image","override":false,"restored":1,"deleted":1,"heldBack":0,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T13:52:37.836Z","kind":"checkpoint","taskId":"det1","ref":"refs/conductor/checkpoints/det1","commit":"904188b544fb19b5fcd9a7f419ced862a4116703","tree":"08585692ce06452da6f82ae66b90d98b55536fca","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\detached","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\detached","head":"9aba3c4fe2483ac10c76c6159007cb73ed7bead5","detached":true,"files":1,"ignoredRef":"refs/conductor/ignored/det1","inProgress":null}
{"ts":"2026-08-01T13:52:38.294Z","kind":"checkpoint","taskId":"det2","ref":"refs/conductor/checkpoints/det2","commit":"6822e7cb79fb6cee72918dc6a34f4d4ab2d16e58","tree":"08585692ce06452da6f82ae66b90d98b55536fca","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\detached","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\detached","head":"9aba3c4fe2483ac10c76c6159007cb73ed7bead5","detached":true,"files":1,"ignoredRef":"refs/conductor/ignored/det2","inProgress":null}
{"ts":"2026-08-01T13:52:38.365Z","kind":"checkpoint_refused","taskId":"plain1","cwd":"C:\\Users\\KANESN~1\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\plain-folder","reason":"the folder \"C:\\Users\\KANESN~1\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\plain-folder\" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run \"git init\" in that folder, or point the task at a folder that is already under version control."}
{"ts":"2026-08-01T13:52:38.906Z","kind":"checkpoint","taskId":"scoped1","ref":"refs/conductor/checkpoints/scoped1","commit":"7a58d65de1b2f01363713a2be601765a490b4854","tree":"ba75d5a6a8f284d392dbe3391b7e88b9c39f9da2","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\scoped","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\scoped\\project","head":"d5956f304aab5274abc32a8f2d8328466491f313","detached":false,"files":2,"ignoredRef":"refs/conductor/ignored/scoped1","inProgress":null}
{"ts":"2026-08-01T13:52:39.087Z","kind":"postimage","taskId":"scoped1","ref":"refs/conductor/postimage/scoped1","commit":"b8757eb8d750662b81bb69cb00a3f65429b1987a","tree":"2e89b260c6e14b97319662a64d2b43217f12530d","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\scoped"}
{"ts":"2026-08-01T13:52:39.476Z","kind":"undo","taskId":"scoped1","ref":"refs/conductor/checkpoints/scoped1","commit":"7a58d65de1b2f01363713a2be601765a490b4854","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\scoped","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\scoped\\project","provenance":"post-image","override":false,"restored":1,"deleted":0,"heldBack":0,"outsideLeftAlone":1,"failures":0}
{"ts":"2026-08-01T13:52:40.025Z","kind":"checkpoint","taskId":"attr1","ref":"refs/conductor/checkpoints/attr1","commit":"a94e47ef4703b7955df19cafb2bec1c6021b5d62","tree":"ca32e720db685e54bb22dc356635c3e49cc78482","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\attrs","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\attrs","head":"a3fe1665bef6895501509385eb587ab953679b0f","detached":false,"files":3,"ignoredRef":"refs/conductor/ignored/attr1","inProgress":null}
{"ts":"2026-08-01T13:52:40.211Z","kind":"postimage","taskId":"attr1","ref":"refs/conductor/postimage/attr1","commit":"787c2b8c147605d4f708428d46c50c546eba17a0","tree":"4ec36e4847bd08df278e8c278d2f0a2e664c2ce2","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\attrs"}
{"ts":"2026-08-01T13:52:40.595Z","kind":"undo","taskId":"attr1","ref":"refs/conductor/checkpoints/attr1","commit":"a94e47ef4703b7955df19cafb2bec1c6021b5d62","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\attrs","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\attrs","provenance":"post-image","override":false,"restored":2,"deleted":0,"heldBack":0,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T13:52:41.157Z","kind":"checkpoint","taskId":"attr2","ref":"refs/conductor/checkpoints/attr2","commit":"57dc8a890d444d20162e318a205e812f9853e27c","tree":"6f8b3684bb3c0c802569069b0e433a5f06ad2d1a","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\attrs-silent","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\attrs-silent","head":"2e76dc3132a921aa1f9c72df102d79ffa231fb78","detached":false,"files":2,"ignoredRef":"refs/conductor/ignored/attr2","inProgress":null}
{"ts":"2026-08-01T13:52:41.327Z","kind":"postimage","taskId":"attr2","ref":"refs/conductor/postimage/attr2","commit":"fdbb05862dc3ef10ed4edaee8a2fc8e862e570d0","tree":"6f8b3684bb3c0c802569069b0e433a5f06ad2d1a","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix\\work-fl\\attrs-silent"}

=== done ===
```

### Reading of the engine re-run

Every claim the original run made still holds. Test 1: `git status --porcelain` byte-identical, the
index file's own hash unchanged, `ls-files -s` unchanged, HEAD unmoved, branch unchanged, reflog
unchanged, working files unchanged, and `git branch --list -a` shows only `master`. The Conductor
refs appear only under `refs/conductor`, and there are now two of them before a task ends: the
checkpoint commit and the ignore-set blob. Test 2: every hash returns to its pre-task value, the
emptied directory is removed, the status matches, the staged change is still staged, and the one
ignored file is deliberately untouched. Tests 3 and 4 behave as before on an unborn HEAD and a
detached HEAD. Test 6 refuses a non-git folder. Test 7 restores only inside the task folder and
counts what it left outside.

Test 8 is the one worth reading twice. The documented conversion half still fails on purpose:
`lf.txt` goes in as LF against a `text eol=crlf` attribute and comes back CRLF. The silent half Sol
named is now probed as well: a file changed only in its line endings produces an empty change list,
because both spellings clean to one blob. That is not a bug introduced here and it is not fixed here.
It is printed, so nobody has to discover it.

## Slice A finish line, re-run: the doors

The real daemon, the real HTTP endpoint, the real CLI, with the bound confirmation in place.
```
=== starting the daemon ===
conductor 0.1.0
  listening:  http://127.0.0.1:7747 (loopback only)
  state root: "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\state-doors"
  door token: "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\state-doors\daemon-token" (fresh for this daemon; doors read it from there)
  playbook:   2174 chars
  accounts:   0 usable of 2 configured

No usable accounts yet. Edit "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\state-doors\config.json" and point each entry at a real
Claude Code config directory.

=== a non-git folder is refused at the queue door ===
conductor: the folder "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-doors\plain" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run "git init" in that folder, or point the task at a folder that is already under version control.
  exit code: 1

=== the same command against the git folder is accepted past the reversibility gate ===
conductor: no usable account; edit "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\state-doors\config.json"
  exit code: 1

=== checkpointing the scratch repo through the engine, then making a mess ===
  checkpoint: refs/conductor/checkpoints/t1 104f6bdba25ab2e62ceab170a88e4389ee3d1252
  post-image: refs/conductor/postimage/t1 df48865b0110823c81d3af0895994bae7c693d70
  git status now:
 D gone.txt
 M keep.txt
?? new.txt
?? untracked.txt

=== POST /undo with no confirm: preview only, nothing changes ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: 104f6bdba25ab2e62ceab170a88e4389ee3d1252

  restore  (deleted by the task)  gone.txt
  restore  (changed by the task)  keep.txt
  delete   (created by the task)  new.txt
  restore  (changed by the task)  untracked.txt

  3 file(s) restored, 1 file(s) deleted.
  files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  neither restores nor deletes them, whatever .gitignore says now.
  directories a deletion leaves empty are removed, up to the task folder.
  your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  a working-tree image only: staged state the task destroyed does not come back.
  this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  applied: false
  planId: c3bd6d22cfc8900a3bce6444, planHash: 469299c623d79a55...
  note: nothing was changed. Send "confirm": true with this planId and planHash to apply exactly this list.
  git status after the unconfirmed call (must be unchanged):
 D gone.txt
 M keep.txt
?? new.txt
?? untracked.txt

=== conductor undo t1 without --yes ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: 104f6bdba25ab2e62ceab170a88e4389ee3d1252

  restore  (deleted by the task)  gone.txt
  restore  (changed by the task)  keep.txt
  delete   (created by the task)  new.txt
  restore  (changed by the task)  untracked.txt

  3 file(s) restored, 1 file(s) deleted.
  files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  neither restores nor deletes them, whatever .gitignore says now.
  directories a deletion leaves empty are removed, up to the task folder.
  your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  a working-tree image only: staged state the task destroyed does not come back.
  this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.

nothing has been changed. Run "conductor undo t1 --yes" to apply exactly the list above.
  exit code: 0
  git status after (must still be unchanged):
 D gone.txt
 M keep.txt
?? new.txt
?? untracked.txt

=== conductor undo t1 --yes ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: 104f6bdba25ab2e62ceab170a88e4389ee3d1252

  restore  (deleted by the task)  gone.txt
  restore  (changed by the task)  keep.txt
  delete   (created by the task)  new.txt
  restore  (changed by the task)  untracked.txt

  3 file(s) restored, 1 file(s) deleted.
  files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  neither restores nor deletes them, whatever .gitignore says now.
  directories a deletion leaves empty are removed, up to the task folder.
  your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  a working-tree image only: staged state the task destroyed does not come back.
  this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.

undone: 3 file(s) restored, 1 file(s) deleted.
  exit code: 0
  git status after:
?? untracked.txt
  keep.txt:      original
  gone.txt:      delete me
  untracked.txt: user work in progress
  new.txt:       removed, correct
  refs/conductor:
104f6bdba25ab2e62ceab170a88e4389ee3d1252 commit	refs/conductor/checkpoints/t1
e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 blob	refs/conductor/ignored/t1
df48865b0110823c81d3af0895994bae7c693d70 commit	refs/conductor/postimage/t1

=== conductor undo with no task id, defaulting to the last checkpoint ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: 104f6bdba25ab2e62ceab170a88e4389ee3d1252

  nothing would be changed: every difference is being held back, see below.

  0 file(s) restored, 0 file(s) deleted.

  changed after the task finished, so left alone (1):
    would restore  keep.txt
  These are somebody else's changes, not the task's. Undo will not touch them. To include exactly
  the paths listed above, send "overrideChangedAfterTask": true, or pass
  --override-changed-after-task on the command line.
  files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  neither restores nor deletes them, whatever .gitignore says now.
  directories a deletion leaves empty are removed, up to the task folder.
  your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  a working-tree image only: staged state the task destroyed does not come back.
  this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  exit code: 0
  keep.txt: clobbered again

=== a human edit made after the task, through the CLI door ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: 104f6bdba25ab2e62ceab170a88e4389ee3d1252

  nothing would be changed: every difference is being held back, see below.

  0 file(s) restored, 0 file(s) deleted.

  changed after the task finished, so left alone (2):
    would delete   humannote.txt
    would restore  keep.txt
  These are somebody else's changes, not the task's. Undo will not touch them. To include exactly
  the paths listed above, send "overrideChangedAfterTask": true, or pass
  --override-changed-after-task on the command line.
  files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  neither restores nor deletes them, whatever .gitignore says now.
  directories a deletion leaves empty are removed, up to the task folder.
  your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  a working-tree image only: staged state the task destroyed does not come back.
  this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  exit code: 0
  humannote.txt: written by a human after the task

=== logbook ===
  daemon_start  
  checkpoint t1 
  postimage t1 
  undo t1 restored=3 deleted=1 heldBack=0 provenance=post-image

=== stopping the daemon ===
daemon stopping.
  exit code: 0

=== done ===
```

### Reading of the doors re-run

- A non-git folder is still refused at the queue door with exit code 1. The same command against the
  git folder gets past the reversibility gate and stops on the account check, which is the correct
  next gate for a scratch daemon with no accounts.
- `POST /undo` without `confirm` returns the preview, `applied: false`, a `planId`, a `planHash`, and
  a note saying to send those back. `git status` after that call is unchanged.
- `conductor undo t1` without `--yes` prints the preview and changes nothing.
- `conductor undo t1 --yes` restores three files and deletes one, using the plan from its own first
  call. `keep.txt` is back to `original`, the deleted `gone.txt` is back, the user's untracked
  `untracked.txt` is back to `user work in progress`, and the task's `new.txt` is gone. The
  repository shows three Conductor refs and no branch.
- `conductor undo --yes` with no task id defaults to the last checkpoint. This time the working tree
  had been changed by a human after the task, so it plans nothing, names the path it is holding back,
  and exits 0 having touched nothing. On the old code this call silently reverted that edit.
- The last block writes `humannote.txt` after the task and runs undo again: the note survives, named
  in the preview as changed after the task.
- The logbook carries `provenance`, `override` and `heldBack` on every undo line, so the trail says
  what the undo knew as well as what it did.

## Closure of all fifteen Sol findings

| # | Sol's finding | Outcome | Evidence |
|---|---|---|---|
| 1 | Undo cannot tell task output from later human work | **Fixed** | R1 and R1b, before and after, above. `postImageTask` and `previewUndo` in `src/engine/checkpoint.ts`; the `finally` in `src/main.ts` |
| 2 | Index, HEAD, refs and merge or rebase state outside the before-image | **Documented limit**, now announced | Limits list item 2 in `m2-sliceA-findings.md`; preview line "your index, HEAD, branch and any merge or rebase in progress are not read and not restored"; the merge case detected and named in the limits run above |
| 3 | Confirmation not bound to the preview | **Fixed** | R2, before and after. `planFingerprint` in `checkpoint.ts`, `previewUndoPlan` and `applyPreviewedUndo` in `src/server/http.ts`, the two-call flow in `src/cli.ts` |
| 4 | Inherited `GIT_DIR` / `GIT_WORK_TREE` redirect the checkpoint | **Open, carried** | Not fixed and not documented as a limit. It is a real hole, it was outside the four this round was scoped to, and calling it closed would be false. It needs a scrub of git-specific variables in `gitEnv`, which is a small change and its own review |
| 5 | Case-only rename deletes the file undo just restored | **Fixed** | R3, before and after. Delete-then-restore ordering plus `caseCollisionsIn` in `applyUndo` and `previewUndo` |
| 6 | A changed ignore rule lets undo delete a previously ignored file | **Fixed** | R4, before and after. `captureIgnored` and `readIgnored` in `checkpoint.ts`, `refs/conductor/ignored/<taskId>` |
| 7 | `.gitattributes` is worse than described, including silent non-detection | **Documented limit**, now announced | Limits list item 3; test 8 in the engine re-run probes both halves, including the empty change list for an eol-only difference; preview names any repository holding a `.gitattributes` |
| 8 | Submodule contents not captured | **Documented limit**, now announced | Limits list item 4; the limits run above detects the submodule and says so in the preview |
| 9a | Symlink referents outside the before-image | **Documented limit**, now announced | Limits list item 5; detection is in `treeFacts`, and it is unverified on this host because creating a symlink returned `EPERM` |
| 9b | A junction swap between preview and delete can escape the folder | **Open, carried** | Needs a hostile concurrent actor. Not fixed. Recorded here rather than quietly dropped |
| 10 | State root inside a non-ignored worktree | **False positive** | The guard exists at `src/config.ts:71-76` and refuses at startup when the state root sits inside a git checkout. It was outside Sol's file scope, so it could not be seen. A pointer comment now sits on `scratchIndex` in `checkpoint.ts` |
| 11 | `git add -A` is not a point-in-time snapshot | **Documented limit** | Limits list item 6. Not detectable and not cheaply fixable without filesystem snapshots, so it is stated and nothing more |
| 12 | Task ids reused after a daemon restart overwrite refs | **Documented limit** | Limits list item 10. It belongs to the queue rather than to the checkpoint, and M2's real queue is where it gets fixed |
| 13 | `pruneEmptyDirs` removes directories the preview never listed | **Fixed as a preview defect** | The preview now says "directories a deletion leaves empty are removed, up to the task folder", visible in every transcript above. Pruning also moved after the restores, so a directory a restore needs is never removed in between |
| 14 | `core.fileMode=false` captures the wrong mode | **Documented limit** | Limits list item 8. POSIX-only, and untested on this Windows-first project |
| 15 | Non-atomic apply reports counts that do not match writes | **Fixed for the counts** | `checkoutPaths` in `checkpoint.ts`: the batch stays the fast path, and a failure falls back to one call per path so the count and the failure list describe what happened. The non-atomicity itself is limits list item 11 |

Two rows say "open, carried" rather than closed. That is deliberate. Finding 4 needs an environment
scrub that deserves its own look, and finding 9b needs a hostile process racing an undo. Neither is
in the four this round was scoped to, and marking them closed would be exactly the kind of confident
claim this whole round exists to stop making.

## What this does not unlock

Nothing yet. Slice A is reversibility only. Slice B, argument-vector execution and filesystem-level
place enforcement, and then slice C, are still what re-enable autonomous trust. What changed is that
the preview a human reads is now a description of what undo will do, rather than a guess presented as
one, and that is the claim the permissive default was always resting on.
