# M2 slice A, second fix round: a git environment that cannot be redirected, and a preview that claims only what it knows

Built and verified 2026-08-01 on branch `feat/m2-checkpoints`, after the first fix round
(`m2-sliceA-fix-findings.md`) closed Sol's four merge-blocking findings. Two defects were left: Sol's
carried-open finding 4, and one the architect found reading the fixed file. This document is the
evidence that each fails on the code as it was and passes on the code as it is, plus the re-run of
everything the first round proved, showing nothing else moved. Every transcript is raw output from a
run, pasted whole. All git work happened in throwaway repositories under the session scratchpad
against a scratch `CONDUCTOR_HOME`; no real project was touched.

One file changed: `src/engine/checkpoint.ts`. No new dependencies. `tsc --noEmit` is clean.

## What changed

**1. The git environment is denied by default, not inherited (Sol's finding 4).** `gitEnv` spread
`process.env` wholesale, so `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_INDEX_FILE` and
`GIT_CONFIG_*` all rode into every git call this file makes. A daemon started from a git hook, or
from a shell that exports any of them, would have every command answer about a different repository
than the one it names: a before-image written into somebody else's repo, or a restore taken out of
one. The whole `GIT_*` namespace is now stripped and only what Conductor sets deliberately goes back
in: `GIT_INDEX_FILE` when a scratch index is in play, `GIT_TERMINAL_PROMPT=0`, and the commit
identity when a commit is being written. Nothing is allowed through: git finds its exec path, its
config and its repository from the cwd we hand it, which is the only repository this file is
entitled to touch. The match is case-insensitive, because the Windows environment is, so `Git_Dir`
is caught too.

`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are stripped with the rest and deliberately **not**
replaced with an empty file. Stripping is what stops an inherited pair steering us. Neutralising
them as well would mean reading the repository differently from the way the user's own git reads it,
which would change `core.longpaths`, `safe.directory` and filter behaviour, and a checkpoint that
does not match what the user sees is not a before-image. The settings that must not vary are already
passed per command as `-c`, which outranks any config file.

**2. The preview attributes work only when a post-image says it can.** Under unknown provenance the
override folds the held changes into `changes`, and the main loop then printed them as "created by
the task" and "changed by the task". Those are the exact claims that cannot be made when there is no
post-image. The same held-then-folded paths were mislabelled under known provenance too: with a
post-image and the override given, somebody else's edit was printed as the task's. Wording now comes
from one function, `verbFor`, and attribution needs both a post-image and a path that is not in the
held set. Otherwise the line says what is actually known:

```
  delete   (present now, not in the checkpoint)
  restore  (differs from the checkpoint)
  restore  (in the checkpoint, absent now)
```

Two sentences around the held list made the same kind of claim and were fixed with it: the
`OVERRIDE GIVEN` header, which called the held paths "NOT the task's work" even with no post-image
to say so, and the footer "These are somebody else's changes, not the task's", which under unknown
provenance becomes "Whose changes these are is not recorded". The rest of `describePlan` and the
plan-building code were read line by line: the counts, the `why` values, the case-collision block,
the ignored-path count, the outside-the-folder count and the limit notes are all statements about
trees and paths, and none of them attributes anything to anybody.

## How the before-and-after was run

`git worktree add --detach` put the pre-fix commit (`30172da`) in a scratch folder with
`node_modules` junctioned in. One script, `repro2.ts`, takes the source tree to exercise as an
environment variable and imports `checkpoint.ts` and `config.ts` from it, so the identical script
runs against both versions and the difference in output is the difference in the code. Its own git
calls always strip `GIT_*`, so the harness observes rather than participates.

Twenty-one checks. Fifteen fail before, none fail after.

## Reproduction, before the fix: 15 of 21 checks fail
```

================ A: GIT_DIR and GIT_WORK_TREE point at a decoy while a checkpoint is taken ================
  checkpoint ok: true
  repoRoot recorded:  C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-before\a-decoy
  refs in the intended repo: ""
  refs in the decoy repo:    "refs/conductor/checkpoints/a1\nrefs/conductor/ignored/a1"
  [FAIL] the checkpoint records the repository the task folder is in  C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-before\a-decoy
  [FAIL] the checkpoint ref is written into the intended repository
  [FAIL] no Conductor ref is written into the decoy repository
  [PASS] the decoy working tree is untouched

================ B: GIT_DIR and GIT_WORK_TREE point at a decoy while an undo runs ================
  preview refused: the checkpoint ref "refs/conductor/checkpoints/b1" no longer exists in "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-before\b-intended"
  [FAIL] the intended repo is put back to its checkpoint  THE TASK CHANGED THIS
  [FAIL] the file the task created in the intended repo is gone
  [PASS] the decoy repo is untouched

================ B2: GIT_WORK_TREE alone points at a decoy while an undo runs ================
  planned: []
  applied: {"restored":0,"deleted":0,"failures":[]}
  [FAIL] the intended repo is put back to its checkpoint  THE TASK CHANGED THIS
  [FAIL] the file the task created in the intended repo is gone
  [PASS] the decoy repo is untouched

================ C: the preview under unknown provenance, with the override ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-before\c-unknown" to the checkpoint taken before task c1.
  |   ref:    refs/conductor/checkpoints/c1
  |   commit: 1c79bfb2a4020a5a4c7b848ec949f12a06ce8cb2
  | 
  |   NO POST-IMAGE was recorded for this task, so Conductor cannot tell the task's work from anybody
  |   else's. The task did not finish cleanly, or its post-image is gone. Provenance is unknown, so the
  |   blanket undo is refused. Nothing below will be touched without the override named at the end.
  | 
  |   delete   (created by the task)  appeared.txt
  |   restore  (changed by the task)  edited.txt
  |   restore  (deleted by the task)  removed.txt
  | 
  |   2 file(s) restored, 1 file(s) deleted.
  | 
  |   OVERRIDE GIVEN: the 3 path(s) below are NOT the task's work and will be changed anyway:
  |     would delete   appeared.txt
  |     would restore  edited.txt
  |     would restore  removed.txt
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  [PASS] provenance is unknown and the override folded the changes in
  [FAIL] the preview does not say the task created anything
  [FAIL] the preview does not say the task changed anything
  [FAIL] the preview does not say the task deleted anything
  [FAIL] it says what is actually known about a file that is present now
  [FAIL] it says what is actually known about a file that differs
  [FAIL] it says what is actually known about a file that is missing

================ D: the preview with a post-image, override folding somebody else's work in ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-before\d-known" to the checkpoint taken before task d1.
  |   ref:    refs/conductor/checkpoints/d1
  |   commit: 103e68a271db09d44d88d2fc56d627a2234e7a1d
  | 
  |   restore  (changed by the task)  humanfile.txt
  |   delete   (created by the task)  humannew.txt
  |   restore  (changed by the task)  taskfile.txt
  | 
  |   2 file(s) restored, 1 file(s) deleted.
  | 
  |   OVERRIDE GIVEN: the 2 path(s) below are NOT the task's work and will be changed anyway:
  |     would restore  humanfile.txt
  |     would delete   humannew.txt
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  [PASS] provenance is from the post-image
  [PASS] the task's own edit is still named as the task's  restore  (changed by the task)  taskfile.txt
  [FAIL] the human's edit, folded in by the override, is not  restore  (changed by the task)  humanfile.txt
  [FAIL] the human's new file, folded in by the override, is not  delete   (created by the task)  humannew.txt

================ 15 CHECK(S) FAILED ================
```

### Reading of the before run

- **A.** With `GIT_DIR` and `GIT_WORK_TREE` pointed at a decoy repository, a checkpoint of a task
  folder in `a-intended` recorded `repoRoot` as `a-decoy`, wrote `refs/conductor/checkpoints/a1` and
  `refs/conductor/ignored/a1` into the decoy, and left the intended repository with no checkpoint at
  all. The task would then have run with nothing to undo, while a repository nobody named grew two
  refs and a commit object.
- **B.** A checkpoint taken cleanly, then an undo run with the same two variables set: git looked for
  the checkpoint ref in the decoy, did not find it, and the undo refused. The task's changes stayed
  on disk. Loud rather than destructive in this shape, but the repository being consulted was still
  the wrong one.
- **B2.** `GIT_WORK_TREE` alone is the quiet shape, and the worse one. The refs are still found,
  because the git directory is discovered from the cwd, but the working tree read is the decoy's. The
  plan came out empty, so undo reported `restored: 0, deleted: 0, failures: []` and changed nothing,
  while the task's edit and the task's new file both survived. An undo that silently does nothing and
  reports success is the failure mode this file was written to avoid.
- **C.** No post-image, override given. Every line of the preview attributed the change to the task:
  "created by the task" for a file that appeared from somewhere, "changed by the task" for a file
  somebody edited, "deleted by the task" for a file somebody removed. The header three lines above it
  says in capitals that provenance is unknown, and then the list states it anyway. The
  `OVERRIDE GIVEN` line adds a second unsupported claim: that the paths are "NOT the task's work".
- **D.** With a post-image and the override, the human's edit and the human's new file were folded
  into the main list and printed as "changed by the task" and "created by the task", next to the
  task's own file with the identical wording. The record could tell them apart; the preview did not.

## Reproduction, after the fix: 21 of 21 checks pass
```

================ A: GIT_DIR and GIT_WORK_TREE point at a decoy while a checkpoint is taken ================
  checkpoint ok: true
  repoRoot recorded:  C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-after\a-intended
  refs in the intended repo: "refs/conductor/checkpoints/a1\nrefs/conductor/ignored/a1"
  refs in the decoy repo:    ""
  [PASS] the checkpoint records the repository the task folder is in  C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-after\a-intended
  [PASS] the checkpoint ref is written into the intended repository
  [PASS] no Conductor ref is written into the decoy repository
  [PASS] the decoy working tree is untouched

================ B: GIT_DIR and GIT_WORK_TREE point at a decoy while an undo runs ================
  planned: ["restore file.txt","delete tasknew.txt"]
  applied: {"restored":1,"deleted":1,"failures":[]}
  [PASS] the intended repo is put back to its checkpoint  INTENDED ORIGINAL
  [PASS] the file the task created in the intended repo is gone
  [PASS] the decoy repo is untouched

================ B2: GIT_WORK_TREE alone points at a decoy while an undo runs ================
  planned: ["restore file.txt","delete tasknew.txt"]
  applied: {"restored":1,"deleted":1,"failures":[]}
  [PASS] the intended repo is put back to its checkpoint  INTENDED ORIGINAL
  [PASS] the file the task created in the intended repo is gone
  [PASS] the decoy repo is untouched

================ C: the preview under unknown provenance, with the override ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-after\c-unknown" to the checkpoint taken before task c1.
  |   ref:    refs/conductor/checkpoints/c1
  |   commit: 04988387be736d96b88026cc82d7274d730e4777
  | 
  |   NO POST-IMAGE was recorded for this task, so Conductor cannot tell the task's work from anybody
  |   else's. The task did not finish cleanly, or its post-image is gone. Provenance is unknown, so the
  |   blanket undo is refused. Nothing below will be touched without the override named at the end.
  | 
  |   delete   (present now, not in the checkpoint)  appeared.txt
  |   restore  (differs from the checkpoint)  edited.txt
  |   restore  (in the checkpoint, absent now)  removed.txt
  | 
  |   2 file(s) restored, 1 file(s) deleted.
  | 
  |   OVERRIDE GIVEN: there is no post-image, so the 3 path(s) below cannot be attributed to
  |   the task or to anybody else. They will be changed anyway:
  |     would delete   appeared.txt
  |     would restore  edited.txt
  |     would restore  removed.txt
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  [PASS] provenance is unknown and the override folded the changes in
  [PASS] the preview does not say the task created anything
  [PASS] the preview does not say the task changed anything
  [PASS] the preview does not say the task deleted anything
  [PASS] it says what is actually known about a file that is present now
  [PASS] it says what is actually known about a file that differs
  [PASS] it says what is actually known about a file that is missing

================ D: the preview with a post-image, override folding somebody else's work in ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-after\d-known" to the checkpoint taken before task d1.
  |   ref:    refs/conductor/checkpoints/d1
  |   commit: ad4b531cefe4a509e3bf80d3e3eb83cbfb8e120d
  | 
  |   restore  (differs from the checkpoint)  humanfile.txt
  |   delete   (present now, not in the checkpoint)  humannew.txt
  |   restore  (changed by the task)  taskfile.txt
  | 
  |   2 file(s) restored, 1 file(s) deleted.
  | 
  |   OVERRIDE GIVEN: the 2 path(s) below are NOT the task's work and will be changed anyway:
  |     would restore  humanfile.txt
  |     would delete   humannew.txt
  |   files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo
  |   neither restores nor deletes them, whatever .gitignore says now.
  |   directories a deletion leaves empty are removed, up to the task folder.
  |   your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is
  |   a working-tree image only: staged state the task destroyed does not come back.
  |   this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.
  [PASS] provenance is from the post-image
  [PASS] the task's own edit is still named as the task's  restore  (changed by the task)  taskfile.txt
  [PASS] the human's edit, folded in by the override, is not  restore  (differs from the checkpoint)  humanfile.txt
  [PASS] the human's new file, folded in by the override, is not  delete   (present now, not in the checkpoint)  humannew.txt

================ ALL CHECKS PASSED ================
```

### Reading of the after run

- **A.** The checkpoint records `a-intended`, both Conductor refs are in `a-intended`, the decoy has
  none, and the decoy's working files hash the same before and after. The hostile variables were set
  in the daemon's own environment for the duration of the call, so this is the daemon's environment
  being ignored, not a caller passing better arguments.
- **B and B2.** In both shapes the undo planned `restore file.txt` and `delete tasknew.txt`, applied
  them in `b-intended` and `b2-intended`, and left the decoy byte-identical, including an uncommitted
  file in B that a stray checkout would have overwritten.
- **C.** Nothing in the preview says "by the task". The three lines say what the record supports:
  present now and not in the checkpoint, differs from the checkpoint, in the checkpoint and absent
  now. The `OVERRIDE GIVEN` block now says there is no post-image and the paths cannot be attributed
  to the task or to anybody else.
- **D.** One list, two kinds of line. `taskfile.txt` still reads "(changed by the task)", because a
  post-image proves it. `humanfile.txt` and `humannew.txt` read "(differs from the checkpoint)" and
  "(present now, not in the checkpoint)", because the override moved them and the task did not touch
  them. A human reading this list can see which is which, which is the entire purpose of showing it.

## Nothing else moved: the first fix round, re-run

The four merge-blocking reproductions from round one, run again against the code with both new fixes
in it. Unchanged: 20 of 20.
```

================ R1: a human edit made after the task survives undo ================
  checkpoint ok: true
  post-image: refs/conductor/postimage/r1
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-rp\r1" to the checkpoint taken before task r1.
  |   ref:    refs/conductor/checkpoints/r1
  |   commit: c5c84e51fb5a440565d6ad6ba93283cd0aea2872
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
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-rp\r1b" to the checkpoint taken before task r1b.
  |   ref:    refs/conductor/checkpoints/r1b
  |   commit: df65a37470825258909c6deefe47588fe47ab458
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
  |   Whose changes these are is not recorded, so undo will not touch them. To include exactly
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
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-rp\r3" to the checkpoint taken before task r3.
  |   ref:    refs/conductor/checkpoints/r3
  |   commit: f771e47bdae1a1b25c8a8a34170ae7d0f9a3b6d8
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
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-rp\r4" to the checkpoint taken before task r4.
  |   ref:    refs/conductor/checkpoints/r4
  |   commit: 024b5409fa221cf9324611db316adf1ae238c0f4
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
  preview -> 200, planId 4a528758000f4b552e0b7d61, list ["file.txt"]
  confirm -> 200 {"applied":true,"restored":1,"deleted":0}
  [PASS] a file that appeared after the preview is not touched
  [PASS] the previewed restore did happen  before
  tampered hash -> 409 "the planHash does not match the stored plan, so the list being confirmed is not the list that was previewed."
  [PASS] a mismatched planHash is refused
  replayed plan -> 409 "that undo plan is unknown or has expired. Ask for a fresh preview and confirm that one."
  [PASS] a spent plan id cannot be replayed

================ ALL CHECKS PASSED ================
```

The wording in these transcripts is unchanged, and that is the right result: every preview printed
here either has a post-image and no override, where attribution is a fact, or plans nothing at all,
where there is no line to attribute. R1b, the task that died without a post-image, still plans zero
changes and still holds its one path back by name.

## Slice A finish line, re-run: the engine

The eight engine tests, unchanged, against the code with both fixes.
```
state root: "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\state-fl"

================ TEST 1: user state survives a checkpoint ================
checkpoint ok: true
  ref    refs/conductor/checkpoints/demo1
  commit ce91c116f9b156833490871a016bcf1d439abcea
  files  5
status byte-identical:      true
index (ls-files -s) same:   true
.git/index file hash same:  true (e9699e27ec8ff46a -> e9699e27ec8ff46a)
HEAD unmoved:               true (d5c11df3ae08df427c9213dc1ef2af796d75c14a)
branch unchanged:           true (master)
reflog unchanged:           true
working files unchanged:    true
--- git branch --list -a AFTER (the Conductor refs must not appear) ---
* master
--- git for-each-ref refs/conductor ---
ce91c116f9b156833490871a016bcf1d439abcea commit	refs/conductor/checkpoints/demo1
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
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-fl\mess" to the checkpoint taken before task demo1.
  |   ref:    refs/conductor/checkpoints/demo1
  |   commit: 55ee6aee0d3d35d46b0983aa67dbec02c5ddec4c
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
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-fl\fresh" to the checkpoint taken before task fresh1.
  |   ref:    refs/conductor/checkpoints/fresh1
  |   commit: a81046d0c0b4c6c1f00b1645d2a9ca2ee2d8c087
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
refusal: the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-fl\plain-folder" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run "git init" in that folder, or point the task at a folder that is already under version control.
checkpointTask ok: false

================ TEST 7: undo confined to the task folder ================
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-fl\scoped\project" to the checkpoint taken before task scoped1.
  |   ref:    refs/conductor/checkpoints/scoped1
  |   commit: 5d2629291e445d4b6b81243d2c6f688d23fb2aa9
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
  | undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-fl\attrs" to the checkpoint taken before task attr1.
  |   ref:    refs/conductor/checkpoints/attr1
  |   commit: 006e61d44e73149593b1d38190ec5cc6df9c1b38
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
{"ts":"2026-08-01T19:14:41.438Z","kind":"checkpoint","taskId":"demo1","ref":"refs/conductor/checkpoints/demo1","commit":"ce91c116f9b156833490871a016bcf1d439abcea","tree":"53ff3c65ddb1f6f3c36fa47ecc744f4b7c55ce87","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\demo1","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\demo1","head":"d5c11df3ae08df427c9213dc1ef2af796d75c14a","detached":false,"files":5,"ignoredRef":"refs/conductor/ignored/demo1","inProgress":null}
{"ts":"2026-08-01T19:14:42.166Z","kind":"checkpoint","taskId":"demo1","ref":"refs/conductor/checkpoints/demo1","commit":"55ee6aee0d3d35d46b0983aa67dbec02c5ddec4c","tree":"b5717997d481cc4d6ccc30c52b8ce11a5c45bdcf","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\mess","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\mess","head":"05ab435d56302d8069bee9371d7c18d332167933","detached":false,"files":6,"ignoredRef":"refs/conductor/ignored/demo1","inProgress":null}
{"ts":"2026-08-01T19:14:42.363Z","kind":"postimage","taskId":"demo1","ref":"refs/conductor/postimage/demo1","commit":"de8c3d503a18cd9424a7e62f26c0510c7406288d","tree":"7e3dd4d4bf5c23006876485022269971cd5d82bf","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\mess"}
{"ts":"2026-08-01T19:14:42.760Z","kind":"undo","taskId":"demo1","ref":"refs/conductor/checkpoints/demo1","commit":"55ee6aee0d3d35d46b0983aa67dbec02c5ddec4c","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\mess","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\mess","provenance":"post-image","override":false,"restored":4,"deleted":2,"heldBack":0,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T19:14:43.232Z","kind":"checkpoint","taskId":"fresh1","ref":"refs/conductor/checkpoints/fresh1","commit":"a81046d0c0b4c6c1f00b1645d2a9ca2ee2d8c087","tree":"00a508799f7194abe5f1d4b7f89c7c3703858140","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\fresh","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\fresh","head":null,"detached":false,"files":1,"ignoredRef":"refs/conductor/ignored/fresh1","inProgress":null}
{"ts":"2026-08-01T19:14:43.446Z","kind":"postimage","taskId":"fresh1","ref":"refs/conductor/postimage/fresh1","commit":"7ad6fa986a2664de49b86e325d0c00eca7634a98","tree":"04c19a911d991712c4d1fb9e460084d8a9ef7a31","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\fresh"}
{"ts":"2026-08-01T19:14:43.799Z","kind":"undo","taskId":"fresh1","ref":"refs/conductor/checkpoints/fresh1","commit":"a81046d0c0b4c6c1f00b1645d2a9ca2ee2d8c087","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\fresh","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\fresh","provenance":"post-image","override":false,"restored":1,"deleted":1,"heldBack":0,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T19:14:44.412Z","kind":"checkpoint","taskId":"det1","ref":"refs/conductor/checkpoints/det1","commit":"294f4cfb5a46d4c1322e926f4215ac009f521eb0","tree":"08585692ce06452da6f82ae66b90d98b55536fca","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\detached","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\detached","head":"3f2a9eed5163d211b7a2d9c3bfef35c656d43a4c","detached":true,"files":1,"ignoredRef":"refs/conductor/ignored/det1","inProgress":null}
{"ts":"2026-08-01T19:14:44.866Z","kind":"checkpoint","taskId":"det2","ref":"refs/conductor/checkpoints/det2","commit":"bac281ae71f06ea37aaddc902b677e51460261f1","tree":"08585692ce06452da6f82ae66b90d98b55536fca","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\detached","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\detached","head":"3f2a9eed5163d211b7a2d9c3bfef35c656d43a4c","detached":true,"files":1,"ignoredRef":"refs/conductor/ignored/det2","inProgress":null}
{"ts":"2026-08-01T19:14:44.935Z","kind":"checkpoint_refused","taskId":"plain1","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\plain-folder","reason":"the folder \"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\plain-folder\" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run \"git init\" in that folder, or point the task at a folder that is already under version control."}
{"ts":"2026-08-01T19:14:45.479Z","kind":"checkpoint","taskId":"scoped1","ref":"refs/conductor/checkpoints/scoped1","commit":"5d2629291e445d4b6b81243d2c6f688d23fb2aa9","tree":"ba75d5a6a8f284d392dbe3391b7e88b9c39f9da2","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\scoped","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\scoped\\project","head":"0720e067aa89c9515033d4f3ae51b321e2eda1aa","detached":false,"files":2,"ignoredRef":"refs/conductor/ignored/scoped1","inProgress":null}
{"ts":"2026-08-01T19:14:45.662Z","kind":"postimage","taskId":"scoped1","ref":"refs/conductor/postimage/scoped1","commit":"7d003e17e59c73e3eea41d13432add65bfbbeff5","tree":"2e89b260c6e14b97319662a64d2b43217f12530d","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\scoped"}
{"ts":"2026-08-01T19:14:46.039Z","kind":"undo","taskId":"scoped1","ref":"refs/conductor/checkpoints/scoped1","commit":"5d2629291e445d4b6b81243d2c6f688d23fb2aa9","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\scoped","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\scoped\\project","provenance":"post-image","override":false,"restored":1,"deleted":0,"heldBack":0,"outsideLeftAlone":1,"failures":0}
{"ts":"2026-08-01T19:14:46.586Z","kind":"checkpoint","taskId":"attr1","ref":"refs/conductor/checkpoints/attr1","commit":"006e61d44e73149593b1d38190ec5cc6df9c1b38","tree":"ca32e720db685e54bb22dc356635c3e49cc78482","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\attrs","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\attrs","head":"e48ae85ed073b8895975e74048eaa8f213b41768","detached":false,"files":3,"ignoredRef":"refs/conductor/ignored/attr1","inProgress":null}
{"ts":"2026-08-01T19:14:46.769Z","kind":"postimage","taskId":"attr1","ref":"refs/conductor/postimage/attr1","commit":"f794aa4fa6682b3b964f73f1f9bb6e7c5e5c2313","tree":"4ec36e4847bd08df278e8c278d2f0a2e664c2ce2","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\attrs"}
{"ts":"2026-08-01T19:14:47.150Z","kind":"undo","taskId":"attr1","ref":"refs/conductor/checkpoints/attr1","commit":"006e61d44e73149593b1d38190ec5cc6df9c1b38","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\attrs","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\attrs","provenance":"post-image","override":false,"restored":2,"deleted":0,"heldBack":0,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T19:14:47.704Z","kind":"checkpoint","taskId":"attr2","ref":"refs/conductor/checkpoints/attr2","commit":"951486a6aa67df3d2e33eb5050b197fa72f236d6","tree":"6f8b3684bb3c0c802569069b0e433a5f06ad2d1a","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\attrs-silent","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\attrs-silent","head":"cf616449b4d012e9593a07e65401109dd3ac5d60","detached":false,"files":2,"ignoredRef":"refs/conductor/ignored/attr2","inProgress":null}
{"ts":"2026-08-01T19:14:47.878Z","kind":"postimage","taskId":"attr2","ref":"refs/conductor/postimage/attr2","commit":"f2df9990cf93a8cce7d838bac4c85d48a1b675c0","tree":"6f8b3684bb3c0c802569069b0e433a5f06ad2d1a","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\fix2\\work-fl\\attrs-silent"}

=== done ===
```

### Reading of the engine re-run

Every claim the earlier runs made still holds. Test 1: `git status --porcelain` byte-identical, the
index file's own hash unchanged, `ls-files -s` unchanged, HEAD unmoved, branch unchanged, reflog
unchanged, working files unchanged, and only `master` under `git branch --list -a`. Test 2: every
hash returns to its pre-task value, the emptied directory is removed, the status matches, the staged
change is still staged, and the one ignored file is deliberately untouched. Tests 3 and 4 behave as
before on an unborn HEAD and a detached HEAD. Test 6 refuses a non-git folder. Test 7 restores only
inside the task folder and counts what it left outside. Test 8 still prints the `.gitattributes`
limit honestly, conversion half and silent half.

## Slice A finish line, re-run: the doors

The real daemon, the real HTTP endpoint, the real CLI.
```
=== starting the daemon ===
conductor 0.1.0
  listening:  http://127.0.0.1:7749 (loopback only)
  state root: "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\state-doors"
  door token: "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\state-doors\daemon-token" (fresh for this daemon; doors read it from there)
  playbook:   2174 chars
  accounts:   0 usable of 2 configured

No usable accounts yet. Edit "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\state-doors\config.json" and point each entry at a real
Claude Code config directory.

=== a non-git folder is refused at the queue door ===
conductor: the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-doors\plain" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run "git init" in that folder, or point the task at a folder that is already under version control.
  exit code: 1

=== the same command against the git folder is accepted past the reversibility gate ===
conductor: no usable account; edit "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\state-doors\config.json"
  exit code: 1

=== checkpointing the scratch repo through the engine, then making a mess ===
  checkpoint: refs/conductor/checkpoints/t1 c624082bc92941d61af4155e6ec19c113201f95b
  post-image: refs/conductor/postimage/t1 2d2c2ccdb5321ec2a21f86b227d0d2be00aea13f
  git status now:
 D gone.txt
 M keep.txt
?? new.txt
?? untracked.txt

=== POST /undo with no confirm: preview only, nothing changes ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: c624082bc92941d61af4155e6ec19c113201f95b

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
  planId: 3e52abc427b2ab4806f3f981, planHash: 5cae06c267bca663...
  note: nothing was changed. Send "confirm": true with this planId and planHash to apply exactly this list.
  git status after the unconfirmed call (must be unchanged):
 D gone.txt
 M keep.txt
?? new.txt
?? untracked.txt

=== conductor undo t1 without --yes ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: c624082bc92941d61af4155e6ec19c113201f95b

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
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: c624082bc92941d61af4155e6ec19c113201f95b

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
c624082bc92941d61af4155e6ec19c113201f95b commit	refs/conductor/checkpoints/t1
e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 blob	refs/conductor/ignored/t1
2d2c2ccdb5321ec2a21f86b227d0d2be00aea13f commit	refs/conductor/postimage/t1

=== conductor undo with no task id, defaulting to the last checkpoint ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: c624082bc92941d61af4155e6ec19c113201f95b

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
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\fix2\work-doors\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: c624082bc92941d61af4155e6ec19c113201f95b

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

### Reading of the door re-run

The queue door still refuses a non-git folder by name. The undo endpoint still previews without
changing anything, still returns a `planId` and `planHash`, and still applies only the stored plan.
The CLI still prints the list before it asks. The held-back block still names the two paths a human
changed after the task and still refuses to touch them without the override. The logbook line for the
undo still records `provenance=post-image`.

## Closure table

| # | Finding | Source | Status | Evidence |
| --- | --- | --- | --- | --- |
| 4 | Inherited `GIT_*` variables redirect every git call to another repository | Sol, high | Closed | A, B, B2: 10 checks, 7 fail before, 0 after |
| new | The preview attributes work to the task when no post-image supports it | Architect | Closed | C: 7 checks, 6 fail before, 0 after |
| new | The override folds somebody else's changes into the main list under the task's name | Architect | Closed | D: 4 checks, 2 fail before, 0 after |
| 1, 3, 5, 6 | The four merge-blocking findings from round one | Sol, critical and high | Still closed | Round-one reproduction, 20 of 20 |
| n/a | Slice A finish line, engine and doors | Slice A | Still passing | Both transcripts above |

## What was deliberately not changed

- **The `-c` overrides stay per command.** `core.autocrlf`, `core.eol` and `core.safecrlf` are still
  passed as arguments on the two commands that move content, rather than being forced through the
  environment. Command-line `-c` outranks every config file, which is a stronger guarantee than an
  environment variable, and it keeps the override visible at the call site.
- **The user's global and system git config is still read.** Explained above: neutralising it would
  make Conductor read the repository differently from the way the user's git reads it.
- **One CLI help line still over-claims, mildly.** `src/cli.ts` describes
  `--override-changed-after-task` as "also touch files changed after the task finished", which is
  accurate under a post-image and incomplete under unknown provenance, where the override also covers
  paths nobody can attribute. `src/cli.ts` was outside this brief, so it is named here rather than
  edited. It is a help string, not a preview: the preview itself, which is the thing a human reads
  before answering, is now correct in both cases.

## Limits this round did not touch

Sol's findings 2, 7, 8, 9a and 11, and the mediums, are exactly where the first round left them. The
detectable ones still print in the preview; the rest are written down in `m2-sliceA-findings.md`.
Nothing in this round makes any of them better or worse.
