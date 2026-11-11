/**
 * GET / (the outbox page) and GET /api/outbox (its data as JSON).
 *
 * Both sit behind `requireAccess`: they are the only routes in this Worker a
 * person reaches with a browser, and the only ones that read back what the
 * bot has seen.
 */

import { requireAccess } from "./access";
import { renderOutboxPage } from "./page";
import {
  OUTCOMES,
  SOURCES,
  listOutbox,
  type OutboxOutcome,
  type OutboxSource
} from "./store";

const PAGE_SIZE = 50;

function parseQuery(url: URL) {
  const source = url.searchParams.get("source") as OutboxSource | null;
  const outcome = url.searchParams.get("outcome") as OutboxOutcome | null;
  const before = Number(url.searchParams.get("before"));
  const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE);
  return {
    source: source && SOURCES.includes(source) ? source : undefined,
    outcome: outcome && OUTCOMES.includes(outcome) ? outcome : undefined,
    before: Number.isInteger(before) && before > 0 ? before : undefined,
    limit: Number.isFinite(limit)
      ? Math.min(Math.max(1, Math.floor(limit)), 200)
      : PAGE_SIZE
  };
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
};

export async function handleOutbox(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const isPage = url.pathname === "/";
  const isApi = url.pathname === "/api/outbox";
  if (!isPage && !isApi) return null;
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const access = await requireAccess(request, env);
  if (!access.ok) return access.response;

  const query = parseQuery(url);
  const rows = env.DB ? await listOutbox(env.DB, query) : [];
  // A full page may have more behind it; a short one is the end.
  const next = rows.length === query.limit ? rows[rows.length - 1].id : null;

  if (isApi) {
    return Response.json(
      { entries: rows, next },
      { headers: SECURITY_HEADERS }
    );
  }

  const nonce = crypto.randomUUID().replace(/-/g, "");
  const html = renderOutboxPage(
    {
      rows,
      source: query.source,
      outcome: query.outcome,
      next,
      viewer: access.email,
      configured: Boolean(env.DB)
    },
    nonce
  );

  return new Response(html, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    }
  });
}
