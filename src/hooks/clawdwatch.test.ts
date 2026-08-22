import { describe, it, expect } from "vitest";
import {
  signPayload,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  ALERT_SCHEMA_VERSION
} from "clawdwatch";
import type { AlertEvent, CheckSummary } from "clawdwatch";
import {
  verifyAlert,
  alertToPrompt,
  alertHeadline,
  inboxConfigured
} from "./clawdwatch";

const SECRET = "monitoring-webhook-secret";
const env = { MONITORING_WEBHOOK_SECRET: SECRET } as unknown as Env;

const CHECK: CheckSummary = {
  id: "business-login",
  name: "Business Login",
  url: "https://business.example.com/auth/login",
  tags: ["apps"],
  status: "unhealthy"
};

function opened(): AlertEvent {
  return {
    schemaVersion: ALERT_SCHEMA_VERSION,
    kind: "opened",
    at: "2026-07-27T13:01:00.000Z",
    check: CHECK,
    failure: {
      statusCode: 502,
      responseTimeMs: 310,
      assertions: ["Expected status 200, got 502"],
      consecutiveFailures: 3
    },
    incidentId: "inc-42",
    links: {
      incident: "https://mon.example.com/api/incidents/inc-42",
      annotate: "https://mon.example.com/api/incidents/inc-42/annotate?cap=abc",
      capabilities: "https://mon.example.com/api/agent.md"
    }
  };
}

async function signedRequest(body: string, secret = SECRET, at = Date.now()) {
  const timestamp = String(at);
  const signature = await signPayload(secret, timestamp, body);
  return new Request("https://thinkbot.test/hooks/clawdwatch", {
    method: "POST",
    headers: {
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: timestamp,
      "Content-Type": "application/json"
    },
    body
  });
}

describe("inboxConfigured", () => {
  it("requires the shared secret", () => {
    expect(inboxConfigured(env)).toBe(true);
    expect(inboxConfigured({} as Env)).toBe(false);
  });
});

describe("verifyAlert", () => {
  it("accepts a genuinely signed alert", async () => {
    const body = JSON.stringify(opened());
    expect(await verifyAlert(await signedRequest(body), body, env)).toBe(true);
  });

  it("rejects a signature made with a different secret", async () => {
    const body = JSON.stringify(opened());
    expect(
      await verifyAlert(await signedRequest(body, "wrong-secret"), body, env)
    ).toBe(false);
  });

  it("rejects a body that changed after signing", async () => {
    const request = await signedRequest(JSON.stringify(opened()));
    expect(await verifyAlert(request, '{"kind":"recovered"}', env)).toBe(false);
  });

  it("rejects a replayed alert", async () => {
    const body = JSON.stringify(opened());
    const stale = await signedRequest(body, SECRET, Date.now() - 10 * 60_000);
    expect(await verifyAlert(stale, body, env)).toBe(false);
  });

  it("rejects an unsigned request", async () => {
    const body = JSON.stringify(opened());
    const bare = new Request("https://thinkbot.test/hooks/clawdwatch", {
      method: "POST",
      body
    });
    expect(await verifyAlert(bare, body, env)).toBe(false);
  });

  it("rejects everything when no secret is configured", async () => {
    const body = JSON.stringify(opened());
    expect(await verifyAlert(await signedRequest(body), body, {} as Env)).toBe(
      false
    );
  });
});

describe("alertToPrompt", () => {
  it("states what failed and how", () => {
    const prompt = alertToPrompt(opened());
    expect(prompt).toContain("Business Login");
    expect(prompt).toContain("Expected status 200, got 502");
    expect(prompt).toContain("inc-42");
  });

  it("includes the signed action links so the agent can act", () => {
    const prompt = alertToPrompt(opened());
    expect(prompt).toContain("annotate:");
    expect(prompt).toContain("cap=abc");
    expect(prompt).toContain("no credentials needed");
  });

  it("asks for a conclusion to be recorded", () => {
    expect(alertToPrompt(opened())).toContain("annotateIncident");
  });

  it("handles a recovery", () => {
    const event: AlertEvent = {
      schemaVersion: ALERT_SCHEMA_VERSION,
      kind: "recovered",
      at: "2026-07-27T13:20:00.000Z",
      check: { ...CHECK, status: "healthy" },
      downtimeMs: 19 * 60_000,
      incidentId: "inc-42",
      links: {}
    };
    expect(alertToPrompt(event)).toContain("19 minutes");
  });

  it("handles a summary with nothing open", () => {
    const event: AlertEvent = {
      schemaVersion: ALERT_SCHEMA_VERSION,
      kind: "summary",
      at: "2026-07-27T13:20:00.000Z",
      opened: [],
      recovered: [{ ...CHECK, status: "healthy" }],
      stillDown: [],
      allClear: true,
      totalChecks: 10,
      links: {}
    };
    expect(alertToPrompt(event)).toContain("Everything is healthy again");
  });
});

