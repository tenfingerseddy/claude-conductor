# M2 slice A findings: checkpoints and undo

Built and verified 2026-08-01 on branch `feat/m2-checkpoints`. This is the slice the permissive
default rests on, so the verification below is the point of the document and the code is the
supporting detail. Every transcript is raw output from a run, pasted whole. All git work happened in
throwaway repositories under the session scratchpad; no real project was touched.

## What landed

- `src/engine/checkpoint.ts`. Before every task in a git project, the whole working tree, including
  untracked files, becomes a commit under `refs/conductor/checkpoints/<taskId>`. Pure plumbing:
  `read-tree` into a scratch index, `add -A` into that index, `write-tree`, `commit-tree` parented on
  the current HEAD, `update-ref`. No checkout, no branch, no staging, no push, no HEAD move.
- Non-git folders are refused at both doors: the queue rejects the task when it is added, and the
  task loop refuses again before a session starts.
- A `checkpoint` event carries the ref, commit, tree, repo root, task folder, HEAD and file count.
  A refusal logs `checkpoint_refused`. An undo logs `undo` with the file counts. The logbook is also
  how undo finds a checkpoint again later, so no fifth state file was added.
- Undo on both doors: `POST /undo` and `conductor undo [taskId] [--yes]`, defaulting to the last
  checkpoint. It previews first and changes nothing without explicit confirmation.
- Nothing about the rail, the trust model or permissions changed. Autonomous trust is still refused.

## Limits, stated rather than skipped

1. **Ignored files are not in the before-image.** `git add -A` honours `.gitignore`, so build output
   and anything else ignored is not checkpointed and is therefore not restorable. Undo also never
   deletes an ignored file, so the rule is at least consistent, and the preview says so in plain
   words every time. Test 2 below shows an ignored file surviving an undo unchanged.
2. **`.gitattributes` text declarations still normalise content.** Conductor turns off
   `core.autocrlf` for its own git calls (see below), which fixes the common case. It cannot turn off
   an in-tree `.gitattributes`, so a file whose bytes on disk disagree with what its attributes
   declare comes back converted. Test 8 probes this deliberately and shows it failing, rather than
   leaving it for someone to discover later.
3. **File modes and symlinks** are restored by `git checkout-index`, which is correct on POSIX and
   largely moot on Windows. Not separately verified here; Windows is the first-class platform and a
   symlinked working tree was out of scope for this slice.
4. **A staged change that no longer exists in the working tree is not captured.** The checkpoint is
   an image of the working tree, which is what undo restores. The user's index is left exactly as it
   was, so nothing is lost, but undo will not reconstruct a staged-then-deleted file.
5. **Checkpoint refs are never pruned.** One ref per task accumulates in the repository. They are
   cheap and no branch references them, but a later slice should age them out.

## Two bugs found by the verification, both fixed

Recorded because both would have shipped as silent wrongness rather than as errors.

1. **Undo did nothing and reported success.** `git rev-parse --show-toplevel` answers with the true
   long path, and the harness handed the same folder in as an 8.3 short name. `relative()` then said
   the task folder sat outside its own repository, so every change was filtered out as "outside the
   task folder" and undo restored zero files while reporting success. Both ends now go through
   `realpathSync.native`, and a task folder that genuinely does not sit inside its repository is a
   loud refusal rather than an empty plan.
2. **Restored files came back with different bytes.** This machine has `core.autocrlf` on, so
   `git add` stored blobs with LF and `git checkout-index` wrote them back with CRLF. Undo reported
   four files restored and all four differed from the files they replaced. Conductor's own git calls
   now pass `-c core.autocrlf=false -c core.eol=lf -c core.safecrlf=false`; the user's config is not
   touched and the checkpoint commit never joins the user's history, so storing raw bytes costs
   nothing.

## One platform bug worked around

`conductor undo` is the first CLI command that makes two HTTP calls in one invocation, and that
combination crashed Node 24.11.1 on Windows after the command had already printed the right answer:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

