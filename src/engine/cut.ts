// The cut. M1 does fresh cut only, which S3 turned from a preference into an evidenced default:
// compact focus steers but does not redact, summaries confabulate, and the compaction turn reports
// zero usage. A fresh cut carries forward exactly one thing, the note Claude wrote on purpose.
//
// There is no session reuse here and that is the point. The cost is real (S1: a cold session costs
// about 26k cache-creation tokens), which is why the playbook says not to cut for the sake of it.

import type { Config } from '../config.ts';
import type { Handoff } from '../state/handoffs.ts';
import { logEvent } from '../state/logbook.ts';
import { FINISH_TOOL_NAME } from './finish-task.ts';

/** What survives a cut: the note, and a pointer to where it lives on disk. */
export interface Carry {
  handoff: Handoff;
  handoffPath: string | null;
  outcome: string;
}

export function logCut(config: Config, taskId: string, sessionId: string | undefined, reason: string): void {
  logEvent(config, { kind: 'cut', taskId, mode: 'fresh', ...(sessionId ? { sessionId } : {}), reason });
}

/**
 * The opening prompt of a fresh session: who is running this, what carried over, and the task.
 * The handoff text goes in verbatim, because a paraphrase of a note that was already a summary is
 * where detail quietly dies.
 */
export function buildOpeningPrompt(taskPrompt: string, carry: Carry | null): string {
  const blocks: string[] = [
    'You are running under Conductor, which manages one bounded task per session and then cuts the ' +
      'context on purpose. Work this task and nothing else.',
  ];

  if (carry) {
    blocks.push(
      [
        `Handoff from the previous task (outcome: ${carry.outcome}). This is all that carried over; ` +
          'there is no shared history beyond it.',
        '',
        '--- begin handoff note ---',
        renderCarry(carry.handoff),
        '--- end handoff note ---',
        carry.handoffPath
          ? `The same note is on disk at "${carry.handoffPath}". Earlier notes sit beside it in that folder.`
          : 'The note could not be written to disk, so what is above is the only copy.',
      ].join('\n'),
    );
  }

  blocks.push(`Your task:\n${taskPrompt.trim()}`);
  blocks.push(
    `When the task is finished, blocked, or the Conductor gauge line asks you to checkpoint, call ` +
      `the ${FINISH_TOOL_NAME} tool with your handoff note and outcome. That call is how you end ` +
      `the session; do not just stop.`,
  );

  return blocks.join('\n\n');
}

function renderCarry(handoff: Handoff): string {
  const lines = [`Task: ${handoff.task}`, '', 'What was done:', handoff.whatWasDone.trim() || 'none', '', 'What matters:', handoff.whatMatters.trim() || 'none'];
  if (handoff.openThreads.length) lines.push('', 'Open threads:', ...handoff.openThreads.map((t) => `- ${t}`));
  if (handoff.followUps.length) lines.push('', 'Follow-up tasks it left:', ...handoff.followUps.map((t) => `- ${t}`));
  return lines.join('\n');
}
