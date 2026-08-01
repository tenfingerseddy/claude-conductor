// The gauge: four sources stacked, each degrading into the next, none of them ever throwing into
// the session loop. Order and rules come from PLAN.md's decisions log and the S2, S3, S4 verdicts.
//
//   1. The SDK Query's experimental usage method, at task boundaries only. Wrapped hard: the SDK's
//      own method name says do not rely on it, so any throw or shape surprise is "no reading".
//   2. rate_limit_event messages, logged as pressure signals, never read as a percentage (S3).
//   3. <configDir>\.claude.json -> cachedUsageUtilization, gated on fetchedAtMs (S2). SDK sessions
//      never refresh this block, so it is usually stale and is a calibration anchor, not a meter.
//   4. Self-metering summed from result messages. Always on. The floor and the primary number.
//
// The rule every layer obeys: an absent reading is null, never zero. Zero headroom shown as full
// headroom is the failure mode that matters.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { logEvent } from '../state/logbook.ts';

/** S2: past this age a reading is estimated-only, never presented as current headroom. */
export const STALE_AFTER_MS = 90 * 60 * 1000;

// Advisory in M1. The playbook page carries the same numbers in prose; M2 makes it the source.
export const CONTEXT_CHECKPOINT_PERCENT = 60;
export const WINDOW_CHECKPOINT_PERCENT = 70;

// The SDK tells consumers not to depend on this method, so it is reached by name and never imported.
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
// A control request that never answers must not stall a task boundary.
const PROBE_TIMEOUT_MS = 15_000;

export type ReadingSource = 'official_live' | 'official_file' | 'self_metered' | 'anchor_plus_delta' | 'absent';
export type Confidence = 'fresh' | 'stale' | 'estimated' | 'unknown';

export interface Reading {
  percent: number | null;
  resetsAt: string | null;
  source: ReadingSource;
  confidence: Confidence;
}

export const ABSENT_READING: Reading = { percent: null, resetsAt: null, source: 'absent', confidence: 'unknown' };

export interface UsageWindows {
  fiveHour: Reading;
  weekly: Reading;
}

export interface LiveUsage extends UsageWindows {
  subscriptionType: string | null;
}

export interface FileUsage extends UsageWindows {
  fetchedAtMs: number | null;
  ageMs: number | null;
}

/** Layer 1. Returns null for "no reading" on absolutely anything unexpected. */
export async function readLiveUsage(queryObject: unknown): Promise<LiveUsage | null> {
  try {
    const holder = queryObject as Record<string, unknown> | null;
    const method = holder?.[USAGE_METHOD];
    if (typeof method !== 'function') return null;

    const raw = await withTimeout((method as () => Promise<unknown>).call(holder));
    if (!isRecord(raw)) return null;
    if (raw['rate_limits_available'] !== true) return null;

    const limits = raw['rate_limits'];
    if (!isRecord(limits)) return null;

    return {
      fiveHour: windowReading(limits['five_hour'], 'official_live', 'fresh'),
      weekly: windowReading(limits['seven_day'], 'official_live', 'fresh'),
      subscriptionType: typeof raw['subscription_type'] === 'string' ? raw['subscription_type'] : null,
    };
  } catch {
    return null; // experimental surface gone or misbehaving: degrade, never fail the task
  }
}

/** Layer 1b, documented and stable: context fill for the running session. */
export async function readContextPercent(queryObject: unknown): Promise<number | null> {
  try {
    const holder = queryObject as Record<string, unknown> | null;
    const method = holder?.['getContextUsage'];
    if (typeof method !== 'function') return null;
    const raw = await withTimeout((method as () => Promise<unknown>).call(holder));
    if (!isRecord(raw)) return null;
    const percent = raw['percentage'];
    return typeof percent === 'number' && Number.isFinite(percent) ? percent : null;
  } catch {
    return null;
  }
}

/**
 * Layer 3. Plain read of `<configDir>\.claude.json`. Never touches `.credentials.json`, never
 * looks at or keeps `accountUuid`, never throws, and tolerates the duplicate drive-letter keys
 * S4 found by using plain JSON.parse, which keeps the last occurrence.
 */
export function readOfficialFile(configDir: string, now: number = Date.now()): FileUsage | null {
  let block: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'));
    if (!isRecord(parsed)) return null;
    block = parsed['cachedUsageUtilization'];
  } catch {
    return null; // missing, torn mid-rewrite, or renamed by an update: no reading, not zero
  }
  if (!isRecord(block)) return null;

  const fetchedRaw = block['fetchedAtMs'];
  const fetchedAtMs = typeof fetchedRaw === 'number' && Number.isFinite(fetchedRaw) ? fetchedRaw : null;
  const ageMs = fetchedAtMs === null ? null : Math.max(0, now - fetchedAtMs);
  // An undated reading is ancient, not current. Same rule the account switcher already uses.
  const confidence: Confidence = ageMs === null ? 'unknown' : ageMs > STALE_AFTER_MS ? 'stale' : 'fresh';

  const utilization = block['utilization'];
  if (!isRecord(utilization)) return { fetchedAtMs, ageMs, fiveHour: ABSENT_READING, weekly: ABSENT_READING };

  return {
    fetchedAtMs,
    ageMs,
    fiveHour: windowReading(utilization['five_hour'], 'official_file', confidence),
    weekly: windowReading(utilization['seven_day'], 'official_file', confidence),
  };
}

