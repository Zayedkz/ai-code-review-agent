import { Worker, type Job } from "bullmq";

import type { Settings } from "../config/settings.js";
import { createGitHubInstallationTokenProvider } from "../github/auth.js";
import {
  GitHubPullRequestFileClient,
  type PullRequestFileClient,
} from "../github/client.js";
import type { NormalizedPullRequestEvent } from "../github/events.js";
import { createReviewProvider, type ReviewProvider } from "../review/providers.js";
import { redactPullRequestDiff, redactReviewEvent } from "../review/redaction.js";
import type { PullRequestDiff } from "../review/reviewer.js";
import {
  createPostgresReviewEventStore,
  type ReviewEventStore,
} from "../storage/eventStore.js";
import {
  createPostgresReviewJobStore,
  type ReviewJobRecord,
  type ReviewJobStore,
} from "../storage/reviewJobStore.js";
import { reviewQueueName, type ReviewJobPayload } from "./reviewQueue.js";

export type ReviewJobProcessorOptions = {
  eventStore: ReviewEventStore;
  jobStore: ReviewJobStore;
  reviewer?: ReviewProvider;
  pullRequestFileClient?: PullRequestFileClient;
  maxAttempts?: number;
};

export class ReviewJobProcessor {
  private readonly reviewer: ReviewProvider;
  private readonly maxAttempts: number;

  constructor(private readonly options: ReviewJobProcessorOptions) {
    this.reviewer = options.reviewer ?? createReviewProvider("deterministic");
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async process(payload: ReviewJobPayload, attempt = 1): Promise<ReviewJobRecord> {
    await this.options.jobStore.markRunning(payload.event.deliveryId, attempt);
    try {
      const diff = redactPullRequestDiff(await extractDiff(payload.event, this.options.pullRequestFileClient));
      const review = await this.reviewer.review(redactReviewEvent(payload.event), diff);
      await this.options.eventStore.save(payload.event, review);
      return await this.options.jobStore.markCompleted(payload.event.deliveryId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown review job failure";
      const failed = await this.options.jobStore.markFailed(
        payload.event.deliveryId,
        attempt,
        this.maxAttempts,
        message,
      );
      if (attempt < this.maxAttempts) {
        throw error;
      }
      return failed;
    }
  }
}

export function createBullMQReviewWorker(settings: Settings): Worker<ReviewJobPayload> {
  const processor = new ReviewJobProcessor({
    eventStore: createPostgresReviewEventStore(settings.databaseUrl),
    jobStore: createPostgresReviewJobStore(settings.databaseUrl),
    pullRequestFileClient: new GitHubPullRequestFileClient({
      installationTokenProvider: createGitHubInstallationTokenProvider(settings),
      apiBaseUrl: settings.githubApiBaseUrl,
    }),
    reviewer: createReviewProvider(settings.llmProvider),
    maxAttempts: settings.reviewJobMaxAttempts,
  });

  return new Worker<ReviewJobPayload>(
    reviewQueueName,
    async (job: Job<ReviewJobPayload>) => {
      await processor.process(job.data, job.attemptsMade + 1);
    },
    {
      connection: { url: settings.redisUrl },
      concurrency: settings.reviewWorkerConcurrency,
    },
  );
}

async function extractDiff(
  event: NormalizedPullRequestEvent,
  pullRequestFileClient?: PullRequestFileClient,
): Promise<PullRequestDiff> {
  try {
    const diff = await pullRequestFileClient?.fetchPullRequestDiff(event);
    if (diff && diff.files.length > 0) {
      return diff;
    }
  } catch (error) {
    console.warn("GitHub PR file retrieval failed; falling back to pull request body", {
      deliveryId: event.deliveryId,
      repository: event.repository,
      pullRequestNumber: event.pullRequestNumber,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }

  return {
    files: [
      {
        path: "pull-request-description.md",
        patch: event.body ?? "",
      },
    ],
  };
}
