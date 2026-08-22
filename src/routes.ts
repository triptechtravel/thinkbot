/**
 * HTTP routes for channels and hooks.
 *
 * Every route verifies its caller before doing any work — a public Worker URL
 * is reachable by anyone, and each of these can spend money by invoking a
 * model. Verification failures return 401 with no detail.
 */

import type { AlertEvent } from "clawdwatch";
import { runOpsTurn } from "./agent-ops";
import { enqueueTurn } from "./turn-queue";
import { usableFinding } from "./triage-output";
import {
  parseTelegramUpdate,
  telegramConfigured,
  verifyTelegramRequest
} from "./channels/telegram";
import {
  canPost,
  isUrlVerification,
  parseSlackEvent,
  postSlack,
  slackConfigured,
  verifySlackSignature
} from "./channels/slack";
import { sendReply, type ReplyTarget } from "./channels/reply";
import {
  alertToPrompt,
  inboxConfigured,
  verifyAlert
} from "./hooks/clawdwatch";
import {
  e2eHeadline,
  e2eInboxConfigured,
  e2eToPrompt,
  isE2eReport,
  verifyE2eReport,
  type E2eReport
} from "./hooks/e2e";

const unauthorized = () => new Response("unauthorized", { status: 401 });

/**
 * How long a triage turn gets before its silence is recorded as such. Generous
 * — a turn that makes several tool calls is legitimately slow — but finite, so
 * a hang is a log line rather than nothing at all.
 */
const TRIAGE_TIMEOUT_MS = 120_000;
const notConfigured = () => new Response("not configured", { status: 404 });

export async function handleTelegram(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!telegramConfigured(env)) return notConfigured();
  if (!verifyTelegramRequest(request, env)) return unauthorized();

  const update = await request.json().catch(() => null);
  if (!update) return new Response("bad request", { status: 400 });

  const inbound = parseTelegramUpdate(update as never, env);
  // Nothing to do — an edit, a join, or a chat we do not serve. Telegram
  // retries on non-2xx, so this must still be a 200.
  if (!inbound) return new Response("ok");

  ctx.waitUntil(enqueueTurn(env, { kind: "chat", ...inbound }));
  return new Response("ok");
}

export async function handleSlack(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!slackConfigured(env)) return notConfigured();

  const body = await request.text();

  const valid = await verifySlackSignature({
    signingSecret: env.SLACK_SIGNING_SECRET!,
    body,
    signature: request.headers.get("X-Slack-Signature"),
    timestamp: request.headers.get("X-Slack-Request-Timestamp")
  });
  if (!valid) return unauthorized();

  const payload = JSON.parse(body);

  // Slack verifies a new endpoint by asking it to echo a challenge.
  const challenge = isUrlVerification(payload);
  if (challenge) return new Response(challenge);

  const inbound = parseSlackEvent(payload);
  if (!inbound) return new Response("ok");

  // Slack retries anything not acknowledged within three seconds, and a retry
  // would run the agent a second time. Ack now, answer later.
  ctx.waitUntil(enqueueTurn(env, { kind: "chat", ...inbound }));
  return new Response("ok");
}

export async function handleMonitoringAlert(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!inboxConfigured(env)) return notConfigured();

  const body = await request.text();
  if (!(await verifyAlert(request, body, env))) return unauthorized();

  let event: AlertEvent;
  try {
    event = JSON.parse(body) as AlertEvent;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Acknowledge immediately: clawdwatch records delivery outcomes, and a slow
  // response here would show up there as a failure. The turn itself runs on
  // the queue, which has minutes rather than the thirty seconds a waitUntil
  // gets after the response.
  ctx.waitUntil(enqueueTurn(env, { kind: "alert", event }));
  return new Response("ok");
}

export async function handleE2eReport(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!e2eInboxConfigured(env)) return notConfigured();

  const body = await request.text();
  if (!(await verifyE2eReport(request, body, env))) return unauthorized();

  let report: unknown;
  try {
    report = JSON.parse(body);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // A valid signature proves the sender holds the key, not that it sent a
  // report. Refuse the malformed ones here rather than spending a model turn
  // discovering there is nothing to triage.
  if (!isE2eReport(report)) return new Response("bad request", { status: 400 });

  // Say what failed before returning: one Slack call, and it means the alert
  // does not depend on the queue. The explanation follows from the consumer.
  await announceE2eFailure(env, report);
  ctx.waitUntil(enqueueTurn(env, { kind: "e2e", report }));

  // Acknowledge before triaging. A CI job should not sit waiting on an LLM
  // turn, and a slow answer here would read as a failed notification.
  return new Response("ok");
}

/**
 * Investigate a failing end-to-end run and post what it found.
 *
 * Unlike `triageAlert`, this ALWAYS posts. There is no other notifier on this
 * path — the workflow's own Slack step was removed when this inbox replaced
 * it — so staying quiet because triage came up empty would turn a failing
 * nightly suite into silence, which is exactly how this went unnoticed for two
 * nights before. The headline is the floor; the triage paragraph is the value
 * added on top of it.
 */
