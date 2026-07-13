import type { NormalizedPullRequestEvent } from "../github/events.js";
import { DeterministicReviewer, type PullRequestDiff, type ReviewSummary } from "./reviewer.js";

export type ReviewProviderName = "deterministic" | "mock" | "local";

export type ReviewProvider = {
  readonly name: ReviewProviderName;
  review(event: NormalizedPullRequestEvent, diff: PullRequestDiff): ReviewSummary | Promise<ReviewSummary>;
};

export function createReviewProvider(providerName: ReviewProviderName): ReviewProvider {
  if (providerName === "deterministic") {
    return new DeterministicReviewer();
  }

  return new MockLocalReviewProvider(providerName);
}

class MockLocalReviewProvider implements ReviewProvider {
  private readonly deterministicReviewer = new DeterministicReviewer();

  constructor(readonly name: "mock" | "local") {}

  review(event: NormalizedPullRequestEvent, diff: PullRequestDiff): ReviewSummary {
    const review = this.deterministicReviewer.review(event, diff);
    return {
      ...review,
      provider: this.name,
      summary: `${review.summary} LLM provider '${this.name}' ran in local mock mode without external API calls.`,
    };
  }
}
