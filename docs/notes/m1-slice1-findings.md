# M1 slice 1: scaffold and state layer

Built 2026-08-01 on branch `feat/m1-engine`. Scope was the scaffold plus the three state organs and
nothing else. No session runner, no gauge, no server, no CLI.

## What landed

| File | What it does |
|---|---|
| `package.json` | ESM, Node >= 24, no runtime dependencies. Scripts: `start`, `typecheck`. |
| `tsconfig.json` | Editor and `tsc --noEmit` only. `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`. |
| `src/main.ts` | Boots config and state, logs one `daemon_start`, prints a summary, exits 0. |
| `src/config.ts` | State root, first-run seeding, account registry from `config.json`. |
| `src/state/logbook.ts` | `events.jsonl` append-only writer with a typed event union. |
| `src/state/handoffs.ts` | One markdown note per finished task, write, read back, list. |
| `src/state/playbook.ts` | Seed page plus a read for injection. Enforces nothing. |

The state tree created on first run:

```
<CONDUCTOR_HOME or %USERPROFILE%\.conductor>\
  config.json      account registry, seeded with placeholders
  playbook.md      seeded starter page
  events.jsonl     empty
  handoffs\        empty
```

## Decisions made

1. **`@types/node` added as a second dev dependency.** The brief said typescript only. Without the
   node types `tsc --noEmit` cannot resolve `node:fs` or `process` and fails on every file, so a
   clean typecheck was impossible. It is types only, contributes nothing at runtime, and the
   install is 3 packages total (typescript, @types/node, undici-types). Flagging it rather than
   burying it.
2. **`erasableSyntaxOnly` is on.** Node strips types, it does not compile them, so enums, parameter
   properties, and namespaces would all pass `tsc` and then fail at runtime. The flag makes the
   type checker refuse them up front. `allowImportingTsExtensions` is the matching half: relative
   imports keep their `.ts` extension because Node resolves the real file.
3. **Seeding uses the `wx` open flag, not an exists check plus a write.** An exists check has a
   race that ends in a truncated playbook. `wx` fails instead of truncating, and `EEXIST` is
   swallowed as the normal outcome.
4. **`config.json` carries the account registry and the seed entries are obvious placeholders**
   (`work` -> `C:\Users\you\.claude-work`). Real folder names never enter the repo. An account is
   only counted as usable when the user has changed it away from the placeholder AND the directory
   exists, so a fresh clone can never silently point a session at the wrong login. No credential is
   read, stored, or referenced anywhere in this slice.
5. **A hand-edited `config.json` with a syntax error does not take the daemon down.** It logs to
   stderr and runs with zero accounts.
6. **The logbook event union carries `percent: number | null` on `gauge_reading`.** S2 and S4 both
   say an absent reading must never be recorded as zero, so the type makes the honest value
   expressible from day one. `source` and `confidence` are the S2 vocabulary
   (`official_file`, `self_metered`, `anchor_plus_delta`, `absent`; `fresh`, `stale`, `estimated`,
   `unknown`).
7. **Handoff filenames are `YYYYMMDDTHHMMSSZ-slug.md`.** The ISO stamp is flattened because colons
   are illegal in Windows filenames, and the prefix makes plain filename sort equal time sort.
8. **`daemon_stop` is defined but main.ts does not emit it.** It belongs to the real shutdown path,
   which arrives with the session runner. It was exercised by hand instead (below).
9. **The playbook seed carries the S4 hard rail verbatim in plain language**: never cross from plan
   usage into paid extra-usage credits without a human tap. Fresh cut is stated as the default cut
   mode, per the S3 evidence. The page is about 2.2 KB, comfortably under one page.

## Verification

### Type stripping works on this Node

```
$ node --version
v24.11.1
$ node scratch/strip.ts
ok 1
```

### `tsc --noEmit` is clean

```
$ npm install --no-fund --no-audit
added 3 packages in 7s
$ npx tsc --noEmit
tsc exit=0
```

### Run 1 against a scratch state root

```
$ CONDUCTOR_HOME="...\scratchpad\state1" node src/main.ts
conductor 0.1.0
  state root: "...\scratchpad\state1"
  playbook:   2174 chars
  accounts:   0 usable of 2 configured

No usable accounts yet. Edit "...\scratchpad\state1\config.json" and point each entry at a real
Claude Code config directory.
exit=0
```

Tree created:

```
config.json
events.jsonl
handoffs
playbook.md
```

`events.jsonl` after run 1, one line:

```
{"ts":"2026-08-01T07:43:10.445Z","kind":"daemon_start","pid":5564,"stateRoot":"...\\state1","version":"0.1.0","accounts":0}
```