export interface ModelTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * Per-account gauge state. One instance per account for the life of the process, so self-metering
 * accumulates across the tasks in a chain the way a rolling window needs it to.
 */
export class Gauge {
  readonly account: string;
  readonly configDir: string;
  private readonly config: Config;
  private readonly byModel = new Map<string, ModelTotals>();
  private live: LiveUsage | null = null;
  private file: FileUsage | null = null;
  private contextPercent: number | null = null;
  private contextPeak: number | null = null;
  private pressure: string | null = null;
  // Calibration anchor: the last official percentage seen, and the self-metered total at that
  // moment. The gap between the two on the next official reading is the calibration event.
  private anchorPercent: number | null = null;
  private anchorTokens = 0;
  private percentPerToken: number | null = null;

  constructor(config: Config, account: string, configDir: string) {
    this.config = config;
    this.account = account;
    this.configDir = configDir;
    this.file = readOfficialFile(configDir);
  }

  /**
   * Layer 3 before a task starts. It costs one file read and no session, so the very first turn
   * carries a number instead of "no reading yet". The live probe cannot help here: it needs a
   * running session, which is the thing about to start.
   */
  refreshBeforeTask(): void {
    this.file = readOfficialFile(this.configDir);
    if (!this.file) return;
    this.logReading('session_5h', this.file.fiveHour);
    this.logReading('weekly_all', this.file.weekly);
  }

  /** Layer 4. Called for every result message the session produces. */
  noteResult(modelUsage: unknown): void {
    if (!isRecord(modelUsage)) return;
    for (const [model, raw] of Object.entries(modelUsage)) {
      if (!isRecord(raw)) continue;
      const totals = this.byModel.get(model) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      totals.input += num(raw['inputTokens']);
      totals.output += num(raw['outputTokens']);
      totals.cacheCreation += num(raw['cacheCreationInputTokens']);
      totals.cacheRead += num(raw['cacheReadInputTokens']);
      this.byModel.set(model, totals);
    }
  }

  /** Layer 2. A pressure interrupt, logged as an event and never read as a percentage. */
  noteRateLimitEvent(info: unknown): void {
    if (!isRecord(info)) return;
    const status = typeof info['status'] === 'string' ? info['status'] : 'unknown';
    const window = typeof info['rateLimitType'] === 'string' ? info['rateLimitType'] : undefined;
    const resetsAtSeconds = info['resetsAt'];
    logEvent(this.config, {
      kind: 'limit_event',
      account: this.account,
      status,
      window,
      resetsAt: typeof resetsAtSeconds === 'number' ? new Date(resetsAtSeconds * 1000).toISOString() : null,
    });
    // Only a status that has left "allowed" changes what the gauge line says.
    this.pressure = status === 'allowed' ? null : `usage status is ${status}${window ? ` on the ${window} window` : ''}`;
  }

  noteContextPercent(percent: number | null): void {
    if (percent === null) return;
    this.contextPercent = percent;
    this.contextPeak = this.contextPeak === null ? percent : Math.max(this.contextPeak, percent);
  }

  get contextPeakPercent(): number | null {
    return this.contextPeak;
  }

  get selfMeteredTokens(): number {
    let total = 0;
    for (const t of this.byModel.values()) total += t.input + t.output + t.cacheCreation + t.cacheRead;
    return total;
  }

  get selfMeteredByModel(): Record<string, ModelTotals> {
    return Object.fromEntries(this.byModel);
  }

  /**
   * Task boundary refresh: layers 1 and 3, then log what every layer says. The live reading is the
   * only fresh official number available to a Conductor-driven account (S1: SDK sessions never
   * refresh the file), so when one arrives it also drives the calibration event.
   */
  async refreshAtBoundary(queryObject: unknown): Promise<void> {
    this.noteContextPercent(await readContextPercent(queryObject));

    const live = await readLiveUsage(queryObject);
    if (live) this.live = live;
    this.file = readOfficialFile(this.configDir);

    const official = live ?? this.file;
    if (official) {
      this.logReading('session_5h', official.fiveHour);
      this.logReading('weekly_all', official.weekly);
    } else {
      this.logReading('session_5h', ABSENT_READING);
    }

    logEvent(this.config, {
      kind: 'gauge_reading',
      account: this.account,
      bucketId: 'self_metered_tokens',
      percent: null, // tokens are not a percentage of anything we can see; the count is the honest value
      source: 'self_metered',
      confidence: 'fresh',
    });

    if (live) this.calibrate(live.fiveHour);
  }