describe("alertHeadline", () => {
  it("leads with the state, so it reads at a glance", () => {
    expect(alertHeadline(opened())).toContain("Business Login is down");
  });

  it("reports recovery with the downtime", () => {
    const event: AlertEvent = {
      schemaVersion: ALERT_SCHEMA_VERSION,
      kind: "recovered",
      at: "2026-07-27T13:20:00.000Z",
      check: { ...CHECK, status: "healthy" },
      downtimeMs: 19 * 60_000,
      incidentId: "inc-42",
      links: {}
    };
    expect(alertHeadline(event)).toContain("recovered after 19m");
  });
});

describe("response body evidence", () => {
  it("includes the captured snippet for an opened alert", () => {
    const event = opened() as Extract<AlertEvent, { kind: "opened" }>;
    event.failure.bodySnippet =
      '{"ok":false,"error":"Error with system Redis. Cannot execute queries."}';
    const prompt = alertToPrompt(event);
    expect(prompt).toContain("Error with system Redis");
  });

  it("includes the snippet on a reminder too", () => {
    const event: AlertEvent = {
      schemaVersion: ALERT_SCHEMA_VERSION,
      kind: "reminder",
      at: "2026-07-27T14:01:00.000Z",
      check: CHECK,
      failure: {
        statusCode: 500,
        responseTimeMs: 12,
        assertions: ["Expected status 200, got 500"],
        consecutiveFailures: 40,
        bodySnippet: '{"error":"upstream timeout"}'
      },
      downSinceMs: 3_600_000,
      incidentId: "inc-42",
      links: {}
    };
    expect(alertToPrompt(event)).toContain("upstream timeout");
  });

  it("omits the section entirely when no snippet was captured", () => {
    // Most checks will not opt in, and an empty labelled section is noise
    // that costs prompt budget on every alert.
    const prompt = alertToPrompt(opened());
    expect(prompt).not.toContain("Response body");
  });

  it("labels the snippet as an excerpt so the agent does not treat it as the whole body", () => {
    const event = opened() as Extract<AlertEvent, { kind: "opened" }>;
    event.failure.bodySnippet = '{"error":"boom"}';
    expect(alertToPrompt(event)).toMatch(/Response body \(excerpt/);
  });
});

describe("payload schema tolerance", () => {
  it("says nothing about the version when it matches", () => {
    expect(alertToPrompt(opened())).not.toMatch(/schema/i);
  });

  it("still produces a usable prompt when the payload is newer than we know", () => {
    // clawdwatch and thinkbot deploy independently. A newer payload must
    // degrade, never throw — otherwise shipping clawdwatch breaks triage.
    const event = opened() as Extract<AlertEvent, { kind: "opened" }>;
    event.schemaVersion = ALERT_SCHEMA_VERSION + 5;

    const prompt = alertToPrompt(event);
    expect(prompt).toContain("Business Login");
    expect(prompt).toContain("annotateIncident");
    expect(prompt).toMatch(/newer/i);
  });

  it("does not throw on an alert kind it has never seen", () => {
    const event = { ...opened(), kind: "exploded" } as unknown as AlertEvent;
    expect(() => alertToPrompt(event)).not.toThrow();
    expect(alertToPrompt(event)).toContain("annotateIncident");
  });

  it("returns a usable headline for an unknown kind rather than undefined", () => {
    const event = { ...opened(), kind: "exploded" } as unknown as AlertEvent;
    expect(() => alertHeadline(event)).not.toThrow();
    expect(typeof alertHeadline(event)).toBe("string");
    expect(alertHeadline(event)).not.toContain("undefined");
  });
});
