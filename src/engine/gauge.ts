// The gauge: four sources stacked, each degrading into the next, none of them ever throwing into
// the session loop. Order and rules come from PLAN.md's decisions log and the S2, S3, S4 verdicts.
//
//   1. The SDK Query's experimental usage method, at task boundaries only. Wrapped hard: the SDK's
//      own method name says do not rely on it, so any throw or shape surprise is "no reading".
//   2. rate_limit_event messages, logged as pressure signals, never read as a percentage (S3).
//   3. <configDir>\.claude.json -> cachedUsageUtilization, gated on fetchedAtMs (S2). SDK sessions
//      never refresh this block, so it is usually stale and is a calibration anchor, not a meter.
//   4. Self-metering summed from result messages, per model, per rolling window. Always on. The
//      floor and the primary number.
//
// Two rules every layer obeys. An absent reading is null, never zero: zero headroom shown as full
// headroom is the failure mode that matters. And every degradation changes the label. Sol's pass 3
// found the one unforgivable version of the second rule broken, where a failed live probe left the
// last reading cached and still saying "official, live"; the gauge would then report headroom it
// did not have, with a label claiming that number came from Anthropic just now.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { logEvent } from '../state/logbook.ts';

/** S2: past this age a reading is estimated-only, never presented as current headroom. */
export const STALE_AFTER_MS = 90 * 60 * 1000;

/** The two windows the plan actually meters. Self-metering rolls on both (SPEC, the Gauge organ). */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// A timestamp this far ahead of us is a broken clock, not a fresh reading.
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

// Advisory in M1. The playbook page carries the same numbers in prose; M2 makes it the source.
export const CONTEXT_CHECKPOINT_PERCENT = 60;
export const WINDOW_CHECKPOINT_PERCENT = 70;

