/**
 * Slack channel.
 *
 * Two Slack-specific constraints shape this file:
 *
 *   1. Events must be acknowledged within three seconds or Slack retries the
 *      delivery — and a retried event would run the agent twice. So we ack
 *      immediately and reply asynchronously.
 *   2. Request signing covers `v0:timestamp:body`, and old timestamps must be
 *      rejected, otherwise a captured request can be replayed.
 */

import type { InboundMessage } from "./reply";

const SLACK_API = "https://slack.com/api";
const MAX_TIMESTAMP_SKEW_S = 60 * 5;

/** Inbound (mentions) needs a full Slack app: bot token + signing secret. */
export function slackConfigured(env: Env): boolean {
  return Boolean(env.SLACK_BOT_TOKEN && env.SLACK_SIGNING_SECRET);
}

/**
 * Outbound only needs somewhere to post. An incoming webhook is enough and
 * requires no app, no scopes, and no new credential — so alert narration
 * works before anyone sets up the conversational half.
 */
export function canPost(env: Env): boolean {
  return Boolean(env.SLACK_BOT_TOKEN || env.SLACK_WEBHOOK_URL);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `v0=<hex>` over `v0:<timestamp>:<body>`. */
export async function verifySlackSignature(opts: {
  signingSecret: string;
  body: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
}): Promise<boolean> {
  const { signingSecret, body, signature, timestamp } = opts;
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const now = opts.now ?? Date.now();
  if (Math.abs(now / 1000 - ts) > MAX_TIMESTAMP_SKEW_S) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `v0:${timestamp}:${body}`
    ) as Uint8Array<ArrayBuffer>
  );

  return timingSafeEqual(`v0=${toHex(mac)}`, signature);
}

/**
 * Post a message, preferring the bot token when present because it can thread
 * replies. Falls back to the incoming webhook, which cannot thread and always
 * posts to the channel the webhook was created for — `channel` is ignored in
 * that case, which is fine for alert narration.
 */
export async function postSlack(
  env: Env,
  channel: string,
  text: string,
  threadTs?: string
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN && env.SLACK_WEBHOOK_URL) {
    const hook = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The webhook is shared with the monitoring Worker, so without an
      // explicit name these messages appear to come from Monitoring itself —
      // commentary with no visible author.
      body: JSON.stringify({ text, username: "thinkbot", icon_emoji: ":mag:" })
    });
    if (!hook.ok) {
      throw new Error(`Slack webhook returned ${hook.status}`);
    }
    return;
  }

  const response = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs })
  });

  // Slack answers 200 with ok:false for application errors, so the status
  // code alone does not tell you whether the message was delivered.
  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) {
    throw new Error(
      `Slack chat.postMessage failed: ${result.error ?? "unknown"}`
    );
  }
}

interface SlackEvent {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    subtype?: string;
    text?: string;
    channel?: string;
    user?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
}

export function isUrlVerification(payload: SlackEvent): string | null {
  return payload.type === "url_verification"
    ? (payload.challenge ?? null)
    : null;
}

/** Strip the `<@U123>` mention Slack includes when the bot is addressed. */
function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function parseSlackEvent(payload: SlackEvent): InboundMessage | null {
  const event = payload.event;
  if (!event) return null;
  if (event.type !== "app_mention" && event.type !== "message") return null;

  // Ignore our own messages, and edits/joins that carry a subtype. Without
  // this the bot replies to itself, forever.
  if (event.bot_id || event.subtype) return null;
  if (!event.text || !event.channel) return null;

  const text = stripMention(event.text);
  if (!text) return null;

  // Thread the reply to the message that prompted it, so a busy channel does
  // not interleave unrelated conversations.
  const threadTs = event.thread_ts ?? event.ts;

  return {
    sessionId: `slack:${event.channel}:${threadTs ?? "main"}`,
    text,
    target: { channel: "slack", conversation: event.channel, threadTs }
  };
}
