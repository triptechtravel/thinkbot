/**
 * Cloudflare Workers observability — "was the SITE actually serving?"
 *
 * This tool exists because of a specific wrong answer. On 2026-08-22 the
 * nightly E2E suite failed on three POI specs, and triage — run twice, on two
 * different models, eight turns between them — concluded every single time
 * that the site was healthy and the tests were flaky. The site was not
 * healthy. POI renders were stalling for 40-60 seconds and the HTML stream was
 * being truncated, on roughly a third of cold requests.
 *
 * Neither model was at fault. Every source they could reach agreed with them:
 * no PR merged in the window, no new Sentry issue, no Datadog alert, and the
 * uptime checks — which fetch a page and get a 200 with a fast first byte —
 * looked perfect. The evidence lived in exactly one place none of them could
 * see, the Worker's own invocation telemetry, where the failure is unmistakable:
 *
 *     wallTime 59971ms, cpuTime 117ms, outcome canceled
 *
 * That shape — minutes of wall against milliseconds of CPU — cannot be
 * anything but a request stalled on I/O that never came back. No amount of
 * model quality substitutes for the number, which is why this is a tool and
 * not a better prompt.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not return log lines. A busy Worker produces thousands per minute,
 * they are paid for in context on every later turn, and they carry request
 * URLs and headers. The aggregate answers the question a triage turn actually
 * has — "is this worker healthy right now, and if not, how is it unhealthy" —
 * without moving any of that.
 */

import { tool } from "ai";
import { z } from "zod";
import { fetchJson, NotConfiguredError } from "./shared";

const API = "https://api.cloudflare.com/client/v4";

/** The dataset holding one record per Worker invocation. */
const DATASET = "cloudflare-workers";

/**
 * Above this, a request is not slow — it is stuck. Cloudflare's own hang
 * detector fires around here, and the stalls that prompted this tool sat at
 * 40-60s while healthy renders on the same worker finished inside 1s.
 */
const STALL_WALL_MS = 10_000;

/**
 * Wall/CPU ratio that means "waiting", not "working". A render doing real work
 * spends CPU roughly in proportion to its wall time; the observed stalls ran
 * 500:1. Set far below that so the check is a floor, not a fingerprint of one
 * incident.
 */
const STALL_RATIO = 20;

interface Aggregate {
  groupKey?: string;
  value?: number;
}

interface Calculation {
  alias?: string;
  aggregates?: Aggregate[];
}

interface QueryResponse {
  result?: { calculations?: Calculation[] };
}

function credentials(env: Env): { accountId: string; token: string } {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new NotConfiguredError(
      "Cloudflare Workers observability",
      "CF_ACCOUNT_ID and CF_API_TOKEN"
    );
  }
  return { accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN };
}

