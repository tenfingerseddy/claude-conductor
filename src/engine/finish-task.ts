// finish_task: the one custom tool Claude gets in v1. Calling it is how Claude asks for the cut.
// It is an in-process SDK MCP tool, so it runs inside this daemon with no subprocess and no
// transport of its own. The tool writes the handoff note and logs the finish; ending the session
// is the session runner's job, which watches the flag this tool sets.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Handoff } from '../state/handoffs.ts';
import { writeHandoff } from '../state/handoffs.ts';
import { logEvent, type TokenUsage } from '../state/logbook.ts';

export const FINISH_SERVER_NAME = 'conductor';
export const FINISH_TOOL_NAME = 'mcp__conductor__finish_task';

export type Outcome = 'done' | 'partial' | 'blocked';

export interface FinishTaskCall {
  outcome: Outcome;
  handoff: Handoff;
  handoffPath: string | null;
  followUps: string[];
}

const DESCRIPTION =
  'Finish this task and hand off. Call this exactly once, when the task is done, blocked, or when ' +
  'the Conductor gauge line asks you to checkpoint. Write the handoff for a reader with no memory ' +
  'of this session: it is the only thing the next task will see. The session ends after this ' +
  'returns, so say everything that matters here.';

/**
 * Builds the in-process MCP server carrying finish_task. `onFinish` fires after the note is on
 * disk, so the runner knows the cut was asked for and by what verdict.
 */
export function createFinishTaskServer(
  config: Config,
  taskTitle: string,
  onFinish: (call: FinishTaskCall) => void,
) {
  // One task, one handoff. Sol's pass 2 finding 2: the guard used to live in the runner's onFinish
  // callback, which runs *after* the note is on disk, so a second call in the same response wrote a
  // second note and only then had it discarded. Two notes on disk, one of them orphaned, and a tool
  // result telling the model its second handoff had been recorded. The claim is taken here, before
  // anything is written, which is what makes the tool idempotent rather than merely deduplicated.
  let claimed: FinishTaskCall | null = null;

  const finishTask = tool(
    'finish_task',
    DESCRIPTION,
    {
      what_was_done: z.string().describe('What you actually did this task, in plain sentences.'),
      what_matters: z
        .string()
        .describe('What the next session must know: decisions, gotchas, paths, anything surprising.'),
      open_threads: z
        .array(z.string())
        .optional()
        .describe('Loose ends left behind. One short line each. Empty is a fine answer.'),
      outcome: z.enum(['done', 'partial', 'blocked']).describe('done, partial (checkpoint), or blocked.'),
      follow_up_tasks: z
        .array(z.string())
        .optional()
        .describe('Tasks that should be queued next. One clear instruction each.'),
    },
    async (args) => {
      if (claimed) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `This task was already handed off with outcome ${claimed.outcome}` +
                `${claimed.handoffPath ? ` to "${claimed.handoffPath}"` : ''}. Nothing was written for this ` +
                `second call and the first handoff stands. Conductor is cutting the context now; end your turn.`,
            },
          ],
        };
      }

      const handoff: Handoff = {
        task: taskTitle,
        whatWasDone: args.what_was_done,
        whatMatters: args.what_matters,
        openThreads: args.open_threads ?? [],
        followUps: args.follow_up_tasks ?? [],
      };
      // Claimed before the write, so a second call that arrives while this one is still in the
      // handler finds the claim taken rather than racing it to disk.
      const call: FinishTaskCall = { outcome: args.outcome, handoff, handoffPath: null, followUps: handoff.followUps };
      claimed = call;
      const handoffPath = writeHandoff(config, handoff);
      call.handoffPath = handoffPath;
      onFinish(call);

      return {
        content: [
          {
            type: 'text' as const,
            text: handoffPath
              ? `Handoff saved to "${handoffPath}". Outcome recorded as ${args.outcome}. Conductor will cut the context now; stop working and end your turn.`
              : `Handoff could not be written to disk, but the outcome ${args.outcome} was recorded. Conductor will cut the context now; stop working and end your turn.`,
          },
        ],
      };
    },
    // Always in the prompt. Without this the model spends a whole turn on tool search before it
    // can hand off, which is one avoidable turn per task in a design built around handing off.
    { alwaysLoad: true },
  );

  return createSdkMcpServer({
    name: FINISH_SERVER_NAME,
    version: '0.1.0',
    instructions: 'Conductor owns the task loop. Call finish_task once to hand off and take the cut.',
    tools: [finishTask],
  });
}

/** One task_finish line per task, whether or not Claude called the tool. */
export function logTaskFinish(
  config: Config,
  taskId: string,
  outcome: string,
  handoffPath: string | null,
  contextPeakPercent: number | null,
  usage: TokenUsage,
): void {
  logEvent(config, {
    kind: 'task_finish',
    taskId,
    outcome,
    ...(handoffPath ? { handoffPath } : {}),
    ...(contextPeakPercent === null ? {} : { contextPeakPercent: Math.round(contextPeakPercent * 100) / 100 }),
    usage,
  });
}
