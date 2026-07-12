import { describe, expect, it } from "vitest";

import type { NormalizedPullRequestEvent } from "../src/github/events.js";
import { DeterministicReviewer } from "../src/review/reviewer.js";

const baseEvent: NormalizedPullRequestEvent = {
  deliveryId: "delivery-1",
  action: "opened",
  repository: "Zayedkz/example",
  repositoryUrl: "https://github.com/Zayedkz/example",
  pullRequestNumber: 12,
  pullRequestTitle: "Add feature",
  pullRequestUrl: "https://github.com/Zayedkz/example/pull/12",
  author: "zayedkz",
  headSha: "abc",
  headRef: "feature",
  baseSha: "def",
  baseRef: "main",
  changedFiles: 2,
  additions: 80,
  deletions: 10,
  body: null,
  installationId: null,
};

describe("DeterministicReviewer", () => {
  it("flags missing tests and risky secret handling", () => {
    const review = new DeterministicReviewer().review(baseEvent, {
      files: [
        {
          path: "src/config.ts",
          patch: "+ const token = process.env.GITHUB_TOKEN;",
        },
      ],
    });

    expect(review.riskLevel).toBe("high");
    expect(review.findings.map((finding) => finding.code)).toEqual([
      "missing-test-change",
      "secret-handling-review",
    ]);
    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-test-change",
          locations: [{ path: "src/config.ts" }],
        }),
        expect.objectContaining({
          code: "secret-handling-review",
          locations: [{ path: "src/config.ts" }],
        }),
      ]),
    );
  });

  it("keeps low risk when tests are changed and no patterns match", () => {
    const review = new DeterministicReviewer().review(baseEvent, {
      files: [
        {
          path: "tests/reviewer.test.ts",
          patch: "+ expect(result).toBeDefined();",
        },
      ],
    });

    expect(review.riskLevel).toBe("low");
    expect(review.findings).toEqual([]);
  });

  it("uses fetched file paths to recognize test-only changes even when patches are unavailable", () => {
    const review = new DeterministicReviewer().review(baseEvent, {
      files: [
        {
          path: "tests/snapshot.test.ts",
          patch: "",
        },
      ],
    });

    expect(review.riskLevel).toBe("low");
    expect(review.findings).toEqual([]);
  });

  it("attributes pattern findings to the matching changed files only", () => {
    const review = new DeterministicReviewer().review(baseEvent, {
      files: [
        {
          path: "src/config.ts",
          patch: "+ const token = process.env.GITHUB_TOKEN;",
        },
        {
          path: "src/logger.ts",
          patch: "+ console.log('debug');",
        },
        {
          path: "tests/logger.test.ts",
          patch: "+ expect(logger).toBeDefined();",
        },
      ],
    });

    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "debug-or-placeholder-code",
          locations: [{ path: "src/logger.ts" }],
        }),
        expect.objectContaining({
          code: "secret-handling-review",
          locations: [{ path: "src/config.ts" }],
        }),
      ]),
    );
    expect(review.findings.find((finding) => finding.code === "missing-test-change")).toBeUndefined();
  });
});