Exit code 127 rather than 0. Reproduced outside Conductor with two bare `fetch` calls followed by
`process.exit`, so it is the platform and not this code. The CLI now sets `process.exitCode` and lets
the loop drain, which exits immediately and cleanly, with an unref'd five second timer as a net.

## Verification, run 1: the engine

Scratch git repositories only. The harness was throwaway.

```
state root: "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\state"

================ TEST 1: user state survives a checkpoint ================
checkpoint ok: true
  ref    refs/conductor/checkpoints/demo1
  commit 7c004bfc25fe79cec551229dc198f4f4a7e0606e
  files  6

--- git status --porcelain BEFORE ---
A  staged.txt
 M tracked.txt
?? scratchnote.txt
--- git status --porcelain AFTER ---
A  staged.txt
 M tracked.txt
?? scratchnote.txt
status byte-identical:      true
index (ls-files -s) same:   true
.git/index file hash same:  true (9613598e735a9817 -> 9613598e735a9817)
HEAD unmoved:               true (06a1451b2ab369283e1a57a3cbafa7126c13f218)
branch unchanged:           true (main)
reflog unchanged:           true
working files unchanged:    true

--- git branch --list -a AFTER (the Conductor ref must not appear) ---
* main
--- git for-each-ref refs/conductor ---
7c004bfc25fe79cec551229dc198f4f4a7e0606e commit	refs/conductor/checkpoints/demo1
--- the staged change is still staged ---
A	staged.txt

================ TEST 2: a mess is made and perfectly undone ================
--- file hashes before the task ---
  181314065df2f2fd  .gitignore
  d8b4a6ac2acd816b  build/artifact.bin
  f6d5c30515284486  doomed.txt
  5b51b7fc0d4ffa3d  scratchnote.txt
  674eb49986436872  staged.txt
  a59fca8fb6533147  sub/nested.txt
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

--- the preview a human would read ---
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\work\mess" to the checkpoint taken before task demo1.
  ref:    refs/conductor/checkpoints/demo1
  commit: 7c004bfc25fe79cec551229dc198f4f4a7e0606e

  delete   (created by the task)  brandnew.txt
  restore  (deleted by the task)  doomed.txt
  restore  (changed by the task)  scratchnote.txt
  delete   (created by the task)  sub/deeper/alsonew.txt
  restore  (changed by the task)  sub/nested.txt
  restore  (changed by the task)  tracked.txt

  4 file(s) restored, 2 file(s) deleted.
  files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  your branch, HEAD and staged changes are not touched.

applied: 4 restored, 2 deleted, failures 0

--- file hashes after undo ---
  181314065df2f2fd  .gitignore
  b280fe04580f3a81  build/artifact.bin
  f6d5c30515284486  doomed.txt
  5b51b7fc0d4ffa3d  scratchnote.txt
  674eb49986436872  staged.txt
  a59fca8fb6533147  sub/nested.txt
  985fddcf72ea5ce1  tracked.txt

working tree byte-identical to before the task, ignoring .gitignore'd paths: true
the one ignored file is deliberately untouched: build/artifact.bin d8b4a6ac2acd816b -> b280fe04580f3a81

--- git status --porcelain after undo (compare with BEFORE above) ---
A  staged.txt
 M tracked.txt
?? scratchnote.txt
status matches the pre-task status: true
staged change still staged: true
HEAD still unmoved
empty directory left by a deleted file removed: true

================ TEST 3: a repository with zero commits ================
checkpoint ok: true
  head recorded as: null (null is correct: no commits yet)
  commit has no parent: true
  status unchanged: true
  HEAD still unborn: true
  preview:
    undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\work\fresh" to the checkpoint taken before task fresh1.
      ref:    refs/conductor/checkpoints/fresh1
      commit: 376afb160e11d543a25bf602f4fe18c701714919
    
      delete   (created by the task)  extra.txt
      restore  (changed by the task)  only.txt
    
      1 file(s) restored, 1 file(s) deleted.
      files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
      your branch, HEAD and staged changes are not touched.
  applied: 1 restored, 1 deleted
  tree back to before: true

================ TEST 4: detached HEAD ================
checkpoint ok: true, detached recorded as true
  HEAD unmoved:      true (HEAD)
  still detached:    true
  status before wip: ""
  status now:        "?? wip.txt" (the ?? line is the file this test wrote, not the checkpoint)
  a second checkpoint changes status: false

================ TEST 5: uncommitted work is preserved and restored ================
  scratchnote.txt content now: "untracked work in progress\n"
  matches the pre-task content: true
  tracked.txt (unstaged user edit) now: "user edited this and did not stage it\n"
  matches the pre-task content: true
  ignored build/artifact.bin now: "REBUILT BY THE TASK\n"
  (ignored, so never checkpointed and never restored or deleted. Stated, not hidden.)

================ TEST 6: a non-git folder is refused ================
refusal: the folder "C:\Users\KANESN~1\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\work\plain-folder" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run "git init" in that folder, or point the task at a folder that is already under version control.
checkpointTask ok: false
  refs created in that folder: none possible, it is not a repository

================ TEST 7: undo confined to the task folder ================
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\work\scoped\project" to the checkpoint taken before task scoped1.
  ref:    refs/conductor/checkpoints/scoped1
  commit: 8dd42abaf0451ad6ae7f770ed3f8ee85989cd668

  restore  (changed by the task)  project/a.txt

  1 file(s) restored, 0 file(s) deleted.
  1 changed file(s) outside the task folder are left exactly as they are.
  files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  your branch, HEAD and staged changes are not touched.

  project/a.txt restored: true
  outside.txt left alone: true

================ TEST 8: the .gitattributes limit, probed honestly ================
  lf.txt: e9024f1a07d29d52 -> 6612d9c94c2da8d2  NOT EXACT
    bytes now: "line one\r\nline two\r\n"
  crlf.txt: 6612d9c94c2da8d2 -> 6612d9c94c2da8d2  exact
    bytes now: "line one\r\nline two\r\n"

================ logbook lines written ================
{"ts":"2026-08-01T13:04:34.481Z","kind":"checkpoint","taskId":"demo1","ref":"refs/conductor/checkpoints/demo1","commit":"7c004bfc25fe79cec551229dc198f4f4a7e0606e","tree":"c81b7f29823caa81be0dfd7ad6af61bcac108168","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\mess","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\mess","head":"06a1451b2ab369283e1a57a3cbafa7126c13f218","detached":false,"files":6}
{"ts":"2026-08-01T13:04:34.907Z","kind":"undo","taskId":"demo1","ref":"refs/conductor/checkpoints/demo1","commit":"7c004bfc25fe79cec551229dc198f4f4a7e0606e","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\mess","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\mess","restored":4,"deleted":2,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T13:04:35.300Z","kind":"checkpoint","taskId":"fresh1","ref":"refs/conductor/checkpoints/fresh1","commit":"376afb160e11d543a25bf602f4fe18c701714919","tree":"3e4086cdc9c833f0a8f081d260d66d3b298b0f92","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\fresh","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\fresh","head":null,"detached":false,"files":1}
{"ts":"2026-08-01T13:04:35.557Z","kind":"undo","taskId":"fresh1","ref":"refs/conductor/checkpoints/fresh1","commit":"376afb160e11d543a25bf602f4fe18c701714919","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\fresh","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\fresh","restored":1,"deleted":1,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T13:04:36.133Z","kind":"checkpoint","taskId":"det1","ref":"refs/conductor/checkpoints/det1","commit":"410671c11c13d8f6966fee3d7c2361db9b59dde5","tree":"b4b4df2b63fd9ebb2d0ce613f329833756e4ce47","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\detached","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\detached","head":"95720a0bb3fe633edf22fac58d67df48e4bb4fa8","detached":true,"files":5}
{"ts":"2026-08-01T13:04:36.482Z","kind":"checkpoint","taskId":"det2","ref":"refs/conductor/checkpoints/det2","commit":"e4349a8ae204e71aaf0dacd74da2244689bafb4c","tree":"b4b4df2b63fd9ebb2d0ce613f329833756e4ce47","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\detached","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\detached","head":"95720a0bb3fe633edf22fac58d67df48e4bb4fa8","detached":true,"files":5}
{"ts":"2026-08-01T13:04:36.558Z","kind":"checkpoint_refused","taskId":"plain1","cwd":"C:\\Users\\KANESN~1\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\plain-folder","reason":"the folder \"C:\\Users\\KANESN~1\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\plain-folder\" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run \"git init\" in that folder, or point the task at a folder that is already under version control."}
{"ts":"2026-08-01T13:04:37.069Z","kind":"checkpoint","taskId":"scoped1","ref":"refs/conductor/checkpoints/scoped1","commit":"8dd42abaf0451ad6ae7f770ed3f8ee85989cd668","tree":"41f4259f8ad60349d817f14176fc3e9d5f7de3ad","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\scoped","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\scoped\\project","head":"a4b728b335261133b3cab2f917e173d923d69c6f","detached":false,"files":6}
{"ts":"2026-08-01T13:04:37.313Z","kind":"undo","taskId":"scoped1","ref":"refs/conductor/checkpoints/scoped1","commit":"8dd42abaf0451ad6ae7f770ed3f8ee85989cd668","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\scoped","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\scoped\\project","restored":1,"deleted":0,"outsideLeftAlone":1,"failures":0}
{"ts":"2026-08-01T13:04:37.759Z","kind":"checkpoint","taskId":"attr1","ref":"refs/conductor/checkpoints/attr1","commit":"90aa40d21d6126630eba91faf7f21a28661cb37a","tree":"f2865384e9df657c382db39aa5000b5b5e7e1ea7","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\attrs","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\attrs","head":"c50fe2cfff3c95c68c83409d2fc5af97ef31c285","detached":false,"files":7}
{"ts":"2026-08-01T13:04:38.001Z","kind":"undo","taskId":"attr1","ref":"refs/conductor/checkpoints/attr1","commit":"90aa40d21d6126630eba91faf7f21a28661cb37a","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\attrs","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\work\\attrs","restored":2,"deleted":0,"outsideLeftAlone":0,"failures":0}
```

