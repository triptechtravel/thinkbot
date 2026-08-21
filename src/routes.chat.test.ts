import { describe, it, expect, vi, beforeEach } from "vitest";

const sendReply = vi.fn(
  async (_env: Env, _target: unknown, _text: string) => {}
);
const runOpsTurn = vi.fn(async () => ({ text: "here is your answer" }));

vi.mock("./channels/reply", () => ({ sendReply }));
vi.mock("./agent-ops", () => ({ runOpsTurn }));
vi.mock("./channels/slack", () => ({
  postSlack: async () => {},
  canPost: () => true,
  slackConfigured: () => false,
  verifySlackSignature: async () => false,
  parseSlackEvent: () => null,
  isUrlVerification: () => null
}));

const { answerChat } = await import("./routes");

const env = {} as Env;
const job = {
  sessionId: "slack:C123:1700000000.000100",
  text: "why did the deploy fail?",
  target: {
    channel: "slack" as const,
    conversation: "C123",
    threadTs: "1700000000.000100"
  }
};

beforeEach(() => {
  sendReply.mockClear();
  runOpsTurn.mockClear();
  runOpsTurn.mockResolvedValue({ text: "here is your answer" });
});

describe("answerChat", () => {
  it("replies with the turn's answer", async () => {
    await answerChat(env, job);
    expect(sendReply).toHaveBeenCalledWith(
      env,
      job.target,
      "here is your answer"
    );
  });

  /**
   * Triage stays quiet when it finds nothing; this must not. A person is
   * waiting in a thread, and silence from a bot is indistinguishable from a
   * bot that is broken.
   */
  it("still says something when the turn throws", async () => {
    runOpsTurn.mockRejectedValue(new Error("model exploded"));
    await answerChat(env, job);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0][2]).toContain("could not finish");
  });

  it("still says something when the turn comes back empty", async () => {
    runOpsTurn.mockResolvedValue({ text: "   " });
    await answerChat(env, job);
    expect(sendReply.mock.calls[0][2]).toContain("could not finish");
  });

  it("does not throw when the reply itself fails to send", async () => {
    sendReply.mockRejectedValue(new Error("slack 500"));
    await expect(answerChat(env, job)).resolves.toBeUndefined();
  });
});