  /** The one line injected into every turn. Calm, per the spec's wording rule. */
  line(): string {
    const parts: string[] = [`Conductor gauge, account "${this.account}"`];

    parts.push(
      this.contextPercent === null
        ? 'context: fresh session, still small'
        : `context: ${round(this.contextPercent)}% of the window`,
    );

    parts.push(`5-hour window: ${describe(this.pick('fiveHour'))}`);
    parts.push(`weekly window: ${describe(this.pick('weekly'))}`);
    parts.push(`this run has metered ${formatTokens(this.selfMeteredTokens)} tokens on this account`);
    if (this.pressure) parts.push(this.pressure);

    // The standing sentence. It is standing on purpose: a model told it is near a limit wraps up
    // early and badly, so the line always says the current step is safe to finish.
    let text = `${parts.join(' | ')}. There is ample room to finish the current step.`;
    if (this.shouldCheckpoint()) {
      text +=
        ' Room is getting tighter, so wrap up at the next natural boundary and call finish_task' +
        ' with a checkpoint handoff rather than starting anything new.';
    }
    return text;
  }

  /** Advisory thresholds in M1. The gauge line is the only checkpoint mechanism, per the spec. */
  private shouldCheckpoint(): boolean {
    if (this.pressure) return true;
    if (this.contextPercent !== null && this.contextPercent >= CONTEXT_CHECKPOINT_PERCENT) return true;
    const five = this.pick('fiveHour');
    return five.percent !== null && five.confidence !== 'stale' && five.percent >= WINDOW_CHECKPOINT_PERCENT;
  }

  /** Highest-trust reading available for a window, with the anchor-plus-delta estimate as fallback. */
  private pick(window: keyof UsageWindows): Reading {
    const live = this.live?.[window];
    if (live && live.percent !== null) return live;

    const file = this.file?.[window];
    if (file && file.percent !== null) {
      if (file.confidence !== 'stale') return file;
      const estimated = this.estimateFrom(file.percent);
      return estimated ?? { ...file, source: 'official_file', confidence: 'stale' };
    }
    return ABSENT_READING;
  }

  /** Anchor plus self-metered delta, only once a calibration has taught us a rate. */
  private estimateFrom(anchorPercent: number): Reading | null {
    if (this.percentPerToken === null) return null;
    const spent = this.selfMeteredTokens - this.anchorTokens;
    return {
      percent: Math.max(0, anchorPercent + spent * this.percentPerToken),
      resetsAt: null,
      source: 'anchor_plus_delta',
      confidence: 'estimated',
    };
  }

  /**
   * S2's calibration plan: compare what we would have reported against the fresh official number,
   * log the gap, and let the gap train the tokens-to-percent rate for the next estimate.
   */
  private calibrate(fresh: Reading): void {
    if (fresh.percent === null) return;
    const tokens = this.selfMeteredTokens;

    if (this.anchorPercent !== null) {
      const predicted = this.estimateFrom(this.anchorPercent)?.percent ?? this.anchorPercent;
      const spent = tokens - this.anchorTokens;
      logEvent(this.config, {
        kind: 'calibration',
        account: this.account,
        bucketId: 'session_5h',
        predictedPercent: round2(predicted),
        officialPercent: round2(fresh.percent),
        gap: round2(fresh.percent - predicted),
        fetchedAt: new Date().toISOString(),
      });
      if (spent > 0) this.percentPerToken = (fresh.percent - this.anchorPercent) / spent;
    }

    this.anchorPercent = fresh.percent;
    this.anchorTokens = tokens;
  }

  private logReading(bucketId: string, reading: Reading): void {
    logEvent(this.config, {
      kind: 'gauge_reading',
      account: this.account,
      bucketId,
      percent: reading.percent === null ? null : round2(reading.percent),
      source: reading.source,
      confidence: reading.confidence,
      resetsAt: reading.resetsAt,
    });
  }
}

function describe(reading: Reading): string {
  if (reading.percent === null) return 'no reading yet';
  const label =
    reading.source === 'official_live'
      ? 'official, live'
      : reading.source === 'official_file'
        ? reading.confidence === 'stale'
          ? 'official but stale'
          : 'official, from disk'
        : 'estimated';
  const reset = reading.resetsAt ? `, resets ${shortTime(reading.resetsAt)}` : '';
  return `${round(reading.percent)}% used (${label}${reset})`;
}

function shortTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${at.toISOString().slice(11, 16)}Z`;
}

function windowReading(raw: unknown, source: ReadingSource, confidence: Confidence): Reading {
  if (!isRecord(raw)) return ABSENT_READING;
  const utilization = raw['utilization'];
  const percent = typeof utilization === 'number' && Number.isFinite(utilization) ? utilization : null;
  const resets = raw['resets_at'];
  if (percent === null) return ABSENT_READING;
  return { percent, resetsAt: typeof resets === 'string' ? resets : null, source, confidence };
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('gauge probe timed out')), PROBE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function round(value: number): number {
  return Math.round(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatTokens(total: number): string {
  if (total < 1000) return String(total);
  return `${(total / 1000).toFixed(1)}k`;
}