### Reading of run 1

- **Test 1, the user's own state survives.** `git status --porcelain` is byte-identical before and
  after, the index file's own hash is unchanged, `ls-files -s` is unchanged, HEAD did not move, the
  branch did not change, the reflog did not grow, and the staged `staged.txt` is still staged.
  `git branch --list -a` shows only `main`; the checkpoint is visible only through
  `git for-each-ref refs/conductor`.
- **Test 2, a mess is perfectly undone.** The task edited a tracked file, edited a nested tracked
  file, created two files including one in a new directory, deleted a tracked file, and clobbered the
  user's untracked note. Every hash comes back to its pre-task value, the emptied directory is
  removed, and `git status --porcelain` matches the pre-task status exactly. The single reported
  difference is `build/artifact.bin`, which `.gitignore` covers and undo deliberately leaves alone.
- **Test 3, zero commits.** The checkpoint records `head: null`, the commit has no parent, HEAD stays
  unborn, and the tree comes back exactly.
- **Test 4, detached HEAD.** Recorded as detached, HEAD unmoved, still detached afterwards, and a
  second checkpoint does not change `git status` either.
- **Test 5, uncommitted work.** The user's unstaged edit and their untracked note both survive the
  checkpoint and come back byte-exact after undo. This is the case the whole design exists for.
