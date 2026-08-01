// The one door frame. HTTP plus WebSocket on 127.0.0.1 and nothing else (D6), because every face
// Conductor grows is a client of this and no capability may live in only one face.
//
// Two rules from S5 are load-bearing here. The bind names a single address, so the listener exists
// on loopback or not at all. And a bind failure is fatal and loud: the daemon exits rather than
// retrying on a wider address, since a door that quietly opens on 0.0.0.0 is the failure nobody
// notices until it matters.
//
// A third rule arrived with Sol's pass 1, and it is the important one: loopback is not a trust
// boundary. Any page a browser on this machine loads can reach 127.0.0.1, and the Host header a
// browser sends is 127.0.0.1 too, so the old check waved it straight through. Sol's chain was a
// loopback-reachable page queueing an autonomous task with an unrestricted cwd, starting it, and
// then approving its own rail stops. Three things close it, and all three are needed:
//
//   1. A per-daemon bearer token in an Authorization header. A browser cannot set headers on a
//      WebSocket at all, so the token is not merely a secret a page does not have; it is a channel
//      a page cannot use.
//   2. An Origin header must be absent. Every browser sends one on a cross-origin request; no CLI
//      does. Present means browser-shaped, which means refused.
//   3. Bodies must arrive as application/json, which a cross-origin simple request cannot send
//      without a preflight the daemon will fail.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, usableAccounts, type Config } from '../config.ts';
import { applyUndo, checkpointRefusal, describePlan, findCheckpoint, planFingerprint, previewUndo, type UndoPlan } from '../engine/checkpoint.ts';
import { Gauge } from '../engine/gauge.ts';
import type { Carry } from '../engine/cut.ts';
import { trustRefusal, type ApprovalOutcome, type ApprovalRequest, type SessionHandle, type Task, type Trust } from '../engine/session.ts';
import { runTasks, VERSION, type TaskRun } from '../main.ts';
import { logEvent } from '../state/logbook.ts';
import { mintDaemonToken, tokenMatches } from '../state/token.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Loopback only. The Tailscale address is M5 and gets its own listener, never a widened bind. */
export const BIND_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7717;

export function serverPort(): number {
  const raw = process.env['CONDUCTOR_PORT']?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

export function serverBaseUrl(): string {
  return `http://${BIND_HOST}:${serverPort()}`;
}

/** A task as the doors see it: the engine's Task plus where it got to. */
export interface QueuedTask extends Task {
  status: 'pending' | 'running' | 'done' | 'blocked' | 'error' | 'aborted';
  outcome: string | null;
  handoffPath: string | null;
  addedAt: string;
}

export interface DaemonHandle {
  port: number;
  close(): Promise<void>;
}

export interface DaemonOptions {
  /** Called when a door asks the daemon to stop, so the owner logs and exits on its own terms. */
  onStop?: () => void;
}

interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  askedAt: string;
  /**
   * The one door this question was put to. Sol's pass 1 finding 1: any socket could settle any
   * approval, so a second client could answer yes to a question a human was still reading. An
   * approval is now addressed, and only its addressee may answer it.
   */
  addressee: WebSocket;
  settle: (approved: boolean, door: string | null, via: 'door' | 'timeout') => void;
}

// A door that has gone quiet must not hold a session open forever. Long enough for a human to
// come back to the terminal, short enough that an abandoned run ends by itself.
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
// What a late-joining door gets replayed. Small on purpose: the logbook is the real history.
const RECENT_LIMIT = 50;
// How long a previewed undo plan stays confirmable. Long enough to read a file list, short enough
// that a plan cannot be confirmed against a working tree that has moved on since.
const UNDO_PLAN_TTL_MS = 5 * 60 * 1000;

/** A previewed plan, held so the confirming call applies that list and not a freshly guessed one. */
interface StoredUndoPlan {
  plan: UndoPlan;
  hash: string;
  createdAt: number;
}

