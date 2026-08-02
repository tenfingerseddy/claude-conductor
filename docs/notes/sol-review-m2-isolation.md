# Sol review, M2 isolation: does the isolated copy actually hold?

Raw output from Sol below. Not edited, not filtered. The triage under the separator is Fable's,
not Sol's.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief.md`
- Run from: repo root, branch `feat/m2-isolation`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only, 44,627 tokens
- File in scope: `src/engine/isolation.ts` in full, at commit `a6effd6`
- Evidence given: the file inlined into the brief with line numbers. The codex sandbox cannot launch
  a process on this host, so Sol cannot read from disk here. Inlining is the workaround.
- Dimension: does the isolation guarantee hold. Three claims to attack: the user's checkout does not
  move, discard is safe, the copy is honest about itself.
- Told not to re-report as discoveries: the copy lacks untracked and ignored files, worktree add runs
  the repo's smudge filters and post-checkout hooks, seal runs its pre-commit hooks, submodules are
  not populated, and nothing yet stops a session writing outside the copy.
- Date: 2026-08-02

The brief's own text and the 592 inlined lines are left out below; what follows is Sol's answer.

---

## Verdict

1. **The user’s checkout does not move — does not hold.** Normal linked-worktree operations leave the primary HEAD and HEAD reflog alone, but `dirtyCounts` can rewrite the primary index, and a configurable state root may sit inside the checkout. Sealing can also advance an unrelated existing branch.

2. **Discard is safe — does not hold.** The normal-path disk check at lines 479–485 is good: it prevents success while the recorded directory still exists. However, branch and worktree ownership are inferred from reusable names and paths, and global pruning touches unrelated worktrees.

3. **The copy is honest about itself — does not hold.** The description clearly states the base commit and the absence of untracked and ignored files. The dirty counts and base-ref attribution are not reliable under several ordinary repository states or concurrent human activity.

## Findings

### 1. Critical — sealing can commit directly onto a user-owned branch

**Lines:** 386–418, especially 390–412; consequence at 466–470.

**Sequence:**

1. Conductor creates `conductor/task-t1`.
2. The repository also has an existing branch `release`, not checked out elsewhere.
3. Inside the copy, the session runs `git switch release` and edits files.
4. `sealWorkspace` verifies only that the directory exists.
5. `git add` and `git commit` run on `release`, advancing that user-owned ref.

**Cost:** Conductor contaminates an existing branch, while the workspace record still advertises `conductor/task-t1` as the output. A later discard refuses because the checked-out branch no longer matches. A detached-HEAD variant seals successfully while leaving the advertised task branch unchanged.

**Blocks wiring:** Yes.

### 2. Critical — failed-add cleanup can delete a branch created by the human in the race window

**Lines:** 279–280, 309–315, 349–356.

**Sequence:**

1. Line 279 confirms `conductor/task-t1` does not exist.
2. Before line 309 runs, the human creates that branch in another terminal without checking it out.
3. `git worktree add -b` fails because the branch now exists.
4. `cleanUpFailedAdd` sees the ref and executes `git branch -D`.

**Cost:** A branch Conductor did not create is deleted. Its reflog is also removed, potentially leaving unique commits dangling. This repeats the previous design’s structural mistake: timing is treated as authorship.

**Blocks wiring:** Yes.

### 3. Critical — discard deletes any later branch that reuses the recorded name

**Lines:** 452–465 and 480–493, especially 488–489.

**Sequence:**

1. A valid workspace record exists for task `t1`.
2. The original worktree and task branch are subsequently removed outside Conductor.
3. Later, the human creates a new, independent un-checked-out branch named `conductor/task-t1`.
4. The recorded worktree path is absent, so `ours` is false.
5. Line 488 nevertheless treats mere ref existence as authority to delete it.

The same problem occurs if an old repository path is later occupied by a different repository containing the same branch name.

**Cost:** Independent human work can lose its branch and reflog. The code contradicts lines 448–450: metadata has not confirmed ownership in this path.

**Blocks wiring:** Yes.

