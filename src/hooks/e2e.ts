/**
 * The end-to-end test inbox.
 *
 * A CI runner POSTs a signed report here when a Playwright suite fails. This is
 * deliberately NOT a clawdwatch AlertEvent: an E2E run is not a synthetic check.
 * Forging one would mean inventing an incident id and signed `links` that point
 * at nothing in clawdwatch's database, and the triage prompt would then ask the
 * agent to annotate an incident that does not exist.
 *
 * The split of work is the point. The runner holds evidence no Worker can
 * reach — which specs failed, what the assertions said, where the trace
 * artefact is. thinkbot holds the credentials the runner should not — GitHub,
 * Sentry, Datadog — and the question worth answering: what changed
 * around this commit.
 *
 * Verification reuses clawdwatch's `verifySignature`, which is the same
 * construction (HMAC-SHA256 over `timestamp.body`, with a staleness window),
 * under thinkbot's own header names and its own secret. A CI runner is a
 * different sender in a different trust domain from the monitoring Worker, so
 * it gets a different key: leaking one must not grant the other.
 */

import { verifySignature } from "clawdwatch";

export const E2E_SIGNATURE_HEADER = "x-thinkbot-signature";
export const E2E_TIMESTAMP_HEADER = "x-thinkbot-timestamp";

/** The payload version this build understands. */
export const E2E_SCHEMA_VERSION = 1;

/** One failing spec, as the reporter saw it. */
export interface E2eFailure {
  /** Full title, suite path included. */
  title: string;
  /** Playwright projects it failed under, e.g. ['desktop-chrome']. */
  projects?: string[];
  /** First lines of the assertion error, if the reporter captured them. */
  error?: string;
}

export interface E2eReport {
  schemaVersion?: number;
  /**
   * A delivery test, not an incident. Reported over the same route on purpose:
   * a probe that took a different path through the code would prove that path
   * works and nothing about the one a real failure takes.
   */
  probe?: boolean;
  /** owner/repo, so the agent knows where to look for what changed. */
  repo: string;
  /** Commit the suite ran against. */
  sha: string;
  ref?: string;
  workflow?: string;
  /** `schedule`, `push`, `workflow_dispatch`. */
  trigger?: string;
  /**
   * ISO-8601 time the run began.
   *
   * Triage asks the Worker's own telemetry whether the site was healthy, and
   * that query is a time WINDOW. Without this the agent can only ask about
   * "now" — correct when a report arrives seconds after the failure, wrong for
   * a queue backlog, a retry, or a recorded report replayed through the
   * harness, where it cheerfully reports the health of some later hour.
   *
   * Optional: a runner predating the field omits it, and the prompt then says
   * nothing about windows rather than asserting a wrong one.
   */
  startedAt?: string;
  /** The site under test. */
  baseUrl?: string;
  runUrl?: string;
  /**
   * Set when the suite never ran — a spec failed to import, the config threw.
   * Mutually informative with `failures`: a load error with no failures means
   * nothing was tested, which is a different incident from tests failing.
   */
  loadError?: string | null;
  failures?: E2eFailure[];
  passed?: number;
  skipped?: number;
}

export function e2eInboxConfigured(env: Env): boolean {
  return Boolean(env.E2E_WEBHOOK_SECRET);
}

export async function verifyE2eReport(
  request: Request,
  body: string,
  env: Env
): Promise<boolean> {
  if (!env.E2E_WEBHOOK_SECRET) return false;
  return verifySignature({
    secret: env.E2E_WEBHOOK_SECRET,
    body,
    signature: request.headers.get(E2E_SIGNATURE_HEADER),
    timestamp: request.headers.get(E2E_TIMESTAMP_HEADER)
  });
}

/**
 * Reject a payload that is not shaped like a report before spending a model
 * turn on it. A valid signature proves the sender holds the key, not that it
 * sent something sensible.
 */
export function isE2eReport(value: unknown): value is E2eReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  return typeof report.repo === "string" && typeof report.sha === "string";
}

/**
 * Same contract as clawdwatch's: additive fields never bump the version, so a
 * higher number means something was removed or changed meaning. Degrade and
 * say so rather than refusing — a CI change must not silence triage.
 */
function schemaNotice(report: E2eReport): string[] {
  const version = report.schemaVersion;
  if (typeof version !== "number" || version <= E2E_SCHEMA_VERSION) return [];

  return [
    `NOTE: this report uses payload schema v${version}, newer than the ` +
      `v${E2E_SCHEMA_VERSION} this build knows. Some detail may be missing ` +
      "from the summary above — prefer the run link over anything you infer."
  ];
}

/**
 * Tell the agent when the run was, in the units its tools take.
 *
 * `workerHealth` and the Datadog tools all take "how many minutes back", so an
 * ISO timestamp alone would leave the agent doing date arithmetic on a clock
 * it cannot read. Both are given: the timestamp so it can quote the window,
 * and the age in minutes so it can pass one straight through.
 *
 * The floor of 5 is because a report normally arrives within seconds and a
 * zero-minute window returns nothing at all — which reads as "the site served
 * no traffic", the most misleading answer available.
 */
