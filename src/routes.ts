/**
 * HTTP routes for channels and hooks.
 *
 * Every route verifies its caller before doing any work — a public Worker URL
 * is reachable by anyone, and each of these can spend money by invoking a
 * model. Verification failures return 401 with no detail.
 */

import type { AlertEvent } from 'clawdwatch';
import { runOpsTurn } from './agent-ops';
import {
  parseTelegramUpdate,
  telegramConfigured,
  verifyTelegramRequest,
} from './channels/telegram';
import {
  canPost,
  isUrlVerification,
  parseSlackEvent,
  postSlack,
  slackConfigured,
  verifySlackSignature,
} from './channels/slack';
import { alertHeadline, alertToPrompt, inboxConfigured, verifyAlert } from './hooks/clawdwatch';

const unauthorized = () => new Response('unauthorized', { status: 401 });
const notConfigured = () => new Response('not configured', { status: 404 });

export async function handleTelegram(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!telegramConfigured(env)) return notConfigured();
  if (!verifyTelegramRequest(request, env)) return unauthorized();

  const update = await request.json().catch(() => null);
  if (!update) return new Response('bad request', { status: 400 });

  const inbound = parseTelegramUpdate(update as never, env);
  // Nothing to do — an edit, a join, or a chat we do not serve. Telegram
  // retries on non-2xx, so this must still be a 200.
  if (!inbound) return new Response('ok');

  ctx.waitUntil(
    runOpsTurn(env, inbound.text)
      .then((result) => inbound.reply(result.text))
      .catch((err) => console.error('[telegram] turn failed:', err)),
  );

  return new Response('ok');
}

export async function handleSlack(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!slackConfigured(env)) return notConfigured();

  const body = await request.text();

  const valid = await verifySlackSignature({
    signingSecret: env.SLACK_SIGNING_SECRET!,
    body,
    signature: request.headers.get('X-Slack-Signature'),
    timestamp: request.headers.get('X-Slack-Request-Timestamp'),
  });
  if (!valid) return unauthorized();

  const payload = JSON.parse(body);

  // Slack verifies a new endpoint by asking it to echo a challenge.
  const challenge = isUrlVerification(payload);
  if (challenge) return new Response(challenge);

  const inbound = parseSlackEvent(payload, env);
  if (!inbound) return new Response('ok');

  // Slack retries anything not acknowledged within three seconds, and a retry
  // would run the agent a second time. Ack now, answer later.
  ctx.waitUntil(
    runOpsTurn(env, inbound.text)
      .then((result) => inbound.reply(result.text))
      .catch((err) => console.error('[slack] turn failed:', err)),
  );

  return new Response('ok');
}

export async function handleMonitoringAlert(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!inboxConfigured(env)) return notConfigured();

  const body = await request.text();
  if (!(await verifyAlert(request, body, env))) return unauthorized();

  let event: AlertEvent;
  try {
    event = JSON.parse(body) as AlertEvent;
  } catch {
    return new Response('bad request', { status: 400 });
  }

  ctx.waitUntil(triageAlert(env, event));

  // Acknowledge immediately: clawdwatch records delivery outcomes, and a slow
  // response here would show up there as a failure.
  return new Response('ok');
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
  const channel = env.SLACK_ALERT_CHANNEL ?? '';
  const result = await runOpsTurn(env, alertToPrompt(event));

  // The prompt asks for the bare word NOTHING when triage came up empty.
  if (!result.text || /^nothing\.?$/i.test(result.text)) {
    console.log('[alert] triage found nothing to report');
    return;
  }

  if (!canPost(env)) {
    console.log('[alert] triage:', result.text);
    return;
  }

  const label = 'check' in event ? event.check.name : 'monitoring';
  await postSlack(env, channel, `*${label}* — ${result.text}`).catch((err) =>
    console.error('[alert] analysis failed:', err),
  );
}