/** One telemetry query, grouped or ungrouped, reduced to alias → value. */
async function query(
  env: Env,
  script: string,
  minutes: number,
  calculations: Array<Record<string, string>>,
  groupBy?: string
): Promise<Calculation[]> {
  const { accountId, token } = credentials(env);
  const to = Date.now();

  const body = {
    queryId: "thinkbot-worker-health",
    timeframe: { from: to - minutes * 60_000, to },
    limit: 100,
    view: "calculations",
    parameters: {
      datasets: [DATASET],
      filters: [
        {
          key: "$workers.scriptName",
          operation: "eq",
          value: script,
          type: "string"
        }
      ],
      calculations,
      ...(groupBy ? { groupBys: [{ type: "string", value: groupBy }] } : {})
    }
  };

  const response = await fetchJson<QueryResponse>(
    `${API}/accounts/${accountId}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    },
    "Workers observability"
  );

  return response.result?.calculations ?? [];
}

/** Sum every group of a calculation, keyed by group. */
function byGroup(calculations: Calculation[], alias: string) {
  const found = calculations.find((c) => c.alias === alias);
  const out: Record<string, number> = {};
  for (const aggregate of found?.aggregates ?? []) {
    if (aggregate.groupKey === undefined) continue;
    out[aggregate.groupKey] =
      (out[aggregate.groupKey] ?? 0) + (aggregate.value ?? 0);
  }
  return out;
}

/** A single ungrouped number. */
function scalar(calculations: Calculation[], alias: string): number | null {
  const found = calculations.find((c) => c.alias === alias);
  const value = found?.aggregates?.[0]?.value;
  return typeof value === "number" ? Math.round(value) : null;
}

/**
 * The interpretation, stated rather than left as arithmetic.
 *
 * The numbers alone did not stop two models concluding "site healthy" — they
 * never had them, but a model that DOES have them can still read
 * "p99 wall 52000" as ordinary slowness. Naming the shape is the point of the
 * tool: high wall against low CPU is not slow, it is stuck, and the two call
 * for completely different responses.
 */
function verdict(
  outcomes: Record<string, number>,
  wallP99: number | null,
  cpuP99: number | null
): string {
  const total = Object.values(outcomes).reduce((a, b) => a + b, 0);
  if (total === 0)
    return "No invocations in this window — the worker served nothing.";

  const bad = total - (outcomes.ok ?? 0);
  const notes: string[] = [];

  if (wallP99 !== null && wallP99 >= STALL_WALL_MS) {
    const stalling =
      cpuP99 !== null && cpuP99 > 0 && wallP99 / cpuP99 >= STALL_RATIO;
    notes.push(
      stalling
        ? `STALLED: p99 wall ${wallP99}ms against p99 CPU ${cpuP99}ms — ${Math.round(
            wallP99 / cpuP99
          )}:1. That is a request waiting on I/O that never returns, NOT slow code. Treat the site as unhealthy however green the uptime checks look.`
        : `SLOW: p99 wall ${wallP99}ms with p99 CPU ${cpuP99}ms — the worker is doing real work, just a lot of it.`
    );
  }

  if (bad > 0) {
    const share = ((bad / total) * 100).toFixed(1);
    notes.push(
      `${bad} of ${total} invocations (${share}%) did not end 'ok' — ${Object.entries(
        outcomes
      )
        .filter(([k]) => k !== "ok")
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}.`
    );
  }

  if (notes.length === 0) {
    return `Healthy: ${total} invocations, all 'ok', p99 wall ${wallP99 ?? 0}ms.`;
  }
  return notes.join(" ");
}

export function workerTools(env: Env) {
  return {
    workerHealth: tool({
      description:
        "Cloudflare Worker invocation telemetry: outcomes and wall/CPU time for a deployed Worker over the last N minutes. Use this BEFORE concluding that a failing test is a test problem — it is the only source that shows a request stalling or being killed, and it disagrees with uptime checks when a response starts fast and then never finishes. A high wall time against a low CPU time means stuck on I/O, not slow code. The campermate.com site is the worker named 'campermate'.",
      inputSchema: z.object({
        script: z
          .string()
          .describe("Worker name as deployed, e.g. 'campermate'"),
        minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .default(60)
          .describe("How far back to look. Keep it near the failure window.")
      }),
      execute: async ({ script, minutes }) => {
        // Two queries: outcomes need a groupBy, the timing percentiles must not
        // have one or every group reports its own and the shape stops being
        // comparable.
        const [grouped, timings] = await Promise.all([
          query(
            env,
            script,
            minutes,
            [{ operator: "count", alias: "n" }],
            "$workers.outcome"
          ),
          query(env, script, minutes, [
            // `median`, not `p50`. The API accepts median/p25/p90/p95/p99 and
            // rejects p50 outright — with `success:false` and an empty error
            // array, so a wrong operator here fails silently rather than
            // saying why. Verified against the live endpoint; the unit tests
            // stub fetch and cannot see it, which is what workers.itest.ts is
            // for.
            {
              operator: "median",
              key: "$workers.wallTimeMs",
              alias: "wallP50"
            },
            { operator: "p99", key: "$workers.wallTimeMs", alias: "wallP99" },
            { operator: "max", key: "$workers.wallTimeMs", alias: "wallMax" },
            { operator: "p99", key: "$workers.cpuTimeMs", alias: "cpuP99" },
            { operator: "max", key: "$workers.cpuTimeMs", alias: "cpuMax" }
          ])
        ]);

        const outcomes = byGroup(grouped, "n");
        const wallP99 = scalar(timings, "wallP99");
        const cpuP99 = scalar(timings, "cpuP99");

        return {
          script,
          windowMinutes: minutes,
          invocations: Object.values(outcomes).reduce((a, b) => a + b, 0),
          outcomes,
          wallTimeMs: {
            p50: scalar(timings, "wallP50"),
            p99: wallP99,
            max: scalar(timings, "wallMax")
          },
          cpuTimeMs: { p99: cpuP99, max: scalar(timings, "cpuMax") },
          verdict: verdict(outcomes, wallP99, cpuP99)
        };
      }
    })
  };
}
