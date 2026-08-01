// The one door frame. HTTP plus WebSocket on 127.0.0.1 and nothing else (D6), because every face
// Conductor grows is a client of this and no capability may live in only one face.
//
// Two rules from S5 are load-bearing here. The bind names a single address, so the listener exists
// on loopback or not at all. And a bind failure is fatal and loud: the daemon exits rather than
// retrying on a wider address, since a door that quietly opens on 0.0.0.0 is the failure nobody
// notices until it matters.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, usableAccounts, type Config } from '../config.ts';
import { Gauge } from '../engine/gauge.ts';
import type { ApprovalOutcome, ApprovalRequest, SessionHandle, Task, Trust } from '../engine/session.ts';
import { runTasks, VERSION, type TaskRun } from '../main.ts';
import { logEvent } from '../state/logbook.ts';
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
  status: 'pending' | 'running' | 'done' | 'blocked' | 'error';
  outcome: string | null;
  handoffPath: string | null;
  addedAt: string;
}

export interface DaemonHandle {
  port: number;
  close(): Promise<void>;
}

interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  askedAt: string;
  settle: (approved: boolean) => void;
}

// A door that has gone quiet must not hold a session open forever. Long enough for a human to
// come back to the terminal, short enough that an abandoned run ends by itself.
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
// What a late-joining door gets replayed. Small on purpose: the logbook is the real history.
const RECENT_LIMIT = 50;

class Daemon {
  readonly config: Config;
  private readonly tasks: QueuedTask[] = [];
  private readonly gauges = new Map<string, Gauge>();
  private readonly sockets = new Set<WebSocket>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly recent: unknown[] = [];
  private running = false;
  private currentTaskId: string | null = null;
  private handle: SessionHandle | null = null;
  private nextId = 1;
  private nextApprovalId = 1;
  private readonly startedAt = Date.now();

  constructor(config: Config) {
    this.config = config;
    for (const account of usableAccounts(config)) {
      this.gauges.set(account.name, new Gauge(config, account.name, account.configDir));
    }
  }

  // --- doors ---------------------------------------------------------------

  attach(socket: WebSocket): void {
    this.sockets.add(socket);
    this.send(socket, { type: 'hello', status: this.status() });
    for (const item of this.recent) this.sendRaw(socket, item);
    // A door arriving mid-stop should see the question it is expected to answer.
    for (const p of this.pending.values()) {
      this.send(socket, { type: 'approval_request', id: p.id, askedAt: p.askedAt, ...p.request });
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
        this.send(socket, { type: 'error', error: `no approval pending with id "${id}"` });
        return;
      }
      pending.settle(approved);
      return;
    }

    if (message['type'] === 'message') {
      const text = typeof message['text'] === 'string' ? message['text'] : '';
      if (!this.handle || !text.trim()) {
        this.send(socket, { type: 'error', error: 'no session is running, or the message was empty' });
        return;
      }
      this.handle.send(text);
      this.broadcast({ type: 'door_message', taskId: this.handle.taskId, text });
      return;
    }

    this.send(socket, { type: 'error', error: `unknown message type "${String(message['type'])}"` });
  }

  /** The Approver the engine calls. With no door attached the answer is no, and it is immediate. */
  approve = (request: ApprovalRequest): Promise<ApprovalOutcome> => {
    if (this.sockets.size === 0) return Promise.resolve({ approved: false, door: null });

    const id = `a${this.nextApprovalId++}`;
    return new Promise<ApprovalOutcome>((resolve) => {
      let done = false;
      const settle = (approved: boolean, door: string | null = 'websocket') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.broadcast({ type: 'approval_settled', id, approved });
        resolve({ approved, door });
      };
      // Nobody came back to answer, so the answer is the safe no and no door gets the credit.
      const timer = setTimeout(() => settle(false, null), APPROVAL_TIMEOUT_MS);
      const askedAt = new Date().toISOString();
      this.pending.set(id, { id, request, askedAt, settle });
      this.broadcast({ type: 'approval_request', id, askedAt, ...request });
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
        pressure: snap.pressure,
        buckets: [
          { id: 'session_5h', percent: snap.fiveHour.percent, source: snap.fiveHour.source, confidence: snap.fiveHour.confidence, resetsAt: snap.fiveHour.resetsAt },
          { id: 'weekly_all', percent: snap.weekly.percent, source: snap.weekly.source, confidence: snap.weekly.confidence, resetsAt: snap.weekly.resetsAt },
          { id: 'self_metered_tokens', percent: null, tokens: snap.selfMeteredTokens, byModel: snap.selfMeteredByModel, source: 'self_metered', confidence: 'fresh', resetsAt: null },
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

    const trustRaw = typeof body['trust'] === 'string' ? body['trust'] : 'attended';
    if (trustRaw !== 'attended' && trustRaw !== 'autonomous') return { error: 'trust must be attended or autonomous' };

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

    this.running = true;
    this.broadcast({ type: 'run_started', tasks: pending.map((t) => t.id) });

    void runTasks(pending, {
      config: this.config,
      gauges: this.gauges,
      approve: this.approve,
      onMessage: (taskId, message) => this.onSessionMessage(taskId, message),
      onTaskStart: (task) => {
        this.currentTaskId = task.id;
        this.patch(task.id, { status: 'running' });
        this.broadcast({ type: 'task_started', taskId: task.id, title: task.title, account: task.account, trust: task.trust });
      },
      onTaskFinish: (run: TaskRun) => {
        this.currentTaskId = null;
        this.patch(run.taskId, {
          status: run.errorText ? 'error' : run.outcome === 'blocked' ? 'blocked' : 'done',
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
        this.broadcast({ type: 'run_done', status: this.tasks.map((t) => ({ id: t.id, status: t.status, outcome: t.outcome })) });
      });

    return { started: true, count: pending.length };
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
    for (const socket of this.sockets) this.sendRaw(socket, item);
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

/** Boots the listener. Rejects, loudly, if the loopback bind fails. */
export async function startDaemon(config: Config = loadConfig()): Promise<DaemonHandle> {
  const daemon = new Daemon(config);
  const port = serverPort();
  const server = createServer((req, res) => void handle(daemon, req, res));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', serverBaseUrl());
    if (url.pathname !== '/ws' || !localHost(req)) {
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

async function handle(daemon: Daemon, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!localHost(req)) return json(res, 403, { error: 'this door answers loopback only' });

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
    return json(res, 404, { error: `no route for ${route}` });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
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

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A short human title from the prompt, so the handoff file has a name worth reading. */
function titleFrom(prompt: string): string {
  const firstLine = prompt.split('\n')[0]?.trim() ?? prompt;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
