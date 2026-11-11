import { env, SELF } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type { AlertEvent } from "clawdwatch";

// The model is the one thing this suite cannot run offline, so the AI binding
// is a stub that answers with fixed text. Everything else — the real turn
// code, the output guard, the channel, the D1 write, the Access check, the
// page — is the code that ships, on a real D1.
let modelSays = "";
let modelThrows: Error | null = null;
const AI = {
  run: async () => {
    if (modelThrows) throw modelThrows;
    return {
      response: modelSays,
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    };
  }
};
const withAi = () => ({ ...env, AI }) as unknown as Env;

const { triageAlert, announceE2eFailure } = await import("../../src/routes");
const { recordOutbox, listOutbox } = await import("../../src/outbox/store");
const { handleOutbox } = await import("../../src/outbox/routes");

const TEAM = "test.cloudflareaccess.com";
const AUD = "test-aud";

const event: AlertEvent = {
  schemaVersion: 1,
  kind: "opened",
  at: "2026-11-12T00:00:00.000Z",
  check: {
    id: "api",
    name: "API health",
    url: "https://api.example.com/health",
    tags: [],
    status: "unhealthy"
  },
  failure: {
    statusCode: 500,
    responseTimeMs: 120,
    assertions: ["expected 200, got 500"],
    consecutiveFailures: 3,
    bodySnippet: "db timeout"
  },
  incidentId: "inc-1",
  links: {}
};

// ── A real RS256 key and JWKS, so the Access check runs unmodified ──────

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accessJwt(
  claims: Record<string, unknown> = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "k1" }))
  );
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        aud: [AUD],
        iss: `https://${TEAM}`,
        exp: now + 300,
        iat: now,
        email: "dev@example.com",
        ...claims
      })
    )
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

let slackPosts: Array<{ url: string; body: string }> = [];
let slackStatus = 200;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  jwk = {
    ...((await crypto.subtle.exportKey(
      "jwk",
      keyPair.publicKey
    )) as JsonWebKey),
    kid: "k1"
  };
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM outbox").run();
  modelSays = "";
  modelThrows = null;
  slackPosts = [];
  slackStatus = 200;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `https://${TEAM}/cdn-cgi/access/certs`)
        return Response.json({ keys: [jwk] });
      if (url.startsWith("https://hooks.slack.com/")) {
        slackPosts.push({ url, body: String(init?.body) });
        return new Response(slackStatus === 200 ? "ok" : "no_service", {
          status: slackStatus
        });
      }
      return new Response("unexpected fetch", { status: 599 });
    }
  );
});

afterEach(() => vi.unstubAllGlobals());

