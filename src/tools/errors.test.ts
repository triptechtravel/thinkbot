import { describe, it, expect, vi, afterEach } from "vitest";
import { sentryTools } from "./errors";

/**
 * The Sentry tool, executed for real against a stubbed `fetch`.
 *
 * It used to REQUIRE a project slug that appears nowhere the agent can see —
 * not in the E2E payload, not in the prompt, not derivable from the repo name.
 * So it guessed, Sentry answered 404, and triage reported "no new Sentry
 * errors": a tool that never ran, presented as a source that came back clean.
 * Observed on 2026-08-22; the real slugs are `campermate-com` and
 * `react-native`.
 */

const env = {
  SENTRY_TOKEN: "tok",
  SENTRY_ORG: "triptech-hy"
} as unknown as Env;

const run = (input: Record<string, unknown>) => {
  const execute = sentryTools(env).sentryIssues.execute as unknown as (
    i: unknown,
    o: unknown
  ) => Promise<{
    scope: string;
    issues: Array<{ project: string; title: string }>;
    note?: string;
  }>;
  return execute(input, {});
};

const iso = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** One issue as the org-wide endpoint returns it — project attached. */
const issue = (over: Record<string, unknown> = {}) => ({
  id: "1",
  title: "Large HTTP payload",
  culprit: "GET /en/poi",
  count: "12",
  userCount: 3,
  firstSeen: iso(10),
  lastSeen: iso(1),
  level: "error",
  permalink: "https://sentry.io/x",
  status: "unresolved",
  project: { slug: "campermate-com" },
  ...over
});

/**
 * A FRESH Response per call. `mockResolvedValue` hands back one object, and a
 * Response body can only be read once — so the second call in a test parsed an
 * already-consumed stream and threw, which looked like a bug in the tool.
 */
function stub(payload: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response(JSON.stringify(payload), { status: 200 })
    );
}

afterEach(() => vi.restoreAllMocks());

describe("sentryIssues", () => {
  it("searches every project when none is named", async () => {
    const spy = stub([issue()]);

    const result = await run({});

    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/organizations/triptech-hy/issues/");
    expect(url).not.toContain("/projects/");
    expect(result.scope).toMatch(/every project/);
  });

  it("names the project each issue came from", async () => {
    // The whole point of dropping the required slug: the answer must still say
    // where the exception was, or it is unactionable.
    stub([issue(), issue({ id: "2", project: { slug: "react-native" } })]);

    const result = await run({});

    expect(result.issues.map((i) => i.project)).toEqual([
      "campermate-com",
      "react-native"
    ]);
  });

  it("still queries one project directly when the slug is known", async () => {
    const spy = stub([issue()]);

    await run({ project: "campermate-com" });

    expect(String(spy.mock.calls[0][0])).toContain(
      "/projects/triptech-hy/campermate-com/issues/"
    );
  });

  /**
   * `withinMinutes` can now exceed a day — the report carries the run's start
   * time, and a delayed or replayed one is hours old. A hardcoded 24h period
   * would silently exclude the window being asked about.
   */
  it("widens the Sentry period to cover the window asked for", async () => {
    const spy = stub([]);

    await run({ withinMinutes: 60 });
    await run({ withinMinutes: 300 });
    await run({ withinMinutes: 3 * 24 * 60 });
    await run({ withinMinutes: 30 * 24 * 60 });

    const periods = spy.mock.calls.map((c) =>
      new URL(String(c[0])).searchParams.get("statsPeriod")
    );
    expect(periods).toEqual(["1h", "24h", "7d", "14d"]);
  });

  it("filters to issues that are actually new in the window", async () => {
    stub([
      issue({ id: "old", firstSeen: iso(10_000), lastSeen: iso(1) }),
      issue({ id: "new", firstSeen: iso(5), lastSeen: iso(1) })
    ]);

    const result = await run({ withinMinutes: 120 });

    expect(result.issues).toHaveLength(1);
    expect(result.note).toBeUndefined();
  });

  it("says so plainly when nothing new fired", async () => {
    stub([]);

    const result = await run({ withinMinutes: 120 });

    expect(result.issues).toHaveLength(0);
    expect(result.note).toMatch(/No new issues/);
  });

  it("does not put the string 'undefined' in the URL when the org is unset", async () => {
    stub([]);
    const execute = sentryTools({ SENTRY_TOKEN: "t" } as unknown as Env)
      .sentryIssues.execute as unknown as (
      i: unknown,
      o: unknown
    ) => Promise<unknown>;

    await expect(execute({}, {})).rejects.toThrow(/SENTRY_ORG/);
  });
});
