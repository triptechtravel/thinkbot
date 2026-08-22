import { describe, it, expect, vi, beforeEach } from "vitest";

const generateText = vi.fn();
vi.mock("ai", () => ({ generateText, stepCountIs: (n: number) => n }));
vi.mock("workers-ai-provider", () => ({
  createWorkersAI: () => (id: string) => ({ id })
}));
vi.mock("./tools/clawdwatch", () => ({ clawdwatchTools: () => ({}) }));
vi.mock("./tools/github", () => ({ githubTools: () => ({}) }));
vi.mock("./tools/datadog", () => ({ datadogTools: () => ({}) }));
vi.mock("./tools/workers", () => ({ workerTools: () => ({}) }));
vi.mock("./tools/errors", () => ({
  sentryTools: () => ({}),
  rollbarTools: () => ({})
}));

const { runOpsTurn } = await import("./agent-ops");

const env = {} as Env;

const turn = (text: string, steps: number, withEvidence = true) => ({
  text,
  steps: new Array(steps).fill(null).map((_, i) => ({
    toolResults: withEvidence
      ? [{ toolName: `tool${i}`, output: { finding: `result ${i}` } }]
      : []
  })),
  response: { messages: [{ role: "assistant", content: "…" }] }
});

beforeEach(() => generateText.mockReset());

/**
 * A turn that queries every source and then writes nothing.
 *
 * Observed on 2 of 3 runs against the recorded report, always on the turns
 * that did the most work — the investigation happened, the paragraph never
 * did, and the channel got silence under a live headline.
 */
describe("runOpsTurn — an empty answer after real work", () => {
  it("asks again, with no tools, and returns what comes back", async () => {
    generateText
      .mockResolvedValueOnce(turn("", 5))
      .mockResolvedValueOnce(turn("PR #1246 landed 20 minutes before.", 1));

    const result = await runOpsTurn(env, "why did it fail?");

    expect(result.text).toBe("PR #1246 landed 20 minutes before.");
    // The step count must stay the investigation's, not the retry's — it is
    // how a caller tells a real turn from a model answering off the prompt.
    expect(result.steps).toBe(5);

    // The second call offers no tools and does NOT continue the tool
    // conversation — a turn that stopped mid-tool-call leaves an assistant
    // call with no matching result, and asking a model to continue from that
    // returns the same silence. It gets the evidence as plain text instead.
    const second = generateText.mock.calls[1][0];
    expect(second.tools).toBeUndefined();
    expect(second.messages).toBeUndefined();
    expect(second.prompt).toMatch(/Write the answer now/);
    // The evidence has to actually travel, or the retry is guesswork.
    expect(second.prompt).toContain("tool0");
    expect(second.prompt).toContain("result 0");
    // ...and the original question, so it knows what it is answering.
    expect(second.prompt).toContain("why did it fail?");
  });

  it("does not spend a second call when the first one answered", async () => {
    generateText.mockResolvedValueOnce(turn("A clear finding.", 4));

    const result = await runOpsTurn(env, "why?");

    expect(result.text).toBe("A clear finding.");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("does not retry a turn that never did anything", async () => {
    // Zero steps and no text is a model declining the question, not work
    // being dropped. Asking again just spends money on the same silence.
    generateText.mockResolvedValueOnce(turn("", 0));

    const result = await runOpsTurn(env, "why?");

    expect(result.text).toBe("");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the steps carried no tool results", async () => {
    // Steps without evidence give the retry nothing to summarise, so it would
    // be asking the model to invent one — the filler the prompt forbids.
    generateText.mockResolvedValueOnce(turn("", 3, false));

    const result = await runOpsTurn(env, "why?");

    expect(result.text).toBe("");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("still allows the retry to say NOTHING", async () => {
    // The silence contract has to survive the retry, or every quiet incident
    // gains a paragraph of filler.
    generateText
      .mockResolvedValueOnce(turn("", 3))
      .mockResolvedValueOnce(turn("NOTHING", 1));

    expect((await runOpsTurn(env, "why?")).text).toBe("NOTHING");
  });

  it("reports a failed retry as an error, not as silence", async () => {
    generateText
      .mockResolvedValueOnce(turn("", 3))
      .mockRejectedValueOnce(new Error("model exploded"));

    const result = await runOpsTurn(env, "why?");

    expect(result.text).toMatch(/Could not complete the investigation/);
  });
});