`config.json` as seeded:

```json
{
  "_comment": "Edit \"accounts\": map a short label to the Claude Code config directory for that login.\nThe seeded entries are placeholders and are ignored until you change them.",
  "accounts": {
    "work": "C:\\Users\\you\\.claude-work",
    "personal": "C:\\Users\\you\\.claude-personal"
  }
}
```

### Run 2 proves idempotent seeding

Between the runs the playbook was replaced with a three-line hand edit and a real third account was
added to `config.json`.

```
$ CONDUCTOR_HOME="...\scratchpad\state1" node src/main.ts
conductor 0.1.0
  state root: "...\scratchpad\state1"
  playbook:   71 chars
  accounts:   1 usable of 3 configured
exit=0

$ cat state1/playbook.md
# Playbook

EDITED BY HAND. This line proves run two does not clobber.
```

The hand edit survived, the seed did not come back, the third account was picked up as the only
usable one, and `events.jsonl` grew to two lines rather than being rewritten:

```
{"ts":"2026-08-01T07:43:10.445Z","kind":"daemon_start","pid":5564,...,"accounts":0}
{"ts":"2026-08-01T07:43:22.057Z","kind":"daemon_start","pid":32924,...,"accounts":1}
```

### Handoffs and the rest of the event kinds

`main.ts` does not touch handoffs yet, so a throwaway script in the scratchpad exercised them.

```
$ node scratchpad/exercise.mts
wrote: ...\state1\handoffs\20260801T074353Z-wire-the-state-layer-config-logbook-handoffs.md
--- file on disk ---
# Wire the state layer: config, logbook, handoffs

Finished 2026-08-01T07:43:53.347Z

## What was done

Built config.ts, logbook.ts, handoffs.ts and a stub main.ts.

## What matters

Node 24 strips types, so imports keep .ts extensions and nothing may use enums.

## Open threads

- The account registry is seeded with placeholders only.
- No gauge yet.

## Follow-up tasks

- Build the session runner.
- Build the gauge.

--- round trip ---
{
  "task": "Wire the state layer: config, logbook, handoffs",
  "whatWasDone": "Built config.ts, logbook.ts, handoffs.ts and a stub main.ts.",
  "whatMatters": "Node 24 strips types, so imports keep .ts extensions and nothing may use enums.",
  "openThreads": [
    "The account registry is seeded with placeholders only.",
    "No gauge yet."
  ],
  "followUps": [
    "Build the session runner.",
    "Build the gauge."
  ]
}
listed: 1
```

The round trip is lossless on all five fields.

### The logbook does not throw into its caller

Same script, last step: the events path was pointed at a directory so the append had to fail.

```
conductor: logbook write failed, event dropped: Error: EISDIR: illegal operation on a directory, write
{"ts":"2026-08-01T07:43:53.352Z","kind":"daemon_stop","pid":28336,"reason":"forced failure test"}
survived a failed logbook write
exit=0
```

The dropped line is echoed to stderr so nothing is lost silently, and execution continued.

Tail of `events.jsonl` after the run, showing three more kinds written correctly:

```
{"ts":"2026-08-01T07:43:53.351Z","kind":"task_start","taskId":"t1","account":"scratch","model":"opus","effort":"medium"}
{"ts":"2026-08-01T07:43:53.352Z","kind":"gauge_reading","account":"scratch","bucketId":"session","percent":null,"source":"absent","confidence":"unknown"}
{"ts":"2026-08-01T07:43:53.352Z","kind":"cut","taskId":"t1","mode":"fresh","reason":"task finished"}
```

## Surprises

- **The typecheck genuinely cannot run on typescript alone.** Node's own globals are not shipped
  with the compiler. This is the one place the brief and reality disagreed.
- **`erasableSyntaxOnly` matters more than it looks.** Without it a plain TypeScript `enum` type
  checks fine and then throws at runtime under type stripping. Anyone extending this slice should
  leave the flag on.
- **Node's short path form leaks into logged paths.** The scratch run recorded
  `C:\Users\KANESN~1\...` because `TMPDIR` is the 8.3 form. Harmless here, but worth knowing before
  anything compares two paths as strings.
- **`package-lock.json` is untracked and not in this commit.** It was not in the file list for this
  slice. It should probably be committed with the next one; flagging rather than deciding.
- **`PLAN.md` had uncommitted edits when the branch was cut.** They were left alone and are not in
  this commit.

## Not done, on purpose

Session runner, `finish_task`, the cut, the gauge, the HTTP and WebSocket server, and the CLI.
Those are the later slices of M1.
