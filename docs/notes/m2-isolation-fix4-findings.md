# M2 isolation, fix round 4: the probe and the write

Branch `feat/m2-isolation`, on top of `799ec69`. Files changed: `src/engine/isolation.ts` and
`spikes/isolation/verify.ts`. `src/state/logbook.ts` untouched and not forced. No wiring, no
`checkpoint.ts`.

Sol's three closures from round 3 held. Two refinements of the same crank remained, and both are the
same shape as everything before them: a thing that could not be known was being treated as a thing
that was known.

## What changed

**1. The tip probe now carries the distinction in its exit code, not in its silence.** `branchTip`
asked with `rev-parse --verify --quiet`, which exits non-zero for a missing ref and for a repository
that failed quietly, and told the two apart by whether git had written to stderr. A silent failure has
no stderr, so it read as absence, which is the very collapse round 3 was supposed to remove. The probe
is now `git for-each-ref <full-ref> --format=%(objectname)`:

| outcome | exit | stdout | meaning |
|---|---|---|---|
| present | 0 | the hash | present |
| absent | 0 | empty | absent, an answer rather than a failure |
| refused | non-zero | empty | unreadable |

One refinement on top of Sol's mapping, kept deliberately. A ref file holding something that is not a
hash makes `for-each-ref` exit 0 with empty output and `warning: ignoring broken ref` on stderr, which
the exit code alone would call absent. Anything git had to say about the ref means it is not a clean
absence, so an empty answer with stderr on it is unreadable. That errs towards refusing, which is the
direction this whole file errs in, and it keeps the broken-ref detection the old probe happened to
have. Every caller is unchanged; the tri-state and its three call sites are untouched.

**2. The pre-mkdir resolution is strict.** `realPathDeep` fell back to a lexical `resolve()` and its
result was joined with `workspaces` and handed straight to `mkdirSync`, so the one write that happens
before any strict check stood on an unverified path. It had exactly one caller, so rather than grow a
strict twin it became `realPathDeepStrict` and returns null on failure; `createWorkspace` refuses on
null before creating anything. The strict resolution after the mkdir is unchanged and still catches a
junction at the `workspaces` level once that directory exists.

## Evidence

Both new sections run the identical `verify.ts` against a detached worktree of `799ec69` and against
the fix. Against `799ec69`: `4 CHECK(S) FAILED`, all four inside the new sections, with the 169 checks
in sections 1 to 22 passing unchanged. Against the fix: `ALL CHECKS PASSED`, 193 checks.

**Item 1, the mapping shown against a real repository** on git 2.52.0.windows.1, raw:

    present  exit=0 stdout="5e34c098e91fda6b8e38ab943fdf9aef01dd34fe\n" stderr=""
    absent   exit=0 stdout="" stderr=""
    broken   exit=0 stdout="" stderr="warning: ignoring broken ref refs/heads/conductor/task-broken"
    refused  exit=128 stderr="fatal: bad config line 11 in file .git/config"

and the same three answers as Conductor behaviour, end to end: present gives a successful discard with
a note naming the branch it left alone; absent gives a successful discard with nothing to say; a
broken ref, which is forceable for real, refuses rather than reading as a clean absence.

**Item 1, the case that actually differentiates**, through the round 3 stub-harness seam because git
2.52 will not fail silently on demand: the seam returns a non-zero exit with both streams empty for
the tip probe.

- Against `799ec69`: `discard said: ok, no note`. The copy was removed, the branch left behind, a
  clean success logged. That is the exact half-done job round 3 was meant to close, reached through
  the other door.
- Against the fix: `git would not say what the branch "conductor/task-p6" points at (git could not
  read it), so Conductor cannot delete it safely and will not remove the copy ...`, with the copy
  still on disk and the branch still there, and a clean discard once the seam is removed.

**Item 2, a real junction plus the seam.** A junction partway along the state root's path, above the
`workspaces` level, pointing into the repository; the state root really resolves to
`<repo>\smuggled\state`. The seam fails that one resolution, which is the state this machine will not
produce on demand and precisely when the lexical fallback mattered.

- Against `799ec69`: `smuggled folder inside the repo exists? true`. The `mkdirSync` wrote through the
  junction and into the user's checkout, and only then did the later strict check catch the
  containment and refuse. The refusal was honest; the write had already happened.
