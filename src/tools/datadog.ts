/**
 * Datadog — "is this a spike, a step change, or normal?"
 *
 * Datadog holds the long history clawdwatch does not: it keeps 48 hours, so
 * anything about baselines has to come from here.
 *
 * Series are summarised rather than returned point by point. A day of
 * per-minute data is thousands of numbers, and a model reasons better about
 * "3.2× the previous hour" than about the raw array.
 */

import { tool } from "ai";
import { z } from "zod";
import { clip, fetchJson, NotConfiguredError } from "./shared";

const API = "https://api.datadoghq.com/api";

interface SeriesPoint {
  0: number;
  1: number | null;
}

interface QueryResponse {
  series?: Array<{
    metric: string;
    scope: string;
    pointlist: SeriesPoint[];
  }>;
  error?: string;
}

interface MonitorSummary {
  id: number;
  name: string;
  overall_state: string;
  message?: string;
  modified?: string;
}

function headers(env: Env): Record<string, string> {
  if (!env.DD_API_KEY || !env.DD_APP_KEY) {
    throw new NotConfiguredError("Datadog", "DD_API_KEY and DD_APP_KEY");
  }
  return {
    "DD-API-KEY": env.DD_API_KEY,
    "DD-APPLICATION-KEY": env.DD_APP_KEY
  };
}

/** Reduce a point list to the few numbers a decision actually rests on. */
function summarise(points: SeriesPoint[]) {
  const values = points.map((p) => p[1]).filter((v): v is number => v !== null);
  if (values.length === 0) return null;

  const sum = values.reduce((a, b) => a + b, 0);
  const half = Math.floor(values.length / 2);
  const earlier = values.slice(0, half);
  const later = values.slice(half);
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  const firstHalf = avg(earlier);
  const secondHalf = avg(later);

  return {
    points: values.length,
    total: Math.round(sum * 100) / 100,
    max: Math.max(...values),
    avg: Math.round((sum / values.length) * 100) / 100,
    firstHalfAvg: Math.round(firstHalf * 100) / 100,
    secondHalfAvg: Math.round(secondHalf * 100) / 100,
    // The number that actually answers "is this unusual?"
    changeRatio:
      firstHalf > 0 ? Math.round((secondHalf / firstHalf) * 100) / 100 : null
  };
}

export function datadogTools(env: Env) {
  return {
    datadogQuery: tool({
      description:
        'Query a Datadog metric over a time window and get a summary — total, max, average, and how the second half compares with the first. Use this to tell a genuine spike from normal variation. Example queries: "sum:cloudflare.worker.errors{worker:images}.as_count()", "avg:trace.http.request.duration{service:api}".',
      inputSchema: z.object({
        query: z.string().describe("A Datadog metric query"),
        withinMinutes: z
          .number()
          .optional()
          .describe("Window ending now. Default 120.")
      }),
      execute: async ({ query, withinMinutes = 120 }) => {
        const to = Math.floor(Date.now() / 1000);
        const from = to - withinMinutes * 60;

        const data = await fetchJson<QueryResponse>(
          `${API}/v1/query?from=${from}&to=${to}&query=${encodeURIComponent(query)}`,
          { headers: headers(env) },
          "Datadog query"
        );

        if (data.error) return { query, error: data.error };
        if (!data.series?.length) {
          return {
            query,
            windowMinutes: withinMinutes,
            series: [],
            note: "No data for this query."
          };
        }

        return {
          query,
          windowMinutes: withinMinutes,
          series: data.series.slice(0, 5).map((s) => ({
            metric: s.metric,
            scope: s.scope,
            ...summarise(s.pointlist)
          }))
        };
      }
    }),

    datadogMonitors: tool({
      description:
        "Datadog monitors that are currently alerting or warning. Use this to see whether something else noticed the same problem, or whether an anomaly monitor fired around the same time.",
      inputSchema: z.object({
        onlyTriggered: z.boolean().optional().describe("Default true.")
      }),
      execute: async ({ onlyTriggered = true }) => {
        const data = await fetchJson<MonitorSummary[]>(
          `${API}/v1/monitor?with_downtimes=false`,
          { headers: headers(env) },
          "Datadog monitors"
        );

        const rows = data
          .filter(
            (m) =>
              !onlyTriggered ||
              ["Alert", "Warn", "No Data"].includes(m.overall_state)
          )
          .map((m) => ({
            id: m.id,
            name: clip(m.name, 100),
            state: m.overall_state,
            modified: m.modified
          }));

        return {
          triggered: rows.length,
          monitors: rows.slice(0, 20),
          note: rows.length === 0 ? "No monitors are alerting." : undefined
        };
      }
    })
  };
}
