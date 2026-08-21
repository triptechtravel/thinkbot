import { describe, it, expect, vi, beforeEach } from "vitest";
import { enqueueTurn, turnQueueConfigured } from "./turn-queue";
import type { QueueJob } from "./turn-queue";

const job: QueueJob = {
  kind: "e2e",
  report: { repo: "owner/repo", sha: "abc", failures: [{ title: "a test" }] }
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("enqueueTurn", () => {
  it("sends the job to the queue", async () => {
    const send = vi.fn(async () => {});
    const env = { TRIAGE_QUEUE: { send } } as unknown as Env;

    expect(await enqueueTurn(env, job)).toBe(true);
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

    expect(await enqueueTurn(env, job)).toBe(false);
    expect(errors).toHaveBeenCalled();
  });

  it("reports failure rather than throwing when there is no binding", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await enqueueTurn({} as Env, job)).toBe(false);
    expect(errors).toHaveBeenCalled();
  });
});

describe("turnQueueConfigured", () => {
  it("is false without a binding", () => {
    expect(turnQueueConfigured({} as Env)).toBe(false);
  });

  it("is true with one", () => {
    expect(turnQueueConfigured({ TRIAGE_QUEUE: {} } as unknown as Env)).toBe(
      true
    );
  });
});
