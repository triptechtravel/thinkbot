import { describe, it, expect } from "vitest";
import { signPayload } from "clawdwatch";
import {
  E2E_SCHEMA_VERSION,
  E2E_SIGNATURE_HEADER,
  E2E_TIMESTAMP_HEADER,
  e2eHeadline,
  e2eInboxConfigured,
  e2eToPrompt,
  isE2eReport,
  verifyE2eReport,
  type E2eReport
} from "./e2e";

const SECRET = "e2e-webhook-secret";
const env = { E2E_WEBHOOK_SECRET: SECRET } as unknown as Env;

function report(overrides: Partial<E2eReport> = {}): E2eReport {
  return {
    schemaVersion: E2E_SCHEMA_VERSION,
    repo: "triptechtravel/campermate.com",
    sha: "d0812c0d",
    ref: "main",
    trigger: "schedule",
    baseUrl: "https://campermate.com",
    runUrl: "https://github.com/triptechtravel/campermate.com/actions/runs/1",
    failures: [
      {
        title: "theme.spec.ts › a dark-cookie user ends up dark",
        projects: ["desktop-chrome"],
        error: 'Expected "dark", received "light"'
      }
    ],
    passed: 65,
    skipped: 5,
    ...overrides
  };
}

async function signedRequest(body: string, secret = SECRET, at = Date.now()) {
  const timestamp = String(at);
  const signature = await signPayload(secret, timestamp, body);
  return new Request("https://thinkbot.example.com/hooks/e2e", {
    method: "POST",
    headers: {
      [E2E_SIGNATURE_HEADER]: signature,
      [E2E_TIMESTAMP_HEADER]: timestamp
    },
    body
  });
}

describe("verifyE2eReport", () => {
  it("accepts a correctly signed report", async () => {
    const body = JSON.stringify(report());
    expect(await verifyE2eReport(await signedRequest(body), body, env)).toBe(
      true
    );
  });

  it("rejects a signature made with a different secret", async () => {
    const body = JSON.stringify(report());
    const request = await signedRequest(body, "monitoring-webhook-secret");
    expect(await verifyE2eReport(request, body, env)).toBe(false);
  });

  /** The body is what is signed, so tampering with it must invalidate it. */
  it("rejects a body altered after signing", async () => {
    const body = JSON.stringify(report());
    const request = await signedRequest(body);
    expect(await verifyE2eReport(request, body.replace("65", "66"), env)).toBe(
      false
    );
  });

  it("rejects a replayed report", async () => {
    const body = JSON.stringify(report());
    const request = await signedRequest(
      body,
      SECRET,
      Date.now() - 10 * 60 * 1000
    );
    expect(await verifyE2eReport(request, body, env)).toBe(false);
  });

  it("rejects an unsigned request", async () => {
    const body = JSON.stringify(report());
    const request = new Request("https://thinkbot.example.com/hooks/e2e", {
      method: "POST",
      body
    });
    expect(await verifyE2eReport(request, body, env)).toBe(false);
  });

  /**
   * Without the secret there is nothing to verify against, so every request
   * must fail closed rather than being waved through as "unconfigured".
   */
  it("rejects everything when no secret is configured", async () => {
    const body = JSON.stringify(report());
    const request = await signedRequest(body);
    expect(await verifyE2eReport(request, body, {} as Env)).toBe(false);
    expect(e2eInboxConfigured({} as Env)).toBe(false);
  });
});

describe("isE2eReport", () => {
  it("accepts a report carrying a repo and a commit", () => {
    expect(isE2eReport(report())).toBe(true);
  });

  it.each([[null], [42], ["a string"], [{}], [{ repo: "x" }], [{ sha: "y" }]])(
    "rejects %p",
    (value) => {
      expect(isE2eReport(value)).toBe(false);
    }
  );
});

describe("e2eToPrompt", () => {
  it("names the failing tests and what they asserted", () => {
    const prompt = e2eToPrompt(report());
    expect(prompt).toContain("a dark-cookie user ends up dark");
    expect(prompt).toContain('Expected "dark", received "light"');
    expect(prompt).toContain("[desktop-chrome]");
  });

  it("carries the commit and run so the agent can correlate", () => {
    const prompt = e2eToPrompt(report());
    expect(prompt).toContain("d0812c0d");
    expect(prompt).toContain("actions/runs/1");
    expect(prompt).toContain("https://campermate.com");
  });

  /**
   * The distinction the old alert could not draw: nothing ran, so the run says
   * nothing about the site. Reporting it as "0 tests failed" is what made two
   * nights of outage read as noise.
   */
  it("says the suite never ran when there is a load error and no failures", () => {
    const prompt = e2eToPrompt(
      report({ failures: [], loadError: "Cannot find module 'x'" })
    );
    expect(prompt).toContain("FAILED TO RUN");
    expect(prompt).toContain("No tests executed");
    expect(prompt).toContain("Cannot find module 'x'");
  });

  it("reports a load error alongside failures rather than instead of them", () => {
    const prompt = e2eToPrompt(
      report({ loadError: "a second spec would not load" })
    );
    expect(prompt).toContain("1 test(s) failed");
    expect(prompt).toContain("ALSO reported a load error");
  });

  it("truncates a broad breakage instead of pasting every spec", () => {
    const failures = Array.from({ length: 30 }, (_, i) => ({
      title: `spec ${i}`
    }));
    const prompt = e2eToPrompt(report({ failures }));
    expect(prompt).toContain("spec 11");
    expect(prompt).not.toContain("spec 12");
    expect(prompt).toContain("…and 18 more");
  });

  it("asks the agent to tell a broken site from a broken test", () => {
    expect(e2eToPrompt(report())).toContain("failing SITE from a failing TEST");
  });

  it("warns when the payload is newer than this build understands", () => {
    const prompt = e2eToPrompt(
      report({ schemaVersion: E2E_SCHEMA_VERSION + 1 })
    );
    expect(prompt).toContain("newer than the");
  });

  it("says nothing about schema for the version it knows", () => {
    expect(e2eToPrompt(report())).not.toContain("newer than the");
  });

  it("omits fields the reporter did not send rather than printing undefined", () => {
    const prompt = e2eToPrompt({
      repo: "a/b",
      sha: "abc",
      failures: [{ title: "t" }]
    });
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("Run:");
  });
});

describe("e2eHeadline", () => {
  it("leads with the count and the first failure", () => {
    expect(e2eHeadline(report())).toContain("1 failed");
    expect(e2eHeadline(report())).toContain("a dark-cookie user ends up dark");
  });

  it("counts the rest rather than listing them", () => {
    const failures = [
      { title: "first" },
      { title: "second" },
      { title: "third" }
    ];
    expect(e2eHeadline(report({ failures }))).toContain("(+2 more)");
  });

  it("distinguishes a suite that never ran", () => {
    const headline = e2eHeadline(report({ failures: [], loadError: "boom" }));
    expect(headline).toContain("failed to run");
    expect(headline).toContain("no tests executed");
  });

  it("names the repository without its owner", () => {
    expect(e2eHeadline(report())).toContain("campermate.com");
    expect(e2eHeadline(report())).not.toContain("triptechtravel/");
  });
});
