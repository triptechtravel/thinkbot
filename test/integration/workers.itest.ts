import { describe, it, expect } from "vitest";
import { workerTools } from "../../src/tools/workers";

/**
 * The observability tool against the real Cloudflare API.
 *
 * The unit tests stub `fetch`, so they prove the reduction and the verdict and
 * nothing about whether the request is one the API will accept. That gap is
 * not hypothetical: the first version asked for `p50`, which Cloudflare
 * rejects — returning `success:false` with an EMPTY error array, so the call
 * fails without saying why. Every unit test still passed.
 *
 * This is the only thing that catches an operator or field being renamed.
 *
 *   CF_ACCOUNT_ID=… CF_API_TOKEN=… npm run test:integration
 *
 * The token needs Workers Observability read; `cloudflare/prd` in Doppler has
 * it. Read-only, and it queries an aggregate — no log lines are fetched.
 */

const env = {
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  CF_API_TOKEN: process.env.CF_API_TOKEN
} as unknown as Env;

const configured = Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);

const run = (script: string, minutes: number) => {
  const execute = workerTools(env).workerHealth.execute as unknown as (
    i: unknown,
    o: unknown
  ) => Promise<{
    invocations: number;
    outcomes: Record<string, number>;
    wallTimeMs: { p50: number | null; p99: number | null; max: number | null };
    cpuTimeMs: { p99: number | null; max: number | null };
    verdict: string;
  }>;
  return execute({ script, minutes }, {});
};

describe.skipIf(!configured)("workerHealth against the real API", () => {
  it("returns invocations, outcomes and timings for a live worker", async () => {
    const result = await run("campermate", 60);

    // campermate serves production traffic continuously; a zero here means the
    // filter or the dataset name has drifted, not that the site is idle.
    expect(result.invocations).toBeGreaterThan(0);
    expect(result.outcomes.ok).toBeGreaterThan(0);

    // Every operator must actually have come back. A rejected one leaves its
    // alias null, which is exactly how `p50` failed silently.
    expect(result.wallTimeMs.p50).not.toBeNull();
    expect(result.wallTimeMs.p99).not.toBeNull();
    expect(result.wallTimeMs.max).not.toBeNull();
    expect(result.cpuTimeMs.p99).not.toBeNull();
    expect(result.cpuTimeMs.max).not.toBeNull();

    expect(result.verdict).toBeTruthy();
  }, 60_000);

  it("orders the percentiles the way percentiles must be ordered", async () => {
    // A cheap check that the aliases are not being crossed in the reduction —
    // a mix-up would still populate every field.
    const { wallTimeMs } = await run("campermate", 60);

    expect(wallTimeMs.p50!).toBeLessThanOrEqual(wallTimeMs.p99!);
    expect(wallTimeMs.p99!).toBeLessThanOrEqual(wallTimeMs.max!);
  }, 60_000);

  it("reports an unknown worker as an empty window, not an error", async () => {
    const result = await run("no-such-worker-thinkbot-itest", 60);

    expect(result.invocations).toBe(0);
    expect(result.verdict).toMatch(/served nothing/);
  }, 60_000);
});
