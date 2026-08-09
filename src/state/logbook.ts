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
  // --- lost time -------------------------------------------------------------
  //
  // Conductor stopped a task from starting because the account had no room. These two lines are the
  // whole measurement: a pause says what it is waiting for and what the other tanks held at that
  // moment, and its resume says what the wait actually cost. Scaling an account is a spending
  // decision, so it deserves a measured number rather than a feeling that things sometimes stall.
  | {
      kind: 'limit_pause';
      /**
       * One hold, one identity. Sol's finding 5: pairing a resume to a pause by account alone gives
       * the wrong answer the moment two holds on one account overlap, and it reported each re-read
       * round of a single unbroken halt as its own incident, inflating the count and shrinking the
       * worst case. A hold now spans every round the task stayed blocked, and both of its events
       * carry this token.
       */
      holdId: string;
      /** The task that did not start. Present so a hold can be traced to the work it delayed. */
      taskId: string;
      account: string;
      /** When the hold began, as an instant. The report intersects durations against its window. */
      startedAt: string;
      /** The window whose reset the wait is aimed at: the one that clears last. */
      window: 'session_5h' | 'weekly_all';
      utilization: number;
      resetsAt: string;
      threshold: number;
      /** The strongest cause that fired, for a reader who wants one word. See `causes` for all. */
      reason: 'threshold' | 'paid_credit_boundary';
      /**
       * Every cause that fired, per window, recorded independently of which window is being waited
       * on. Sol's finding 7: a weekly window at 96% binds the wait because it clears last, and
       * labelling the whole pause `threshold` then hides that the five-hour window was
       * simultaneously at 100% on an account that spends money past that line. Someone reading the
       * log to decide whether to raise the threshold has to see both.
       */
      causes: { window: 'session_5h' | 'weekly_all'; utilization: number; kind: 'threshold' | 'paid_credit_boundary' }[];
      /** The credit setting at pause start, with the freshness of the block it was read from. */
      creditsEnabled: boolean | null;
      creditsFresh: boolean;
      /** How many tasks were behind this one, including it, when the wait started. */
      tasksWaiting: number;
      /**
       * What every other usable account read at pause start. Names only, the ones already in the
       * user's own config; no emails and no account identifiers, per the scrub rule.
       *
       * Each reading carries whether it was usable by the same test the pause gate itself applies,
       * because Sol's finding 2 was that a week-old file reading 0% counted as headroom and turned
       * a six-hour wait into six recoverable hours on evidence the gauge would have refused to act
       * on. A null percentage is an absent reading and never a zero.
       */
      otherAccounts: {
        account: string;
        /** Age of that account's block at this instant, or null when it will not say. */
        ageMs: number | null;
        fiveHour: number | null;
        weekly: number | null;
        /** Usable by `usableForPause`: present, fresh, and describing a window that has not passed. */
        fiveHourUsable: boolean;
        weeklyUsable: boolean;
      }[];
    }
  // lostMs is elapsed time actually spent waiting, measured on a monotonic clock so a system clock
  // correction cannot make it negative or inflate it. plannedMs is what the hold said it would be
  // when it started, so the two disagreeing is itself worth seeing. `rounds` is how many times the
  // gauge was re-read inside this one hold. interrupted means the daemon stopped mid-wait, so the
  // task never did start.
  | {
      kind: 'limit_resume';
      holdId: string;
      taskId: string;
      account: string;
      startedAt: string;
      lostMs: number;
      plannedMs: number;
      rounds: number;
      interrupted: boolean;
    }
  // The gauge could not say where the window stood, so nothing was paused. Logged because a silent
  // "no reading, carry on" and a silent "no reading, stop" are indistinguishable afterwards, and one
  // of them idles a full tank.
  | { kind: 'limit_reading_unusable'; account: string; taskId: string; reason: string }
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