class Daemon {
  readonly config: Config;
  readonly token: string;
  private readonly tasks: QueuedTask[] = [];
  private readonly gauges = new Map<string, Gauge>();
  /** Insertion-ordered, so the most recently attached door is the one questions are put to. */
  private readonly sockets = new Map<WebSocket, string>();
  private readonly pending = new Map<string, PendingApproval>();
  /** Ids already answered. An approval is single-use; a replayed id is refused, not re-run. */
  private readonly spentApprovals = new Set<string>();
  private readonly recent: unknown[] = [];
  /** Previewed undo plans, by plan id. Single use, and they expire. */
  private readonly undoPlans = new Map<string, StoredUndoPlan>();
  private running = false;
  private currentTaskId: string | null = null;
  private handle: SessionHandle | null = null;
  private nextId = 1;
  private nextDoorId = 1;
  /** What the last run ended holding, so a second `conductor run` is not a memory wipe. */
  private carry: Carry | null = null;
  private readonly startedAt = Date.now();

  constructor(config: Config, token: string) {
    this.config = config;
    this.token = token;
    for (const account of usableAccounts(config)) {
      this.gauges.set(account.name, new Gauge(config, account.name, account.configDir));
    }
  }

  // --- doors ---------------------------------------------------------------

  attach(socket: WebSocket): void {
    const name = `door${this.nextDoorId++}`;
    this.sockets.set(socket, name);
    this.send(socket, { type: 'hello', door: name, status: this.status() });
    for (const item of this.recent) this.sendRaw(socket, item);
    // A door arriving mid-stop should see the question, but only the door it was put to may answer.
    for (const p of this.pending.values()) {
      this.send(socket, {
        type: 'approval_request',
        id: p.id,
        askedAt: p.askedAt,
        yours: p.addressee === socket,
        ...p.request,
      });
    }
  }

  detach(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  /** Whatever a door sends. Unknown shapes are answered, never obeyed. */
  onDoorMessage(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(socket, { type: 'error', error: 'not JSON' });
      return;
    }
    const message = asRecord(parsed);

    if (message['type'] === 'approval_response') {
      const id = String(message['id'] ?? '');
      const approved = message['approved'] === true;
      const pending = this.pending.get(id);
      if (!pending) {
        const spent = this.spentApprovals.has(id);
        this.send(socket, {
          type: 'error',
          error: spent ? `approval "${id}" was already answered; approvals are single use` : `no approval pending with id "${id}"`,
        });
        return;
      }
      if (pending.addressee !== socket) {
        this.send(socket, { type: 'error', error: `approval "${id}" was put to another door, so this door cannot answer it` });
        return;
      }
      pending.settle(approved, this.sockets.get(socket) ?? 'websocket', 'door');
      return;
    }

    if (message['type'] === 'message') {
      const text = typeof message['text'] === 'string' ? message['text'] : '';
      if (!this.handle || !text.trim()) {
        this.send(socket, { type: 'error', error: 'no session is running, or the message was empty' });
        return;
      }
      // The session says whether it took the message. Sol's pass 2 finding 7: during the 250 ms
      // between finish_task and the cut, a message was accepted and then silently dropped or
      // delivered, with the caller told nothing either way.
      if (!this.handle.send(text)) {
        this.send(socket, { type: 'error', error: 'the session is finishing, so the message was not delivered' });
        return;
      }
      this.broadcast({ type: 'door_message', taskId: this.handle.taskId, text });
      return;
    }

    this.send(socket, { type: 'error', error: `unknown message type "${String(message['type'])}"` });
  }

