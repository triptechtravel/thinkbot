/**
 * Which correlation tools this deployment offers, and why.
 *
 * The tool set used to be a literal in `runOpsTurn` — five factories spread
 * into one object. That is fine for the deployment it was written for and
 * wrong for anyone else: this repo is meant to be run against someone else's
 * estate, and theirs has no clawdwatch, or no Datadog, or a Sentry and nothing
 * else. Adopting it meant editing the agent to delete tools you do not have.
 *
 * So a provider declares itself — a name, what it needs, and how to build its
 * tools — and the set is composed at call time from configuration.
 *
 * THE RULE THAT MATTERS: AN UNCONFIGURED PROVIDER IS NOT OFFERED
 *
 * Not offered, rather than offered and failing. This is the lesson Rollbar
 * taught this deployment the expensive way. Its token was invalid for months,
 * so every triage turn spent one of its handful of steps calling a tool that
 * could only answer 403 — and once the prompt was told to report tools that
 * failed, every write-up carried "Rollbar could not be checked" as though it
 * were a finding. A tool that cannot answer costs a step AND a sentence, every
 * single time, forever.
 *
 * Declaring `requires` makes that structural: a provider missing its
 * credentials never reaches the model, so the model never spends a step on it
 * and never has to explain it.
 *
 * WHY A LIST AND NOT A DIRECTORY SCAN
 *
 * Workers have no filesystem and no dynamic import at runtime, so "drop a file
 * in and it is found" is not available. This list IS the registration. Adding a
 * provider is one import and one entry.
 */

import type { ToolSet } from "ai";
import { clawdwatchTools } from "./clawdwatch";
import { githubTools } from "./github";
import { datadogTools } from "./datadog";
import { workerTools } from "./workers";
import { sentryTools } from "./errors";

export interface ToolProvider {
  /** Stable id used in the `TOOLS` setting. Lowercase, no spaces. */
  name: string;
  /** One line, for the log and the docs. */
  summary: string;
  /**
   * Env vars this provider cannot work without. Named rather than inferred so
   * a deployment can be told what is missing instead of discovering it as a
   * silent absence — the failure mode this repo keeps rediscovering.
   */
  requires: string[];
  /** Build the tools. Only called when `requires` are all present. */
  build: (env: Env) => ToolSet;
}

export const PROVIDERS: readonly ToolProvider[] = [
  {
    name: "clawdwatch",
    summary: "Synthetic uptime checks: is it still failing, and has it before?",
    requires: ["MONITORING_URL"],
    build: clawdwatchTools
  },
  {
    name: "github",
    summary: "Merged pull requests and workflow runs — what changed, and when.",
    requires: ["GITHUB_TOKEN", "GITHUB_OWNER"],
    build: githubTools
  },
  {
    name: "datadog",
    summary: "Metrics and monitors: a spike, a step change, or normal.",
    requires: ["DD_API_KEY", "DD_APP_KEY"],
    build: datadogTools
  },
  {
    name: "workers",
    summary:
      "Cloudflare Worker invocation telemetry — the only source that sees a response start fast and never finish.",
    requires: ["CF_ACCOUNT_ID", "CF_API_TOKEN"],
    build: workerTools
  },
  {
    name: "sentry",
    summary: "Exceptions, and whether one is NEW inside the failure window.",
    requires: ["SENTRY_TOKEN", "SENTRY_ORG"],
    build: sentryTools
  }
];

/** Env vars a provider is missing. Empty means it can run. */
export function missing(provider: ToolProvider, env: Env): string[] {
  const record = env as unknown as Record<string, unknown>;
  return provider.requires.filter((key) => {
    const value = record[key];
    return typeof value !== "string" || value.trim() === "";
  });
}

export interface Selection {
  /** Providers that will be offered to the model. */
  enabled: ToolProvider[];
  /** Named in `TOOLS` (or default) but unusable, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Read the `TOOLS` setting.
 *
 * Unset means every provider this deployment is credentialed for, which keeps
 * a fresh install working with no configuration at all — the setting exists to
 * NARROW, not to opt in.
 *
 * Names may be prefixed with `-` to remove them from that default. Mixing bare
 * names and removals is an inclusion list with the removals taken out, which
 * reads oddly but is what someone writing `github,-github` meant to be told
 * about rather than to have silently resolved.
 */
function parse(setting: string | undefined): {
  include: string[];
  exclude: string[];
} {
  const parts = (setting ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  return {
    include: parts.filter((p) => !p.startsWith("-")),
    exclude: parts.filter((p) => p.startsWith("-")).map((p) => p.slice(1))
  };
}

/**
 * Decide which providers run, and record why the others do not.
 *
 * Never throws. A deployment with a typo in `TOOLS`, or with half its
 * credentials, still triages with what it has — an alert that arrives with
 * fewer sources beats one that does not arrive.
 */
export function selectProviders(env: Env): Selection {
  const { include, exclude } = parse(env.TOOLS);
  const known = new Set(PROVIDERS.map((p) => p.name));

  const enabled: ToolProvider[] = [];
  const skipped: Selection["skipped"] = [];

  // A name nobody recognises is almost always a typo, and its effect — a tool
  // quietly absent — is indistinguishable from a deliberate choice. Say it.
  for (const name of [...include, ...exclude]) {
    if (!known.has(name)) {
      skipped.push({
        name,
        reason: "unknown provider — check the TOOLS setting"
      });
    }
  }

  for (const provider of PROVIDERS) {
    if (include.length > 0 && !include.includes(provider.name)) continue;
    if (exclude.includes(provider.name)) {
      skipped.push({ name: provider.name, reason: "excluded by TOOLS" });
      continue;
    }

    const absent = missing(provider, env);
    if (absent.length > 0) {
      skipped.push({
        name: provider.name,
        reason: `not configured — ${absent.join(", ")} unset`
      });
      continue;
    }

    enabled.push(provider);
  }

  return { enabled, skipped };
}

/**
 * The tool set for one turn.
 *
 * Logged once per turn rather than once per isolate: a turn that found nothing
 * is a completely different event depending on whether it had four sources or
 * one, and that has to be recoverable from the logs afterwards.
 */
export function composeTools(env: Env): ToolSet {
  const { enabled, skipped } = selectProviders(env);

  console.log(
    `[tools] ${enabled.map((p) => p.name).join(", ") || "none"}` +
      (skipped.length
        ? ` | skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`
        : "")
  );

  return enabled.reduce<ToolSet>(
    (all, provider) => ({ ...all, ...provider.build(env) }),
    {}
  );
}