- **Test 6, a non-git folder.** Refused with a message naming the folder and saying what to do about
  it.
- **Test 7, scope.** With the task pointed at a subfolder, only the subfolder's file is restored, and
  the changed file outside it is counted in the preview and left alone.
- **Test 8, the `.gitattributes` limit.** Probed on purpose and it fails, as documented above:
  `lf.txt` held LF bytes while `.gitattributes` declared `text eol=crlf`, and it came back CRLF.
  `crlf.txt`, which agreed with its own attributes, came back exact.

## Verification, run 2: the doors

The real daemon, the real HTTP endpoint, the real CLI.

```
warning: in the working copy of 'gone.txt', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'keep.txt', LF will be replaced by CRLF the next time Git touches it
=== starting the daemon ===
conductor 0.1.0
  listening:  http://127.0.0.1:7731 (loopback only)
  state root: "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\doorstate"
  door token: "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\doorstate\daemon-token" (fresh for this daemon; doors read it from there)
  playbook:   2174 chars
  accounts:   0 usable of 2 configured

No usable accounts yet. Edit "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\doorstate\config.json" and point each entry at a real

=== a non-git folder is refused at the queue door ===
conductor: the folder "C:/Users/KaneSnyder(nexwave)/AppData/Local/Temp/claude/c--Users-KaneSnyder-nexwave--repos-conductor/9a8ad5b6-1a06-443f-afcb-2098008ae6c7/scratchpad/doorwork/plain" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run "git init" in that folder, or point the task at a folder that is already under version control.
  exit code: 1

=== the same command against the git folder is accepted ===
conductor: no usable account; edit "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\doorstate\config.json"

=== status: only the git-folder task exists ===
conductor 0.1.0, pid 17808, up 2s
  state root:  "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\doorstate"
  running:     no
  doors open:  0
  accounts:    work (unusable), personal (unusable)
  tasks:       0

=== checkpointing the scratch repo through the engine, then making a mess ===
  checkpoint: refs/conductor/checkpoints/t1 d0bfb15917b886e221508f46fd90e077c1e8beb2
  git status now:
     D gone.txt
     M keep.txt
    ?? new.txt
    ?? untracked.txt

=== POST /undo with no confirm: preview only, nothing changes ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\doorwork\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: d0bfb15917b886e221508f46fd90e077c1e8beb2

  restore  (deleted by the task)  gone.txt
  restore  (changed by the task)  keep.txt
  delete   (created by the task)  new.txt
  restore  (changed by the task)  untracked.txt

  3 file(s) restored, 1 file(s) deleted.
  files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  your branch, HEAD and staged changes are not touched.
  applied: false
  note: nothing was changed. Send the same request with "confirm": true to apply it.
  git status after the unconfirmed call (must be unchanged):
     D gone.txt
     M keep.txt
    ?? new.txt
    ?? untracked.txt

=== conductor undo t1 without --yes ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\doorwork\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: d0bfb15917b886e221508f46fd90e077c1e8beb2

  restore  (deleted by the task)  gone.txt
  restore  (changed by the task)  keep.txt
  delete   (created by the task)  new.txt
  restore  (changed by the task)  untracked.txt

  3 file(s) restored, 1 file(s) deleted.
  files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  your branch, HEAD and staged changes are not touched.

nothing has been changed. Run "conductor undo t1 --yes" to apply it.
  git status after (must still be unchanged):
     D gone.txt
     M keep.txt
    ?? new.txt
    ?? untracked.txt

=== conductor undo t1 --yes ===
undo would restore the folder "C:\Users\KaneSnyder(nexwave)\AppData\Local\Temp\claude\c--Users-KaneSnyder-nexwave--repos-conductor\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\scratchpad\doorwork\proj" to the checkpoint taken before task t1.
  ref:    refs/conductor/checkpoints/t1
  commit: d0bfb15917b886e221508f46fd90e077c1e8beb2

  restore  (deleted by the task)  gone.txt
  restore  (changed by the task)  keep.txt
  delete   (created by the task)  new.txt
  restore  (changed by the task)  untracked.txt

  3 file(s) restored, 1 file(s) deleted.
  files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  your branch, HEAD and staged changes are not touched.

undone: 3 file(s) restored, 1 file(s) deleted.
  git status after:
    ?? untracked.txt
  keep.txt:      original
  gone.txt:      delete me
  untracked.txt: user work in progress
  new.txt:       removed, correct
  git branch:
    * main
  refs/conductor:
    d0bfb15917b886e221508f46fd90e077c1e8beb2 commit	refs/conductor/checkpoints/t1

=== conductor undo with no task id, defaulting to the last checkpoint ===
  files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.
  your branch, HEAD and staged changes are not touched.

undone: 1 file(s) restored, 0 file(s) deleted.
  keep.txt: original

=== logbook ===
{"ts":"2026-08-01T13:04:21.529Z","kind":"checkpoint","taskId":"t1","ref":"refs/conductor/checkpoints/t1","commit":"d0bfb15917b886e221508f46fd90e077c1e8beb2","tree":"afaa580d86c7c7cb8693c99b2d9db3bc3248f5cc","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\doorwork\\proj","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\doorwork\\proj","head":"7a00a7c7080b445f82cfa81d15689035758c016f","detached":false,"files":3}
{"ts":"2026-08-01T13:04:23.144Z","kind":"undo","taskId":"t1","ref":"refs/conductor/checkpoints/t1","commit":"d0bfb15917b886e221508f46fd90e077c1e8beb2","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\doorwork\\proj","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\doorwork\\proj","restored":3,"deleted":1,"outsideLeftAlone":0,"failures":0}
{"ts":"2026-08-01T13:04:24.166Z","kind":"undo","taskId":"t1","ref":"refs/conductor/checkpoints/t1","commit":"d0bfb15917b886e221508f46fd90e077c1e8beb2","repoRoot":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\doorwork\\proj","cwd":"C:\\Users\\KaneSnyder(nexwave)\\AppData\\Local\\Temp\\claude\\c--Users-KaneSnyder-nexwave--repos-conductor\\9a8ad5b6-1a06-443f-afcb-2098008ae6c7\\scratchpad\\doorwork\\proj","restored":1,"deleted":0,"outsideLeftAlone":0,"failures":0}

=== gate two: the task loop itself refuses a non-git folder, with no session started ===
  outcome:   blocked
  errorText: the folder "C:/Users/KaneSnyder(nexwave)/AppData/Local/Temp/claude/c--Users-KaneSnyder-nexwave--repos-conductor/9a8ad5b6-1a06-443f-afcb-2098008ae6c7/scratchpad/doorwork/plain" is not inside a git repository, so Conductor cannot checkpoint it and nothing it does there would be undoable. Run "git init" in that folder, or point the task at a folder that is already under version control.
  sessionId: undefined
  any SDK message seen: false

=== done ===
```

