# Sol review, M1 engine, pass 1: security

Raw output from Sol. Not edited, not filtered.

- Command: `codex exec -s read-only --skip-git-repo-check - < brief1.txt`
- Run from: repo root, branch `feat/m1-engine`
- Model: `gpt-5.6-sol`, reasoning effort `xhigh` (from ~/.codex/config.toml)
- Sandbox: read-only (override of the config default)
- Files in scope: src/server/http.ts, src/engine/session.ts, src/config.ts, src/cli.ts
- Dimension: security only
- Date: 2026-08-01

---

# SECURITY findings

## Critical

### 1. Any WebSocket client can impersonate the human approver

**File:** `src/server/http.ts:82-89, 107-126, 133-153, 334-345, 406-409`

The WebSocket handshake has no authentication and does not validate `Origin`. The `Host` check accepts a normal connection to `127.0.0.1`. Every newly connected socket receives pending approval IDs, and any socket may settle any request.

A malicious page with permitted loopback access, browser extension, or local process can approve every destructive action:

```js
const ws = new WebSocket("ws://127.0.0.1:7717/ws");

ws.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "approval_request") {
    ws.send(JSON.stringify({
      type: "approval_response",
      id: event.id,
      approved: true
    }));
  }
};
```

The first response wins. `pending.settle(true)` makes the PreToolUse hook return `allow`, so the destructive-action rail no longer represents a human tap.

The same unauthenticated socket can inject arbitrary user messages into the active Claude session through lines 119-126.

### 2. The state-changing HTTP endpoints are unauthenticated and CSRF-compatible

**File:** `src/server/http.ts:214-242, 374-395, 417-427`

`POST /tasks` and `POST /run` require no token, session, or origin validation. `readJson` accepts JSON carried as `text/plain`, allowing a simple cross-origin request without the normal JSON CORS preflight:

```js
await fetch("http://127.0.0.1:7717/tasks", {
  method: "POST",
  mode: "no-cors",
  headers: { "content-type": "text/plain" },
  body: JSON.stringify({
    prompt: "Follow these hostile instructions",
    cwd: "C:\\",
    trust: "autonomous"
  })
});

await fetch("http://127.0.0.1:7717/run", {
  method: "POST",
  mode: "no-cors"
});
```

This lets an untrusted loopback client choose an unrestricted `cwd`, select autonomous trust, inject the task prompt, and start execution. Combined with finding 1, the same client can approve any rail stops.

### 3. Interpreter wrappers bypass both destructive-action layers

**File:** `src/engine/session.ts:80-88, 176-185, 322-346, 357-387`

Both PreToolUse and `canUseTool` depend on the same command blacklist. Commands are only recognized when destructive words appear in a few exact syntactic positions. Paths embedded in a Bash command are also invisible to `PATH_FIELDS`.

These destructive commands are classified as safe:

```text
cmd.exe /d /c "del /q C:\Users\victim\important.txt"
node -e "require('node:fs').rmSync('C:\\Users\\victim\\important.txt')"
git -C C:\repo reset --hard HEAD~1
```

For an autonomous task:

1. PreToolUse gets `null` and returns `{}` at lines 180-181.
2. `canUseTool` gets the same `null`.
3. Line 325 returns `allow`.

The first two examples can delete files outside the task folder without any tap. This is new relative to PLAN wrinkle 2: it defeats Conductor’s classifiers in autonomous mode, independently of SDK default-mode auto-allows.

## High

### 4. Junctions and symlinks bypass the outside-cwd rail

**File:** `src/engine/session.ts:87-88, 358-364, 403-406`

`insideCwd` performs only lexical path comparison. It never resolves filesystem links.

Trigger:

1. Place `C:\repo\bridge` as a junction to `C:\Users\victim\Documents`.
2. Run an autonomous task rooted at `C:\repo`.
3. Use Write or Edit on `bridge\important.txt`.

The code classifies the path as inside `C:\repo`. The filesystem follows the junction and changes the external file without approval.

### 5. Unauthenticated WebSockets expose prompts, tool output, paths, and usage

**File:** `src/server/http.ts:82-89, 158-170, 300-310, 334-345`

On connection, every socket receives:

- `status()`, including `stateRoot`, complete queued tasks, prompts, cwd values, account labels, and pending approval inputs.
- The latest 50 raw broadcast events.
- Every subsequent raw `SDKMessage`.

Raw result messages contain token usage. Assistant and tool-result messages can contain file contents or credentials. An unauthenticated cross-origin WebSocket client can therefore collect and relay session content and usage data.

### 6. Every daemon environment secret is inherited by Claude and its tools

**File:** `src/engine/session.ts:157-164, 309-314`

`childEnv` copies all of `process.env` and removes only `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.

If the daemon starts with `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `AZURE_CLIENT_SECRET`, or another credential, an autonomous task can leak it into the repository with an unflagged command:

```text
node -e "require('node:fs').writeFileSync('leak.txt',process.env.GITHUB_TOKEN)"
```

It can instead print the value, after which the full tool result is broadcast through the unauthenticated WebSocket channel.

## Medium

### 7. Configuration permits state and credential roots inside the repository

**File:** `src/config.ts:44-63, 77-99`; `src/engine/session.ts:157-164, 309-314`

There are two concrete paths:

- Starting the daemon from the repository with `CONDUCTOR_HOME=.` places `config.json`, `playbook.md`, `events.jsonl`, and `handoffs/` directly in the repository. Subsequent usage and rail events are written there.
- Account directories are accepted as arbitrary strings. Pointing an account at the repository, or using `"."` with the repository as the task cwd, passes `existsSync` and is forwarded unchanged as `CLAUDE_CONFIG_DIR`. The credential-bearing Claude configuration can then be created or updated inside the repository.

Neither path is rejected despite the repo-public and no-credentials-in-repo invariants.

## Clean file

`src/cli.ts` is clean for this review dimension. It uses the insecure server channel, but the authentication and approval-spoofing defects are implemented in `src/server/http.ts`, not in the CLI client.