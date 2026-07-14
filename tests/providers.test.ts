import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings.js";
import type { NormalizedPullRequestEvent } from "../src/github/events.js";
import { createReviewProvider } from "../src/review/providers.js";

const event: NormalizedPullRequestEvent = {
  deliveryId: "delivery-provider",
  action: "opened",
  repository: "Zayedkz/example",
  repositoryUrl: "https://github.com/Zayedkz/example",
  pullRequestNumber: 3,
  pullRequestTitle: "Add provider",
  pullRequestUrl: "https://github.com/Zayedkz/example/pull/3",
  author: "zayedkz",
  headSha: "abc",
  headRef: "feature",
  baseSha: "def",
  baseRef: "main",
  changedFiles: 1,
  additions: 10,
  deletions: 2,
  body: null,
  installationId: null,
};

describe("review provider selection", () => {
  it("defaults settings to the deterministic provider", () => {
    expect(loadSettings({}).llmProvider).toBe("deterministic");
  });

  it("keeps PR comment publishing opt-in", () => {
    expect(loadSettings({}).publishReviewComments).toBe(false);
    expect(loadSettings({ PUBLISH_REVIEW_COMMENTS: "true" }).publishReviewComments).toBe(true);
  });

  it("selects a mock local provider without external API calls", async () => {
    const provider = createReviewProvider("mock");
    const review = await provider.review(event, {
      files: [{ path: "tests/provider.test.ts", patch: "+ expect(review).toBeDefined();" }],
    });

    expect(provider.name).toBe("mock");
    expect(review.provider).toBe("mock");
    expect(review.summary).toContain("local mock mode");
  });

  it("selects the deterministic provider explicitly", async () => {
    const provider = createReviewProvider("deterministic");
    const review = await provider.review(event, {
      files: [{ path: "tests/provider.test.ts", patch: "+ expect(review).toBeDefined();" }],
    });

    expect(provider.name).toBe("deterministic");
    expect(review.provider).toBe("deterministic");
  });
});
