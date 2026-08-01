// events.jsonl, append-only. One line per meaningful event.
// Two rules this file exists to keep: a write is one appendFileSync call ending in a newline, so
// a crash mid-run can only ever lose a whole line and never tear one; and a failed write goes to
// stderr and returns, because losing the log must never take down the work being logged.

import { appendFileSync } from 'node:fs';
import type { Config } from '../config.ts';

export type EventKind = ConductorEvent['kind'];

/** Token counts as reported by the SDK. Kept loose: later slices add per-model breakdowns. */
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
}

export type ConductorEvent =
  | { kind: 'daemon_start'; pid: number; stateRoot: string; version: string; accounts: number }
  | { kind: 'daemon_stop'; pid: number; reason: string }
  | { kind: 'task_start'; taskId: string; account: string; model?: string; effort?: string; cwd?: string }
  | {
      kind: 'task_finish';
      taskId: string;
      outcome: string;
      handoffPath?: string;
      contextPeakPercent?: number;
      usage?: TokenUsage;
    }
  | { kind: 'cut'; taskId: string; mode: 'fresh' | 'compact'; sessionId?: string; reason?: string }
  // The before-image for a task. This line is also how undo finds the checkpoint again later, which
  // is why it carries the repo root and the task folder and not only the ref.
  | {
      kind: 'checkpoint';
      taskId: string;
      ref: string;
      commit: string;
      tree: string;
      repoRoot: string;
      cwd: string;
      /** Where the user's HEAD was when we looked. Recorded, never moved. Null in a fresh repo. */
      head: string | null;
      detached: boolean;
      files: number;
      /** Ref pinning the blob that lists what .gitignore covered when the checkpoint was taken. */
      ignoredRef?: string | null;
      /** A merge or rebase paused when the checkpoint was taken. Recorded, never restored. */
      inProgress?: 'merge' | 'rebase' | null;
    }
  // No before-image was taken, so no task ran. A refusal is logged as loudly as a checkpoint,
  // because "nothing was captured" is the fact a later reader most needs.
  | { kind: 'checkpoint_refused'; taskId: string; cwd: string; reason: string }
  // The task-end image. Pairs with the checkpoint above to make provenance a recorded fact rather
  // than something undo infers: checkpoint..post-image is the task's work, post-image..now is not.
  | { kind: 'postimage'; taskId: string; ref: string; commit: string; tree: string; repoRoot: string }
  // No post-image, so provenance is unknown and undo refuses the blanket case. Logged rather than
  // swallowed, because this is the line that explains the refusal later.
  | { kind: 'postimage_failed'; taskId: string; reason: string }
  | {
      kind: 'undo';
      taskId: string;
      ref: string;
      commit: string;
      repoRoot: string;
      cwd: string;
      /** Whether the plan knew the task's own changes, or could only see checkpoint against now. */
      provenance?: 'post-image' | 'unknown';
      /** True when a human explicitly asked to touch changes the task did not make. */
      override?: boolean;
      restored: number;
      deleted: number;
      /** Differences left alone because somebody other than the task made them. */
      heldBack?: number;
      outsideLeftAlone: number;
      failures: number;
    }
  // --- isolation (M2 slice A-prime) ------------------------------------------
  // A task's own copy of a project. This line is also how undo finds the copy again later, which is
  // why it carries the repo root, the branch and the worktree path and not only the task id.
  | {
      kind: 'workspace_created';
      taskId: string;
      repoRoot: string;
      /** The commit the copy was made from. Named, so "what did this start from" is never a guess. */
      baseCommit: string;
      /** Where the user's HEAD pointed. Null when it was detached. Recorded, never moved. */
      baseRef: string | null;
      branch: string;
      worktreePath: string;
      /** The task cwd relative to the repo root, '/'-separated. Empty when it is the root. */
      relPath: string;
      workdir: string;
      /** What the copy lacks, counted in the user's folder at creation time. */
      modifiedTracked: number;
      untracked: number;
      workdirCreated: boolean;
    }
  // No copy was made, so no task ran. Logged as loudly as a creation: there is no fallback to
  // running in the user's folder, so this line is the whole story of why nothing happened.
  | { kind: 'workspace_refused'; taskId: string; cwd: string; reason: string }
  // The task's work committed on its own branch. committed:false means the task changed nothing.
  | { kind: 'workspace_sealed'; taskId: string; branch: string; commit: string; committed: boolean; files: number }
  | { kind: 'workspace_seal_failed'; taskId: string; branch: string; reason: string }
  // Undo. ok:false means the copy is still on disk and the branch was left alone.
  | { kind: 'workspace_discarded'; taskId: string; branch: string; worktreePath: string; ok: boolean; reason?: string }
  | {
      kind: 'gauge_reading';
      account: string;
      bucketId: string;
      // Null means unknown. S2 and S4 are emphatic: an absent reading is never a zero.
      percent: number | null;
      source: 'official_file' | 'official_live' | 'self_metered' | 'anchor_plus_delta' | 'absent';
      confidence: 'fresh' | 'stale' | 'estimated' | 'unknown';
      resetsAt?: string | null;
      costsMoney?: boolean;
    }
  // The gap between what we predicted from self-metering and a fresh official number. `accepted`
  // says whether the gap was allowed to train the rate; a rejected calibration is logged with the
  // reason, because a silently discarded calibration is a number nobody can account for later.
  | {
      kind: 'calibration';
      account: string;
      bucketId: string;
      predictedPercent: number;
      officialPercent: number;
      gap: number;
      fetchedAt: string;
      accepted: boolean;
      rejectedReason?: string;
      learnedPercentPerToken?: number;
    }
  // Auto-compact fired. Every one of these means the one-task-one-cut loop failed.
  | { kind: 'backstop_compact'; sessionId?: string; taskId?: string; trigger: string; preTokens?: number; postTokens?: number }
  | { kind: 'limit_event'; account: string; status: string; window?: string; resetsAt?: string | null }
  // A hard rail stopped a tool call. Every stop is logged, approved or not, so the trail shows
  // both what was refused and what a human waved through.
  | {
      kind: 'rail_stop';
      taskId: string;
      toolName: string;
      layer: 'pre_tool_use' | 'can_use_tool';
      kindOfRisk: RailRiskKind;
      reason: string;
      trust: 'attended' | 'autonomous';
      decision: 'approved' | 'denied';
      /** Which door answered, or null when no door was attached and the answer was the safe no. */
      door: string | null;
    }
  // Every question put to a human, rail case or ordinary attended work. Wrinkle 1 from the M1
  // finish line: the tap on an ordinary write left no trace at all, which broke the logbook's
  // claim to hold the full story.
  | {
      kind: 'approval_request';
      taskId: string;
      approvalId: string;
      toolName: string;
      layer: 'pre_tool_use' | 'can_use_tool';
      reason: string;
      trust: 'attended' | 'autonomous';
      /** Set when Conductor's own rail raised this; absent when it is ordinary attended work. */
      kindOfRisk?: RailRiskKind;
    }
  | {
      kind: 'approval_answer';
      taskId: string;
      approvalId: string;
      toolName: string;
      layer: 'pre_tool_use' | 'can_use_tool';
      decision: 'approved' | 'denied';
      /** Which door answered. Null means nobody was attached, so the answer was the safe no. */
      door: string | null;
      /** How the answer arrived: a door said so, nobody was there, or the question timed out. */
      via: 'door' | 'no_door' | 'timeout' | 'error';
      waitedMs: number;
    };

/** Why the rail stopped something. `unvouched` is the deny-by-default case: not positively safe. */
export type RailRiskKind = 'destructive' | 'elevated' | 'outside_cwd' | 'unvouched';

export type LoggedEvent = ConductorEvent & { ts: string };

/** Appends one event. Never throws into the caller. */
export function logEvent(config: Config, event: ConductorEvent): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  try {
    appendFileSync(config.eventsPath, line, 'utf8');
  } catch (err) {
    process.stderr.write(`conductor: logbook write failed, event dropped: ${String(err)}\n${line}`);
  }
}
