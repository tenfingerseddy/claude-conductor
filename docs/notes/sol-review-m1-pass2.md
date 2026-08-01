# Sol review, M1 engine, pass 2: loop correctness

Raw output from Sol. Not edited, not filtered.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief2.txt`
- Run from: repo root, branch `feat/m1-engine`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only (override of the config default)
- Files in scope: src/engine/session.ts, src/engine/finish-task.ts, src/engine/cut.ts, src/main.ts
- Dimension: loop correctness only (one task, one cut)
- Date: 2026-08-01

---

# LOOP CORRECTNESS findings

## High

1. **A session ending without `finish_task` consumes the unfinished task and advances the queue.**  
   Files: [session.ts:273](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:273>), [main.ts:89](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/main.ts:89>)

   Sequence: task A hits `maxTurns`, produces an error result, throws from the SDK stream, or ends normally without calling the tool. `runSession` returns `finish: null`. `runTasks` records `error` or `no_finish_task`, sets `carry = null`, and immediately iterates to task B. Task A is neither retried nor retained, and B receives no handoff. The same sequence also writes a `cut` event even though Conductor never initiated a cut.

2. **A second `finish_task` call still writes a handoff before it is rejected.**  
   Files: [finish-task.ts:58](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/finish-task.ts:58>), [session.ts:111](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:111>)

   Sequence: Claude emits two `finish_task` calls in one response. Call A writes handoff A, then sets `state.finish`. Call B writes handoff B, then reaches `onFinish`, where the `state.finish` guard discards it. The second tool response nevertheless says its outcome was recorded. If repeated titles resolve to the same path, disk contains B while the next session receives in-memory A. If they resolve to distinct paths, B is an orphaned handoff. The deduplication occurs too late to make the tool idempotent.

3. **`runTasks` provides no single-flight or task-claim boundary for concurrent callers.**  
   File: [main.ts:46](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/main.ts:46>)

   Sequence: a shared array contains task A. Caller 1 enters `runTasks`, begins A, and pauses at `await runSession`. Caller 2 enters `runTasks` with the same array and also begins A because neither runner removes or marks it. If task B is appended while both runners are suspended, JavaScript’s live array iterators can then make both runners execute B as well. Each execution logs its own start, finish, and cut and may write the same handoff filename.

   The POST handler is outside the permitted review scope, so HTTP reachability cannot be confirmed here. The runner itself is unsafe if concurrent `POST /tasks` requests invoke it this way. Separate `runTasks` calls also have separate `carry` variables, so even distinct concurrent tasks do not form one ordered handoff chain.

4. **Exceptions from `onHandle` bypass session cleanup and leave the SDK query unclosed.**  
   File: [session.ts:234](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:234>)

   Two exact paths exist:

   - The query is created, then `onHandle(handle)` runs before the `try` block. If that callback throws, `run.close()` is never called and no finish or cut is logged.
   - During normal cleanup, `onHandle(null)` runs before `run.close()`. If it throws, the remainder of `finally` is skipped, the query remains unclosed, and `runSession` rejects instead of returning its result.

   In both cases Conductor withdraws no reliable handle and performs no SDK cleanup. Any child or query resources are left to SDK or process teardown.

5. **A persisted handoff is not recoverable after a daemon restart.**  
   Files: [finish-task.ts:66](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/finish-task.ts:66>), [main.ts:46](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/main.ts:46>)

   Sequence: task A writes its handoff successfully. The process exits or crashes before task B starts. A later `runTasks` invocation initializes `carry` to `null`; none of these files reads the saved handoff back from disk. Task B therefore starts without A’s handoff even though the note exists. A crash after the write but before `onFinish` additionally leaves the note with no matching finish event.

## Medium

6. **The delayed interrupt has no failure or completion backstop.**  
   File: [session.ts:111](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:111>)

   Sequence: `finish_task` sets the finish state and schedules `interrupt()` for 250 ms later. The interrupt rejects, and its error is swallowed. If the SDK does not independently emit a result afterward, the `for await` remains pending because streaming input is still open. `finally` never runs, the handle is never withdrawn, no finish or cut is logged, and the task loop never advances.

7. **Messages can cross the finish boundary or be silently dropped during the 250 ms window.**  
   File: [session.ts:118](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/session.ts:118>)

   Sequence: Claude calls `finish_task`; before the timer interrupts the query, a door calls `SessionHandle.send`. `send` accepts the message because `inputClosed` remains false until `finally`. The input generator may deliver that message into the finishing session, or cleanup may discard it from `queued`. The caller receives no indication which occurred.

8. **`follow_up_tasks` are not added to the task list by the default loop.**  
   Files: [finish-task.ts:53](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/engine/finish-task.ts:53>), [main.ts:97](<C:/Users/KaneSnyder(nexwave)/repos/conductor/src/main.ts:97>)

   Sequence: the initial array contains only task A. A finishes with follow-up B. `runTasks` copies B into `TaskRun.followUps`, invokes the optional callback, and reaches the end of the array. With default options, B is never appended or executed. The follow-up survives inside the handoff text and return value, but not as an in-memory queued task.

## File verdict

- `src/engine/session.ts`: not clean.
- `src/engine/finish-task.ts`: not clean.
- `src/main.ts`: not clean.
- `src/engine/cut.ts`: clean for this dimension. Within one uninterrupted `runTasks` call, it renders exactly the supplied in-memory handoff once and does not independently duplicate or discard it.