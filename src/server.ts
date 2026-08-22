/**
 * thinkbot's entry point: the RPC alert inbox and the signed HTTP routes.
 *
 * There is no chat agent here any more. Every caller — Slack, Telegram, the
 * monitoring inbox, the CI inbox — wants one turn and an answer, which is what
 * `runOpsTurn` is, so the Durable Object that used to hold streaming chat
 * state had no remaining caller once the UI went.
 */

import {
  answerChat,
  handleE2eReport,
  handleE2eDryRun,
  handleMonitoringAlert,
  handleSlack,
  handleTelegram,
  triageAlert,
  triageE2eReport
} from "./routes";
import { enqueueTurn, type QueueJob } from "./turn-queue";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { AlertEvent } from "clawdwatch";

/**
 * The RPC inbox, for a clawdwatch deployment on the same Cloudflare account.
 *
 * Preferred over the signed HTTP hook where it is available: the platform
 * authenticates the caller, so there is no shared secret to distribute or
 * rotate and no public endpoint to defend. There is correspondingly no
 * signature to verify here — that check belongs to the HTTP adapter, and
 * `triageAlert` is written not to assume it ran.
 *
 * Bound from the sending Worker as:
 *   "services": [
 *     { "binding": "AGENT", "service": "thinkbot", "entrypoint": "AlertInbox" }
 *   ]
 */
export class AlertInbox extends WorkerEntrypoint<Env> {
  async alert(event: AlertEvent): Promise<void> {
    // Return immediately, exactly as the HTTP inbox does. Triage runs an LLM
    // turn; holding the caller open for it would surface in clawdwatch's
    // delivery records as a slow or failed notification.
    //
    // Enqueued rather than run here. This used to be `waitUntil(triageAlert)`,
    // which gets about thirty seconds after the call returns — less than a
    // tool-calling turn often needs — so monitoring triage was being cancelled
    // silently whenever it ran long.
    this.ctx.waitUntil(enqueueTurn(this.env, { kind: "alert", event }));
  }
}

export default {
  /**
   * Where every model turn actually runs — triage and chat replies alike.
   *
   * A batch is one job (see `max_batch_size`): batching would only make a slow
   * turn wait behind another slow turn, and each job posts independently
   * anyway.
   *
   * Every job is acked, including failed ones. A retry would re-run a turn
   * that may already have posted its answer, so the failure mode of retrying
   * is a duplicate — an explanation repeated under an incident someone is
   * reading, or the bot answering the same question twice in a thread — worse
   * than the missing one it is trying to recover. Failures are logged instead.
   */
  async queue(batch: MessageBatch<QueueJob>, env: Env) {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.kind === "alert") await triageAlert(env, job.event);
        else if (job.kind === "e2e") await triageE2eReport(env, job.report);
        else await answerChat(env, job);
      } catch (err) {
        console.error("[queue] job failed:", job.kind, err);
      } finally {
        message.ack();
      }
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);

    // Channels and hooks are plain routes, checked before the agent router so
    // they never depend on its path conventions.
    if (request.method === "POST") {
      if (pathname === "/hooks/telegram")
        return handleTelegram(request, env, ctx);
      if (pathname === "/hooks/slack") return handleSlack(request, env, ctx);
      if (pathname === "/hooks/clawdwatch") {
        return handleMonitoringAlert(request, env, ctx);
      }
      if (pathname === "/hooks/e2e") return handleE2eReport(request, env, ctx);
      // Same payload, same signature, same turn — but the answer comes back
      // to the caller instead of to the channel. The triage harness drives
      // this; nothing in production calls it.
      if (pathname === "/hooks/e2e/dry-run") {
        return handleE2eDryRun(request, env);
      }
    }

    if (pathname === "/health") {
      return Response.json({ ok: true, service: "thinkbot" });
    }

    // Nothing else is served. This Worker holds a GitHub PAT, Datadog and
    // Sentry keys, and write access to monitoring incidents; a chat surface
    // reachable by anyone who found the hostname would hand over all of it.
    // Every route above verifies its caller before doing any work, and there
    // is no asset bundle behind this line to answer in the Worker's place.
    //
    // To add a UI, put the hostname behind Cloudflare Access with a bypass
    // policy for /hooks/* — webhook senders cannot authenticate to Access —
    // and serve it from a route here rather than from static assets, so it
    // stays behind the same check as everything else.
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env, QueueJob>;
