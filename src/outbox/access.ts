/**
 * The Access gate for /outbox.
 *
 * The page shows alert payloads (which can carry a captured response body)
 * and raw model output, so it is never served on the strength of a hostname
 * being "probably behind Access". The Worker verifies the Access JWT itself,
 * against the team's keys and the application's AUD, and refuses when either
 * setting is missing. Forgetting to configure Access therefore produces a 404,
 * not a public page.
 *
 * Verification is clawdwatch's `verifyAccessJwt`, the same code that guards
 * the monitoring dashboard, rather than a second implementation.
 */

import { verifyAccessJwt } from "clawdwatch";

export type AccessResult =
  | { ok: true; email: string | null }
  | { ok: false; response: Response };

export function accessConfigured(env: Env): boolean {
  return Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
}

export async function requireAccess(
  request: Request,
  env: Env,
  verify: typeof verifyAccessJwt = verifyAccessJwt
): Promise<AccessResult> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  }

  // Access sets this header on every request it lets through. The cookie is
  // not consulted: a cookie can be replayed to a hostname Access does not
  // cover, the header cannot be set by the browser at all.
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }

  try {
    const identity = await verify(token, {
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      aud: env.CF_ACCESS_AUD
    });
    return { ok: true, email: identity.email ?? null };
  } catch {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
}