### Reading of run 2

- A non-git folder is refused when the task is queued, exit code 1, and `conductor status` shows zero
  tasks, so nothing was created and no session started. The same command against the git folder gets
  past the reversibility check and stops on the next one, the account check, because this scratch
  daemon has no real accounts configured. That is the correct next gate, not a failure of this one.
- `POST /undo` without `confirm` returns the full preview, `applied: false`, and a note saying how to
  apply it. `git status` after that call is unchanged.
- `conductor undo t1` without `--yes` prints the same preview and changes nothing.
- `conductor undo t1 --yes` restores three files and deletes one. `keep.txt` is back to `original`,
  the deleted `gone.txt` is back, the user's untracked `untracked.txt` is back to
  `user work in progress`, and the task's `new.txt` is gone. `git branch --list -a` shows only
  `main`; the checkpoint appears only under `refs/conductor`.
- `conductor undo --yes` with no task id defaults to the last checkpoint and restores correctly.
- Gate two: `runTasks` given a non-git folder returns `outcome: blocked` with the refusal sentence,
  `sessionId: undefined`, and no SDK message was ever seen, so no session started and no usage was
  spent.

## What this does not unlock

Nothing yet. Slice B, argument-vector execution and filesystem-level place enforcement, and then
slice C are still what re-enable autonomous trust. This slice only makes the work reversible, which
is the prerequisite the plan says it is.