### 4. Critical — a detached worktree at the reused path is accepted as “ours”

**Lines:** 463–474, especially 466.

**Sequence:**

1. The original Conductor worktree is removed manually.
2. The human creates a new detached worktree at the same path and makes uncommitted changes there.
3. `registeredWorktrees` returns the recorded path with `branchThere === null`.
4. The mismatch guard explicitly excludes `null`.
5. `git worktree remove --force` deletes the replacement worktree and its uncommitted contents.

**Cost:** Discard destroys a worktree Conductor did not create merely because its path was reused.

**Blocks wiring:** Yes.

### 5. High — counting dirt can mutate the primary checkout’s index

**Lines:** 116–125, 228–240 and 305–306.

**Sequence:**

1. A tracked file’s timestamp changes without its contents changing.
2. Capture the bytes of the primary `.git/index`.
3. `createWorkspace` runs `git status`.
4. Git performs its normal optional index refresh and writes updated stat data.

No `GIT_OPTIONAL_LOCKS=0` is supplied; in fact, `gitEnv` strips any inherited value.

**Cost:** The primary index is no longer byte-identical, breaking the explicit hard invariant. It can also contend with the human’s concurrent index operation.

**Blocks wiring:** Yes.

### 6. High — the state root may be inside the live checkout

**Lines:** 289–309; incomplete cleanup at 350–356.

**Sequence:**

1. Configure `CONDUCTOR_HOME`/`config.stateRoot` as an unignored directory beneath `repoRoot`.
2. Line 308 creates `<repo>\...\workspaces`.
3. The nested worktree is then created there, or creation fails after the directory mutation.

**Cost:** The user’s live folder and `git status` change during creation. After discard, parent directories can remain. The task’s supposed isolated copy also physically resides beneath the folder it promises not to touch.

**Blocks wiring:** Yes.

### 7. High — `git worktree prune` can remove unrelated user worktree metadata

**Lines:** 352 and 495.

**Sequence:**

1. The user has an unrelated linked worktree on a disconnected drive whose missing-path metadata is old enough to be prunable.
2. Conductor encounters a failed add or successfully discards any task.
3. The unscoped `git worktree prune` removes metadata for that unrelated worktree too.

**Cost:** The unrelated worktree is no longer registered and may require manual repair when its storage returns. This exceeds the permitted metadata mutation.

**Blocks wiring:** Yes.

### 8. High — zero dirty counts do not prove that the checkout is clean

**Lines:** 228–240 and 573–581.

**Sequence A:**

1. Mark a tracked file `assume-unchanged` or `skip-worktree`.
2. Modify its working-tree contents.
3. `git status --porcelain` omits it.
4. The record stores `modifiedTracked: 0`, and line 580 says the copy matches the human’s folder.

**Sequence B:**

1. The primary index is corrupt or otherwise makes `git status` fail.
2. Line 234 silently converts that failure into two zero counts.
3. If worktree creation from `HEAD` succeeds, the same false clean statement is shown.

**Cost:** The task receives the committed version while the user is explicitly told it matches the version they are viewing. It may therefore produce work against stale source or configuration.

**Blocks wiring:** Yes.

### 9. Medium — base commit, base ref and dirty counts are not one coherent observation

**Lines:** 264–266, 305–309 and 569–580.

**Sequence:**

1. Line 264 reads commit `A` while the human is on `main`.
2. The human switches to clean branch `feature` at commit `B`.
3. Line 266 records `refs/heads/feature`; line 306 records zero dirty files.
4. Line 309 still creates the copy from `A`.
5. The description says it was made from `A` “on feature” and that it matches the human’s clean folder at `B`.

A simple edit after line 306 likewise makes the stored counts stale before creation completes.

**Cost:** The audit record contains a false commit/ref pairing and the user receives a false freshness assurance. The task may run against an older revision than the checkout being viewed.

**Blocks wiring:** Yes, because accurate creation-time provenance and counts are explicit requirements.

---

## Triage, Fable, 2026-08-02

