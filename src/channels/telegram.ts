/**
 * Telegram channel.
 *
 * Deliberately thin: verify the request came from Telegram, hand the text to
 * the agent, send the reply back. No framework knowledge leaks in here, so a
 * breaking change in the agent library touches one file, not this one.
 */

import { allowedTelegramChats } from "../config";
import type { InboundMessage } from "./reply";

const API = "https://api.telegram.org";

interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    text?: string;
  };
}

export function telegramConfigured(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
}

/**
 * Telegram echoes the secret we registered with setWebhook. Anyone can POST to
 * a public Worker, so this header is what makes the endpoint trustworthy.
 */
export function verifyTelegramRequest(request: Request, env: Env): boolean {
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  return Boolean(provided && provided === env.TELEGRAM_WEBHOOK_SECRET);
}

export async function sendTelegram(
  env: Env,
  chatId: number | string,
  text: string
): Promise<void> {
  const response = await fetch(
    `${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // Telegram rejects the whole message on malformed markdown, and model
        // output is not reliably well-formed. Plain text always arrives.
        disable_web_page_preview: true
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram sendMessage returned ${response.status}`);
  }
}

/**
 * Parse an update into something channel-agnostic, or null when there is
 * nothing to act on (edited messages, joins, a chat we do not serve).
 */
export function parseTelegramUpdate(
  update: TelegramUpdate,
  env: Env
): InboundMessage | null {
  const message = update.message;
  if (!message?.text) return null;

  const chatId = String(message.chat.id);
  const allowed = allowedTelegramChats(env);

  // An allow-list is the difference between a personal assistant and one
  // anyone who finds the bot can run tools with.
  if (allowed.size > 0 && !allowed.has(chatId)) return null;

  return {
    sessionId: `telegram:${chatId}`,
    text: message.text,
    target: { channel: "telegram", chatId }
  };
}
