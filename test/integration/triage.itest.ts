import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";

/**
 * The model half of triage, against a real model.
 *
 * Everything in `src/**\/*.test.ts` mocks `runOpsTurn`, so the whole suite is
 * green whatever the model emits — which is how 256 exclamation marks reached
 * #development under a live incident headline. Nothing that mocks the turn can
 * catch that, by construction.
 *
 * Drives the deployed Worker rather than calling `runOpsTurn` directly,
 * because the model is on the `AI` binding and the correlation tools hold
 * GitHub, Datadog and Sentry credentials — none of which exist in a test
 * process. It posts to `/hooks/e2e/dry-run`, which runs the same prompt
 * through the same turn and returns the result instead of announcing a fake
 * incident in Slack.
 *
 *   E2E_WEBHOOK_SECRET=$(…) npm run test:integration
 *
 * Point it at a local worker with THINKBOT_URL=http://localhost:8787 and
 * `npx wrangler dev`. `wrangler dev` reaches a real Workers AI binding, so
 * the model is real either way.
 *
 * WHAT THESE CAN AND CANNOT CHECK
 *
 * They cannot check that a diagnosis is correct. No assertion separates a
 * sound conclusion from a confident wrong one, and writing one that pretends
 * to would be worse than having none — it would go green on fluent nonsense.
 *
 * What they check is that the output is the KIND of thing that belongs in an
 * incident channel: prose, finished, its reasoning kept to itself, hedged
 * when the evidence is thin, and silent when there is nothing to say. Every
 * assertion below corresponds to something this deployment actually posted.
 *
 * Run with VERBOSE=1 to read the turns. That mode is the point of the file as
 * much as the assertions are — it is how you judge a model, and how you decide
 * whether a different one is better.
 */

const BASE = process.env.THINKBOT_URL ?? "https://thinkbot.campermate.com";
const SECRET = process.env.E2E_WEBHOOK_SECRET;
const MODEL = process.env.MODEL;
const VERBOSE = Boolean(process.env.VERBOSE);

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

interface DryRun {
  headline: string;
  /** What the model emitted, before any guard touched it. */
  raw: string;
  /** What would have reached Slack. Empty means the channel stays quiet. */
  posted: string;
  reason: string | null;
  steps: number;
  model: string;
  ms: number;
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

async function triage(report: Record<string, unknown>): Promise<DryRun> {
  const body = JSON.stringify(report);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", SECRET as string)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  const url = new URL("/hooks/e2e/dry-run", BASE);
  if (MODEL) url.searchParams.set("model", MODEL);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-thinkbot-signature": `sha256=${signature}`,
      "x-thinkbot-timestamp": timestamp
    },
    body
  });

  if (!response.ok) {
    throw new Error(
      `${url.pathname} ${response.status}: ${await response.text()}`
    );
  }

  const result = (await response.json()) as DryRun;

  if (VERBOSE) {
    console.log(
      `\n  ${result.model} — ${result.steps} step(s), ${result.ms}ms` +
        `${result.reason ? ` — ${result.reason}` : ""}\n` +
        `  ${result.raw.replace(/\n/g, "\n  ") || "(nothing)"}\n`
    );
  }

  return result;
}

/** The largest share any one character holds — the collapse detector. */
function peakCharShare(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  return Math.max(...counts.values()) / [...text].length;
}

describe.skipIf(!SECRET)("triage, against a real model", () => {
  let mapTimeouts: DryRun;

  beforeAll(async () => {
    mapTimeouts = await triage(fixture("three-map-timeouts"));
  }, 180_000);

  it("says something at all", () => {
    // The floor. A nightly failure that triages into silence is the state this
    // whole path was built to end.
    expect(mapTimeouts.posted.length).toBeGreaterThan(0);
  });

  it("emits prose rather than a collapsed generation", () => {
    // The 2026-08-22 regression, checked against the raw text so a green
    // result means the model behaved, not that the guard caught it.
    expect(peakCharShare(mapTimeouts.raw)).toBeLessThan(0.4);
  });

  it("finishes its sentence", () => {
    // Findings were arriving cut mid-word before maxOutputTokens was set.
    expect(mapTimeouts.raw.trim()).toMatch(/[.!?)\]"'”’]$/);
  });

  it("keeps its own planning out of the answer", () => {
    // "We need to fetch PR details." — the harmony analysis channel arriving
    // as the first line of a Slack message.
    expect(mapTimeouts.raw).not.toMatch(
      /^(?:we|i|let's)\s+(?:need to|should|must|will)\s+(?:fetch|check|look|call|query|inspect|search|get|find)/i
    );
  });

  it("stays inside one short paragraph", () => {
    // The prompt asks for one; a model that writes an essay under an incident
    // is a model whose output nobody reads.
    expect(mapTimeouts.posted.length).toBeLessThan(1200);
  });

  it("actually investigated rather than answering from the prompt", () => {
    // The whole argument for a model here is that it can reach GitHub,
    // Datadog and Sentry. A zero-step turn is a model guessing from the
    // failure titles, which the headline already carries.
    expect(mapTimeouts.steps).toBeGreaterThan(1);
  });

  it("does not invent a culprit it cannot have evidence for", () => {
    // Nothing merged in the window before this run. Naming a PR anyway sends
    // someone to the wrong change, which the prompt says costs more than an
    // honest "unclear" — so one or the other must be true of the answer.
    const hedged =
      /unclear|cannot|could not|no (?:obvious|clear|single)|not (?:clear|obvious)|nothing (?:merged|changed)|ruled out/i;
    const named = /\b(?:PR\s*)?#\d+\b|\b[0-9a-f]{7,40}\b/;

    expect(
      hedged.test(mapTimeouts.posted) || named.test(mapTimeouts.posted)
    ).toBe(true);
  });
});

describe.skipIf(!SECRET)("triage, on reports that are not failures", () => {
  it("is silent on the delivery probe", async () => {
    // An agent asked to explain a non-event will invent one, so the prompt
    // asks for the bare word NOTHING. Anything else here is a fabricated
    // incident posted under a message that says nothing is wrong.
    const result = await triage(fixture("probe"));

    expect(result.posted).toBe("");
    expect(result.steps).toBeLessThan(2);
  }, 180_000);

  it("does not claim the site is healthy when nothing ran", async () => {
    // The distinction the reporter was rewritten to preserve: a suite that
    // died at collection time says nothing about the site. A triage turn that
    // reports it as "all clear" undoes that at the last step.
    const result = await triage(fixture("suite-failed-to-run"));

    expect(result.posted.length).toBeGreaterThan(0);
    expect(result.posted).not.toMatch(
      /site is (?:fine|healthy|up|working)|no impact to users|everything is working/i
    );
  }, 180_000);
});

describe("fixtures", () => {
  // The one check here that needs no credentials and no model. A fixture
  // that stopped matching the payload the reporter sends would make every
  // assertion above meaningless while still going green, so it is worth
  // catching on a run that skipped all of them.
  it("all parse and carry the fields the inbox requires", () => {
    const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const report = fixture(name.replace(/\.json$/, ""));
      expect(typeof report.repo, name).toBe("string");
      expect(typeof report.sha, name).toBe("string");
    }
  });
});
