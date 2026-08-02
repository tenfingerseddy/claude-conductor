# Sol review, M2 wiring: does the wiring preserve what the parts guaranteed separately?

Raw output from Sol below, then the triage, which is Fable's.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief.md`
- Run from: repo root, branch `feat/m2-isolation`
- Model: `gpt-5.6-sol`, effort `xhigh`
- Evidence given: the full unified diff of `f39009b` against its parent (src/ only, context 6),
  inlined. The codex sandbox cannot launch a process here; inlining is the standing workaround.
- Dimension: wiring only. Five questions: session path scoping, the undo door's confirm binding
  and reachability, seal-in-finally, the checkpoint deletion's blast radius, rail behaviour drift.
- Told not to re-report: absolute-path writes outside the copy (next slice), the isolation
  module's internals (six passes already), the parked limits.
- Date: 2026-08-02

---

One merge-blocking finding.

- **High — the daemon does not enforce preview-before-confirm.** `src/server/http.ts:451-468`, reached through `src/server/http.ts:662-664`. `discard()` validates only `taskId` and `confirm: true`, then performs a fresh `findWorkspace()` and immediately calls `discardWorkspace()`. An authenticated caller can therefore make its first request `POST /undo {"taskId":"…","confirm":true}`; no preview need ever have existed. The `taskId` adequately names a total-discard target, but it does not bind confirmation to a preview. Cost: the worktree, uncommitted files, and output branch can be deleted without the promised human preview. This blocks the merge. A single-use preview nonce bound to the workspace identity would restore the two-step guarantee; it need not contain the old path-level undo plan.

The rest of the wiring holds:

1. **Path scoping:** `runSession()` receives `isolated`, whose `cwd` is `workspace.workdir` (`src/main.ts:116-119, 150`). Both structured-tool rail paths therefore scope to the copy. The original cwd survives only as workspace input, logging/display data, and `userCwd` wording; `classifyRail()` still compares exclusively against `task.cwd` (`src/engine/session.ts:683-691`). An attended user may deliberately approve an outside-copy action, as before. Absolute-path shell escape remains the explicitly excluded next slice.

2. **Undo access:** the new GET only previews. The POST remains a state-changing route behind the daemon’s existing token gate; this diff adds no unauthenticated or cross-origin route to `discardWorkspace()`. The defect is authenticated direct confirmation, not an authentication bypass.

3. **Seal:** under `sealWorkspace()`’s established result contract, an `{ok:false}` return cannot replace the session result. Its reason is combined with any session error (`src/main.ts:155-193`), and the copy remains on disk with uncommitted work. There is no automatic discard in the task loop.

4. **Deletion compatibility:** no surviving production import, route, or CLI verb in this diff references `checkpoint.ts` or the five removed event kinds. Old JSONL entries remain parseable: the new readers skip unrelated kinds, while `/events` and `tail` pass them through. Removing variants from the TypeScript write union does not invalidate historical lines.

5. **Rails:** no trust or approval behavior changes. Autonomous mode is still refused; only the refusal text drops the now-completed checkpoint prerequisite. The outside-cwd tap changes wording, not classification or approval mapping.

---

## Triage, Fable

Four dimensions hold with zero findings, in Sol's own words. One finding, high, merge-blocking,
accepted without argument: the daemon promised preview-then-confirm and enforced only confirm. The
fix is Sol's own prescription, a single-use preview nonce bound to the workspace identity, minted
by GET /undo, required and consumed by POST /undo, with an expiry. Fix round follows; nothing else
is open on this diff.

---

# Fix round (commit `c746263`), and the confirmation

The nonce landed as prescribed, plus one builder deviation adopted after review: the token pins the
`workspace_created` timestamp as a fourth field, because task ids restart with the daemon and a
replacement copy under a reused id would otherwise match every field the prescription named. Twenty
checks green on a live daemon across three real tasks (blind, invented, replayed, cross-task and
expired tokens all refused; preview-then-confirm and the CLI flow succeed), plus a synthetic check
of the timestamp pin, labelled synthetic in the findings because the CLI cannot reach that state
today. Sol's confirmation of the fix is below.

Raw:

The blocker is closed. `POST /undo` now requires a live nonce minted by `GET /undo`, consumes it before any outcome, and verifies it against the task ID, worktree path, branch, and creation record before discarding; expiry and daemon-local storage also make replay and restart reuse fail safely. I see no new correctness or security blocker in these hunks—the timestamp binding is arguably redundant because restart also clears tokens, but it adds defense without weakening the flow.

Safe to merge: **yes, the wiring diff is safe to merge.**
