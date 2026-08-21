/**
 * Where every model turn actually runs.
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
 * message was accepted" from "the model has finished thinking", which is the
 * distinction every caller here actually cares about — Slack and Telegram
 * included, where the same cancellation showed up as a question that was never
 * answered and never errored.
 *
 * The queue is still named `thinkbot-triage`, after its first use. Renaming a
 * Cloudflare queue means creating a new one and draining the old, which is not
 * worth doing for a name.
 */

import type { AlertEvent } from "clawdwatch";
import type { E2eReport } from "./hooks/e2e";
import type { ReplyTarget } from "./channels/reply";

/**
 * A discriminated union rather than one loose shape: the paths differ in what
 * they post and where, and a `kind` field keeps the consumer from having to
 * guess by sniffing for fields.
 *
 * Everything here must survive JSON. That is the constraint that shaped
 * `ReplyTarget`: the channel parsers used to hand back a closure, which is
 * exactly what cannot be put in a message.
 */
export type QueueJob =
  | { kind: "alert"; event: AlertEvent }
  | { kind: "e2e"; report: E2eReport }
  | { kind: "chat"; sessionId: string; text: string; target: ReplyTarget };

export function turnQueueConfigured(env: Env): boolean {
  return Boolean(env.TRIAGE_QUEUE);
}

/**
 * Hand a job to the queue, or say why it could not be.
 *
 * Returns false rather than throwing so a caller can decide: the inboxes
 * acknowledge either way, because a queue that is unavailable is not the
 * sender's problem to retry — clawdwatch would record a failed delivery, a CI
 * job would fail a step, and Slack and Telegram would both redeliver and run
 * the turn twice, all misleading about what actually broke.
 */
export async function enqueueTurn(env: Env, job: QueueJob): Promise<boolean> {
  if (!env.TRIAGE_QUEUE) {
    console.error("[queue] no TRIAGE_QUEUE binding — dropping", job.kind);
    return false;
  }

  try {
    await env.TRIAGE_QUEUE.send(job);
    return true;
  } catch (err) {
    console.error("[queue] could not enqueue", job.kind, err);
    return false;
  }
}
