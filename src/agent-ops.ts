/**
 * The non-streaming entry point channels and hooks use.
 *
 * The chat UI streams over a WebSocket; Telegram, Slack, and the monitoring
 * inbox all want a plain "here is a message, give me an answer". Keeping that
 * on one method means the framework's chat surface is touched in exactly one
 * place, and a breaking change there does not reach the channels.
 */

import { generateText, stepCountIs } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { clawdwatchTools } from './tools/clawdwatch';
import { githubTools } from './tools/github';
import { datadogTools } from './tools/datadog';
import { rollbarTools, sentryTools } from './tools/errors';
import { DEFAULT_MODEL } from './config';

export const OPS_SYSTEM_PROMPT = `You are an operations assistant for a small engineering team.

You have tools for monitoring (status, history, incidents, run-a-check,
annotate) and for working out why something broke: recent merged PRs and CI
runs, Datadog metrics and monitors, and Sentry / Rollbar errors.

When you are handed an alert, work in this order:
  1. Confirm it is still failing. runCheckNow is cheap and stops you
     explaining an outage that has already passed.
  2. Look at the check history. A single blip and a sustained outage call for
     different responses.
  3. Look for what changed. Most outages follow a deploy, so recentDeploys on
     the relevant repository is usually the highest-value call.
  4. Look for corroboration: a new Sentry or Rollbar error that started inside
     the same window, or a Datadog metric that stepped rather than wobbled.
  5. Check whether this endpoint has failed before and what was concluded.

Then say what you actually found. Cite the specific evidence — the PR number,
the exception, the ratio. If the evidence does not support a cause, say the
cause is unclear and list what you ruled out. A confident wrong answer sends
someone to the wrong service and costs more than an honest "unclear".

Record real conclusions with annotateIncident so they outlive the chat.

Be brief. One short paragraph unless asked for more. No preamble, no
restating the question. These messages arrive in Slack and Telegram, so plain
sentences beat formatting.

When triaging an alert, the alert itself has already been posted — do not
repeat what failed. Add only what the monitoring system could not know.
If you investigated and found nothing that explains it, reply with the single
word NOTHING and nothing else; an empty channel is better than filler under
an incident someone is trying to read.`;

/**
 * The system prompt plus whatever this deployment knows about its own estate.
 *
 * Which repositories matter, what the Sentry projects are called, which
 * service owns what — all of it is deployment-specific, so it lives in
 * `ESTATE_NOTES` rather than in this file. Baking one organisation's inventory
 * into the prompt is what makes an otherwise general tool unusable by anyone
 * else, and stale for its original owner the first time the estate changes.
 *
 * Free-form prose: it is read by a model, not parsed.
 */
export function opsSystemPrompt(env: Env): string {
  const notes = env.ESTATE_NOTES?.trim();
  return notes ? `${OPS_SYSTEM_PROMPT}\n\nAbout this estate:\n${notes}` : OPS_SYSTEM_PROMPT;
}

export interface AskResult {
  text: string;
  steps: number;
}

/**
 * Run one turn with the ops tools. Errors are returned as text rather than
 * thrown: a channel should say "I could not reach monitoring" rather than
 * silently dropping the user's message.
 */
export async function runOpsTurn(env: Env, prompt: string): Promise<AskResult> {
  const workersai = createWorkersAI({
    binding: env.AI,
    // Routing through AI Gateway gives caching, request logs, and lets the
    // model change without a deploy. Falls back to the direct binding.
    ...(env.CF_AI_GATEWAY_ID ? { gateway: { id: env.CF_AI_GATEWAY_ID } } : {}),
  });

  try {
    const result = await generateText({
      model: workersai(env.MODEL ?? DEFAULT_MODEL),
      system: opsSystemPrompt(env),
      prompt,
      tools: {
        ...clawdwatchTools(env),
        ...githubTools(env),
        ...datadogTools(env),
        ...sentryTools(env),
        ...rollbarTools(env),
      },
      stopWhen: stepCountIs(12),
    });

    // An empty string means "nothing worth saying" — callers decide whether
    // that becomes silence or a log line. Never invent filler text: it reads
    // as commentary on an incident and tells the reader nothing.
    return { text: result.text.trim(), steps: result.steps?.length ?? 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ops] turn failed:', message);
    return { text: `Could not complete the investigation: ${message}`, steps: 0 };
  }
}
