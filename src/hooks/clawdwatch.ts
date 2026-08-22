/**
 * The monitoring inbox.
 *
 * clawdwatch POSTs a signed AlertEvent here. Verification uses the library's
 * own `verifySignature` rather than a local reimplementation — the signature
 * covers `timestamp.body` and rejects stale timestamps, and getting either
 * detail subtly wrong is the kind of bug that only shows up when someone
 * exploits it.
 */

import {
  verifySignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  ALERT_SCHEMA_VERSION
} from "clawdwatch";
import type { AlertEvent } from "clawdwatch";

export function inboxConfigured(env: Env): boolean {
  return Boolean(env.MONITORING_WEBHOOK_SECRET);
}

export async function verifyAlert(
  request: Request,
  body: string,
  env: Env
): Promise<boolean> {
  if (!env.MONITORING_WEBHOOK_SECRET) return false;
  return verifySignature({
    secret: env.MONITORING_WEBHOOK_SECRET,
    body,
    signature: request.headers.get(SIGNATURE_HEADER),
    timestamp: request.headers.get(TIMESTAMP_HEADER)
  });
}

/**
 * What the failing response actually said, when the check opted in to
 * capturing it.
 *
 * Worth its prompt budget: a status code says a request failed, the body
 * usually says why. Absent for checks that did not opt in, so this yields
 * nothing rather than an empty labelled section.
 *
 * It is labelled an excerpt deliberately — it is truncated and scrubbed, so
 * the agent should not reason as though it has the whole response, and should
 * not quote it as authoritative without checking the endpoint itself.
 */
function bodyEvidence(failure: { bodySnippet?: string | null }): string[] {
  return failure.bodySnippet
    ? [
        `Response body (excerpt, truncated and secret-scrubbed): ${failure.bodySnippet}`
      ]
    : [];
}

/**
 * Warn the agent when the payload is newer than this build understands.
 *
 * clawdwatch and thinkbot deploy independently, so a version skew is normal,
 * not exceptional. The contract is that additive fields never bump the
 * version — so a higher number means something was removed or changed meaning,
 * and fields this code reads may be missing. Degrade and say so; refusing to
 * triage would turn a clawdwatch release into a monitoring outage.
 */
function schemaNotice(event: AlertEvent): string[] {
  const version = event.schemaVersion;
  if (typeof version !== "number" || version <= ALERT_SCHEMA_VERSION) return [];

  return [
    `NOTE: this alert uses payload schema v${version}, newer than the v${ALERT_SCHEMA_VERSION} ` +
      "this build knows. Some detail may be missing from the summary above — " +
      "prefer the incident link over anything you infer from what is here."
  ];
}

/**
 * Turn an alert into the prompt the agent triages.
 *
 * The links are included verbatim and called out explicitly: they are
 * short-lived signed URLs scoped to this incident, so the agent can annotate
 * or acknowledge without any standing credential.
 */
export function alertToPrompt(event: AlertEvent): string {
  const lines: string[] = [];

  switch (event.kind) {
    case "opened":
      lines.push(
        `MONITORING ALERT — ${event.check.name} is DOWN.`,
        `URL: ${event.check.url}`,
        `Failed: ${event.failure.assertions.join("; ")}`,
        `Status code: ${event.failure.statusCode ?? "unreachable"}`,
        `Consecutive failures: ${event.failure.consecutiveFailures}`,
        ...bodyEvidence(event.failure),
        `Incident: ${event.incidentId}`
      );
      break;

    case "recovered":
      lines.push(
        `MONITORING RECOVERY — ${event.check.name} is healthy again.`,
        `It was down for ${Math.round(event.downtimeMs / 60000)} minutes.`,
        `Incident: ${event.incidentId}`
      );
      break;

    case "reminder":
      lines.push(
        `MONITORING REMINDER — ${event.check.name} is STILL down.`,
        `Down for ${Math.round(event.downSinceMs / 60000)} minutes.`,
        `Failed: ${event.failure.assertions.join("; ")}`,
        ...bodyEvidence(event.failure),
        `Incident: ${event.incidentId}`
      );
      break;

    case "summary":
      lines.push(
        "MONITORING SUMMARY",
        `Opened: ${event.opened.map((c) => c.name).join(", ") || "none"}`,
        `Recovered: ${event.recovered.map((c) => c.name).join(", ") || "none"}`,
        `Still down: ${event.stillDown.map((c) => c.name).join(", ") || "none"}`,
        event.allClear ? "Everything is healthy again." : ""
      );
      break;
  }

  const links = Object.entries(event.links)
    .filter(([, url]) => Boolean(url))
    .map(([name, url]) => `  ${name}: ${url}`)
    .join("\n");

  if (links) {
    lines.push(
      "",
      "Signed action links for this incident (no credentials needed, valid about an hour):",
      links
    );
  }

  lines.push(...schemaNotice(event));

  lines.push(
    "",
    "Investigate: confirm whether it is still failing, check the history for a pattern, " +
      "and look for anything that changed around the failure window. " +
      "If you reach a conclusion, record it with annotateIncident. " +
      "Then report what you found in one short paragraph."
  );

  return lines.filter(Boolean).join("\n");
}

/** A one-line headline for the channel, before the agent has thought about it. */
export function alertHeadline(event: AlertEvent): string {
  switch (event.kind) {
    case "opened":
      return `🔴 ${event.check.name} is down — ${event.failure.assertions[0] ?? "check failed"}`;
    case "recovered":
      return `🟢 ${event.check.name} recovered after ${Math.round(event.downtimeMs / 60000)}m`;
    case "reminder":
      return `⚠️ ${event.check.name} still down after ${Math.round(event.downSinceMs / 60000)}m`;
    case "summary":
      return event.allClear
        ? "✅ All checks healthy again"
        : "📋 Monitoring summary";
    default:
      // A kind added by a newer clawdwatch. Better a vague headline than
      // `undefined` rendered into a channel.
      return "📋 Monitoring alert";
  }
}
