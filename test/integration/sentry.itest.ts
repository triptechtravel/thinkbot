import { describe, it, expect } from "vitest";
import { sentryTools } from "../../src/tools/errors";

/**
 * The Sentry tool against the real API.
 *
 * The unit tests stub `fetch`, so they prove the URL is built and the rows are
 * shaped and nothing about whether Sentry will answer it. That gap is exactly
 * where this tool was broken: the organisation-wide issues endpoint is a
 * different path from the per-project one, and a wrong project slug returns
 * 404 — which, once swallowed, is indistinguishable from "no errors".
 *
 *   SENTRY_TOKEN=… SENTRY_ORG=triptech-hy npm run test:integration
 *
 * Read-only.
 */

const env = {
  SENTRY_TOKEN: process.env.SENTRY_TOKEN,
  SENTRY_ORG: process.env.SENTRY_ORG
} as unknown as Env;

const configured = Boolean(env.SENTRY_TOKEN && env.SENTRY_ORG);

const run = (input: Record<string, unknown>) => {
  const execute = sentryTools(env).sentryIssues.execute as unknown as (
    i: unknown,
    o: unknown
  ) => Promise<{
    scope: string;
    issues: Array<{ project: string; title: string; firstSeen: string }>;
    note?: string;
  }>;
  return execute(input, {});
};

describe.skipIf(!configured)("sentryIssues against the real API", () => {
  it("answers without being told a project slug", async () => {
    // The whole fix. Before this the call could not be made at all without a
    // slug the agent had no way to know.
    const result = await run({ withinMinutes: 30 * 24 * 60, onlyNew: false });

    expect(result.scope).toMatch(/every project/);
    expect(Array.isArray(result.issues)).toBe(true);
  }, 60_000);

  it("attaches a real project slug to every issue it returns", async () => {
    const result = await run({ withinMinutes: 30 * 24 * 60, onlyNew: false });

    // Skip rather than fail on a genuinely quiet org — an empty list is a
    // valid state and must not be read as a broken tool.
    if (result.issues.length === 0) return;

    for (const issue of result.issues) {
      expect(issue.project).toBeTruthy();
      expect(issue.project).not.toBe("undefined");
      // The org slug leaking through as a project name would mean the
      // per-issue fallback fired, i.e. the endpoint stopped returning it.
      expect(issue.project).not.toBe(env.SENTRY_ORG);
    }
  }, 60_000);

  it("rejects a period Sentry does not understand by never sending one", async () => {
    // Every bucket the mapper can emit must be accepted by the API. A rejected
    // period is a 400 and would throw here.
    for (const minutes of [30, 300, 3 * 24 * 60, 30 * 24 * 60]) {
      await expect(run({ withinMinutes: minutes })).resolves.toBeTruthy();
    }
  }, 120_000);
});
