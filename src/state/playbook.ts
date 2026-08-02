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
 * Reads `pause threshold: N%` out of the playbook, leniently, because the playbook is a page a
 * human writes in plain language and not a config file. Any spacing, an optional percent sign, a
 * decimal, and any surrounding prose on the line are all fine. Anything else, including a number
 * outside 1 to 100, falls back to the default rather than failing: a policy page with a typo in it
 * must not decide that every task is allowed to run into a wall, nor that none may start.
 */
export function readPauseThreshold(config: Config): number {
  const match = /pause\s+threshold\s*[:=]\s*(\d{1,3}(?:\.\d+)?)\s*%?/i.exec(readPlaybook(config));
  const parsed = match?.[1] === undefined ? NaN : Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : DEFAULT_PAUSE_THRESHOLD_PERCENT;
}