export async function announceE2eFailure(
  env: Env,
  report: E2eReport
): Promise<void> {
  const headline = e2eHeadline(report);

  if (!canPost(env)) {
    console.log("[e2e]", headline);
    return;
  }

  // Posted in the request itself, not from the queue. It is a single Slack
  // call, so it costs the caller milliseconds, and it means the alert does not
  // depend on the queue being healthy — a backed-up or unbound queue delays
  // the explanation, never the fact that something failed.
  await postSlack(env, env.SLACK_ALERT_CHANNEL ?? "", headline).catch((err) =>
    console.error("[e2e] posting the headline failed:", err)
  );
}

/**
 * The triage half of the e2e path, run from the queue consumer.
 *
 * Posts only the finding: `announceE2eFailure` has already said what failed,
 * and repeating it under an explanation reads as two incidents.
 */
export async function triageE2eReport(
  env: Env,
  report: E2eReport
): Promise<void> {
  const finding = await runTriageTurn(env, e2eToPrompt(report), "e2e");
  if (!finding) return;

  await postSlack(env, env.SLACK_ALERT_CHANNEL ?? "", finding).catch((err) =>
    console.error("[e2e] posting the finding failed:", err)
  );
}

/**
 * Answer someone who asked the bot a question.
 *
 * Unlike triage, this always replies. A person is waiting on the other end of
 * a thread, and silence from a bot is indistinguishable from a bot that is
 * broken — which, until the turn moved off `waitUntil`, is what a slow question
 * produced: no answer, no error, nothing to tell them it had even been read.
 */
export async function answerChat(
  env: Env,
  job: { sessionId: string; text: string; target: ReplyTarget }
): Promise<void> {
  const answer = await runOpsTurn(env, job.text)
    .then((result) => result.text?.trim() ?? "")
    .catch((err) => {
      console.error("[chat] turn failed:", job.sessionId, err);
      return "";
    });

  await sendReply(
    env,
    job.target,
    answer || "I could not finish that one — nothing came back from the model."
  ).catch((err) => console.error("[chat] reply failed:", job.sessionId, err));
}

/**
 * One triage turn, bounded and reduced to "something worth posting, or not".
 *
 * The bound is smaller than the consumer's own budget on purpose. A turn that
 * runs to the platform limit is killed with no trace at all; one that loses
 * this race leaves a log line saying so, which is the difference between
 * "found nothing" and "never finished".
 */
async function runTriageTurn(
  env: Env,
  prompt: string,
  label: string
): Promise<string> {
  return Promise.race([
    runOpsTurn(env, prompt)
      .then((result) => {
        // Nothing sits between the model and the channel but this. On
        // 2026-08-22 a collapsed generation put 256 exclamation marks under a
        // real incident headline, because the only checks here were "empty"
        // and "the word NOTHING".
        const verdict = usableFinding(result.text);
        if (verdict.reason) {
          console.error(
            `[${label}] output rejected or altered — ${verdict.reason};`,
            `${result.steps} step(s), ${result.text.length} chars:`,
            JSON.stringify(result.text.slice(0, 200))
          );
        }
        return verdict.text;
      })
      .catch((err) => {
        console.error(`[${label}] triage failed:`, err);
        return "";
      }),
    new Promise<string>((resolve) =>
      setTimeout(() => {
        console.error(
          `[${label}] triage did not finish within`,
          TRIAGE_TIMEOUT_MS,
          "ms"
        );
        resolve("");
      }, TRIAGE_TIMEOUT_MS)
    )
  ]);
}

/**
 * Investigate an alert and post the finding.
 *
 * The transport-agnostic core: reached from the signed HTTP inbox and from the
 * RPC entrypoint alike. It takes an already-trusted event, so it must never
 * assume a signature was checked — over a service binding there is no
 * signature to check, and authenticity comes from the binding itself.
 *
 * No headline is posted: clawdwatch already sent its own alert to the same
 * channel, so a second "X is down" is pure duplication. This adds the one
 * thing clawdwatch cannot — why.
 *
 * Silence is a valid outcome. If triage found nothing, saying nothing is
 * better than posting filler under an incident someone is trying to read.
 */
export async function triageAlert(env: Env, event: AlertEvent): Promise<void> {
  // The prompt asks for the bare word NOTHING when triage came up empty.
  const finding = await runTriageTurn(env, alertToPrompt(event), "alert");
  if (!finding) {
    console.log("[alert] triage found nothing to report");
    return;
  }

  if (!canPost(env)) {
    console.log("[alert] triage:", finding);
    return;
  }

  const label = "check" in event ? event.check.name : "monitoring";
  await postSlack(
    env,
    env.SLACK_ALERT_CHANNEL ?? "",
    `*${label}* — ${finding}`
  ).catch((err) => console.error("[alert] analysis failed:", err));
}
