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
  // The gap between what we predicted from self-metering and a fresh official number.
  | { kind: 'calibration'; account: string; bucketId: string; predictedPercent: number; officialPercent: number; gap: number; fetchedAt: string }
  // Auto-compact fired. Every one of these means the one-task-one-cut loop failed.
  | { kind: 'backstop_compact'; sessionId?: string; taskId?: string; trigger: string; preTokens?: number; postTokens?: number }
  | { kind: 'limit_event'; account: string; status: string; window?: string; resetsAt?: string | null };

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
