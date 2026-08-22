import { describe, it, expect } from "vitest";
import { usableFinding, looksTruncated } from "./triage-output";

/**
 * The cases here are transcripts, not inventions. Each of the first three is
 * something this deployment actually posted into #development, which is the
 * only reason to believe the thresholds are set where they need to be.
 */

/** Posted 2026-08-22 07:38 UTC, under a headline about three failing specs. */
const EXCLAMATION_WALL = "!".repeat(256);

/** Posted 2026-08-21, with the model's own planning as the first line. */
const LEAKED_PLAN =
  "We need to fetch PR details.\nThe only code change landed just before " +
  "the failing run was PR #1246 (“fix(itinerary): name the focal " +
  "coordinate in image URLs instead of gravity=auto”, merged 2026-08-21 " +
  "05:14:58 UTC). No new Sentry issues or Datadog error spikes appeared in " +
  "the same window.";

/** A sound finding, of the shape the prompt asks for. */
const GOOD =
  "PR #1246 landed 20 minutes before the run and changed image URL " +
  "construction, which the failing spec asserts on. No new Sentry issues " +
  "and no Datadog step change, so the site looks healthy and the test is " +
  "pinning a value the change moved.";

describe("usableFinding — output that is not prose", () => {
  it("drops a collapsed generation outright", () => {
    const verdict = usableFinding(EXCLAMATION_WALL);

    expect(verdict.text).toBe("");
    expect(verdict.reason).toMatch(/degenerate/);
  });

  it("reports a collapsed generation as degenerate, not as too short", () => {
    // The distinction is the whole diagnostic value of the log line: one sends
    // the next reader to the token limit, the other to the model.
    expect(usableFinding("?".repeat(400)).reason).toMatch(/degenerate/);
  });

  it("drops punctuation that never becomes a sentence", () => {
    expect(usableFinding("-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=").text).toBe("");
  });

  it("keeps a finding dense with identifiers and numbers", () => {
    // Guards the letter-share floor against the findings most worth posting.
    const dense =
      "Datadog shows 502s stepping from 0.1% to 4.2% at 05:15 UTC, and " +
      "Sentry issue CAMPERMATE-COM-1F4 first fired at 05:16 — both inside " +
      "the window PR #1246 merged in (05:14:58).";

    expect(usableFinding(dense).text).toBe(dense);
  });

  it("keeps a finding that is not written in Latin script", () => {
    const cyrillic = "Причина неяс" + "на, новых ошиб" + "ок нет.";

    expect(usableFinding(cyrillic).text).toBe(cyrillic);
  });

  it("does not mistake a horizontal rule inside real prose for collapse", () => {
    const withRule = `${GOOD}\n\n${"-".repeat(24)}\n\nRuled out: a deploy.`;

    expect(usableFinding(withRule).text).toBe(withRule);
  });
});

describe("usableFinding — silence", () => {
  it("is silent on the agreed word", () => {
    expect(usableFinding("NOTHING").text).toBe("");
    expect(usableFinding("nothing.").text).toBe("");
    expect(usableFinding("  Nothing  ").text).toBe("");
  });

  it("does not mistake a real finding that opens with the word", () => {
    const finding =
      "Nothing merged in the six hours before the run, and no new Sentry " +
      "issues fired, so the cause is unclear.";

    expect(usableFinding(finding).text).toBe(finding);
  });

  it("is silent on a fragment too short to be the paragraph asked for", () => {
    const verdict = usableFinding("Unclear.");

    expect(verdict.text).toBe("");
    expect(verdict.reason).toMatch(/too short/);
  });

  it("is silent on an empty turn", () => {
    expect(usableFinding("   \n  ").text).toBe("");
  });
});

describe("usableFinding — leaked reasoning", () => {
  it("strips the model's planning line and keeps the finding", () => {
    const verdict = usableFinding(LEAKED_PLAN);

    expect(verdict.text.startsWith("The only code change")).toBe(true);
    expect(verdict.text).not.toMatch(/We need to fetch/);
    expect(verdict.reason).toMatch(/leaked plan/);
  });

  it("strips harmony channel markers wherever they survive", () => {
    const verdict = usableFinding(
      `<|channel|>final<|message|>${GOOD}<|return|>`
    );

    expect(verdict.text).toBe(GOOD);
  });

  it("keeps a recommendation that only looks like a plan line", () => {
    // First-person and forward-looking, but about the estate rather than about
    // the turn — the reader needs this one.
    const advice =
      "We should roll back PR #1246, which changed image URL construction " +
      "20 minutes before the run and is the only candidate in the window.";

    expect(usableFinding(advice).text).toBe(advice);
  });

  it("keeps only the final channel when the whole envelope survives", () => {
    const verdict = usableFinding(
      "<|start|>assistant<|channel|>analysis<|message|>We need to fetch PR " +
        `details.<|end|><|start|>assistant<|channel|>final<|message|>${GOOD}` +
        "<|return|>"
    );

    expect(verdict.text).toBe(GOOD);
    expect(verdict.text).not.toMatch(/We need to fetch/);
  });

  it("does not strip a plan line that is the whole message", () => {
    // Nothing survives it, so removing it would turn a diagnosable symptom
    // into indistinguishable silence.
    const verdict = usableFinding("We need to fetch the PR details.");

    expect(verdict.text).toBe("We need to fetch the PR details.");
  });
});

describe("usableFinding — truncation", () => {
  it("marks a paragraph cut mid-sentence rather than dropping it", () => {
    const cut =
      "The only code change landed just before the failing run was PR " +
      "#1246, and no new Sentry issues appeared in the same window";

    const verdict = usableFinding(cut);

    expect(verdict.text).toBe(`${cut} […cut off]`);
    expect(verdict.reason).toMatch(/truncated/);
  });

  it("leaves a finished sentence alone", () => {
    expect(usableFinding(GOOD)).toEqual({ text: GOOD });
  });

  it("accepts the punctuation a sentence can legitimately end on", () => {
    for (const ending of [".", "!", "?", ")", "”"]) {
      expect(looksTruncated(`${GOOD.slice(0, -1)}${ending}`)).toBe(false);
    }
  });
});
