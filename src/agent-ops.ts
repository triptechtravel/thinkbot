/**
 * The one entry point every channel and hook goes through.
 *
 * Telegram, Slack, the monitoring inbox and the CI inbox all want the same
 * thing: here is a message, give me an answer. That is the whole shape, which
 * is why the streaming chat agent this was scaffolded with had no caller left
 * once the UI went — a Durable Object holding conversation state earns nothing
 * when every conversation is one turn long.
 */

import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { clawdwatchTools } from "./tools/clawdwatch";
import { githubTools } from "./tools/github";
import { datadogTools } from "./tools/datadog";
import { workerTools } from "./tools/workers";
import { rollbarTools, sentryTools } from "./tools/errors";
import { DEFAULT_MODEL } from "./config";

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

Before you call anything a test problem, call workerHealth on the worker that
serves the thing under test. An uptime check fetches a page and reports the
first byte; it cannot see a response that starts fast and then never finishes.
workerHealth can, and it is the only source that can. A high wall time against
a low CPU time is a request stuck on I/O — the site is unhealthy no matter how
green everything else looks.

NEVER report the absence of evidence as evidence of absence. If a tool errored,
returned nothing, or was not configured, say so in those words — "Sentry was
unreachable" is useful and "no new Sentry errors" is a lie that reads exactly
like an all-clear. Anyone acting on your answer needs to know which sources
actually spoke.

Then say what you actually found. Cite the specific evidence — the PR number,
the exception, the ratio. If the evidence does not support a cause, say the
cause is unclear and list what you ruled out, and name anything you could not
check. A confident wrong answer sends someone to the wrong service and costs
more than an honest "unclear".

Ruling something out requires having looked. You may only say a deploy, an
exception or a metric is ruled out if the tool for it actually answered.

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
  return notes
    ? `${OPS_SYSTEM_PROMPT}\n\nAbout this estate:\n${notes}`
    : OPS_SYSTEM_PROMPT;
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
export interface OpsTurnOptions {
  /**
   * Model id for this turn only, overriding `env.MODEL`.
   *
   * Exists for the triage harness, which compares models against the same
   * recorded reports. Comparing them by editing a var and redeploying takes
   * the deployment down to one model at a time and makes the two runs
   * incomparable — different day, different estate, different answer.
   */
  model?: string;
}

export async function runOpsTurn(
  env: Env,
  prompt: string,
  options: OpsTurnOptions = {}
): Promise<AskResult> {
  const workersai = createWorkersAI({
    binding: env.AI,
    // Routing through AI Gateway gives caching, request logs, and lets the
    // model change without a deploy. Falls back to the direct binding.
    ...(env.CF_AI_GATEWAY_ID ? { gateway: { id: env.CF_AI_GATEWAY_ID } } : {})
  });

  try {
    const result = await generateText({
      model: workersai(options.model ?? env.MODEL ?? DEFAULT_MODEL),
      system: opsSystemPrompt(env),
      prompt,
      tools: {
        ...clawdwatchTools(env),
        ...githubTools(env),
        ...datadogTools(env),
        ...workerTools(env),
        ...sentryTools(env),
        ...rollbarTools(env)
      },
      stopWhen: stepCountIs(12),
      // Workers AI defaults to a small completion budget — small enough that
      // the deployment's triage paragraphs were arriving cut mid-sentence
      // ("…appeared in the same window", no full stop), and the collapsed
      // generation that reached Slack was exactly 256 characters long.
      //
      // That 256 was the cap, now confirmed rather than inferred: reproducing
      // the collapse against this model with the cap at 2048 produces exactly
      // 2048 characters. `!` is a single token, so a run of them is a
      // generation emitting token 0 until the budget stops it — the length IS
      // the cap, and reading it as a content limit would have sent the next
      // reader looking in the wrong place.
      //
      // Raising it therefore makes a collapse LONGER, not rarer. That is
      // deliberate and safe only because `usableFinding` drops the collapse
      // before it can be posted; the headroom exists so a reasoning model's
      // hidden tokens do not consume the whole budget before it starts
      // writing the answer.
      maxOutputTokens: 2048
    });

    const steps = result.steps?.length ?? 0;
    const text = result.text.trim();

    // An empty string means "nothing worth saying" — callers decide whether
    // that becomes silence or a log line. Never invent filler text: it reads
    // as commentary on an incident and tells the reader nothing.
    //
    // But an empty answer AFTER several tool calls is not that. It is a turn
    // that queried GitHub, Datadog and the Worker's telemetry and then simply
    // stopped without writing the paragraph — observed on 2 of 3 runs against
    // the recorded report, always on the turns that did the MOST work (4-5
    // steps; the one that answered used 2). The evidence was gathered and
    // thrown away, and the channel got silence under a live headline.
    //
    // So ask once more, with the same conversation and NO tools, which leaves
    // the model nothing to do except write. Bounded to a single extra call:
    // the alternative is re-running the whole investigation, at several times
    // the cost, to recover an answer it had already reached.
    if (text || steps === 0) return { text, steps };

    console.warn(
      `[ops] ${steps} step(s) produced no text — asking for the summary`
    );

    // Deliberately NOT a continuation of the tool conversation. The first
    // attempt at this appended a user message to `result.response.messages`,
    // and it recovered one empty turn out of two: when a turn ends mid-tool-call
    // that history holds an assistant tool call with no matching result, and
    // asking a model to continue from a malformed exchange gets you the same
    // silence again.
    //
    // So the evidence is flattened into plain text and handed over as an
    // ordinary prompt with no tools at all. Nothing to continue, nothing to
    // call, no protocol to get wrong — the only thing left to do is write.
    const evidence = (result.steps ?? [])
      .flatMap((step) => step.toolResults ?? [])
      .map((call) => {
        const record = call as unknown as {
          toolName?: string;
          output?: unknown;
          result?: unknown;
        };
        const value = record.output ?? record.result;
        // Bounded per tool: a triage turn can pull a lot back, and the point
        // is to restate a conclusion already reached, not to re-derive it.
        return `${record.toolName ?? "tool"}: ${JSON.stringify(value).slice(0, 1500)}`;
      })
      .join("\n\n");

    if (!evidence) return { text: "", steps };

    const summary = await generateText({
      model: workersai(options.model ?? env.MODEL ?? DEFAULT_MODEL),
      system: opsSystemPrompt(env),
      prompt: [
        "You already investigated this and did not write the answer.",
        "",
        `The question was:\n${prompt}`,
        "",
        `What your tools returned:\n${evidence}`,
        "",
        "Write the answer now: one short paragraph, from the evidence above.",
        "Reply with the single word NOTHING only if that evidence genuinely",
        "explains nothing."
      ].join("\n"),
      maxOutputTokens: 2048
    });

    return { text: summary.text.trim(), steps };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ops] turn failed:", message);
    return {
      text: `Could not complete the investigation: ${message}`,
      steps: 0
    };
  }
}
