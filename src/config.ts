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
 * `this.env` inside the agent and the env passed to routes are the same type.
 * Bindings (AI, ChatAgent) come from env.d.ts; everything here is vars and
 * secrets.
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

  SENTRY_TOKEN?: string;
  /** Sentry organisation slug, as it appears in the Sentry URL. */
  SENTRY_ORG?: string;

  ROLLBAR_TOKEN?: string;

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

/** Default model. Chosen for tool calling; override with MODEL. */
export const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";

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
