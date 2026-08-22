import { describe, it, expect, vi, beforeEach } from "vitest";

const postSlack = vi.fn(
  async (_env: Env, _channel: string, _text: string) => {}
);
// Typed as the real `runOpsTurn` returns, so a test that stubs `steps` is
// checked against the shape the route actually reads.
const runOpsTurn = vi.fn(
  async (): Promise<{ text: string; steps?: number }> => ({
    text: "A PR merged 20 minutes before the run touched the theme cookie."
  })
);

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

const { announceE2eFailure, triageE2eReport } = await import("./routes");

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

/**
 * The two halves are separate functions because they run in different places:
 * the headline in the request that received the report, the triage turn on the
 * queue. The split is the guarantee — a queue that is unavailable, backed up,
 * or unbound delays the explanation and never the alert.
 */
describe("announceE2eFailure", () => {
  it("posts the headline and runs no model turn", async () => {
    await announceE2eFailure(env, report);
    expect(postSlack).toHaveBeenCalledTimes(1);
    expect(postSlack.mock.calls[0][2]).toContain("E2E");
    expect(runOpsTurn).not.toHaveBeenCalled();
  });

  it("logs instead of posting when no channel is configured", async () => {
    await announceE2eFailure({} as Env, report);
    expect(postSlack).not.toHaveBeenCalled();
  });

  /** A Slack outage must not take the inbox's 200 down with it. */
  it("does not throw when Slack rejects the post", async () => {
    postSlack.mockRejectedValueOnce(new Error("slack 500"));
    await expect(announceE2eFailure(env, report)).resolves.toBeUndefined();
  });
});

describe("triageE2eReport", () => {
  it("posts the finding on its own, not repeating the headline", async () => {
    await triageE2eReport(env, report);
    expect(postSlack).toHaveBeenCalledTimes(1);
    expect(postSlack.mock.calls[0][2]).toContain("theme cookie");
    expect(postSlack.mock.calls[0][2]).not.toContain("E2E:");
  });

  it("says nothing when triage found nothing", async () => {
    runOpsTurn.mockResolvedValue({ text: "NOTHING" });
    await triageE2eReport(env, report);
    expect(postSlack).not.toHaveBeenCalled();
  });

  /**
   * The regression this whole guard exists for. On 2026-08-22 a collapsed
   * generation posted 256 exclamation marks under a live headline about three
   * failing specs, where it read as the alerting itself having broken. The
   * mock returns what the model actually returned that morning.
   */
  it("says nothing when the model collapses instead of answering", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    runOpsTurn.mockResolvedValue({ text: "!".repeat(256), steps: 4 });

    await triageE2eReport(env, report);

    expect(postSlack).not.toHaveBeenCalled();
    // Silent to the channel, loud in the logs: the turn still burned tools and
    // tokens, and nobody would go looking for a message that never arrived.
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("degenerate"),
      expect.stringContaining("256 chars"),
      expect.any(String)
    );
    errors.mockRestore();
  });

  it("posts a finding with the model's leaked planning line removed", async () => {
    runOpsTurn.mockResolvedValue({
      text:
        "We need to fetch PR details.\nPR #1246 changed image URL " +
        "construction 20 minutes before the run, and no new Sentry issues " +
        "appeared in the same window."
    });

    await triageE2eReport(env, report);

    expect(postSlack).toHaveBeenCalledTimes(1);
    expect(postSlack.mock.calls[0][2]).not.toContain("We need to fetch");
    expect(postSlack.mock.calls[0][2]).toContain("#1246");
  });

  it("says nothing when the turn throws", async () => {
    runOpsTurn.mockRejectedValue(new Error("model exploded"));
    await expect(triageE2eReport(env, report)).resolves.toBeUndefined();
    expect(postSlack).not.toHaveBeenCalled();
  });

  /**
   * A turn that runs to the platform limit is killed with no trace. Losing
   * this race leaves a log line, which is the difference between "found
   * nothing" and "never finished".
   */
  it("gives up on a turn that never resolves, and says so", async () => {
    vi.useFakeTimers();
    runOpsTurn.mockImplementation(() => new Promise(() => {}));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const done = triageE2eReport(env, report);
    await vi.advanceTimersByTimeAsync(120_000);
    await done;

    expect(postSlack).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(
      "[e2e] triage did not finish within",
      120_000,
      "ms"
    );

    errors.mockRestore();
    vi.useRealTimers();
  });
});
