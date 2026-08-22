/**
 * GitHub — "what changed just before this broke?"
 *
 * The single most useful correlation signal: most outages follow a deploy.
 * Returns merged PRs and workflow runs in a window, nothing else.
 */

import { tool } from "ai";
import { z } from "zod";
import { clip, fetchJson, NotConfiguredError, since } from "./shared";

const API = "https://api.github.com";

interface PullRequest {
  number: number;
  title: string;
  merged_at: string | null;
  user: { login: string } | null;
  html_url: string;
}

interface WorkflowRun {
  name: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "thinkbot"
  };
}

export function githubTools(env: Env) {
  // Resolved lazily, like the token: a missing owner should surface as a clear
  // "not configured" rather than as `undefined` inside a request URL, which
  // reads as a 404 and sends triage looking for a deleted repo.
  function owner(): string {
    if (!env.GITHUB_OWNER)
      throw new NotConfiguredError("GitHub", "GITHUB_OWNER");
    return env.GITHUB_OWNER;
  }

  function token(): string {
    if (!env.GITHUB_TOKEN)
      throw new NotConfiguredError("GitHub", "GITHUB_TOKEN");
    return env.GITHUB_TOKEN;
  }

  return {
    recentDeploys: tool({
      description:
        "Pull requests merged recently in a repository. Use this first when something breaks — most outages follow a deploy. Returns what merged, when, and by whom.",
      inputSchema: z.object({
        repo: z
          .string()
          .describe('Repository name without the owner, e.g. "api-server"'),
        withinMinutes: z
          .number()
          .optional()
          .describe("How far back to look. Default 120.")
      }),
      execute: async ({ repo, withinMinutes = 120 }) => {
        const cutoff = since(withinMinutes);
        // Closed PRs sorted by update time; merged ones are a subset.
        const prs = await fetchJson<PullRequest[]>(
          `${API}/repos/${owner()}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=20`,
          { headers: headers(token()) },
          "GitHub pulls"
        );

        const merged = prs
          .filter((p) => p.merged_at && p.merged_at >= cutoff)
          .map((p) => ({
            number: p.number,
            title: clip(p.title, 120),
            mergedAt: p.merged_at,
            author: p.user?.login ?? null,
            url: p.html_url
          }));

        return {
          repo: `${owner()}/${repo}`,
          windowMinutes: withinMinutes,
          merged,
          note:
            merged.length === 0 ? "Nothing merged in this window." : undefined
        };
      }
    }),

    recentWorkflowRuns: tool({
      description:
        "Recent CI/deploy workflow runs for a repository. Use when a deploy may have failed or partially applied, rather than a code change being at fault.",
      inputSchema: z.object({
        repo: z.string(),
        withinMinutes: z.number().optional().describe("Default 120."),
        onlyFailures: z.boolean().optional()
      }),
      execute: async ({ repo, withinMinutes = 120, onlyFailures = false }) => {
        const cutoff = since(withinMinutes);
        const data = await fetchJson<{ workflow_runs: WorkflowRun[] }>(
          `${API}/repos/${owner()}/${repo}/actions/runs?per_page=20`,
          { headers: headers(token()) },
          "GitHub workflow runs"
        );

        const runs = data.workflow_runs
          .filter((r) => r.created_at >= cutoff)
          .filter((r) => !onlyFailures || r.conclusion === "failure")
          .map((r) => ({
            name: r.name,
            branch: r.head_branch,
            status: r.status,
            conclusion: r.conclusion,
            at: r.created_at,
            url: r.html_url
          }));

        return {
          repo: `${owner()}/${repo}`,
          windowMinutes: withinMinutes,
          runs
        };
      }
    })
  };
}
