import { describe, it, expect, vi, beforeEach } from "vitest";

const postSlack = vi.fn(
  async (_env: Env, _channel: string, _text: string, _threadTs?: string) => {}
);
const sendTelegram = vi.fn(
  async (_env: Env, _chatId: string | number, _text: string) => {}
);

vi.mock("./slack", () => ({ postSlack }));
vi.mock("./telegram", () => ({ sendTelegram }));

const { sendReply } = await import("./reply");
import type { ReplyTarget } from "./reply";

const env = {} as Env;

beforeEach(() => {
  postSlack.mockClear();
  sendTelegram.mockClear();
});

describe("sendReply", () => {
  it("answers Slack in the thread that asked", async () => {
    const target: ReplyTarget = {
      channel: "slack",
      conversation: "C123",
      threadTs: "1700000000.000100"
    };
    await sendReply(env, target, "an answer");

    expect(postSlack).toHaveBeenCalledWith(
      env,
      "C123",
      "an answer",
      "1700000000.000100"
    );
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("answers Slack in the channel when there is no thread", async () => {
    await sendReply(env, { channel: "slack", conversation: "C123" }, "hi");
    expect(postSlack).toHaveBeenCalledWith(env, "C123", "hi", undefined);
  });

  it("answers Telegram in the chat that asked", async () => {
    await sendReply(env, { channel: "telegram", chatId: "12345" }, "an answer");
    expect(sendTelegram).toHaveBeenCalledWith(env, "12345", "an answer");
    expect(postSlack).not.toHaveBeenCalled();
  });

  /**
   * The reason this is data and not a closure. A `reply()` function reads
   * better at the call site and cannot be put in a queue message, which is
   * what left slow chat turns cancelled with no answer and no error.
   */
  it("survives the round trip through a queue message", async () => {
    const target: ReplyTarget = {
      channel: "slack",
      conversation: "C123",
      threadTs: "1700000000.000100"
    };
    const revived = JSON.parse(JSON.stringify(target)) as ReplyTarget;

    await sendReply(env, revived, "an answer");
    expect(postSlack).toHaveBeenCalledWith(
      env,
      "C123",
      "an answer",
      "1700000000.000100"
    );
  });
});
