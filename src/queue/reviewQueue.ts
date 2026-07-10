import { Queue, type JobsOptions } from "bullmq";

import type { NormalizedPullRequestEvent } from "../github/events.js";

export const reviewQueueName = "review-jobs";

export type ReviewJobPayload = {
  event: NormalizedPullRequestEvent;
};

export interface ReviewQueue {
  enqueue(event: NormalizedPullRequestEvent): Promise<void>;
}

export class InMemoryReviewQueue implements ReviewQueue {
  readonly enqueued: ReviewJobPayload[] = [];

  async enqueue(event: NormalizedPullRequestEvent): Promise<void> {
    this.enqueued.push({ event });
  }
}

export class BullMQReviewQueue implements ReviewQueue {
  private readonly queue: Queue<ReviewJobPayload>;

  constructor(redisUrl: string, private readonly maxAttempts: number) {
    this.queue = new Queue<ReviewJobPayload>(reviewQueueName, {
      connection: { url: redisUrl },
    });
  }

  async enqueue(event: NormalizedPullRequestEvent): Promise<void> {
    const options: JobsOptions = {
      jobId: event.deliveryId,
      attempts: this.maxAttempts,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: {
        age: 86_400,
      },
      removeOnFail: false,
    };

    await this.queue.add("review-pull-request", { event }, options);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
