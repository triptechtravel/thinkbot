import { describe, it, expect, vi, beforeEach } from "vitest";

const postSlack = vi.fn(
  async (_env: Env, _channel: string, _text: string) => {}
);
const runOpsTurn = vi.fn(async () => ({
  text: "A PR merged 20 minutes before the run touched the theme cookie."
}));

vi.mock("./channels/slack", () => ({
  postSlack,
  canPost: (env: { SLACK_WEBHOOK_URL?: string }) =>
    Boolean(env.SLACK_WEBHOOK_URL),
  slackConfigured: () => false,
  verifySlackSignature: async () => false,
  parseSlackEvent: () => null,
  isUrlVerification: () => null
}));
vi.mock("./agent-ops", () => ({ runOpsTurn }));

const { triageE2eReport } = await import("./routes");

const env = {
  SLACK_WEBHOOK_URL: "https://hooks.slack.test/x"
} as unknown as Env;
const report = {
  repo: "triptechtravel/campermate.com",
  sha: "abc",
  failures: [{ title: "a test" }]
};

beforeEach(() => {
  postSlack.mockClear();
  runOpsTurn.mockClear();
  runOpsTurn.mockResolvedValue({
    text: "A PR merged 20 minutes before the run touched the theme cookie."
  });
});

describe("triageE2eReport", () => {
  /**
   * The ordering is the whole guarantee. Triage is a model turn that can
   * outlive the request's waitUntil budget; posting the headline afterwards
   * means a slow turn swallows the alert entirely, which is exactly what
   * happened the first time this ran against a real report.
   */
  it("posts the headline before triage has run", async () => {
    let headlineSeen = false;
    runOpsTurn.mockImplementation(async () => {
      headlineSeen = postSlack.mock.calls.length > 0;
      return { text: "a finding" };
    });

    await triageE2eReport(env, report);
    expect(headlineSeen).toBe(true);
  });

  it("posts the finding as a second message", async () => {
    await triageE2eReport(env, report);
    expect(postSlack).toHaveBeenCalledTimes(2);
    expect(postSlack.mock.calls[1][2]).toContain("theme cookie");
  });

  it("still posts the headline when triage throws", async () => {
    runOpsTurn.mockRejectedValue(new Error("model exploded"));
    await triageE2eReport(env, report);
    expect(postSlack).toHaveBeenCalledTimes(1);
    expect(postSlack.mock.calls[0][2]).toContain("E2E");
  });

  it("says nothing extra when triage found nothing", async () => {
    runOpsTurn.mockResolvedValue({ text: "NOTHING" });
    await triageE2eReport(env, report);
    expect(postSlack).toHaveBeenCalledTimes(1);
  });

  /** A failed headline delivery must not take the finding down with it. */
  it("still posts the finding when the headline fails to deliver", async () => {
    postSlack.mockRejectedValueOnce(new Error("slack 500"));
    await triageE2eReport(env, report);
    expect(postSlack).toHaveBeenCalledTimes(2);
  });

  it("logs instead of posting when no channel is configured", async () => {
    await triageE2eReport({} as Env, report);
    expect(postSlack).not.toHaveBeenCalled();
    expect(runOpsTurn).not.toHaveBeenCalled();
  });
});

describe("triageE2eReport when triage never returns", () => {
  /**
   * A hang leaves no error and no message. Bounding the wait is what turns
   * that into something a log can show.
   */
  it("gives up on a turn that never resolves, keeping the headline", async () => {
    vi.useFakeTimers();
    runOpsTurn.mockImplementation(() => new Promise(() => {}));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const done = triageE2eReport(env, report);
    await vi.advanceTimersByTimeAsync(120_000);
    await done;

    expect(postSlack).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(
      "[e2e] triage did not finish within",
      120_000,
      "ms"
    );

    errors.mockRestore();
    vi.useRealTimers();
  });
});