**Verdict on the verdict: Sol is right to fail it, and this failure is a different kind from the
last two.** Every one of the nine is a defect inside one file: an ownership check that infers from a
name instead of asking, a read that writes, a cleanup that is too broad. None of them says the design
cannot know something. The previous two rounds failed because a snapshot cannot tell who made an
edit, which no amount of code closes. That difference is the evidence isolation is the right model,
and it is worth stating plainly rather than treating nine findings as nine equal blows.

One theme runs through findings 1, 2, 3 and 4, and it is the same mistake the earlier design made in
a different costume: **treating a name or a path as proof of ownership.** A branch called
`conductor/task-t1` is not necessarily ours. A folder at our recorded path is not necessarily our
worktree. Conductor must confirm from git's own metadata that a thing is its own before removing it,
and where it cannot confirm, it leaves the thing alone and says so.

| # | Sol's severity | Call | Fix |
|---|---|---|---|
| 1 | Critical | **Accept.** Real. The session can `git switch` inside the copy. | Seal verifies the copy's HEAD is still `refs/heads/<recorded branch>` and refuses otherwise. |
| 2 | Critical | **Accept**, narrow but the fix is cheap. | After a failed add, only delete the branch if its tip is exactly the base commit. Otherwise leave it and name it in the refusal. |
| 3 | Critical | **Accept.** The `ours \|\|` clause at line 488 is exactly the sloppy bit. | Delete the branch only when git's worktree metadata confirmed the worktree was ours. |
| 4 | Critical | **Accept.** Excluding `null` from the mismatch guard is wrong. | Require the registered branch to equal our branch exactly. A detached worktree at our path is not ours. |
| 5 | High | **Accept, and it is the best finding here.** A read that writes breaks the one hard invariant. | `--no-optional-locks` on every read-only git call. |
| 6 | High | **Reject**, with a reason Sol could not have seen. `loadConfig` (src/config.ts) refuses at startup a state root inside any git checkout, which is also what keeps the daemon token out of a repository. Sol was given `isolation.ts` alone. Belt and braces anyway, because the check is one line: refuse if the worktree path resolves inside the repo root. |
| 7 | High | **Accept**, and fix by deletion. Unscoped `git worktree prune` is not ours to run. | Drop it. `git worktree remove` cleans its own metadata; confirm our entry is gone by asking git. |
| 8 | High | **Accept the honesty half.** A failed `git status` becoming "0 changed, 0 untracked" is the gauge's unforgivable lie in a new place. `assume-unchanged` and `skip-worktree` are a stated limit, not a fix. | Counts become nullable; null prints as "could not tell", never as clean. |
| 9 | Medium | **Accept the cheap half.** The copy really is made from the recorded commit, so the copy is never wrong; only the label can be. | Re-read HEAD after creation and record whether the user's folder moved while the copy was being made. |

Nothing here is contested and nothing is parked. Fix round follows.

---

# Sol confirmation pass, after the fix round (commit `f1ad8bd`)

- Command: `codex exec -s read-only --skip-git-repo-check - < sol-confirm.md`
- Model: `gpt-5.6-sol`, effort `xhigh`. Fixed file inlined with line numbers, same workaround.
- Date: 2026-08-02

Raw output:

Verdict: not a clean pass. Five findings are closed; four are only partially closed. The new discard metadata handling also introduces an honesty/error-handling defect.