function windowLines(report: E2eReport): string[] {
  if (!report.startedAt) return [];
  const started = Date.parse(report.startedAt);
  if (Number.isNaN(started)) return [];

  const minutes = Math.max(5, Math.ceil((Date.now() - started) / 60_000));
  return [
    `Run started: ${report.startedAt} (${minutes} minutes ago).`,
    `When you query Worker telemetry or metrics, cover THAT window — pass ` +
      `minutes=${minutes} or wider. A default recent window can report a ` +
      `perfectly healthy hour that the failure did not happen in.`
  ];
}

/** Cap the prompt: a broad breakage can fail dozens of specs that share a cause. */
const MAX_LISTED = 12;

function failureLines(failures: E2eFailure[]): string[] {
  const lines = failures.slice(0, MAX_LISTED).map((failure) => {
    const projects = failure.projects?.length
      ? ` [${failure.projects.join(", ")}]`
      : "";
    const error = failure.error
      ? `\n    ${failure.error.replace(/\n/g, "\n    ")}`
      : "";
    return `  - ${failure.title}${projects}${error}`;
  });

  if (failures.length > MAX_LISTED) {
    lines.push(`  …and ${failures.length - MAX_LISTED} more, see the run.`);
  }
  return lines;
}

/** Turn a report into the prompt the agent triages. */
export function e2eToPrompt(report: E2eReport): string {
  const failures = report.failures ?? [];
  const lines: string[] = [];

  // Do not spend a triage turn correlating commits against a synthetic
  // failure: there is nothing to find, and an agent asked to explain a
  // non-event will invent one.
  if (report.probe) {
    return [
      "ALERT PATH PROBE — this is a delivery test, not a failure.",
      `Repository: ${report.repo}`,
      report.runUrl ? `Run: ${report.runUrl}` : "",
      "",
      "Reply with the single word NOTHING. Do not investigate."
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (report.loadError && failures.length === 0) {
    lines.push(
      `E2E SUITE FAILED TO RUN — ${report.repo}.`,
      "No tests executed, so this says nothing about whether the site is healthy.",
      `Loader error: ${report.loadError}`
    );
  } else {
    lines.push(
      `E2E FAILURE — ${failures.length} test(s) failed in ${report.repo}.`,
      ...failureLines(failures)
    );
    if (report.loadError) {
      lines.push(`The run ALSO reported a load error: ${report.loadError}`);
    }
  }

  lines.push(
    `Commit: ${report.sha}${report.ref ? ` on ${report.ref}` : ""}`,
    report.baseUrl ? `Target: ${report.baseUrl}` : "",
    report.trigger ? `Triggered by: ${report.trigger}` : "",
    ...windowLines(report),
    report.runUrl ? `Run: ${report.runUrl}` : "",
    typeof report.passed === "number"
      ? `Also in this run: ${report.passed} passed, ${report.skipped ?? 0} skipped.`
      : ""
  );

  lines.push(...schemaNotice(report));

  lines.push(
    "",
    "Investigate what changed around this commit: pull requests merged shortly " +
      "before it, workflow runs on the same ref, exceptions first seen in that " +
      "window, metrics that stepped rather than wobbled. Name the commit or PR " +
      "if the evidence supports one, and say the cause is unclear if it does not — " +
      "list what you ruled out. Distinguish a failing SITE from a failing TEST: " +
      "a test that pins an environment-specific value fails against production " +
      "while the site is fine. Report in one short paragraph."
  );

  return lines.filter(Boolean).join("\n");
}

/**
 * The line posted whether or not triage found anything.
 *
 * Silence is the right default for a flapping synthetic — clawdwatch has
 * already said the endpoint is down, and a second message adds nothing. It is
 * the wrong default here: a nightly suite fails into an empty channel and
 * nobody opens the Actions tab. This deployment learned that the hard way,
 * with two nights of alerts reading "Failed: 0 test(s)" while the suite had
 * not run at all.
 */
export function e2eHeadline(report: E2eReport): string {
  const failures = report.failures ?? [];
  const where = report.repo.split("/").pop() ?? report.repo;

  // Say so unmistakably and first: a probe that reads as an outage costs
  // someone their evening, and one that does it twice stops being believed.
  if (report.probe) {
    return `🧪 ${where} E2E alert path probe — delivery works, nothing is wrong`;
  }

  if (report.loadError && failures.length === 0) {
    return `🔴 ${where} E2E suite failed to run — no tests executed`;
  }

  const first = failures[0]?.title;
  const rest = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
  return `🔴 ${where} E2E: ${failures.length} failed — ${first ?? "see the run"}${rest}`;
}
