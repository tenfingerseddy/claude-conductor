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
import { describeWorkspace, discardWorkspace, findWorkspace, isolationRefusal } from '../engine/isolation.ts';
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
  /** Set when the task starts, from the copy it was given. `cwd` stays the folder the human named. */
  branch?: string;
  worktreePath?: string;
  workdir?: string;
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
// How long a preview stays confirmable. Long enough for a human to read the description and think
// about it, short enough that a preview taken hours ago cannot authorise discarding a copy whose
// state has moved on since.
const UNDO_PREVIEW_TTL_MS = 10 * 60 * 1000;

/**
 * A preview that happened, held so the discard that follows it is the one that was shown.
 *
 * Sol's round 2 finding, and it was a merge blocker. The two-call shape was documented and the CLI
 * followed it, but the daemon enforced nothing: a first-ever `POST /undo` carrying a taskId and
 * `confirm: true` deleted the worktree and the output branch with no human having seen a word about
 * what was in it. "The client does two calls" is a convention; this is the check.
 *
 * Bound to the workspace identity rather than to the taskId alone, because the taskId outlives the
 * copy. A preview of task t1's copy must not authorise discarding a different copy that later took
 * the same id, so the branch and the worktree path are pinned too. There is no path-level plan to
 * pin beyond that: discard is total, so the identity of the thing is the whole of the consent.
 */
interface UndoPreview {
  taskId: string;
  worktreePath: string;
  branch: string;
  /**
   * The timestamp on the `workspace_created` line this preview described.
   *
   * The taskId, the branch and the path are not enough on their own, and the case that proves it is
   * reachable: discard task t1's copy, restart the daemon so ids begin at t1 again, run another
   * task, and the replacement copy has the same id, the same branch and the same path as the one
   * the preview described. Every field the workspace record carries is identical, so the only thing
   * left that separates them is when the record was written. Two creations for one id cannot share
   * a millisecond, because the first has to be fully discarded before the second is allowed to
   * exist and git takes longer than that.
   */
  recordStamp: string;
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
  /** Previews that have happened, by token. Single use, and they expire. */
  private readonly undoPreviews = new Map<string, UndoPreview>();
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

