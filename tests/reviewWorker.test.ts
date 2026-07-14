import { describe, expect, it } from "vitest";

import type { NormalizedPullRequestEvent } from "../src/github/events.js";
import { ReviewJobProcessor } from "../src/queue/reviewWorker.js";
import type { ReviewProvider } from "../src/review/providers.js";
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

  it("redacts diff and pull request body text before provider review", async () => {
    const eventStore = new InMemoryReviewEventStore();
    const jobStore = new InMemoryReviewJobStore();
    const event = normalizedEvent("delivery-redaction");
    await jobStore.create(event, 3);

    const reviewer = new RecordingReviewer();
    const processor = new ReviewJobProcessor({
      eventStore,
      jobStore,
      reviewer,
      pullRequestFileClient: {
        fetchPullRequestDiff: async () => ({
          files: [
            {
              path: "src/config.ts",
              patch: "+ const token = 'ghp_123456789012345678901234567890123456';",
            },
          ],
        }),
      },
      maxAttempts: 3,
    });

    await processor.process({ event }, 1);

    expect(reviewer.receivedPatch).not.toContain("ghp_123456789012345678901234567890123456");
    expect(reviewer.receivedPatch).toContain("[REDACTED]");
    expect(reviewer.receivedBody).not.toContain("GITHUB_TOKEN");
    const stored = await eventStore.get("delivery-redaction");
    expect(stored?.event.body).toContain("GITHUB_TOKEN");
  });

  it("publishes a review summary comment after persisting the review", async () => {
    const eventStore = new InMemoryReviewEventStore();
    const jobStore = new InMemoryReviewJobStore();
    const event = normalizedEvent("delivery-comment");
    const published: Array<{ event: NormalizedPullRequestEvent; riskLevel: string }> = [];
    await jobStore.create(event, 3);

    const processor = new ReviewJobProcessor({
      eventStore,
      jobStore,
      pullRequestFileClient: {
        fetchPullRequestDiff: async () => ({
          files: [{ path: "src/review.ts", patch: "+ console.log('debug');" }],
        }),
      },
      pullRequestReviewCommentClient: {
        publishReviewSummaryComment: async (reviewEvent, review) => {
          published.push({ event: reviewEvent, riskLevel: review.riskLevel });
          return { commentId: 1001, action: "created" };
        },
      },
      maxAttempts: 3,
    });

    const result = await processor.process({ event }, 1);

    expect(result.status).toBe("completed");
    expect(published).toEqual([{ event, riskLevel: "medium" }]);
    await expect(eventStore.get("delivery-comment")).resolves.toBeDefined();
  });

  it("marks comment publishing failures as retryable worker failures", async () => {
    const eventStore = new InMemoryReviewEventStore();
    const jobStore = new InMemoryReviewJobStore();
    const event = normalizedEvent("delivery-comment-fail");
    await jobStore.create(event, 3);

    const processor = new ReviewJobProcessor({
      eventStore,
      jobStore,
      pullRequestReviewCommentClient: {
        publishReviewSummaryComment: async () => {
          throw new Error("comment write denied");
        },
      },
      maxAttempts: 3,
    });

    await expect(processor.process({ event }, 1)).rejects.toThrow("comment write denied");
    await expect(jobStore.get("delivery-comment-fail")).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "comment write denied",
    });
    await expect(eventStore.get("delivery-comment-fail")).resolves.toBeDefined();
  });
});

class FailingReviewer extends DeterministicReviewer {
  override review(): never {
    throw new Error("provider unavailable");
  }
}

class RecordingReviewer implements ReviewProvider {
  readonly name = "deterministic";
  receivedPatch = "";
  receivedBody: string | null = null;

  review(event: NormalizedPullRequestEvent, diff: Parameters<ReviewProvider["review"]>[1]) {
    this.receivedPatch = diff.files[0]?.patch ?? "";
    this.receivedBody = event.body;
    return new DeterministicReviewer().review(event, diff);
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