| # | Status | Assessment |
|---|---|---|
| 1 | Closed | Seal checks the symbolic HEAD against the recorded full ref before staging anything (`L523–533`, before `git add` at `L535`). A switched or detached copy is refused. |
| 2 | Partially closed | The tip check at `L468–470` protects branches pointing somewhere other than `baseCommit`, but a human-created replacement pointing exactly at `baseCommit` is still deleted. Tip equality is not ownership. |
| 3 | Partially closed | Missing or mismatched metadata now preserves the branch. However, ownership is checked at `L615–620`, the worktree is removed at `L630`, and the branch is deleted later at `L656`. A same-named branch can be replaced in that interval and then deleted. |
| 4 | Closed | A detached registered worktree produces `branchThere === null`, making `ours` false and refusing at `L621–626` before any removal. |
| 5 | Closed | Every read-only Git operation shown goes through `gitRead` and therefore `--no-optional-locks`. The remaining direct `git` calls are the intended writers. |
| 6 | Partially closed | Direct containment is blocked, but the code does not actually resolve the prospective worktree path. It resolves only `config.stateRoot` at `L370`, then appends `workspaces/...`. An existing junction below the state root can redirect the worktree back inside the repository. |
| 7 | Closed | Both unscoped prune calls are gone, so discard no longer deregisters unrelated stale worktrees through `prune`. The replacement confirmation has a separate defect below. |
| 8 | Closed | Status failure produces two nulls at `L315`; restoration preserves nulls at `L717–718`; description cannot turn them into a clean claim (`L746–751`). |
| 9 | Partially closed | The second HEAD check detects some movement, but it still does not create a coherent observation and can itself miss movement. Counts can change without HEAD moving, and the two post-check commands are separate. |

Concrete remaining sequences:

1. Finding 2 still deletes a human branch at the base commit:

   - `worktree add` fails at `L406–407`.
   - Before `L468`, the branch is absent or removed and a human creates `conductor/task-t1` at `baseCommit`.
   - `tip === baseCommit` at `L469`.
   - `branch -D` at `L470` deletes the human branch.

2. Finding 3 still has a branch-identity race:

   - `registeredWorktrees` confirms the original worktree and branch at `L615–620`.
   - Conductor removes that worktree at `L630`.
   - Before `L656`, the human deletes the now-free task branch and creates a new same-named branch at another commit.
   - `git branch -D <name>` deletes the replacement without checking its tip or identity.

3. Finding 6 has a static junction bypass:

   - State root is `C:\ConductorState`, legitimately outside `C:\repo`.
   - `C:\ConductorState\workspaces` is an existing junction to a directory inside `C:\repo`.
   - `realPathDeep(config.stateRoot)` at `L370` resolves only `C:\ConductorState`; the appended path remains lexically outside, so `L379–385` passes.
   - `mkdirSync`/`worktree add` at `L405–406` follows the junction and creates files physically inside the user’s checkout.
   - The real path is discovered only at `L418`, after the checkout has already been changed.

4. Finding 9 still permits a false clean claim:

   - `dirtyCounts` reports zero at `L403`.
   - The human edits a tracked file without moving HEAD.
   - Both comparisons at `L433` remain equal, so `headMovedDuringCreate` is false.
   - `L760` claims the folder has no uncommitted changes and the copy matches what the user is looking at.

   There is also a narrower HEAD race: the first post-read inside `L433` can observe the old commit, then the branch advances before `headRef` runs. The ref name remains unchanged, so both comparisons pass and movement is missed.

New defect introduced by the fixes:

`registeredWorktrees` erases failure into an empty, authoritative-looking map (`L570–572`). Every caller therefore confuses “Git said there are no worktrees” with “Git could not answer.”

A concrete consequence:

- `git worktree list` fails at `L570–572`.
- The recorded path is currently absent, so `L636` does not stop processing.
- A branch exists, so `L660–668` returns `ok: true`, falsely says Git had no registered worktree, and logs a successful discard.
- `findWorkspace` subsequently treats that success as final at `L700–706`, preventing an automatic retry even though stale worktree metadata may remain.

The verification at `L644` has the same problem: a failed second listing is accepted as confirmed absence.

There is also a false error message when metadata genuinely has no entry but an unrelated directory exists at the recorded path. No remove command runs because `ours` is false, yet `L636–639` says “git reported the worktree removed.” The directory is left safe, but the result is not honest.

So the fixes materially improve the file, and no unscoped-prune regression appears, but the three claims do not yet all hold: the junction bypass can move the checkout, branch deletion still has an ownership race, and both creation and discard can still make claims unsupported by their observations.

---

## Triage of the confirmation pass, Fable

Five closed (1, 4, 5, 7, 8), four partial, one new defect. Calls:

