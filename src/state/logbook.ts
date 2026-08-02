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
  | {
      kind: 'task_start';
      taskId: string;
      account: string;
      model?: string;
      effort?: string;
      /** The folder the human named. The session never runs here; see workdir. */
      cwd?: string;
      /** Where the session actually ran: the isolated copy's counterpart of cwd. */
      workdir?: string;
      /** The branch the copy's work lands on, so a reader can find the output from this line alone. */
      branch?: string;
    }
  | {
      kind: 'task_finish';
      taskId: string;
      outcome: string;
      handoffPath?: string;
      contextPeakPercent?: number;
      usage?: TokenUsage;
    }
  | { kind: 'cut'; taskId: string; mode: 'fresh' | 'compact'; sessionId?: string; reason?: string }
  // --- isolation (M2 slice A-prime) ------------------------------------------
  //
  // These replace the checkpoint kinds this file used to carry (`checkpoint`, `checkpoint_refused`,
  // `postimage`, `postimage_failed` and `undo`), deleted with src/engine/checkpoint.ts when tasks
  // moved into their own copy. An events.jsonl written before that still holds those lines, and
  // every reader here tolerates a kind it does not know: findWorkspace skips non-matching kinds,
  // the daemon's /events and `conductor tail` pass whole lines through without inspecting kind.
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
      /**
       * What the copy lacks, counted in the user's folder at creation time. Null when the count
       * could not be taken: a failed `git status` must never be logged as a clean folder.
       */
      modifiedTracked: number | null;
      untracked: number | null;
      workdirCreated: boolean;
      /** True when the user's HEAD moved between reading it and the copy existing. */
      headMovedDuringCreate: boolean;
    }
  // No copy was made, so no task ran. Logged as loudly as a creation: there is no fallback to
  // running in the user's folder, so this line is the whole story of why nothing happened.
  | { kind: 'workspace_refused'; taskId: string; cwd: string; reason: string }
  // The task's work committed on its own branch. committed:false means the task changed nothing.
  | { kind: 'workspace_sealed'; taskId: string; branch: string; commit: string; committed: boolean; files: number }
  | { kind: 'workspace_seal_failed'; taskId: string; branch: string; reason: string }
  // Undo. ok:false means the copy is still on disk and the branch was left alone.
  // `note` records something deliberately left alone, such as a branch of the right name that git's
  // metadata could not confirm was Conductor's.
  | { kind: 'workspace_discarded'; taskId: string; branch: string; worktreePath: string; ok: boolean; reason?: string; note?: string }
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
