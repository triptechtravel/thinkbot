/**
 * Sentry and Rollbar — "did a new exception appear at the same moment?"
 *
 * The two error trackers share a shape, so they share a file. What matters
 * for correlation is not the whole issue list but the ones that are *new* or
 * *regressed* inside the failure window: an exception that has been firing all
 * week is unlikely to explain an outage that started twenty minutes ago.
 */

import { tool } from "ai";
import { z } from "zod";
import { clip, fetchJson, NotConfiguredError, since } from "./shared";

// ── Sentry ───────────────────────────────────────────────────────────────

interface SentryIssue {
  id: string;
  title: string;
  culprit: string | null;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  level: string;
  permalink: string;
  status: string;
  /** Present on the organization-wide endpoint, absent on the per-project one. */
  project?: { slug?: string };
}

/**
 * Sentry wants a period, not a number of minutes, and rejects anything it does
 * not recognise. Round UP to the next supported bucket so the window always
 * contains the failure, then filter precisely on `lastSeen` afterwards.
 */
function statsPeriod(minutes: number): string {
  if (minutes <= 60) return "1h";
  if (minutes <= 24 * 60) return "24h";
  if (minutes <= 7 * 24 * 60) return "7d";
  return "14d";
}

export function sentryTools(env: Env) {
  // Lazy for the same reason as the token: an unset org must not become the
  // string "undefined" in a Sentry URL.
  function org(): string {
    if (!env.SENTRY_ORG) throw new NotConfiguredError("Sentry", "SENTRY_ORG");
    return env.SENTRY_ORG;
  }

  return {
    sentryIssues: tool({
      description:
        "Sentry issues seen recently, newest first. Use after a failure to check whether a new exception appeared at the same time. An issue that first appeared inside the failure window is far more interesting than a long-standing one. Searches EVERY project in the organisation unless you name one — do not guess a project slug.",
      inputSchema: z.object({
        project: z
          .string()
          .optional()
          .describe(
            'Sentry project slug, exactly as it appears in the Sentry URL. Omit this unless you already know the slug — omitting it searches every project and each result says which one it came from. A wrong slug returns 404, which looks exactly like "no errors".'
          ),
        withinMinutes: z.number().optional().describe("Default 120."),
        onlyNew: z
          .boolean()
          .optional()
          .describe("Only issues first seen inside the window. Default true.")
      }),
      execute: async ({ project, withinMinutes = 120, onlyNew = true }) => {
        if (!env.SENTRY_TOKEN)
          throw new NotConfiguredError("Sentry", "SENTRY_TOKEN");
        const cutoff = since(withinMinutes);

        // Organisation-wide by default. Naming a project was the only way to
        // call this, and the slug is not in the payload, the prompt or the
        // repo name — so the model guessed, guessed wrong, and Sentry answered
        // 404. Triage then reported "no new Sentry errors", which is the exact
        // failure the prompt now forbids: a tool that never ran, presented as
        // a source that came back clean.
        const url = project
          ? `https://sentry.io/api/0/projects/${org()}/${project}/issues/`
          : `https://sentry.io/api/0/organizations/${org()}/issues/`;

        const issues = await fetchJson<SentryIssue[]>(
          `${url}?statsPeriod=${statsPeriod(withinMinutes)}&query=${encodeURIComponent("is:unresolved")}&limit=25`,
          { headers: { Authorization: `Bearer ${env.SENTRY_TOKEN}` } },
          "Sentry issues"
        );

        const rows = issues
          .filter((i) => i.lastSeen >= cutoff)
          .filter((i) => !onlyNew || i.firstSeen >= cutoff)
          .map((i) => ({
            // Named per row: without a slug in the request, the answer must
            // still say which project each exception came from.
            project: i.project?.slug ?? project ?? org(),
            title: clip(i.title, 140),
            culprit: clip(i.culprit, 100),
            level: i.level,
            events: Number(i.count),
            users: i.userCount,
            firstSeen: i.firstSeen,
            lastSeen: i.lastSeen,
            url: i.permalink
          }));

        return {
          scope: project ? `project ${project}` : `every project in ${org()}`,
          windowMinutes: withinMinutes,
          issues: rows.slice(0, 10),
          note:
            rows.length === 0
              ? onlyNew
                ? "No new issues in this window — the cause is probably not a fresh exception."
                : "No activity in this window."
              : undefined
        };
      }
    })
  };
}

// ── Rollbar ──────────────────────────────────────────────────────────────

interface RollbarItem {
  id: number;
  counter: number;
  title: string;
  level: string;
  environment: string;
  total_occurrences: number;
  first_occurrence_timestamp: number;
  last_occurrence_timestamp: number;
  status: string;
}

export function rollbarTools(env: Env) {
  return {
    rollbarItems: tool({
      description:
        "Recent Rollbar items for the legacy applications, newest activity first. Same purpose as sentryIssues: find an error that started when the failure did.",
      inputSchema: z.object({
        withinMinutes: z.number().optional().describe("Default 120."),
        onlyNew: z
          .boolean()
          .optional()
          .describe("Only items first seen inside the window. Default true.")
      }),
      execute: async ({ withinMinutes = 120, onlyNew = true }) => {
        if (!env.ROLLBAR_TOKEN)
          throw new NotConfiguredError("Rollbar", "ROLLBAR_TOKEN");
        const cutoffSeconds = Math.floor(
          (Date.now() - withinMinutes * 60_000) / 1000
        );

        const data = await fetchJson<{ result: { items: RollbarItem[] } }>(
          "https://api.rollbar.com/api/1/items/?status=active&limit=25",
          { headers: { "X-Rollbar-Access-Token": env.ROLLBAR_TOKEN } },
          "Rollbar items"
        );

        const rows = (data.result?.items ?? [])
          .filter((i) => i.last_occurrence_timestamp >= cutoffSeconds)
          .filter(
            (i) => !onlyNew || i.first_occurrence_timestamp >= cutoffSeconds
          )
          .map((i) => ({
            title: clip(i.title, 140),
            level: i.level,
            environment: i.environment,
            occurrences: i.total_occurrences,
            firstSeen: new Date(
              i.first_occurrence_timestamp * 1000
            ).toISOString(),
            lastSeen: new Date(i.last_occurrence_timestamp * 1000).toISOString()
          }));

        return {
          windowMinutes: withinMinutes,
          items: rows.slice(0, 10),
          note:
            rows.length === 0
              ? "No matching Rollbar activity in this window."
              : undefined
        };
      }
    })
  };
}