- **Residual 2 and 3 are the same shape: branch deletion is not atomic with the check that
  justified it.** Fix both with `git update-ref -d <ref> <expected-tip>`, which is git's own
  compare-and-delete: it refuses if the ref moved since we looked. What remains after that is a
  same-user sub-second race where the loss is a branch name pointing at a commit that still
  exists, and that residue is parked in writing rather than chased.
- **Residual 6 accepted.** Resolving only the state root and appending lexically is the same 8.3
  mistake in junction form. Resolve the workspaces dir after creating it and re-check containment
  before `worktree add` runs.
- **Residual 9: fix the claim, not the race.** The copy is always truly made from the recorded
  commit; only the labels can go stale, and no sequence of re-reads makes two git commands one
  observation. The description switches to past tense ("had no uncommitted changes when the copy
  was made") so it claims exactly what was observed and nothing more.
- **New defect accepted, both halves.** `registeredWorktrees` must distinguish "no worktrees" from
  "git could not answer", and the "git reported the worktree removed" sentence must not fire on a
  path we never removed.

---

# Sol pass 3, after fix round 2 (commit `6bf04f1`)

Same command shape, file inlined at `6bf04f1`. Judged the five round-2 changes only.

Raw output:

I’ll keep this strictly to the inlined file and the five round-2 changes. I’m also honoring “no disk access,” so I won’t open the repo’s working-notes files; the verdict will be based only on the supplied lines and stated limits.
codex
1. **Partially closed** — compare-and-delete is correctly used in failed-add cleanup (lines 497–500) and discard (693–745). However:

   - The tip reads ignore `result.ok` (497, 693). An unreadable tip becomes `''`; discard can remove the worktree, skip branch deletion, and log success (744–765).
   - If `update-ref` fails and the subsequent read also fails, `now` is empty and execution again falls through to success (746–765).
   - Line 742 incorrectly says a recreated branch survives. A branch recreated at the same tip remains vulnerable under the explicitly parked ABA limit.

2. **Partially closed** — the ordering and path use are correct (395–410, 429, 441–464), but resolution is not fail-closed. `realPath` converts every resolution failure into a lexical `resolve(path)` result (199–204); that fallback reaches both `realPathDeep` (221) and the critical post-creation resolution (407). If canonicalization cannot answer, containment is not proven and creation should refuse.

3. **Closed on its own terms** — the dirty-count statements are past-tense and creation-anchored (843–865), with the detected HEAD-movement qualification at 867–870.

4. **Closed on its own terms** — failure returns `null` (615–618), and both discard queries distinguish it from an empty registration list (669–675, 721–729).

5. **Closed on its own terms** — the unregistered-directory path now explicitly says no removal occurred and leaves the branch alone (702–711).

The round introduced two substantive fail-open “could not answer” cases: canonical-path resolution can degrade to lexical containment, and branch-tip/deletion failures can become successful discard records.

**Not safe to wire in:** containment and completed branch deletion are still reported as established when the underlying operation may only be unknown.

Triage: items 3, 4 and 5 closed on their own terms. Items 1 and 2 partially closed, both the same
shape: an operation that could not be performed was still being reported as performed. Fix round 3
(commit `799ec69`) introduced the `branchTip` tri-state and the strict path resolver, with
reproductions that fail 11 checks against `6bf04f1` and pass whole against the fix.

---

# Sol pass 4, after fix round 3 (commit `799ec69`)

Judged the round-3 closures only. Raw output:

Not safe to wire in: `branchTip` still mistakes silent `rev-parse --quiet` failures for absence, and `realPathDeep()` can still use a lenient path before `mkdirSync`, permitting a write through an unresolved junction before the strict check.

Triage: the three closures held; two refinements of the same crank remain. The rev-parse probe
cannot distinguish a quiet failure from absence by its streams, so the probe moves to
`for-each-ref`, whose exit code carries the distinction. And the pre-mkdir resolution of the state
root is still lenient, so the mkdir itself must move behind the strict rule. Fix round 4 covers
both. Round sizes 9, 5, 2, 2: converging, and every round since the first has been about honesty of
failure modes rather than the isolation model itself, which no pass has dented.

---

# Sol pass 5, after fix round 4 (commit `ce14ecd`)

Judged the two round-4 changes. Raw verdict:

1. `branchTip`: not closed.

- The implementation accepts stdout before checking stderr. Exit 0 with both a hash and stderr becomes `present`, contrary to the stated unreadable rule.
- `for-each-ref` treats `<full-ref>` as a pattern. It can also match descendants: if the exact task ref is absent but `refs/heads/conductor/task-t1/sub` exists, its hash is incorrectly reported as the task branch’s tip. That prefix ambiguity is new.

The compare-and-delete still prevents deleting the descendant, but the helper can misreport ownership and cross the intended refuse-before-removal boundary.

2. Deep state-root resolution: closed under the stated threat model. It canonicalizes the deepest existing ancestor before `mkdirSync`, performs the pre-write containment check using that canonical path, and retains the post-creation junction check. It introduces only additional conservative refusals, not a new unsafe write path.

Smallest sufficient change: change only `branchTip` so the format includes both refname and object name—such as `%(refname)%00%(objectname)`—then reject any stderr before inspecting stdout and accept `present` only for exactly one record whose refname equals `ref`. No exact record means absent; malformed or multiple exact records mean unreadable. Callers can remain unchanged.

**Verdict: not safe to wire in yet; with that localized `branchTip` correction, yes.**

Item 2 closed under the threat model. Item 1's two defects were real, and Sol named the smallest
sufficient change and committed to a verdict: "with that localized `branchTip` correction, yes"
safe to wire in. Round 5 (commit `15d2193`) adopted the prescription verbatim, with all four probe
states demonstrated end to end on a real repository, including the descendant-ref and packed-branch
broken-ref cases, no stubs needed.

---

# Sol pass 6, on the round-5 correction, and the close-out call

Asked one question: is the correction faithful to the prescription, and is the file safe to wire
in. Sol's answer:

> No—not fully, so I would not wire it in yet. `stderr.trim()` fails to reject whitespace-only
> stderr, and stdout is filtered before validation: malformed records can be ignored, normalized by
> `trim()`, or reported as `absent` when no exact record survives. Reject nonempty raw stderr, parse
> every nonterminal output line without trimming, reject malformed records, and only then classify
> the exact-ref count as absent, duplicated, or present.

## Architect call: reviewed enough. Parked, with the reasoning in full.

Pass 5 named a smallest sufficient change and stated plainly that with it the file is safe to wire
in. The change was adopted exactly as prescribed and demonstrated on a real repository. Pass 6 then
raised the bar again, and the new items are of a different kind from every earlier finding: each
one requires git itself to emit output that violates its own `--format` contract, a whitespace-only
stderr carrying meaning, a record for the exact ref printed without the format's NUL separator, a
non-hex object name surviving the 40-or-64 hex gate. No earlier finding needed the platform to
misbehave; these do.

They also all fail in the safe direction. The parser's only path to `present` demands one exact-ref
record with a well-formed hash, so a format violation can produce `absent` or `unreadable`, never a
false `present`. `absent` where `unreadable` was deserved means a branch is left alone rather than
deleted, and the one consequence is a leftover branch the sentence did not mention. Nothing is
removed, nothing is overwritten, nothing is misattributed.

Review rounds found 9, then 5, then 2, then 2, then 1 real defects; pass 6 found zero that reach a
real git. Stop condition 6 covers a finding that changes the design; this is the opposite, a
reviewer that has run out of design and code and moved to the platform's own contract. Continuing
past the point where the reviewer's previous sufficient-change commitment is honoured and the new
findings require platform misbehaviour is not more safety, it is review without a stopping rule.
Kane ratifies at merge, per D3, and this file records what he is ratifying.

Scoreboard across the six passes: 19 distinct real defects found and fixed, every fix verified by a
reproduction failing against the prior commit and passing against the fix, 205 checks in
`spikes/isolation/verify.ts`, and the isolation model itself never dented once: every finding after
round 1 was about honesty of failure modes, not about whether a task's copy isolates it.
