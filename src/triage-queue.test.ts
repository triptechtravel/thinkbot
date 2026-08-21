import { describe, it, expect, vi, beforeEach } from "vitest";
import { enqueueTriage, triageQueueConfigured } from "./triage-queue";
import type { TriageJob } from "./triage-queue";

const job: TriageJob = {
  kind: "e2e",
  report: { repo: "owner/repo", sha: "abc", failures: [{ title: "a test" }] }
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("enqueueTriage", () => {
  it("sends the job to the queue", async () => {
    const send = vi.fn(async () => {});
    const env = { TRIAGE_QUEUE: { send } } as unknown as Env;

    expect(await enqueueTriage(env, job)).toBe(true);
    expect(send).toHaveBeenCalledWith(job);
  });

  /**
   * The inboxes acknowledge whether or not this succeeds, so the failure has
   * to be loud somewhere. A queue that is unavailable is not the sender's
   * problem to retry: clawdwatch would record a failed delivery and a CI job
   * would fail a step, both misleading about what actually broke.
   */
  it("reports failure rather than throwing when the send fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = {
      TRIAGE_QUEUE: {
        send: async () => {
          throw new Error("queue unavailable");
        }
      }
    } as unknown as Env;

    expect(await enqueueTriage(env, job)).toBe(false);
    expect(errors).toHaveBeenCalled();
  });

  it("reports failure rather than throwing when there is no binding", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await enqueueTriage({} as Env, job)).toBe(false);
    expect(errors).toHaveBeenCalled();
  });
});

describe("triageQueueConfigured", () => {
  it("is false without a binding", () => {
    expect(triageQueueConfigured({} as Env)).toBe(false);
  });

  it("is true with one", () => {
    expect(triageQueueConfigured({ TRIAGE_QUEUE: {} } as unknown as Env)).toBe(
      true
    );
  });
});