// Calibration guards. Spending tokens cannot give headroom back, so a negative rate is the window
// rolling over rather than anything the meter can learn. And a plan that burned a whole window in
// ten thousand tokens does not exist, so anything steeper than this is a malformed reading.
const MIN_TOKENS_TO_CALIBRATE = 1_000;
const MAX_PERCENT_PER_TOKEN = 0.01;

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
  /**
   * Whether this account keeps going past its plan limit on paid credits. Null is "the file does
   * not say", which is neither enabled nor disabled: S4 found the two accounts on this machine have
   * different `extra_usage` shapes, so an unreadable block must not be read as "it will just stop".
   */
  extraUsageEnabled: boolean | null;
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
  const rawAgeMs = fetchedAtMs === null ? null : now - fetchedAtMs;
  const ageMs = rawAgeMs === null ? null : Math.max(0, rawAgeMs);
  // Two ways this gate used to fail open, both from Sol's pass 3 finding 4. An undated reading
  // became "unknown" and then rendered as "official, from disk", which reads as current. And a
  // future timestamp was clamped to age zero, so a skewed clock made an ancient reading fresh.
  // Neither is now allowed to pass as current: the label says the age is unknown and the reading
  // is treated as stale everywhere freshness is what matters.
  const confidence: Confidence =
    fetchedAtMs === null || rawAgeMs === null
      ? 'unknown'
      : rawAgeMs < -CLOCK_SKEW_TOLERANCE_MS
        ? 'unknown'
        : rawAgeMs > STALE_AFTER_MS
          ? 'stale'
          : 'fresh';

  const utilization = block['utilization'];
  if (!isRecord(utilization)) {
    return { fetchedAtMs, ageMs, extraUsageEnabled: null, fiveHour: ABSENT_READING, weekly: ABSENT_READING };
  }

  const extra = utilization['extra_usage'];
  const enabledRaw = isRecord(extra) ? extra['is_enabled'] : undefined;

  return {
    fetchedAtMs,
    ageMs,
    extraUsageEnabled: typeof enabledRaw === 'boolean' ? enabledRaw : null,
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

/** One metered result, kept with its timestamp so the windows can roll. */
interface Sample {
  at: number;
  model: string;
  tokens: number;
}

/** Where an estimate starts from: an official percentage and the metered total at that moment. */
interface Anchor {
  percent: number;
  tokens: number;
  at: number;
  source: ReadingSource;
}

/** Everything a door needs to show the gauge, with source and freshness on every number. */
export interface GaugeSnapshot {
  account: string;
  fiveHour: Reading;
  weekly: Reading;
  selfMeteredTokens: number;
  selfMeteredFiveHour: number;
  selfMeteredByModel: Record<string, ModelTotals>;
  contextPercent: number | null;
  contextPeakPercent: number | null;
  fileAgeMs: number | null;
  liveProbeFailed: boolean;
  pressure: string | null;
  line: string;
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
  // Timestamped, because a total that only ever grows cannot represent a window that rolls. SPEC's
  // Gauge organ asks for per rolling window and Sol's pass 3 finding 2 showed what the missing
  // window cost: an official percentage falling as old usage aged out taught calibration that
  // spending tokens creates headroom.
  private samples: Sample[] = [];
  private live: LiveUsage | null = null;
  private liveAt: number | null = null;
  private liveProbeFailed = false;
  private file: FileUsage | null = null;
  private contextPercent: number | null = null;
  private contextPeak: number | null = null;
  private pressure: string | null = null;
  // Calibration state, per window. Kept per window because the five-hour and weekly limits are
  // different sizes, so one percent-per-token rate cannot describe both (Sol pass 3 finding 3).
  private readonly anchors: Record<keyof UsageWindows, Anchor | null> = { fiveHour: null, weekly: null };
  private readonly rates: Record<keyof UsageWindows, number | null> = { fiveHour: null, weekly: null };

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
    this.logReading('session_5h', this.pick('fiveHour'));
    this.logReading('weekly_all', this.pick('weekly'));
  }

  /** Layer 4. Called for every result message the session produces. */
  noteResult(modelUsage: unknown, at: number = Date.now()): void {
    if (!isRecord(modelUsage)) return;
    for (const [model, raw] of Object.entries(modelUsage)) {
      if (!isRecord(raw)) continue;
      const totals = this.byModel.get(model) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      const input = num(raw['inputTokens']);
      const output = num(raw['outputTokens']);
      const cacheCreation = num(raw['cacheCreationInputTokens']);
      const cacheRead = num(raw['cacheReadInputTokens']);
      totals.input += input;
      totals.output += output;
      totals.cacheCreation += cacheCreation;
      totals.cacheRead += cacheRead;
      this.byModel.set(model, totals);
      this.samples.push({ at, model, tokens: input + output + cacheCreation + cacheRead });
    }
    this.prune(at);
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

  /**
   * Whether this account spends money past its plan limit, or null when the file will not say.
   * Read from the file layer only: the live probe carries the same block but is not always there,
   * and a hard rail that only exists while a session is running is not a rail.
   */
  get extraUsageEnabled(): boolean | null {
    return this.file?.extraUsageEnabled ?? null;
  }

  /** The highest-trust reading for a window, for callers outside the gauge. Read only. */
  readingFor(window: keyof UsageWindows): Reading {
    return this.pick(window);
  }

  /** Re-reads the cheap file layer without logging. Used when a pause re-checks where it stands. */
  refreshFile(): void {
    this.file = readOfficialFile(this.configDir);
  }

  /** Tokens metered inside a rolling window. The window is the honest unit; the all-time sum is not. */
  meteredIn(windowMs: number, now: number = Date.now()): number {
    const from = now - windowMs;
    let total = 0;
    for (const sample of this.samples) if (sample.at >= from) total += sample.tokens;
    return total;
  }

  /** The widest window Conductor meters. Anything older has rolled out of every plan limit. */
  get selfMeteredTokens(): number {
    return this.meteredIn(WEEK_MS);
  }

  get selfMeteredFiveHour(): number {
    return this.meteredIn(FIVE_HOUR_MS);
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
    if (live) {
      this.live = live;
      this.liveAt = Date.now();
      this.liveProbeFailed = false;
    } else {
      // The whole of Sol's pass 3 finding 1 in one line: a probe that did not answer invalidates
      // the reading it last answered with. The number may still be the best guess available, but it
      // stops being called live, and pick() degrades it accordingly.
      this.liveProbeFailed = true;
    }
    this.file = readOfficialFile(this.configDir);

    this.logReading('session_5h', this.pick('fiveHour'));
    this.logReading('weekly_all', this.pick('weekly'));

    logEvent(this.config, {
      kind: 'gauge_reading',
      account: this.account,
      bucketId: 'self_metered_tokens',
      percent: null, // tokens are not a percentage of anything we can see; the count is the honest value
      source: 'self_metered',
      confidence: 'fresh',
    });

    if (live) {
      this.calibrate('fiveHour', live.fiveHour);
      this.calibrate('weekly', live.weekly);
    }
  }

  /**
   * Read-only view for the doors. Re-reads the cheap file layer so a door polling /gauge sees
   * current numbers, and logs nothing: a door looking at the gauge is not an event.
   */
  snapshot(): GaugeSnapshot {
    this.file = readOfficialFile(this.configDir);
    return {
      account: this.account,
      fiveHour: this.pick('fiveHour'),
      weekly: this.pick('weekly'),
      selfMeteredTokens: this.selfMeteredTokens,
      selfMeteredFiveHour: this.selfMeteredFiveHour,
      selfMeteredByModel: this.selfMeteredByModel,
      contextPercent: this.contextPercent,
      contextPeakPercent: this.contextPeak,
      fileAgeMs: this.file?.ageMs ?? null,
      liveProbeFailed: this.liveProbeFailed,
      pressure: this.pressure,
      line: this.line(),
    };
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
    parts.push(
      `metered on this account: ${formatTokens(this.selfMeteredFiveHour)} tokens in the last 5 hours, ` +
        `${formatTokens(this.selfMeteredTokens)} this week`,
    );
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
    return five.percent !== null && five.confidence === 'fresh' && five.percent >= WINDOW_CHECKPOINT_PERCENT;
  }

  /** Is the cached live reading still allowed to call itself live? */
  private liveIsCurrent(now: number = Date.now()): boolean {
    if (this.liveProbeFailed) return false;
    return this.liveAt !== null && now - this.liveAt <= STALE_AFTER_MS;
  }

  /**
   * Highest-trust reading available for a window. Every fallthrough changes the label, and nothing
   * that is no longer current is allowed to keep a current-sounding one.
   */
  private pick(window: keyof UsageWindows): Reading {
    const live = this.live?.[window];
    if (live && live.percent !== null) {
      if (this.liveIsCurrent()) return live;
      // Still the best official number seen, but it is no longer live. Project it forward if
      // calibration has earned the right to, otherwise say plainly that it has gone stale.
      return this.estimate(window) ?? { ...live, confidence: 'stale' };
    }

    const file = this.file?.[window];
    if (file && file.percent !== null) {
      if (file.confidence === 'fresh') return file;
      return this.estimate(window) ?? file; // file carries its own stale or unknown label
    }
    return ABSENT_READING;
  }

  /**
   * Anchor plus self-metered delta for one window, using that window's own anchor and its own
   * learned rate. Never mixes: Sol's pass 3 finding 3 was a stale file percentage being projected
   * from a live reading's token anchor, which reported eighty percent headroom where the matching
   * live projection said fifty.
   */
  private estimate(window: keyof UsageWindows, now: number = Date.now()): Reading | null {
    const anchor = this.anchors[window];
    const rate = this.rates[window];
    if (!anchor || rate === null) return null;
    const spent = this.meteredIn(windowLength(window), now) - anchor.tokens;
    if (spent < 0) return null; // the window rolled under the anchor; there is nothing honest to project
    return {
      percent: clampPercent(anchor.percent + spent * rate),
      resetsAt: null,
      source: 'anchor_plus_delta',
      confidence: 'estimated',
    };
  }

  /**
   * S2's calibration plan: compare what we would have reported against the fresh official number,
   * log the gap, and let the gap train the tokens-to-percent rate for the next estimate.
   *
   * The guards are the point. A rate is only learned from a movement that could plausibly have been
   * caused by the tokens metered against it; anything else is logged as rejected with its reason,
   * so a number nobody can account for never quietly becomes the basis of a later estimate.
   */
  private calibrate(window: keyof UsageWindows, fresh: Reading, now: number = Date.now()): void {
    if (fresh.percent === null) return;
    const tokens = this.meteredIn(windowLength(window), now);
    const anchor = this.anchors[window];
    const bucketId = window === 'fiveHour' ? 'session_5h' : 'weekly_all';

    if (anchor) {
      const spent = tokens - anchor.tokens;
      const rate = this.rates[window];
      const predicted = rate !== null && spent >= 0 ? clampPercent(anchor.percent + spent * rate) : anchor.percent;
      const candidate = spent > 0 ? (fresh.percent - anchor.percent) / spent : null;

      let rejectedReason: string | null = null;
      if (spent < MIN_TOKENS_TO_CALIBRATE) {
        rejectedReason = `only ${spent} tokens metered since the last anchor, which is too few to attribute a move to`;
      } else if (candidate === null || candidate < 0) {
        rejectedReason = 'the official percentage fell while tokens were spent, so the window rolled rather than the rate changing';
      } else if (candidate === 0) {
        // Spending tokens always costs something. A flat percentage means the official number is
        // rounded coarsely enough to hide the move, and learning zero from it would freeze every
        // later estimate at the anchor no matter how much was spent.
        rejectedReason = 'the official percentage did not move at all, so rounding hid the cost rather than there being none';
      } else if (candidate > MAX_PERCENT_PER_TOKEN) {
        rejectedReason = `a rate of ${candidate} percent per token is not physically plausible`;
      }

      const accepted = rejectedReason === null && candidate !== null;
      logEvent(this.config, {
        kind: 'calibration',
        account: this.account,
        bucketId,
        predictedPercent: round2(predicted),
        officialPercent: round2(fresh.percent),
        gap: round2(fresh.percent - predicted),
        fetchedAt: new Date(now).toISOString(),
        accepted,
        ...(rejectedReason ? { rejectedReason } : {}),
        ...(accepted && candidate !== null ? { learnedPercentPerToken: candidate } : {}),
      });
      if (accepted && candidate !== null) this.rates[window] = candidate;
    }

    this.anchors[window] = { percent: fresh.percent, tokens, at: now, source: fresh.source };
  }

  /** Samples older than the widest window can never count towards any window again. */
  private prune(now: number): void {
    const from = now - WEEK_MS;
    if (this.samples.length > 0 && this.samples[0]!.at >= from) return;
    this.samples = this.samples.filter((s) => s.at >= from);
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

function windowLength(window: keyof UsageWindows): number {
  return window === 'fiveHour' ? FIVE_HOUR_MS : WEEK_MS;
}

/**
 * The label. One phrase per state, and no two states share one: a reader who sees "official, live"
 * is entitled to believe the number came from Anthropic in the last little while, so every other
 * case has to say something else.
 */
export function describe(reading: Reading): string {
  if (reading.percent === null) return 'no reading yet';
  const label =
    reading.source === 'official_live'
      ? reading.confidence === 'fresh'
        ? 'official, live'
        : 'official, live reading has gone stale'
      : reading.source === 'official_file'
        ? reading.confidence === 'fresh'
          ? 'official, from disk'
          : reading.confidence === 'unknown'
            ? 'official, from disk, age unknown'
            : 'official but stale'
        : reading.source === 'anchor_plus_delta'
          ? 'estimated from the last official reading'
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
  // Finite was not enough: a malformed -5 rendered as "-5% used", which is a claim of 105% headroom.
  // A percentage outside its own range is not a reading, so it degrades to no reading at all.
  const percent =
    typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0 && utilization <= 100
      ? utilization
      : null;
  const resets = raw['resets_at'];
  if (percent === null) return ABSENT_READING;
  return { percent, resetsAt: typeof resets === 'string' ? resets : null, source, confidence };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
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

/** The two windows the pause primitive can bind on, named the way the logbook names them. */
export type WindowId = 'session_5h' | 'weekly_all';

export function windowIdFor(window: keyof UsageWindows): WindowId {
  return window === 'fiveHour' ? 'session_5h' : 'weekly_all';
}

/** A reading solid enough to stop work on, with the moment it stops being true. */
export interface UsableReading {
  window: WindowId;
  percent: number;
  resetsAt: string;
  resetsAtMs: number;
}

/**
 * Is this reading good enough to idle Conductor on? Three tests, and all three come from things
 * that already went wrong once.
 *
 * A percentage with no reset time cannot say when a pause would end, so it can only produce a wait
 * with no stated finish. A reading that is not fresh is the S2 staleness problem: SDK sessions
 * never refresh the file, so a percentage can describe a window that ended hours ago. And a reading
 * whose own `resets_at` has already passed is the second freshness test from the decisions log,
 * learned live at 12:22 UTC on 2026-08-01 when a 51-minute-old file still read 100% for a window
 * that had reset two minutes earlier. Checking age alone would have idled a full tank for hours.
 *
 * Null means "do not pause on this". Not pausing is the safe direction here: the worst case is that
 * a task runs and the account stops it, which costs one wasted start. The other direction costs
 * hours of a working machine doing nothing, which is the failure the whole feature exists to
 * measure rather than to cause.
 */
export function usableForPause(window: keyof UsageWindows, reading: Reading, now: number = Date.now()): UsableReading | null {
  if (reading.percent === null || reading.resetsAt === null) return null;
  if (reading.confidence !== 'fresh') return null;
  const resetsAtMs = Date.parse(reading.resetsAt);
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now) return null;
  return { window: windowIdFor(window), percent: reading.percent, resetsAt: reading.resetsAt, resetsAtMs };
}

export function formatTokens(total: number): string {
  if (total < 1000) return String(total);
  return `${(total / 1000).toFixed(1)}k`;
}
