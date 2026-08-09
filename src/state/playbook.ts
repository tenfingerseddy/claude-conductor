// The playbook is the policy page Claude reads every turn and may propose edits to.
// M1 reads it and injects it. M1 enforces nothing; the hard rails arrive in M2.

import { readFileSync } from 'node:fs';
import type { Config } from '../config.ts';

// Seeded on first run only. Capped at roughly one page on purpose: the cap is what forces the
// review loop to merge duplicates and drop rules that never fire.
export const PLAYBOOK_SEED = `# Playbook

Rules Claude reads every turn. Plain language. Keep this to about one page. Propose edits when
the log shows a rule is wrong, missing, or never fires.

## Hard rails

These are not advice. Conductor enforces them and a human tap is the only way past.

- Never cross from plan usage into paid extra-usage credits. Some accounts do not stop at the
  plan limit, they start spending money. Stop at the boundary and ask.
- Destructive actions always stop for a human tap, on every door, whatever the trust level.
- Never start a Fable task above 85% of its weekly window.

## Cutting context

- One task, one cut. Finish a bounded task, write the handoff, take the cut.
- Fresh cut is the default. A new session fed only the handoff note beats a compaction, because
  the summary was written on purpose. Compact cut is the exception, for task chains that truly
  need deep shared history.
- Above 60% context mid-task, checkpoint at the next natural boundary. Same tool, early.
- Auto-compact is the emergency floor only. Every time it fires, the loop failed and this page
  should learn something.

## Pacing

- Above 70% of the 5-hour window: subagents drop to Sonnet at medium effort, and Fable work goes
  in the queue instead of starting now.
- pause threshold: 95%. At or above this on the window that is binding, no new task starts; the
  service waits for that window to reset and logs what the wait cost.
- Heavy tasks wait for a reset. Light useful work mops up headroom that would otherwise expire.
- Starting a session costs real tokens before a word is said. Do not cut for the sake of cutting.
- The gauge number is mostly self-metered, so treat it as a good estimate, not a meter reading.
  An official reading with a fresh timestamp beats it; a stale one does not.

## Model choice

- Fable: design decisions, gnarly debugging, final review. Never file sweeps.
- Opus: building.
- Sonnet or Haiku: routine work, sweeps, and anything the log shows a cheap model already does
  well.
- Say which model and effort a task got, so the review can tell whether it was worth it.

## Working style

- Major work gets an adversarial review before the task is finished.
- Verify before claiming done. Run it and watch it work. Build success is not verification.
- Write the handoff for a reader with no memory of this session.
`;

/** Playbook text for injection. Never throws: a missing or unreadable page is empty, not fatal. */
export function readPlaybook(config: Config): string {
  try {
    return readFileSync(config.playbookPath, 'utf8');
  } catch (err) {
    process.stderr.write(`conductor: could not read playbook at "${config.playbookPath}": ${String(err)}\n`);
    return '';
  }
}

/**
 * The point at which a new task stops starting and waits for the window to reset.
 *
 * 95 rather than a rounder number, and it is a ladder rather than a guess. The gauge already
 * carries two rungs below it: WINDOW_CHECKPOINT_PERCENT at 70, where the playbook drops subagents
 * to a cheaper model and queues the expensive work, and the seeded hard rail at 85, where Fable
 * work stops starting. A pause is the last rung, so it sits above both and below 100, which is
 * where the account either stops on its own or starts spending money. Anything lower would idle a
 * tank the earlier rungs are already there to protect.
 */
export const DEFAULT_PAUSE_THRESHOLD_PERCENT = 95;

/**
 * Reads `pause threshold: N%` out of the playbook. Lenient about the things a human varies, strict
 * about the number itself, and loud when it refuses one.
 *
 * Sol's finding 6 was that the first version promised a 1-to-100 integer and delivered none of it.
 * The pattern did not end after the digits, so `1000%` matched its first three characters and became
 * 100, silently raising the threshold to the point where almost nothing pauses and the lost-time
 * report reads as a clean bill of health. `1e2` became 1, which pauses nearly everything. `0.5` was
 * accepted against a documented range that excludes it. A typo on a policy page must never quietly
 * decide the pacing, so the numeric token now has to stand alone: digits, an optional percent sign,
 * then end of line or whitespace, and nothing else.
 *
 * Integers only. A fractional threshold is not a thing the gauge can act on more precisely than a
 * whole number, and accepting one would mean the documented range and the accepted range differ
 * again, which is the defect rather than a smaller version of it.
 *
 * A rejected value goes to stderr and the default is used. It is not a logbook event: the effective
 * threshold rides on every `limit_pause` line already, so the number that actually governed a pause
 * is always recoverable from the log, and the reject is an operator message about a file they can
 * fix.
 */
export function readPauseThreshold(config: Config): number {
  const text = readPlaybook(config);
  // The whole candidate, so a rejected one can be quoted back rather than described.
  const candidate = /pause\s+threshold\s*[:=]\s*(\S+)/i.exec(text)?.[1];
  if (candidate === undefined) return DEFAULT_PAUSE_THRESHOLD_PERCENT;

  // Two shapes and no third. With a percent sign, ordinary sentence punctuation may follow, because
  // "pause threshold: 95%." is how the seeded page writes it. Without one, a following full stop is
  // refused, so "0.5" and "95.5" are rejected outright rather than silently truncated to 0 and 95.
  const matched = /^(?:(\d{1,3})%(?=$|[\s.,;)])|(\d{1,3})(?=$|[\s,;)]))/.exec(candidate);
  const digits = matched?.[1] ?? matched?.[2];
  const parsed = digits === undefined ? NaN : Number(digits);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    process.stderr.write(
      `conductor: "${config.playbookPath}" sets a pause threshold of "${candidate}", which is not a whole ` +
        `number of percent between 1 and 100. Using the default of ${DEFAULT_PAUSE_THRESHOLD_PERCENT}% instead. ` +
        `Fix the line if that is not what you meant, because this number decides when work stops.\n`,
    );
    return DEFAULT_PAUSE_THRESHOLD_PERCENT;
  }
  return parsed;
}