const page = async (path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://thinkbot.example.com${path}`, { headers });

describe("recording what was sent", () => {
  it("records a posted triage finding with where it went and what it said", async () => {
    modelSays = "The deploy at 23:58 broke the pool.";

    await triageAlert(withAi(), event);

    expect(slackPosts).toHaveLength(1);
    const [row] = await listOutbox(env.DB);
    expect(row).toMatchObject({
      source: "alert",
      step: "finding",
      outcome: "posted",
      trigger: "🔴 API health is down — expected 200, got 500",
      text: "*API health* — The deploy at 23:58 broke the pool.",
      model: "@cf/moonshotai/kimi-k2.6"
    });
    expect(row.ms).toBeGreaterThanOrEqual(0);
    // The webhook path is the credential; it must not reach the log.
    expect(row.destination).not.toContain("secret-token");
    expect(JSON.stringify(row)).not.toContain("secret-token");
    expect((row.context as AlertEvent).incidentId).toBe("inc-1");
  });

  it("records silence, with the raw output and the reason it was dropped", async () => {
    modelSays = "NOTHING";

    await triageAlert(withAi(), event);

    expect(slackPosts).toHaveLength(0);
    const [row] = await listOutbox(env.DB);
    expect(row.outcome).toBe("silent");
    expect(row.text).toBeNull();
    expect(row.raw).toBe("NOTHING");
  });

  it("records a channel failure with the error, and does not throw", async () => {
    modelSays = "The cause is the 23:58 deploy, which dropped the pool size.";
    slackStatus = 404;

    await expect(triageAlert(withAi(), event)).resolves.toBeUndefined();

    const [row] = await listOutbox(env.DB);
    expect(row.outcome).toBe("failed");
    expect(row.reason).toContain("404");
  });

  it("shows exactly what reached the channel when the model call errors", async () => {
    // runOpsTurn turns a model error into text, and triage posts that text.
    // Whether it should is a separate question; the outbox must show it as
    // what was actually sent.
    modelThrows = new Error("model unavailable");

    await triageAlert(withAi(), event);

    const [row] = await listOutbox(env.DB);
    expect(slackPosts).toHaveLength(1);
    expect(row.outcome).toBe("posted");
    expect(row.text).toContain("model unavailable");
    expect(JSON.parse(slackPosts[0].body).text).toBe(row.text);
  });

  it("records the e2e headline it posts on receipt", async () => {
    await announceE2eFailure(
      env as unknown as Env,
      {
        schemaVersion: 1,
        repo: "owner/site",
        sha: "abc",
        ref: "main",
        trigger: "schedule",
        baseUrl: "https://example.com",
        runUrl: "https://ci.example.com/1",
        failures: [{ title: "home loads", file: "home.spec.ts" }]
      } as never
    );

    const [row] = await listOutbox(env.DB);
    expect(row).toMatchObject({
      source: "e2e",
      step: "headline",
      outcome: "posted"
    });
  });

  it("does nothing, and does not throw, without a DB binding", async () => {
    await expect(
      recordOutbox({} as Env, {
        source: "chat",
        step: "reply",
        trigger: "hi",
        outcome: "posted"
      })
    ).resolves.toBeUndefined();
  });

  it("prunes entries older than the retention window", async () => {
    const old = Date.now() - 31 * 86_400_000;
    await recordOutbox(
      env as unknown as Env,
      { source: "chat", step: "reply", trigger: "old", outcome: "posted" },
      old
    );
    await recordOutbox(env as unknown as Env, {
      source: "chat",
      step: "reply",
      trigger: "new",
      outcome: "posted"
    });

    const rows = await listOutbox(env.DB);
    expect(rows.map((r) => r.trigger)).toEqual(["new"]);
  });

  it("filters and pages newest first", async () => {
    for (let i = 0; i < 5; i++) {
      await recordOutbox(env as unknown as Env, {
        source: i % 2 ? "alert" : "chat",
        step: "reply",
        trigger: `t${i}`,
        outcome: i === 4 ? "failed" : "posted"
      });
    }
    expect(
      (await listOutbox(env.DB, { source: "alert" })).map((r) => r.trigger)
    ).toEqual(["t3", "t1"]);
    expect(
      (await listOutbox(env.DB, { outcome: "failed" })).map((r) => r.trigger)
    ).toEqual(["t4"]);
    const first = await listOutbox(env.DB, { limit: 2 });
    const second = await listOutbox(env.DB, { limit: 2, before: first[1].id });
    expect([...first, ...second].map((r) => r.trigger)).toEqual([
      "t4",
      "t3",
      "t2",
      "t1"
    ]);
  });
});

describe("the /outbox page", () => {
  it("refuses a request that did not come through Access", async () => {
    expect((await page("/outbox")).status).toBe(403);
    expect((await page("/outbox/api/entries")).status).toBe(403);
  });

  it("refuses a forged or foreign token", async () => {
    const wrongAud = await accessJwt({ aud: ["another-app"] });
    expect(
      (await page("/outbox", { "Cf-Access-Jwt-Assertion": wrongAud })).status
    ).toBe(403);
    const tampered = (await accessJwt()).replace(/\.[^.]+$/, ".AAAA");
    expect(
      (await page("/outbox", { "Cf-Access-Jwt-Assertion": tampered })).status
    ).toBe(403);
  });

  it("is not served at all when Access is not configured", async () => {
    const request = new Request("https://thinkbot.example.com/outbox", {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt() }
    });
    const response = await handleOutbox(request, {
      DB: env.DB
    } as unknown as Env);
    expect(response?.status).toBe(404);
  });

  it("renders what was sent, escaped, for an Access-authenticated viewer", async () => {
    await recordOutbox(env as unknown as Env, {
      source: "alert",
      step: "finding",
      trigger: "🔴 API health is down",
      outcome: "posted",
      destination: "Slack (incoming webhook's channel)",
      text: "Cause: <script>alert(1)</script> in the deploy"
    });

    const response = await page("/outbox", {
      "Cf-Access-Jwt-Assertion": await accessJwt()
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'"
    );
    const html = await response.text();
    expect(html).toContain("API health is down");
    expect(html).toContain("Slack (incoming webhook&#39;s channel)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("dev@example.com");
  });

  it("serves the same entries as JSON", async () => {
    await recordOutbox(env as unknown as Env, {
      source: "chat",
      step: "reply",
      trigger: "why?",
      outcome: "posted",
      text: "because"
    });
    const response = await page("/outbox/api/entries?source=chat", {
      "Cf-Access-Jwt-Assertion": await accessJwt()
    });
    const body = (await response.json()) as {
      entries: Array<{ trigger: string }>;
      next: number | null;
    };
    expect(body.entries.map((e) => e.trigger)).toEqual(["why?"]);
    expect(body.next).toBeNull();
  });

  it("leaves the signed webhooks reachable without Access", async () => {
    const response = await SELF.fetch(
      "https://thinkbot.example.com/hooks/e2e",
      { method: "POST", body: "{}" }
    );
    // Not configured in the test env, so 404 from the hook itself, never a
    // 403 from the Access gate.
    expect(response.status).not.toBe(403);
  });
});
