/**
 * Environment bindings and secrets.
 *
 * Everything optional degrades gracefully: without Telegram credentials the
 * Telegram route 404s, without a monitoring URL the clawdwatch tools report
 * that monitoring is not configured. A half-configured deployment should
 * still start.
 */

/**
 * Augments the Wrangler-generated global `Env` rather than shadowing it, so
 * the env passed to routes, tools and the RPC entrypoint is one type.
 * Bindings (AI) come from env.d.ts; everything here is vars and secrets.
 */
declare global {
  interface Env extends ThinkbotEnv {}
}

export interface ThinkbotEnv {
  // ── Model routing ────────────────────────────────────────────────────
  /** Overrides the default model id. */
  MODEL?: string;
  /** AI Gateway id — enables gateway routing when set. */
  CF_AI_GATEWAY_ID?: string;

  // ── clawdwatch ───────────────────────────────────────────────────────
  /** Base URL of the monitoring deployment, e.g. https://monitoring.example.workers.dev */
  MONITORING_URL?: string;
  /** Shared secret clawdwatch signs its webhooks with. */
  MONITORING_WEBHOOK_SECRET?: string;
  /** Access service token, for standing API calls. */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;

  // ── CI ───────────────────────────────────────────────────────────────
  /**
   * Shared secret a CI runner signs its end-to-end test reports with. Separate
   * from MONITORING_WEBHOOK_SECRET on purpose: a GitHub runner is a different
   * sender in a different trust domain from the monitoring Worker, and leaking
   * one key must not grant the other.
   */
  E2E_WEBHOOK_SECRET?: string;

  // ── Triage ───────────────────────────────────────────────────────────
  /**
   * Where triage turns run. Optional so an unbound deployment degrades to
   * logging the job rather than failing the inbox that received it — but a
   * deployment without it does no triage at all, which is why the absence is
   * logged loudly.
   */
  TRIAGE_QUEUE?: Queue<import("./turn-queue").QueueJob>;

  /**
   * Free-form notes about this deployment's estate, appended to the system
   * prompt: which repositories matter, what the Sentry projects are called,
   * which service owns what. Read by a model, not parsed.
   */
  ESTATE_NOTES?: string;

  // ── Correlation sources (all read-only) ──────────────────────────────
  /** Fine-grained PAT, contents + actions read. */
  GITHUB_TOKEN?: string;
  /** GitHub org or user that owns the repositories worth correlating against. */
  GITHUB_OWNER?: string;

  DD_API_KEY?: string;
  DD_APP_KEY?: string;

  /**
   * Cloudflare account + a token with Workers Observability read.
   *
   * Separate from CF_ACCESS_* above, which authenticates to Access and cannot
   * read telemetry. This is the only source that shows a Worker request
   * stalling — see src/tools/workers.ts for why that gap mattered.
   */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;

  SENTRY_TOKEN?: string;
  /** Sentry organisation slug, as it appears in the Sentry URL. */
  SENTRY_ORG?: string;

  // ── Channels ─────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN?: string;
  /** Secret token Telegram echoes back, proving the request came from them. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Only these chat ids may talk to the bot. Comma-separated. */
  TELEGRAM_ALLOWED_CHATS?: string;

  /** Full app — required only for receiving mentions. */
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  /** Incoming webhook — enough to post alerts, no app required. */
  SLACK_WEBHOOK_URL?: string;
  /** Channel for unsolicited alerts. Ignored when posting via a webhook. */
  SLACK_ALERT_CHANNEL?: string;
}

/**
 * Default model. Chosen for tool calling; override with `MODEL`.
 *
 * Was `@cf/openai/gpt-oss-120b`. Changed 2026-08-22 on the first real A/B —
 * both models given the same recorded report through `/hooks/e2e/dry-run`,
 * six turns each. Two findings decided it, and neither is about latency:
 *
 *   - gpt-oss-120b COLLAPSED once in six, emitting a wall of exclamation
 *     marks to the token cap. That is the failure that reached #development
 *     in August. kimi-k2.6 did not, in five.
 *   - Where a tool failed, gpt-oss-120b reported "no new errors" for a tool
 *     that had errored — a fabricated negative, indistinguishable in an
 *     incident channel from a real all-clear. kimi-k2.6 said the tool was
 *     inaccessible and that it could not confirm. It also named the test
 *     framework correctly, where gpt-oss called Playwright "Cypress".
 *
 * Calibration is worth more here than speed: kimi is ~2x slower per turn
 * (46-74s vs 20-32s) and this runs on a nightly, so the cost is nothing.
 *
 * What the A/B did NOT show is either model finding a real cause. Both
 * concluded "test flake, site healthy" about an incident that was a
 * server-side render stall — because no tool here reaches Workers
 * observability, which is where the answer was. Changing the model does not
 * fix that, and a better model would have been confidently wrong too.
 */
export const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

/** Session id used for alerts, so triage shares one continuous history. */
export const OPS_SESSION = "ops";

export function allowedTelegramChats(env: Env): Set<string> {
  return new Set(
    (env.TELEGRAM_ALLOWED_CHATS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}
