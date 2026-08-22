import { describe, it, expect, vi, afterEach } from "vitest";
import { workerTools } from "./workers";

/**
 * The real tool, executed against a stubbed `fetch`.
 *
 * Same shape as the agent worker's `tools-execute.test.ts`: run the actual
 * `execute` — schema, both queries, the reduction and the verdict — rather
 * than re-implementing any of it in the test. What is faked is the network and
 * nothing else, so a change to how the response is parsed fails here.
 *
 * The fixtures are the real API's shape, taken from a live query against the
 * `campermate` worker on 2026-08-22, not invented.
 */

const env = {
  CF_ACCOUNT_ID: "acct",
  CF_API_TOKEN: "tok"
} as unknown as Env;

const run = (input: { script: string; minutes: number }) => {
  const execute = workerTools(env).workerHealth.execute as unknown as (
    input: unknown,
    options: unknown
  ) => Promise<{
    invocations: number;
    outcomes: Record<string, number>;
    wallTimeMs: { p50: number | null; p99: number | null; max: number | null };
    cpuTimeMs: { p99: number | null; max: number | null };
    verdict: string;
  }>;
  return execute(input, {});
};

/** The grouped-count response, as the API returns it. */
const outcomes = (groups: Record<string, number>) => ({
  result: {
    calculations: [
      {
        alias: "n",
        aggregates: Object.entries(groups).map(([groupKey, value]) => ({
          groupKey,
          value
        }))
      }
    ]
  }
});

/** The ungrouped timing response. */
const timings = (values: Record<string, number>) => ({
  result: {
    calculations: Object.entries(values).map(([alias, value]) => ({
      alias,
      aggregates: [{ value }]
    }))
  }
});

/**
 * The two queries are issued with Promise.all, so their completion order is
 * not guaranteed. Route by body rather than by call index — keying on order
 * made this pass while asserting nothing.
 */
function stubFetch(
  grouped: Record<string, number>,
  timing: Record<string, number>
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const body = String((init as RequestInit).body);
      const payload = body.includes("groupBys")
        ? outcomes(grouped)
        : timings(timing);
      return new Response(JSON.stringify(payload), { status: 200 });
    });
}

afterEach(() => vi.restoreAllMocks());

describe("workerHealth", () => {
  /**
   * The incident this tool was built for. These are the real numbers from the
   * 2026-08-22 POI stall: minutes of wall against milliseconds of CPU.
   */
  it("calls a stall a stall, not slowness", async () => {
    stubFetch(
      { ok: 1734, canceled: 13 },
      { wallP50: 240, wallP99: 52708, wallMax: 59971, cpuP99: 117, cpuMax: 159 }
    );

    const result = await run({ script: "campermate", minutes: 60 });

    expect(result.verdict).toMatch(/STALLED/);
    // The ratio is the whole argument, so it has to be in the text a model
    // reads — not left as two numbers for it to divide.
    expect(result.verdict).toMatch(/450:1|4\d\d:1/);
    expect(result.verdict).toMatch(/NOT slow code/);
    // And it must contradict the green uptime check explicitly, because that
    // is the evidence the wrong answer was built on.
    expect(result.verdict).toMatch(/unhealthy/i);
  });

  it("calls genuine slowness slow, not stalled", async () => {
    // High wall, but CPU in proportion — the worker is working, not waiting.
    stubFetch(
      { ok: 500 },
      {
        wallP50: 8000,
        wallP99: 12000,
        wallMax: 14000,
        cpuP99: 9000,
        cpuMax: 11000
      }
    );

    const result = await run({ script: "campermate", minutes: 60 });

    expect(result.verdict).toMatch(/SLOW/);
    expect(result.verdict).not.toMatch(/STALLED/);
  });

  it("reports a healthy worker without hedging", async () => {
    stubFetch(
      { ok: 60551 },
      { wallP50: 210, wallP99: 900, wallMax: 1400, cpuP99: 300, cpuMax: 800 }
    );

    const result = await run({ script: "campermate", minutes: 60 });

    expect(result.verdict).toMatch(/^Healthy/);
    expect(result.invocations).toBe(60551);
  });

  it("names the non-ok outcomes and their share", async () => {
    stubFetch(
      { ok: 900, canceled: 90, exceededMemory: 10 },
      { wallP50: 200, wallP99: 800, wallMax: 900, cpuP99: 150, cpuMax: 300 }
    );

    const result = await run({ script: "campermate", minutes: 60 });

    expect(result.verdict).toMatch(/100 of 1000/);
    expect(result.verdict).toMatch(/10\.0%/);
    expect(result.verdict).toMatch(/canceled=90/);
    expect(result.verdict).toMatch(/exceededMemory=10/);
  });

  /**
   * Silence is not health. A worker with no invocations tells you nothing
   * about the site, and reporting it as "all ok" would be the same class of
   * error the prompt now forbids.
   */
  it("does not report an empty window as healthy", async () => {
    stubFetch({}, {});

    const result = await run({ script: "campermate", minutes: 5 });

    expect(result.invocations).toBe(0);
    expect(result.verdict).toMatch(/served nothing/);
    expect(result.verdict).not.toMatch(/Healthy/);
  });

  it("filters to the named script and the asked-for window", async () => {
    const fetchSpy = stubFetch(
      { ok: 1 },
      { wallP50: 1, wallP99: 1, cpuP99: 1 }
    );

    await run({ script: "thinkbot", minutes: 15 });

    const bodies = fetchSpy.mock.calls.map((c) =>
      JSON.parse(String((c[1] as RequestInit).body))
    );
    for (const body of bodies) {
      expect(body.parameters.filters[0]).toMatchObject({
        key: "$workers.scriptName",
        value: "thinkbot"
      });
      const spanMinutes = (body.timeframe.to - body.timeframe.from) / 60_000;
      expect(spanMinutes).toBe(15);
    }
  });

  /** A half-configured deployment answers what it can; it does not crash. */
  it("says it is not configured rather than throwing something opaque", async () => {
    const execute = workerTools({} as Env).workerHealth.execute as unknown as (
      i: unknown,
      o: unknown
    ) => Promise<unknown>;

    await expect(
      execute({ script: "campermate", minutes: 60 }, {})
    ).rejects.toThrow(/CF_ACCOUNT_ID and CF_API_TOKEN/);
  });
});