  /** The Approver the engine calls. With no door attached the answer is no, and it is immediate. */
  approve = (request: ApprovalRequest): Promise<ApprovalOutcome> => {
    // The most recently attached door is the one a human is most likely sitting at, so it is the
    // one the question goes to. Other doors see it and cannot answer it.
    const addressee = [...this.sockets.keys()].at(-1);
    if (!addressee) return Promise.resolve({ approved: false, door: null, via: 'no_door' });
    const doorName = this.sockets.get(addressee) ?? 'websocket';

    // Random, not sequential: an id nobody can guess is one nobody can race the human to answer.
    const id = `a${randomBytes(9).toString('hex')}`;
    return new Promise<ApprovalOutcome>((resolve) => {
      let done = false;
      const settle = (approved: boolean, door: string | null, via: 'door' | 'timeout') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.spentApprovals.add(id);
        this.broadcast({ type: 'approval_settled', id, approved, door });
        resolve({ approved, door, via });
      };
      // Nobody came back to answer, so the answer is the safe no and no door gets the credit.
      const timer = setTimeout(() => settle(false, null, 'timeout'), APPROVAL_TIMEOUT_MS);
      const askedAt = new Date().toISOString();
      this.pending.set(id, { id, request, askedAt, addressee, settle });
      // Visible to every door, answerable by one. `door` names who was asked, so a second watcher
      // can see the question is not theirs rather than silently failing to answer it.
      for (const socket of this.sockets.keys()) {
        this.sendRaw(socket, {
          ts: askedAt,
          type: 'approval_request',
          id,
          askedAt,
          door: doorName,
          yours: socket === addressee,
          ...request,
        });
      }
    });
  };

  // --- state readers -------------------------------------------------------

  status(): Record<string, unknown> {
    return {
      version: VERSION,
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      stateRoot: this.config.stateRoot,
      running: this.running,
      currentTask: this.currentTaskId,
      sessionAttached: this.handle !== null,
      doors: this.sockets.size,
      pendingApprovals: [...this.pending.values()].map((p) => ({ id: p.id, askedAt: p.askedAt, ...p.request })),
      accounts: this.config.accounts.map((a) => ({ name: a.name, usable: this.gauges.has(a.name), placeholder: a.placeholder })),
      tasks: this.tasks,
    };
  }

  gauge(): Record<string, unknown> {
    const accounts = [...this.gauges.values()].map((gauge) => {
      const snap = gauge.snapshot();
      return {
        account: snap.account,
        line: snap.line,
        contextPercent: snap.contextPercent,
        contextPeakPercent: snap.contextPeakPercent,
        fileAgeSeconds: snap.fileAgeMs === null ? null : Math.round(snap.fileAgeMs / 1000),
        liveProbeFailed: snap.liveProbeFailed,
        pressure: snap.pressure,
        buckets: [
          { id: 'session_5h', percent: snap.fiveHour.percent, source: snap.fiveHour.source, confidence: snap.fiveHour.confidence, resetsAt: snap.fiveHour.resetsAt },
          { id: 'weekly_all', percent: snap.weekly.percent, source: snap.weekly.source, confidence: snap.weekly.confidence, resetsAt: snap.weekly.resetsAt },
          { id: 'self_metered_5h', percent: null, tokens: snap.selfMeteredFiveHour, source: 'self_metered', confidence: 'fresh', resetsAt: null },
          { id: 'self_metered_week', percent: null, tokens: snap.selfMeteredTokens, byModel: snap.selfMeteredByModel, source: 'self_metered', confidence: 'fresh', resetsAt: null },
        ],
      };
    });
    return { accounts, unusable: this.config.accounts.filter((a) => !this.gauges.has(a.name)).map((a) => a.name) };
  }

  /** Last N logbook lines, parsed where they parse and passed through raw where they do not. */
  events(tail: number): unknown[] {
    let text: string;
    try {
      text = readFileSync(this.config.eventsPath, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    return lines.slice(-Math.max(1, tail)).map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { raw: line };
      }
    });
  }

  // --- task list -----------------------------------------------------------

  addTask(body: Record<string, unknown>): { task?: QueuedTask; error?: string } {
    const prompt = typeof body['prompt'] === 'string' ? body['prompt'].trim() : '';
    const cwd = typeof body['cwd'] === 'string' ? body['cwd'].trim() : '';
    if (!prompt) return { error: 'prompt is required' };
    if (!cwd) return { error: 'cwd is required' };

    // Gate one of two for reversibility. The task loop checkpoints again before it starts anything,
    // so a task that got into the list some other way still cannot run unreversibly; this one exists
    // so the human hears about it when queueing rather than when the run stalls.
    const notReversible = checkpointRefusal(cwd);
    if (notReversible) return { error: notReversible };

    const trustRaw = typeof body['trust'] === 'string' ? body['trust'] : 'attended';
    if (trustRaw !== 'attended' && trustRaw !== 'autonomous') return { error: 'trust must be attended or autonomous' };
    // Gate one of two. The task loop refuses the same thing again at run time, so a task that got
    // into the list some other way still cannot start.
    const refusal = trustRefusal(trustRaw as Trust);
    if (refusal) return { error: refusal };

    const account = typeof body['account'] === 'string' && body['account'].trim() ? body['account'].trim() : this.defaultAccount();
    if (!account) return { error: `no usable account; edit "${this.config.configFilePath}"` };

    const model = typeof body['model'] === 'string' && body['model'].trim() ? body['model'].trim() : undefined;
    const task: QueuedTask = {
      id: `t${this.nextId++}`,
      title: typeof body['title'] === 'string' && body['title'].trim() ? body['title'].trim() : titleFrom(prompt),
      prompt,
      cwd,
      account,
      trust: trustRaw as Trust,
      ...(model ? { model } : {}),
      status: 'pending',
      outcome: null,
      handoffPath: null,
      addedAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    this.broadcast({ type: 'task_added', task });
    return { task };
  }

  /** Starts working the pending list. Returns immediately; the WebSocket carries the run. */
  startRun(): { started: boolean; count: number; error?: string } {
    if (this.running) return { started: false, count: 0, error: 'a run is already in progress' };
    const pending = this.tasks.filter((t) => t.status === 'pending');
    if (pending.length === 0) return { started: false, count: 0, error: 'no pending tasks' };

    // Flipped and the list claimed before anything awaits, so two POSTs arriving back to back
    // cannot both find `running` false and both take the same tasks.
    this.running = true;
    for (const task of pending) task.status = 'running';
    this.broadcast({ type: 'run_started', tasks: pending.map((t) => t.id) });

    void runTasks(pending, {
      config: this.config,
      gauges: this.gauges,
      approve: this.approve,
      carry: this.carry,
      onCarry: (carry) => {
        this.carry = carry;
      },
      onMessage: (taskId, message) => this.onSessionMessage(taskId, message),
      onTaskStart: (task) => {
        this.currentTaskId = task.id;
        this.patch(task.id, { status: 'running' });
        this.broadcast({ type: 'task_started', taskId: task.id, title: task.title, account: task.account, trust: task.trust });
      },
      onTaskFinish: (run: TaskRun) => {
        this.currentTaskId = null;
        this.patch(run.taskId, {
          status: statusFor(run),
          outcome: run.outcome,
          handoffPath: run.handoffPath,
        });
        this.broadcast({ type: 'task_finished', taskId: run.taskId, outcome: run.outcome, handoffPath: run.handoffPath, followUps: run.followUps, errorText: run.errorText });
      },
      onHandle: (handle) => {
        this.handle = handle;
      },
    })
      .catch((err: unknown) => {
        this.broadcast({ type: 'run_error', error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        this.running = false;
        this.currentTaskId = null;
        this.handle = null;
        // Anything still marked running never reached onTaskFinish, so it is aborted, not pending.
        for (const task of this.tasks) if (task.status === 'running') task.status = 'aborted';
        this.broadcast({ type: 'run_done', status: this.tasks.map((t) => ({ id: t.id, status: t.status, outcome: t.outcome })) });
      });

    return { started: true, count: pending.length };
  }

  /**
   * Undo, the other half of the checkpoint. Two calls by design: the first returns the preview and
   * changes nothing, the second carries `confirm: true` and does the work. Undo is destructive in
   * its own right, so a single call that both describes and performs would be the wrong shape.
   *
   * Sol's finding 3 was that the two-call shape did not actually enforce any of that: the confirming
   * call computed its own plan and applied that one, and a first-and-only call carrying
   * `confirm: true` was accepted, so what executed had never been shown to anybody. Consent is to a
   * specific list of paths, so the preview now hands back a `planId` and a `planHash`, confirming
   * must present both, and the daemon applies the stored plan. No prior preview, a hash that does
   * not match, or a plan that has expired are all refusals.
   */
  undo(body: Record<string, unknown>): { status: number; payload: Record<string, unknown> } {
    if (this.running) {
      return { status: 409, payload: { error: 'a run is in progress; stop it before undoing, or the undo and the task will fight over the same files' } };
    }
    return body['confirm'] === true ? this.applyPreviewedUndo(body) : this.previewUndoPlan(body);
  }

  private previewUndoPlan(body: Record<string, unknown>): { status: number; payload: Record<string, unknown> } {
    const taskId = typeof body['taskId'] === 'string' && body['taskId'].trim() ? body['taskId'].trim() : undefined;
    const record = findCheckpoint(this.config, taskId);
    if (!record) {
      return { status: 404, payload: { error: taskId ? `no checkpoint was recorded for task "${taskId}"` : 'no checkpoint has been recorded yet' } };
    }

    const preview = previewUndo(this.config, record, { overrideChangedAfterTask: body['overrideChangedAfterTask'] === true });
    if (!preview.ok) return { status: 409, payload: { error: preview.reason, taskId: record.taskId, ref: record.ref } };

    const plan = preview.plan;
    const hash = planFingerprint(plan);
    const planId = randomBytes(12).toString('hex');
    this.pruneUndoPlans();
    this.undoPlans.set(planId, { plan, hash, createdAt: Date.now() });

    return {
      status: 200,
      payload: {
        ...undoBase(plan),
        planId,
        planHash: hash,
        expiresInSeconds: Math.round(UNDO_PLAN_TTL_MS / 1000),
        applied: false,
        note:
          plan.changes.length === 0
            ? 'nothing would be changed.'
            : 'nothing was changed. Send "confirm": true with this planId and planHash to apply exactly this list.',
      },
    };
  }

  private applyPreviewedUndo(body: Record<string, unknown>): { status: number; payload: Record<string, unknown> } {
    this.pruneUndoPlans();
    const planId = typeof body['planId'] === 'string' ? body['planId'].trim() : '';
    const planHash = typeof body['planHash'] === 'string' ? body['planHash'].trim() : '';
    if (!planId || !planHash) {
      return {
        status: 400,
        payload: { error: 'confirming an undo needs the planId and planHash from a preview. Ask for the preview first and confirm the list it returns.' },
      };
    }
    const stored = this.undoPlans.get(planId);
    if (!stored) {
      return { status: 409, payload: { error: 'that undo plan is unknown or has expired. Ask for a fresh preview and confirm that one.' } };
    }
    if (stored.hash !== planHash) {
      return { status: 409, payload: { error: 'the planHash does not match the stored plan, so the list being confirmed is not the list that was previewed.' } };
    }
    // Single use. A confirmed plan is spent whether it applied cleanly or not, so nothing can be
    // replayed against a working tree it no longer describes.
    this.undoPlans.delete(planId);

    const plan = stored.plan;
    if (plan.changes.length === 0) return { status: 200, payload: { ...undoBase(plan), applied: false, note: 'nothing to change.' } };

    const outcome = applyUndo(this.config, plan);
    this.broadcast({ type: 'undo', taskId: plan.record.taskId, ref: plan.record.ref, restored: outcome.restored, deleted: outcome.deleted });
    return { status: 200, payload: { ...undoBase(plan), applied: true, restored: outcome.restored, deleted: outcome.deleted, failures: outcome.failures } };
  }

  private pruneUndoPlans(): void {
    const cutoff = Date.now() - UNDO_PLAN_TTL_MS;
    for (const [id, stored] of this.undoPlans) if (stored.createdAt < cutoff) this.undoPlans.delete(id);
  }

  private defaultAccount(): string | null {
    const first = [...this.gauges.keys()][0];
    return first ?? null;
  }

  private patch(taskId: string, fields: Partial<QueuedTask>): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task) Object.assign(task, fields);
  }

  private onSessionMessage(taskId: string, message: SDKMessage): void {
    this.broadcast({ type: 'session_message', taskId, message });
  }

  // --- plumbing ------------------------------------------------------------

  private broadcast(payload: Record<string, unknown>): void {
    const item = { ts: new Date().toISOString(), ...payload };
    this.recent.push(item);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    for (const socket of this.sockets.keys()) this.sendRaw(socket, item);
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    this.sendRaw(socket, { ts: new Date().toISOString(), ...payload });
  }

  private sendRaw(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // A door that cannot be written to is a door that has gone; never let it break the run.
    }
  }
}

