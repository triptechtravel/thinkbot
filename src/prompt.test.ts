import { describe, it, expect } from "vitest";
import { OPS_SYSTEM_PROMPT, opsSystemPrompt } from "./agent-ops";

/**
 * The prompt carries two instructions that exist because of a specific wrong
 * answer, and both are easy to lose in a later edit.
 *
 * On 2026-08-22 triage concluded "site healthy, test flake" eight times out of
 * eight, across two models, about a site that was stalling for 40-60s. Two
 * things produced that: nothing told it to check the worker's own telemetry,
 * and nothing stopped it reporting a tool that had failed as a source that had
 * come back clean.
 */
describe("ops system prompt", () => {
  it("requires worker telemetry before blaming the test", () => {
    expect(OPS_SYSTEM_PROMPT).toMatch(/workerHealth/);
    // The reasoning has to travel with the instruction. Without it the rule
    // reads as a preference and gets dropped the first time it is inconvenient.
    expect(OPS_SYSTEM_PROMPT).toMatch(/first byte/i);
  });

  it("forbids reporting a failed tool as a clean source", () => {
    expect(OPS_SYSTEM_PROMPT).toMatch(
      /absence of evidence as evidence of absence/i
    );
    // Names the exact failure mode observed, so the instruction is concrete
    // rather than a maxim: gpt-oss-120b wrote "no new Sentry errors"
    // for tools that had errored.
    expect(OPS_SYSTEM_PROMPT).toMatch(/unreachable/i);
  });

  it("ties ruling something out to having actually looked", () => {
    expect(OPS_SYSTEM_PROMPT).toMatch(
      /Ruling something out requires having looked/i
    );
  });

  it("still asks for the bare word when there is nothing to say", () => {
    // The silence contract the e2e and alert paths both depend on.
    expect(OPS_SYSTEM_PROMPT).toMatch(/\bNOTHING\b/);
  });

  it("appends estate notes when the deployment has them", () => {
    const env = { ESTATE_NOTES: "  the campermate worker is `campermate`  " };
    const prompt = opsSystemPrompt(env as Env);

    expect(prompt).toContain("About this estate:");
    expect(prompt).toContain("the campermate worker is `campermate`");
    expect(opsSystemPrompt({} as Env)).toBe(OPS_SYSTEM_PROMPT);
  });
});
