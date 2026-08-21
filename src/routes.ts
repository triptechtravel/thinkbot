/**
 * HTTP routes for channels and hooks.
 *
 * Every route verifies its caller before doing any work — a public Worker URL
 * is reachable by anyone, and each of these can spend money by invoking a
 * model. Verification failures return 401 with no detail.
 */

import type { AlertEvent } from "clawdwatch";
import { runOpsTurn } from "./agent-ops";
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

  ctx.waitUntil(
    runOpsTurn(env, inbound.text)
      .then((result) => inbound.reply(result.text))
      .catch((err) => console.error("[telegram] turn failed:", err))
  );

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

  const inbound = parseSlackEvent(payload, env);
  if (!inbound) return new Response("ok");

  // Slack retries anything not acknowledged within three seconds, and a retry
  // would run the agent a second time. Ack now, answer later.
  ctx.waitUntil(
    runOpsTurn(env, inbound.text)
      .then((result) => inbound.reply(result.text))
      .catch((err) => console.error("[slack] turn failed:", err))
  );

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

  ctx.waitUntil(triageAlert(env, event));

  // Acknowledge immediately: clawdwatch records delivery outcomes, and a slow
  // response here would show up there as a failure.
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

  ctx.waitUntil(triageE2eReport(env, report));

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
export async function triageE2eReport(
  env: Env,
  report: E2eReport
): Promise<void> {
  const channel = env.SLACK_ALERT_CHANNEL ?? "";
  const headline = e2eHeadline(report);

  if (!canPost(env)) {
    console.log("[e2e]", headline);
    return;
  }

  // The headline goes out BEFORE triage, not with it. Triage is a model turn
  // with tool calls; it can be slow enough that the runtime tears down the
  // waitUntil before it finishes, and then a combined message is never sent at
  // all. That is not theoretical — it is what happened the first time this ran
  // against a real report: 200 to the caller, no error, and silence in Slack,
  // while the probe (whose turn returns immediately) posted fine. Ordering it
  // this way makes the floor real: the worst case is a headline with no
  // explanation, never an explanation nobody receives.
  await postSlack(env, channel, headline).catch((err) =>
    console.error("[e2e] posting the headline failed:", err)
  );

  // Bound the turn. A triage that never returns leaves no trace at all — the
  // response went out long ago and there is no error to log — so the only
  // symptom is a headline with no explanation and no way to tell whether the
  // model found nothing or never finished. Losing the race does not stop the
  // turn; it just means the outcome is recorded either way.
  const finding = await Promise.race([
    runOpsTurn(env, e2eToPrompt(report))
      .then((result) =>
        !result.text || /^nothing\.?$/i.test(result.text) ? "" : result.text
      )
      .catch((err) => {
        console.error("[e2e] triage failed:", err);
        return "";
      }),
    new Promise<string>((resolve) =>
      setTimeout(() => {
        console.error(
          "[e2e] triage did not finish within",
          TRIAGE_TIMEOUT_MS,
          "ms"
        );
        resolve("");
      }, TRIAGE_TIMEOUT_MS)
    )
  ]);

  if (!finding) return;

  await postSlack(env, channel, finding).catch((err) =>
    console.error("[e2e] posting the finding failed:", err)
  );
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
  const channel = env.SLACK_ALERT_CHANNEL ?? "";
  const result = await runOpsTurn(env, alertToPrompt(event));

  // The prompt asks for the bare word NOTHING when triage came up empty.
  if (!result.text || /^nothing\.?$/i.test(result.text)) {
    console.log("[alert] triage found nothing to report");
    return;
  }

  if (!canPost(env)) {
    console.log("[alert] triage:", result.text);
    return;
  }

  const label = "check" in event ? event.check.name : "monitoring";
  await postSlack(env, channel, `*${label}* — ${result.text}`).catch((err) =>
    console.error("[alert] analysis failed:", err)
  );
}
