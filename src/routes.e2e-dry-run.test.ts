import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const postSlack = vi.fn(async () => {});
const runOpsTurn = vi.fn(
  async (
    _env: Env,
    _prompt: string,
    _options?: { model?: string }
  ): Promise<{ text: string; steps?: number }> => ({
    text: "PR #1246 changed image URL construction 20 minutes before the run.",
    steps: 3
  })
);

vi.mock("./channels/slack", () => ({
  postSlack,
  canPost: () => true,
  slackConfigured: () => false,
  verifySlackSignature: async () => false,
  parseSlackEvent: () => null,
  isUrlVerification: () => null
}));
vi.mock("./agent-ops", () => ({ runOpsTurn }));

const { handleE2eDryRun } = await import("./routes");

/** The shape the harness and the integration suite both read. */
interface DryRunBody {
  headline: string;
  raw: string;
  posted: string;
  reason: string | null;
  steps: number;
  model: string;
  ms: number;
}

const readBody = (response: Response) => response.json() as Promise<DryRunBody>;

const SECRET = "test-secret";
const env = {
  E2E_WEBHOOK_SECRET: SECRET,
  SLACK_WEBHOOK_URL: "https://hooks.slack.test/x"
} as unknown as Env;

const report = {
  repo: "triptechtravel/campermate.com",
  sha: "28ae1a93",
  failures: [{ title: "my-trip-map.spec.ts › a pin" }]
};

/** Sign a body the way the reporter and the harness both do. */
function request(body: unknown, query = "", secret = SECRET): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${text}`)
    .digest("hex");

  return new Request(`https://thinkbot.test/hooks/e2e/dry-run${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-thinkbot-signature": `sha256=${signature}`,
      "x-thinkbot-timestamp": timestamp
    },
    body: text
  });
}

beforeEach(() => {
  postSlack.mockClear();
  runOpsTurn.mockClear();
});

describe("handleE2eDryRun", () => {
  /**
   * The property the whole harness rests on. A dry run that posted would
   * announce a fake incident every time anyone exercised the model, and a
   * channel that cries wolf on a schedule is a channel nobody reads when it
   * is right.
   */
  it("never posts to Slack, even with a channel configured", async () => {
    await handleE2eDryRun(request(report), env);
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("returns the model's raw text next to what would be posted", async () => {
    const response = await handleE2eDryRun(request(report), env);
    const body = await readBody(response);

    expect(body.raw).toContain("#1246");
    expect(body.posted).toContain("#1246");
    expect(body.reason).toBeNull();
    expect(body.steps).toBe(3);
    expect(body.headline).toContain("E2E");
  });

  /**
   * Silence and a clean answer look identical from outside the Worker, so the
   * raw text has to survive the guard — otherwise a rejected generation is
   * indistinguishable from a model that found nothing to say.
   */
  it("reports what the guard dropped, and why", async () => {
    runOpsTurn.mockResolvedValue({ text: "!".repeat(256), steps: 2 });

    const body = await readBody(await handleE2eDryRun(request(report), env));

    expect(body.posted).toBe("");
    expect(body.raw).toHaveLength(256);
    expect(body.reason).toMatch(/degenerate/);
  });

  it("passes a model override through to the turn", async () => {
    await handleE2eDryRun(
      request(report, "?model=%40cf%2Fmoonshotai%2Fkimi-k2.6"),
      env
    );

    expect(runOpsTurn).toHaveBeenCalledWith(env, expect.any(String), {
      model: "@cf/moonshotai/kimi-k2.6"
    });
  });

  it("names the model it actually used", async () => {
    const body = await readBody(
      await handleE2eDryRun(request(report, "?model=@cf/test/model"), env)
    );

    expect(body.model).toBe("@cf/test/model");
  });

  /**
   * It spends tokens and reaches GitHub, Datadog and Sentry, so it is exactly
   * as sensitive as the inbox and carries exactly the same check.
   */
  it("refuses a request signed with the wrong secret", async () => {
    const response = await handleE2eDryRun(
      request(report, "", "not-the-secret"),
      env
    );

    expect(response.status).toBe(401);
    expect(runOpsTurn).not.toHaveBeenCalled();
  });

  it("refuses a signed body that is not a report", async () => {
    const response = await handleE2eDryRun(request({ nope: true }), env);

    expect(response.status).toBe(400);
    expect(runOpsTurn).not.toHaveBeenCalled();
  });

  it("refuses a signed body that is not JSON", async () => {
    const response = await handleE2eDryRun(request("not json"), env);

    expect(response.status).toBe(400);
    expect(runOpsTurn).not.toHaveBeenCalled();
  });

  it("404s when the inbox is not configured", async () => {
    const response = await handleE2eDryRun(request(report), {} as Env);
    expect(response.status).toBe(404);
  });
});