    // Gate one of two for reversibility. The task loop makes the copy again before it starts
    // anything, so a task that got into the list some other way still cannot run unreversibly; this
    // one exists so the human hears about it when queueing rather than when the run stalls.
    const notIsolatable = isolationRefusal(cwd);
    if (notIsolatable) return { error: notIsolatable };

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
      onTaskStart: (task, workspace, description) => {
        this.currentTaskId = task.id;
        this.patch(task.id, { status: 'running', branch: workspace.branch, worktreePath: workspace.worktreePath, workdir: workspace.workdir });
        // The description rides with task start rather than waiting for someone to ask, because what
        // the copy lacks is the thing a human most needs to know before the task acts on it.
        this.broadcast({
          type: 'task_started',
          taskId: task.id,
          title: task.title,
          account: task.account,
          trust: task.trust,
          cwd: task.cwd,
          branch: workspace.branch,
          worktreePath: workspace.worktreePath,
          workdir: workspace.workdir,
          baseCommit: workspace.baseCommit,
          workspace: description,
        });
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
   * Undo: discard the task's copy and delete its branch.
   *
   * Still two calls, and still an explicit confirm, but the machinery in between is gone. The old
   * shape carried a plan id and a fingerprint because in-place undo was selective: consent was to a
   * particular list of paths, and that list could go stale against a folder that had moved on.
   * Discard is total, so there is no list to drift and nothing to pin. What is left is worth
   * keeping: discarding sealed work deletes the task's output branch, so a human sees what will go
   * before it goes. The confirm binds to the taskId, which now identifies the whole operation.
   *
   * The preview reads and changes nothing, and it is the only thing that mints the token the
   * discard needs, so the two-step is enforced here rather than trusted to the caller. The
   * confirming call must also name the taskId itself rather than inherit "the last one".
   */
  previewUndo(taskId: string | undefined): { status: number; payload: Record<string, unknown> } {
    const workspace = findWorkspace(this.config, taskId);
    if (!workspace) {
      return {
        status: 404,
        payload: {
          error: taskId
            ? `no copy is recorded for task "${taskId}"; it may never have run, or it may already have been discarded`
            : 'no copy has been made yet, so there is nothing to discard',
        },
      };
    }

    const seal = this.sealState(workspace.taskId);
    // Random, not sequential, and minted only here. A token nobody can guess is a token nobody can
    // present without having first been shown what it authorises.
    const previewToken = randomBytes(18).toString('hex');
    this.prunePreviews();
    this.undoPreviews.set(previewToken, {
      taskId: workspace.taskId,
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      recordStamp: this.recordStamp(workspace.taskId),
      createdAt: Date.now(),
    });

    return {
      status: 200,
      payload: {
        taskId: workspace.taskId,
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
        repoRoot: workspace.repoRoot,
        baseCommit: workspace.baseCommit,
        ...seal,
        workspace: describeWorkspace(workspace),
        discarded: false,
        previewToken,
        expiresInSeconds: Math.round(UNDO_PREVIEW_TTL_MS / 1000),
        note:
          `nothing has been changed. Discarding deletes the copy at "${workspace.worktreePath}" and the branch ` +
          `"${workspace.branch}"${seal.sealed ? `, which holds the task's ${seal.files} sealed file(s)` : ''}. ` +
          `Your folder "${workspace.repoRoot}" is not touched either way.`,
      },
    };
  }

  discard(body: Record<string, unknown>): { status: number; payload: Record<string, unknown> } {
    if (this.running) {
      return { status: 409, payload: { error: 'a run is in progress; stop it before discarding, or the discard and the task will fight over the same copy' } };
    }
    const taskId = typeof body['taskId'] === 'string' ? body['taskId'].trim() : '';
    if (!taskId) {
      return { status: 400, payload: { error: 'discarding a copy needs the taskId from the preview, so the confirm names what it is discarding' } };
    }
    if (body['confirm'] !== true) {
      return { status: 400, payload: { error: 'discarding a copy needs "confirm": true. Ask for the preview first with GET /undo.' } };
    }

    this.prunePreviews();
    const token = typeof body['previewToken'] === 'string' ? body['previewToken'].trim() : '';
    if (!token) return { status: 400, payload: { error: PREVIEW_FIRST } };
    const preview = this.undoPreviews.get(token);
    // Consumed the moment it is presented, whatever happens next. A token spent on a discard that
    // then failed is still spent: the alternative is a token a caller can retry against a copy whose
    // state has moved on since the human looked at it.
    this.undoPreviews.delete(token);
    if (!preview) return { status: 409, payload: { error: `that preview is unknown, already used, or has expired. ${PREVIEW_FIRST}` } };

    const workspace = findWorkspace(this.config, taskId);
    if (!workspace) return { status: 404, payload: { error: `no copy is recorded for task "${taskId}"` } };

    // The identity check, and the reason the token pins more than the taskId. A task id outlives the
    // copy that carried it, so a preview of one copy must not authorise discarding whatever copy
    // holds that id by the time the confirm arrives.
    const stamp = this.recordStamp(workspace.taskId);
    if (
      preview.taskId !== workspace.taskId ||
      preview.worktreePath !== workspace.worktreePath ||
      preview.branch !== workspace.branch ||
      preview.recordStamp !== stamp
    ) {
      return {
        status: 409,
        payload: {
          error:
            `that preview describes a different copy: it was taken of "${preview.worktreePath}" on branch "${preview.branch}", ` +
            `and task "${workspace.taskId}" now points at "${workspace.worktreePath}" on branch "${workspace.branch}". ` +
            `Nothing was discarded. ${PREVIEW_FIRST}`,
        },
      };
    }

    const seal = this.sealState(workspace.taskId);
    const outcome = discardWorkspace(this.config, workspace);
    if (!outcome.ok) {
      return { status: 409, payload: { error: outcome.reason, taskId: workspace.taskId, branch: workspace.branch, worktreePath: workspace.worktreePath, discarded: false } };
    }
    this.broadcast({ type: 'workspace_discarded', taskId: workspace.taskId, branch: workspace.branch, worktreePath: workspace.worktreePath });
    return {
      status: 200,
      payload: {
        taskId: workspace.taskId,
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
        repoRoot: workspace.repoRoot,
        ...seal,
        discarded: true,
        ...(outcome.note ? { note: outcome.note } : {}),
      },
    };
  }

  /**
   * When the `workspace_created` line that findWorkspace would return was written, or '' when the
   * log will not say. Same backwards walk and the same discard rule, so the two always agree about
   * which record they are talking about.
   *
   * '' is deliberately a value that never equals a real stamp on the way in and always equals
   * itself on the way out, so an unreadable log makes a fresh preview and its own confirm agree
   * while never matching a preview taken when the log was readable. Unknown must not open a door.
   */
  private recordStamp(taskId: string): string {
    let text: string;
    try {
      text = readFileSync(this.config.eventsPath, 'utf8');
    } catch {
      return '';
    }
    const lines = text.split('\n');
    let discarded = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event['taskId'] !== taskId) continue;
      if (event['kind'] === 'workspace_discarded' && event['ok'] === true) {
        discarded = true;
        continue;
      }
      if (event['kind'] !== 'workspace_created') continue;
      if (discarded) return '';
      return typeof event['ts'] === 'string' ? event['ts'] : '';
    }
    return '';
  }

  /** Expired previews are gone before any lookup, so an old token can never be found at all. */
  private prunePreviews(): void {
    const cutoff = Date.now() - UNDO_PREVIEW_TTL_MS;
    for (const [token, preview] of this.undoPreviews) if (preview.createdAt < cutoff) this.undoPreviews.delete(token);
  }

  /**
   * Whether this task's work was sealed, and how much of it, read back out of the logbook.
   *
   * `sealed: null` is "the log does not say", which is neither sealed nor unsealed: a task that
   * crashed before the seal ran and a log that could not be read look the same from here, and both
   * mean the preview must not claim the branch is empty.
   */
  private sealState(taskId: string): { sealed: boolean | null; files: number | null; sealFailure?: string } {
    let text: string;
    try {
      text = readFileSync(this.config.eventsPath, 'utf8');
    } catch {
      return { sealed: null, files: null };
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event['taskId'] !== taskId) continue;
      if (event['kind'] === 'workspace_sealed') {
        return { sealed: event['committed'] === true, files: typeof event['files'] === 'number' ? event['files'] : null };
      }
      if (event['kind'] === 'workspace_seal_failed') {
        return { sealed: false, files: null, sealFailure: String(event['reason'] ?? 'the seal failed') };
      }
    }
    return { sealed: null, files: null };
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

/** The one sentence every rejected discard ends with, so the way out is always the same way in. */
const PREVIEW_FIRST =
  'Ask for the preview first with GET /undo and send back the previewToken it returns, so a human sees what would go before it goes.';

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
    // Undo in two halves, and the verbs say which is which: a GET can only ever describe, and the
    // POST is the only thing that removes anything.
    if (route === 'GET /undo') {
      const taskId = url.searchParams.get('taskId')?.trim();
      const { status, payload } = daemon.previewUndo(taskId ? taskId : undefined);
      return json(res, status, payload);
    }
    if (route === 'POST /undo') {
      const body = asRecord(await readJson(req));
      const { status, payload } = daemon.discard(body);
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
