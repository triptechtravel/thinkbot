/**
 * clawdwatch tools.
 *
 * Read-only except `annotate` and `ack`. Every call goes over the public API
 * with an Access service token — there is no shared binding, no coupling, and
 * nothing installed on either side.
 *
 * Responses are deliberately trimmed before reaching the model: a full status
 * dump is mostly noise, and every token of it is paid for on each turn.
 */

import { tool } from "ai";
import { z } from "zod";

interface StatusRow {
  id: string;
  name: string;
  url: string;
  status: string;
  lastError: string | null;
  lastResponseMs: number | null;
  lastCheckAt: string | null;
  downSince: string | null;
  tags: string[];
}

interface IncidentRow {
  id: string;
  checkId: string;
  startedAt: string;
  resolvedAt: string | null;
  durationMs: number | null;
  triggerError: string | null;
  annotation: string | null;
}

class NotConfigured extends Error {
  constructor() {
    super("Monitoring is not configured — MONITORING_URL is unset.");
  }
}

async function call<T>(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!env.MONITORING_URL) throw new NotConfigured();

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined)
  };

  // A service token is only needed for writes and for deployments that put
  // reads behind Access too; sending it always is simpler and harmless.
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }

  const response = await fetch(
    `${env.MONITORING_URL.replace(/\/+$/, "")}${path}`,
    {
      ...init,
      headers
    }
  );

  if (!response.ok) {
    throw new Error(`Monitoring API ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Compact a status row to what a triage decision actually needs. */
function summarise(row: StatusRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    ...(row.lastError ? { error: row.lastError } : {}),
    ...(row.downSince ? { downSince: row.downSince } : {}),
    ...(row.lastResponseMs !== null ? { responseMs: row.lastResponseMs } : {})
  };
}

export function clawdwatchTools(env: Env) {
  return {
    monitoringStatus: tool({
      description:
        'Current status of every monitored endpoint. Use this to answer "is anything down" and to confirm whether an alert is still current.',
      inputSchema: z.object({
        onlyProblems: z
          .boolean()
          .optional()
          .describe(
            "Return only checks that are degraded or down. Default true."
          )
      }),
      execute: async ({ onlyProblems = true }) => {
        const data = await call<{ overall: string; checks: StatusRow[] }>(
          env,
          "/api/status"
        );
        const rows = onlyProblems
          ? data.checks.filter((c) => c.status !== "healthy")
          : data.checks;
        return {
          overall: data.overall,
          total: data.checks.length,
          checks: rows.map(summarise)
        };
      }
    }),

    monitoringHistory: tool({
      description:
        "Recent results for one check. Use this to see whether a failure is a one-off or a pattern, and how latency has moved.",
      inputSchema: z.object({
        checkId: z.string().describe("The check id, from monitoringStatus"),
        limit: z
          .number()
          .optional()
          .describe("How many recent samples. Default 24.")
      }),
      execute: async ({ checkId, limit = 24 }) => {
        const data = await call<{
          results: Array<{
            success: boolean;
            statusCode: number | null;
            responseTimeMs: number;
            error: string | null;
            ranAt: string;
          }>;
        }>(env, `/api/checks/${encodeURIComponent(checkId)}/history`);

        const recent = data.results.slice(-limit);
        const failures = recent.filter((r) => !r.success);
        const latencies = recent
          .filter((r) => r.success)
          .map((r) => r.responseTimeMs);

        return {
          checkId,
          samples: recent.length,
          failures: failures.length,
          firstFailureAt: failures[0]?.ranAt ?? null,
          medianMs:
            latencies.length > 0
              ? latencies.sort((a, b) => a - b)[
                  Math.floor(latencies.length / 2)
                ]
              : null,
          maxMs: latencies.length > 0 ? Math.max(...latencies) : null
        };
      }
    }),

    monitoringIncidents: tool({
      description:
        "Incidents, newest first. Use this to see whether an endpoint has failed before and what was concluded last time.",
      inputSchema: z.object({
        checkId: z.string().optional(),
        openOnly: z.boolean().optional(),
        limit: z.number().optional().describe("Default 5.")
      }),
      execute: async ({ checkId, openOnly, limit = 5 }) => {
        const params = new URLSearchParams({ limit: String(limit) });
        if (checkId) params.set("check_id", checkId);
        if (openOnly) params.set("status", "open");

        const data = await call<{ incidents: IncidentRow[] }>(
          env,
          `/api/incidents?${params}`
        );
        return data.incidents.map((i) => ({
          id: i.id,
          checkId: i.checkId,
          startedAt: i.startedAt,
          resolved: i.resolvedAt !== null,
          durationMs: i.durationMs,
          error: i.triggerError,
          note: i.annotation
        }));
      }
    }),

    annotateIncident: tool({
      description:
        "Record what you found on an incident. Do this whenever you reach a conclusion about a cause — the note appears on the incident in the dashboard, so the explanation outlives the chat.",
      inputSchema: z.object({
        incidentId: z.string(),
        annotation: z
          .string()
          .describe("What you found. Cite the specific evidence, not a guess.")
      }),
      execute: async ({ incidentId, annotation }) => {
        await call(
          env,
          `/api/incidents/${encodeURIComponent(incidentId)}/annotate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ annotation })
          }
        );
        return { ok: true, incidentId };
      }
    }),

    runCheckNow: tool({
      description:
        "Run one check immediately instead of waiting for the schedule. Use this to confirm whether a reported failure is still happening.",
      inputSchema: z.object({ checkId: z.string() }),
      execute: async ({ checkId }) => {
        const result = await call<{
          success: boolean;
          statusCode: number | null;
          responseTimeMs: number;
          error: string | null;
        }>(env, `/api/checks/${encodeURIComponent(checkId)}/run`, {
          method: "POST"
        });
        return result;
      }
    })
  };
}
