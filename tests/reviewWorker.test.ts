import { describe, expect, it } from "vitest";

import type { NormalizedPullRequestEvent } from "../src/github/events.js";
import { ReviewJobProcessor } from "../src/queue/reviewWorker.js";
import { DeterministicReviewer } from "../src/review/reviewer.js";
import { InMemoryReviewEventStore } from "../src/storage/eventStore.js";
import { InMemoryReviewJobStore } from "../src/storage/reviewJobStore.js";

describe("ReviewJobProcessor", () => {
  it("executes queued review work and persists completed review events", async () => {
    const eventStore = new InMemoryReviewEventStore();
    const jobStore = new InMemoryReviewJobStore();
    const event = normalizedEvent("delivery-worker");
    await jobStore.create(event, 3);

    const processor = new ReviewJobProcessor({
      eventStore,
      jobStore,
      pullRequestFileClient: {
        fetchPullRequestDiff: async () => ({
          files: [
            { path: "src/config.ts", patch: "+ const token = process.env.GITHUB_TOKEN;" },
            { path: "tests/config.test.ts", patch: "+ expect(config).toBeDefined();" },
          ],
        }),
      },
      maxAttempts: 3,
    });

    const result = await processor.process({ event }, 1);

    expect(result).toMatchObject({
      status: "completed",
      attempts: 1,
    });
    const stored = await eventStore.get("delivery-worker");
    expect(stored?.review.riskLevel).toBe("high");
    expect(stored?.review.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["secret-handling-review"]),
    );
    expect(stored?.review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "secret-handling-review",
          locations: [{ path: "src/config.ts" }],
        }),
      ]),
    );
  });

  it("marks transient worker failures as failed and rethrows for BullMQ retry", async () => {
    const eventStore = new InMemoryReviewEventStore();
    const jobStore = new InMemoryReviewJobStore();
    const event = normalizedEvent("delivery-retry");
    await jobStore.create(event, 3);

    const processor = new ReviewJobProcessor({
      eventStore,
      jobStore,
      reviewer: new FailingReviewer(),
      maxAttempts: 3,
    });

    await expect(processor.process({ event }, 1)).rejects.toThrow("provider unavailable");
    await expect(jobStore.get("delivery-retry")).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "provider unavailable",
    });
    await expect(eventStore.count()).resolves.toBe(0);
  });

  it("marks terminal worker failures as dead-letter without persisting a review", async () => {
    const eventStore = new InMemoryReviewEventStore();
    const jobStore = new InMemoryReviewJobStore();
    const event = normalizedEvent("delivery-dead");
    await jobStore.create(event, 2);

    const processor = new ReviewJobProcessor({
      eventStore,
      jobStore,
      reviewer: new FailingReviewer(),
      maxAttempts: 2,
    });

    const result = await processor.process({ event }, 2);

    expect(result).toMatchObject({
      status: "dead_letter",
      attempts: 2,
      maxAttempts: 2,
      lastError: "provider unavailable",
    });
    await expect(eventStore.count()).resolves.toBe(0);
  });
});

class FailingReviewer extends DeterministicReviewer {
  override review(): never {
    throw new Error("provider unavailable");
  }
}

function normalizedEvent(deliveryId: string): NormalizedPullRequestEvent {
  return {
    deliveryId,
    action: "opened",
    repository: "Zayedkz/example",
    repositoryUrl: "https://github.com/Zayedkz/example",
    pullRequestNumber: 7,
    pullRequestTitle: "Add webhook handler",
    pullRequestUrl: "https://github.com/Zayedkz/example/pull/7",
    author: "zayedkz",
    headSha: "abc123",
    headRef: "feature/webhook",
    baseSha: "def456",
    baseRef: "main",
    changedFiles: 25,
    additions: 900,
    deletions: 40,
    body: "This PR uses process.env.GITHUB_TOKEN and has TODO follow-up work.",
    installationId: 12345,
  };
}
