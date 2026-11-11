/**
 * The outbox: a record of every message thinkbot sent, or decided not to.
 *
 * Writing here must never cost a message. Every call is best-effort: a missing
 * binding or a failed insert is logged and swallowed, because the alternative
 * is a triage finding lost to a logging failure.
 */

export type OutboxSource = "alert" | "e2e" | "chat";
export type OutboxStep = "headline" | "finding" | "reply";

/**
 * - posted: delivered to a channel
 * - silent: triage produced nothing worth posting, so nothing was sent
 * - failed: the channel refused it or could not be reached
 * - logged: no channel is configured, so it went to the Worker log only
 */
export type OutboxOutcome = "posted" | "silent" | "failed" | "logged";

export interface OutboxEntry {
  source: OutboxSource;
  step: OutboxStep;
  trigger: string;
  outcome: OutboxOutcome;
  destination?: string | null;
  text?: string | null;
  raw?: string | null;
  reason?: string | null;
  model?: string | null;
  steps?: number | null;
  tools?: string[] | null;
  ms?: number | null;
  context?: unknown;
}

export interface OutboxRow extends OutboxEntry {
  id: number;
  at: string;
}

export const RETENTION_DAYS = 30;

/** Cap on stored text fields. A collapsed generation runs to the token cap. */
const MAX_CHARS = 16_000;

function clip(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.length > MAX_CHARS
    ? `${value.slice(0, MAX_CHARS)}… [${value.length - MAX_CHARS} more chars]`
    : value;
}

function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return clip(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function outboxConfigured(env: Env): boolean {
  return Boolean(env.DB);
}

export async function recordOutbox(
  env: Env,
  entry: OutboxEntry,
  now = Date.now()
): Promise<void> {
  if (!env.DB) return;
  const at = new Date(now).toISOString();
  const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO outbox
           (at, source, step, trigger, outcome, destination, text, raw, reason,
            model, steps, tools, ms, context)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        at,
        entry.source,
        entry.step,
        clip(entry.trigger) ?? "",
        entry.outcome,
        entry.destination ?? null,
        clip(entry.text),
        // Only worth keeping when it differs from what was posted: the gap
        // between them is what explains a rejected or altered finding.
        entry.raw !== undefined && entry.raw !== entry.text
          ? clip(entry.raw)
          : null,
        clip(entry.reason),
        entry.model ?? null,
        entry.steps ?? null,
        entry.tools && entry.tools.length > 0
          ? JSON.stringify(entry.tools)
          : null,
        entry.ms ?? null,
        json(entry.context)
      ),
      // Rows are a handful a day, so pruning on write costs nothing and needs
      // no cron.
      env.DB.prepare("DELETE FROM outbox WHERE at < ?").bind(cutoff)
    ]);
  } catch (err) {
    console.error("[outbox] could not record:", err);
  }
}

export interface OutboxQuery {
  /** Rows with an id below this, for paging. */
  before?: number;
  source?: OutboxSource;
  outcome?: OutboxOutcome;
  limit?: number;
}

interface RawRow {
  id: number;
  at: string;
  source: OutboxSource;
  step: OutboxStep;
  trigger: string;
  outcome: OutboxOutcome;
  destination: string | null;
  text: string | null;
  raw: string | null;
  reason: string | null;
  model: string | null;
  steps: number | null;
  tools: string | null;
  ms: number | null;
  context: string | null;
}

function parse<T>(value: string | null): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export const SOURCES: OutboxSource[] = ["alert", "e2e", "chat"];
export const OUTCOMES: OutboxOutcome[] = [
  "posted",
  "silent",
  "failed",
  "logged"
];

export async function listOutbox(
  db: D1Database,
  query: OutboxQuery = {}
): Promise<OutboxRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (query.before !== undefined) {
    where.push("id < ?");
    binds.push(query.before);
  }
  if (query.source) {
    where.push("source = ?");
    binds.push(query.source);
  }
  if (query.outcome) {
    where.push("outcome = ?");
    binds.push(query.outcome);
  }
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 50)), 200);

  const { results } = await db
    .prepare(
      `SELECT * FROM outbox
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC LIMIT ${limit}`
    )
    .bind(...binds)
    .all<RawRow>();

  return (results ?? []).map((r) => ({
    ...r,
    tools: parse<string[]>(r.tools),
    context: parse<unknown>(r.context)
  }));
}
