# Sol review of M1, triage summary

Twenty findings across three passes. Raw output lives in `sol-review-m1-pass1.md` (security),
`sol-review-m1-pass2.md` (loop correctness), `sol-review-m1-pass3.md` (gauge honesty). All three
ran as `codex exec -s read-only`, model `gpt-5.6-sol` at `xhigh`, from the repo root on
`feat/m1-engine`.

Verdict column is the orchestrator's triage, not Sol's. "Real" means the code path checked out on
a spot read or the reasoning holds without one. Nothing here has been fixed and no source file was
touched.

## Pass 1, security (7 findings)

| # | Sev | File | Finding | Verdict |
|---|-----|------|---------|---------|
| 1 | Critical | `src/server/http.ts` | Any WS client can settle any approval, no auth and no Origin check | Real, confirmed: `localHost()` checks only the Host header, which a browser sets to 127.0.0.1 anyway |
| 2 | Critical | `src/server/http.ts` | `POST /tasks` and `POST /run` unauthenticated and CSRF-reachable | Real, confirmed: `readJson` never inspects content-type, so a `text/plain` simple request needs no preflight |
| 3 | Critical | `src/engine/session.ts` | Interpreter wrappers (`cmd.exe /c`, `node -e`, `git -C`) slip past both rail layers | Real, and genuinely new next to known wrinkle 2 because it defeats Conductor's own classifier, not the SDK's auto-allows |
| 4 | High | `src/engine/session.ts` | `insideCwd` is lexical only, junctions and symlinks escape the cwd rail | Real, and it matters on Windows where junctions need no privilege |
| 5 | High | `src/server/http.ts` | Every WS client receives status, last 50 events, and all raw SDK messages | Real, same missing-auth root cause as finding 1 |
| 6 | High | `src/engine/session.ts` | `childEnv` strips only the two ANTHROPIC vars, all other secrets inherited | Real, confirmed at `session.ts:311-313`; golden rule 1 covers billing keys but not third-party tokens |
| 7 | Medium | `src/config.ts` | `CONDUCTOR_HOME=.` or an account dir inside the repo puts state and credentials in the repo | Real but self-inflicted, since it needs an operator to point config at the repo |

## Pass 2, loop correctness (8 findings)

| # | Sev | File | Finding | Verdict |
|---|-----|------|---------|---------|
| 1 | High | `session.ts`, `main.ts` | A session ending without `finish_task` still consumes the task, drops the carry, and logs a `cut` | Real, confirmed at `main.ts:89-95`; the phantom `cut` event makes the logbook claim a cut that never happened |
| 2 | High | `finish-task.ts` | A second `finish_task` writes handoff B to disk before the guard rejects it | Real, dedup happens in `onFinish` after the write, so the tool is not idempotent |
| 3 | High | `main.ts` | `runTasks` has no single-flight or task-claim boundary | Real, confirmed: nothing marks or removes a task; the HTTP reachability question is the open half |
| 4 | High | `session.ts` | A throwing `onHandle` skips `run.close()` and leaves the query unclosed | Real but low likelihood, since the only in-repo callers pass trivial callbacks |
| 5 | High | `finish-task.ts`, `main.ts` | A written handoff is unrecoverable after a restart, `carry` always starts null | Real, and partly by design; adjacent to the known M1-shape note that the queue is in memory until M2 |
| 6 | Medium | `session.ts` | The 250 ms delayed `interrupt()` has no backstop if it rejects | Real, the loop can hang with no finish or cut logged |
| 7 | Medium | `session.ts` | Messages sent during the 250 ms window may land or be dropped, caller cannot tell | Real but narrow, needs a door to send inside a 250 ms gap |
| 8 | Medium | `finish-task.ts`, `main.ts` | `follow_up_tasks` are recorded but never queued | Already known, matches the PLAN open question naming this M1's shape with the queue as M2's first job |

`src/engine/cut.ts` came back clean.

## Pass 3, gauge honesty (5 findings)

| # | Sev | File | Finding | Verdict |
|---|-----|------|---------|---------|
| 1 | Critical | `gauge.ts` | A failed live probe leaves the last reading cached and still labelled `official, live` | Real, confirmed: `if (live) this.live = live` never invalidates, and `pick()` always prefers it; this is the exact silent-number failure the dimension asked about |
| 2 | High | `gauge.ts` | Self-metering has no rolling-window expiry, so calibration can learn a negative percent-per-token | Real, confirmed no timestamps on the token totals; SPEC.md asks for a rolling window and the code sums forever |
| 3 | High | `gauge.ts` | Stale-file estimation mixes a file percentage with `anchorTokens` from a live reading, and weekly reuses the five-hour rate | Real but narrower than stated, since it needs live absent for that window while a live-derived calibration survives |
| 4 | High | `gauge.ts` | Missing or future `fetchedAtMs` yields `unknown`, which renders as `official, from disk` and passes the gate | Real, the staleness gate fails open rather than closed |
| 5 | Medium | `gauge.ts` | Finite-only validation accepts out-of-range percentages such as -5 | Real but needs malformed upstream data, so it is hardening rather than a live bug |

`src/state/logbook.ts` came back clean, and Sol confirmed absent-versus-zero is handled correctly
end to end.

## Cross-cutting read

- No finding was judged a false positive. Two are already-known (pass 2 #8 outright, pass 2 #5
  partly), and none of the four finish-line wrinkles were re-reported.
- The security pass is the heavy one: findings 1, 2, and 3 compose into a single chain where a
  loopback-reachable page queues an autonomous task, starts it, and approves its own rail stops.
- The gauge answer to "can it report headroom it does not have" is yes, and pass 3 #1 is the one
  that breaks the honesty contract rather than just the accuracy of a number.