- Against the fix: `the state root "..." could not be resolved to a real path ... Nothing was
  created.` Nothing inside the repository, no branch, repo clean.

The same section also checks the unhooked path: with resolution working, that same junction is caught
by the containment refusal instead, so the strict resolver did not replace the check it stands in
front of.

`npx tsc --noEmit` clean with `node_modules` present.

## Still parked, unchanged

The same-tip ABA race on branch deletion, stated accurately in the code comment. The one remaining
lenient resolution, `realPath(worktreePath)` after a successful `git worktree add`, where no
containment decision depends on the result and the folder provably exists.

## Round 5, on top of `ce14ecd`: the probe again, and this time exactly

Sol closed item 2 under the threat model and failed item 1 twice over. Both defects were in
`branchTip` alone, and the fix is Sol's prescription adopted as written. Nothing else in the file
changed and no caller changed.

**Defect one: stdout was believed before stderr was checked.** The stated rule was that anything git
says about the ref makes the answer unclean, but the code returned `present` as soon as it had a hash
and only consulted stderr on an empty answer. A warning arriving beside a perfectly good hash was
therefore ignored. This is reachable on a real repository: pack the task branch so its loose file goes
away, which frees the directory name, then put a broken loose ref underneath it. The same pattern walk
then yields both.

    hash+warning exit=0 stdout="refs/heads/conductor/task-both\0 6d4f990..." stderr="warning: ignoring broken ref refs/heads/conductor/task-both/sub"

**Defect two: `for-each-ref <ref>` is a pattern and matches descendants.** With
`refs/heads/conductor/task-desc` absent and `refs/heads/conductor/task-desc/sub` present, the bare
`%(objectname)` format printed the descendant's hash with nothing to say it was a different ref. A
refname is a path, so this is an ordinary thing for a repository to contain, and the consequence is a
stranger's hash handed to a compare-and-delete.

    descendant, bare   exit=0 stdout="6d4f990b66677a2bb4fc61efed79f0a3bc119375\n"
    descendant, paired exit=0 stdout="refs/heads/conductor/task-desc/sub\0 6d4f990b66677a2bb4fc61efed79f0a3bc119375\n"

**The fix.** Format `%(refname)%00%(objectname)`. Any stderr is rejected before stdout is looked at.
Present requires exactly one record whose refname equals the full ref exactly, and whose object name
is 40 or 64 hex characters. No exact record is absent. Malformed or multiple exact records are
unreadable.

**Evidence.** The whole mapping is shown on one real repository in section 23b, raw, on git
2.52.0.windows.1: present, absent, the descendant case under both formats, and the hash-plus-warning
case. Then both defects as Conductor behaviour, end to end with no stub, run against a detached
worktree of `ce14ecd` and against the fix.

- Descendant. Against `ce14ecd`: `discard said: ok (note: ... A branch named "conductor/task-p8"
  exists, but Conductor cannot confirm ...)`. No such branch exists; only `conductor/task-p8/sub`
  does, and the user is being told their branch may be Conductor litter. Against the fix: `discard
  said: ok, no note`, and the descendant is untouched.
- Warning beside a hash. Against `ce14ecd`: the same false `ok` with a note claiming the branch
  exists. Against the fix: a refusal quoting `warning: ignoring broken ref`.

Against `ce14ecd` the run is `3 CHECK(S) FAILED`, all three in the new subsection, with the 180 checks
before it passing unchanged. Against the fix: `ALL CHECKS PASSED`, 205 checks. `npx tsc --noEmit`
clean with `node_modules` present.

Nothing new is parked. The two limits named above, the same-tip ABA race and the one lenient
`realPath(worktreePath)` after a successful add, are unchanged.

## Note on the harness

Sections 21, 22, the silent-failure case in 23, and the seam half of 24 are not end-to-end
reproductions and are labelled as such in the spike. They drive a copy of `isolation.ts` with two
seams cut by exact-text replacement, each asserted unique before it is replaced, with an unhooked
sanity run proving the copy behaves like the original. The tip-probe predicate in the harness matches
either `rev-parse` or `for-each-ref`, which is what lets one file run against both revisions.
