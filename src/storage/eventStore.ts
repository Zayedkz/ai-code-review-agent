import type { NormalizedPullRequestEvent } from "../github/events.js";
import type { ReviewSummary } from "../review/reviewer.js";

export type StoredReviewEvent = {
  event: NormalizedPullRequestEvent;
  review: ReviewSummary;
  receivedAt: string;
};

export type StoreEventResult = {
  stored: boolean;
  record: StoredReviewEvent;
};

export interface ReviewEventStore {
  save(event: NormalizedPullRequestEvent, review: ReviewSummary): StoreEventResult;
  get(deliveryId: string): StoredReviewEvent | undefined;
  count(): number;
}

export class InMemoryReviewEventStore implements ReviewEventStore {
  private readonly records = new Map<string, StoredReviewEvent>();

  save(event: NormalizedPullRequestEvent, review: ReviewSummary): StoreEventResult {
    const existing = this.records.get(event.deliveryId);
    if (existing) {
      return { stored: false, record: existing };
    }

    const record = {
      event,
      review,
      receivedAt: new Date().toISOString(),
    };
    this.records.set(event.deliveryId, record);
    return { stored: true, record };
  }

  get(deliveryId: string): StoredReviewEvent | undefined {
    return this.records.get(deliveryId);
  }

  count(): number {
    return this.records.size;
  }
}
