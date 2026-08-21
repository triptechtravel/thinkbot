/**
 * Where a reply goes, as data rather than as a closure.
 *
 * The parsers used to hand back a `reply(text)` function that captured the
 * channel and thread. That reads well when the turn runs in the same
 * invocation, and it is unusable the moment the turn moves to a queue: a
 * closure cannot be put in a message. Describing the destination instead makes
 * the turn relocatable, which is the whole point — a chat turn that takes more
 * than about thirty seconds was being cancelled with no reply and no error.
 */

import { sendTelegram } from "./telegram";
import { postSlack } from "./slack";

export type ReplyTarget =
  | { channel: "slack"; conversation: string; threadTs?: string }
  | { channel: "telegram"; chatId: string };

/** Something a person said to the bot, and where the answer belongs. */
export interface InboundMessage {
  sessionId: string;
  text: string;
  target: ReplyTarget;
}

export async function sendReply(
  env: Env,
  target: ReplyTarget,
  text: string
): Promise<void> {
  if (target.channel === "slack") {
    await postSlack(env, target.conversation, text, target.threadTs);
    return;
  }
  await sendTelegram(env, target.chatId, text);
}