/** The parts of an undo response that read the same whether it was previewed or applied. */
function undoBase(plan: UndoPlan): Record<string, unknown> {
  return {
    taskId: plan.record.taskId,
    ref: plan.record.ref,
    commit: plan.record.commit,
    cwd: plan.record.cwd,
    repoRoot: plan.record.repoRoot,
    changes: plan.changes,
    held: plan.held,
    provenance: plan.provenance,
    override: plan.override,
    caseCollisions: plan.caseCollisions,
    ignoredSkipped: plan.ignoredSkipped.length,
    outsideTaskFolder: plan.outsideCount,
    preview: describePlan(plan),
  };
}

/** A task that never handed off is aborted, which is neither done nor an error the model raised. */
function statusFor(run: TaskRun): QueuedTask['status'] {
  if (run.outcome === 'aborted') return 'aborted';
  if (run.outcome === 'blocked') return 'blocked';
  return run.errorText ? 'error' : 'done';
}

/** Boots the listener. Rejects, loudly, if the loopback bind fails. */
export async function startDaemon(config: Config = loadConfig(), options: DaemonOptions = {}): Promise<DaemonHandle> {
  // Bind first, mint second. Sol's re-check finding 8: minting before the bind meant a second
  // daemon started against the same state root overwrote the live daemon's token file and then
  // failed to bind, leaving the running daemon holding a secret no door could read any more. The
  // listener is the thing that can fail, so nothing that a live daemon depends on is touched until
  // it has succeeded. Handlers below close over `daemon`, which is assigned before listen resolves
  // and therefore before any request can arrive.
  let daemon!: Daemon;
  const port = serverPort();
  const server = createServer((req, res) => void handle(daemon, options, req, res));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', serverBaseUrl());
    // Every gate, on the handshake, before a socket exists. A refused upgrade is destroyed rather
    // than answered, because a would-be attacker learns nothing from silence.
    if (url.pathname !== '/ws' || !localHost(req) || browserShaped(req) || !authorized(daemon.token, req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      daemon.attach(ws);
      ws.on('message', (data) => daemon.onDoorMessage(ws, String(data)));
      ws.on('close', () => daemon.detach(ws));
      ws.on('error', () => daemon.detach(ws));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      // No fallback port, no wider address. Say what happened and stop.
      process.stderr.write(
        `conductor: could not bind ${BIND_HOST}:${port} (${err.code ?? err.message}). ` +
          `Another daemon may already be running. Conductor never widens the bind address, so it is stopping.\n`,
      );
      logEvent(config, { kind: 'daemon_stop', pid: process.pid, reason: `bind failed on ${BIND_HOST}:${port}: ${err.code ?? err.message}` });
      reject(err);
    });
    // One address, named explicitly. Omitting host would listen on every interface.
    server.listen({ host: BIND_HOST, port }, resolve);
  });

  // The bind held, so this process is the daemon and may take the token file. Fresh every start, so
  // a token captured from a previous daemon is dead the moment this one boots. This runs in the
  // microtask that follows the listen callback, before Node can dispatch a connection event, so no
  // handler can see `daemon` unassigned.
  daemon = new Daemon(config, mintDaemonToken(config));

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.close();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function handle(daemon: Daemon, options: DaemonOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!localHost(req)) return json(res, 403, { error: 'this door answers loopback only' });
  // A browser sends Origin on anything cross-origin. A CLI never sends it at all. Absent or refused.
  if (browserShaped(req)) return json(res, 403, { error: 'this door does not answer browser-shaped requests' });
  // The token gates reads as well as writes: /status carries prompts, folder paths and the state
  // root, and /events is the whole logbook. Sol's finding 5 was about the WebSocket, but the same
  // content leaves through these.
  if (!authorized(daemon.token, req)) {
    return json(res, 401, { error: `a daemon token is required; doors read it from the state root` });
  }

  const url = new URL(req.url ?? '/', serverBaseUrl());
  const route = `${req.method ?? 'GET'} ${url.pathname}`;

  try {
    if (route === 'GET /status') return json(res, 200, daemon.status());
    if (route === 'GET /gauge') return json(res, 200, daemon.gauge());
    if (route === 'GET /events') {
      const tail = Number(url.searchParams.get('tail') ?? '20');
      return json(res, 200, { events: daemon.events(Number.isFinite(tail) ? tail : 20) });
    }
    if (route === 'POST /tasks') {
      const body = asRecord(await readJson(req));
      const { task, error } = daemon.addTask(body);
      return error ? json(res, 400, { error }) : json(res, 201, { task });
    }
    if (route === 'POST /run') {
      const result = daemon.startRun();
      return json(res, result.started ? 202 : 409, result);
    }
    if (route === 'POST /undo') {
      const body = asRecord(await readJson(req));
      const { status, payload } = daemon.undo(body);
      return json(res, status, payload);
    }
    if (route === 'POST /stop') {
      // Wrinkle 4: Windows cannot deliver SIGINT to a child, so a programmatic stop needs a door.
      if (!options.onStop) return json(res, 501, { error: 'this daemon has no stop handler wired' });
      json(res, 202, { stopping: true });
      setTimeout(() => options.onStop?.(), 50); // let the response flush before the listener closes
      return;
    }
    return json(res, 404, { error: `no route for ${route}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A body Conductor refused to read is the caller's mistake, not the daemon's.
    return json(res, message.startsWith('conductor:') ? 400 : 500, { error: message });
  }
}

/**
 * The bind already limits who can reach this, but a browser on this machine can be pointed at a
 * hostname that resolves to loopback, so the Host header is checked too.
 */
function localHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  return host === BIND_HOST || host === 'localhost' || host === '[::1]' || host === '';
}

/**
 * Does this request carry the marks of a browser? One header answers it. Browsers attach Origin to
 * every cross-origin fetch and to every WebSocket handshake, and no ordinary command-line client
 * sends one. Absent or rejected, with no allowlist: there is no origin Conductor wants to serve.
 */
function browserShaped(req: IncomingMessage): boolean {
  return typeof req.headers.origin === 'string' && req.headers.origin.length > 0;
}

/** `Authorization: Bearer <token>`. Header only; a browser cannot set one on a WebSocket. */
function authorized(token: string, req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] !== undefined && tokenMatches(token, match[1]);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  // A cross-origin form or text/plain post is a "simple request" that needs no preflight. Requiring
  // application/json means the browser must preflight, and the preflight fails on the token.
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== 'application/json') {
    throw new Error('conductor: request bodies must be sent as content-type application/json');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error('conductor: request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('conductor: request body was not valid JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A short human title from the prompt, so the handoff file has a name worth reading. */
function titleFrom(prompt: string): string {
  const firstLine = prompt.split('\n')[0]?.trim() ?? prompt;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
