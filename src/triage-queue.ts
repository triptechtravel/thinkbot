/**
 * Where triage actually runs.
 *
 * It used to run in `ctx.waitUntil` after the response had gone out. That
 * budget is about thirty seconds, and a triage turn makes several tool calls:
 * of the reports put through the live deployment, one finished in 28 seconds
 * and the rest were cancelled outright, logged by the runtime as
 *
 *   waitUntil() tasks did not complete within the allowed time after
 *   invocation end and have been cancelled.
 *
 * No error, 200 to the caller, and nothing in Slack. The monitoring inbox had
 * the same shape, so clawdwatch triage had been silently dropping whenever it
 * ran long — invisible, because the thing that failed was the thing that would
 * have told you.
 *
 * A queue consumer gets minutes rather than seconds, and it decouples "the
 * report was accepted" from "the model has finished thinking", which is the
 * distinction the caller actually cares about.
 */

import type { AlertEvent } from "clawdwatch";
import type { E2eReport } from "./hooks/e2e";

/**
 * A discriminated union rather than one loose shape: the two triage paths
 * differ in what they post and when, and a `kind` field keeps the consumer
 * from having to guess by sniffing for fields.
 */
export type TriageJob =
  | { kind: "alert"; event: AlertEvent }
  | { kind: "e2e"; report: E2eReport };

export function triageQueueConfigured(env: Env): boolean {
  return Boolean(env.TRIAGE_QUEUE);
}

/**
 * Hand a job to the queue, or say why it could not be.
 *
 * Returns false rather than throwing so a caller can decide: the inboxes
 * acknowledge either way, because a queue that is unavailable is not the
 * sender's problem to retry — clawdwatch would record a failed delivery and
 * a CI job would fail a step, both misleading about what actually broke.
 */
export async function enqueueTriage(
  env: Env,
  job: TriageJob
): Promise<boolean> {
  if (!env.TRIAGE_QUEUE) {
    console.error("[triage] no TRIAGE_QUEUE binding — dropping", job.kind);
    return false;
  }

  try {
    await env.TRIAGE_QUEUE.send(job);
    return true;
  } catch (err) {
    console.error("[triage] could not enqueue", job.kind, err);
    return false;
  }
}
