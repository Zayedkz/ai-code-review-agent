import { describe, expect, it } from "vitest";

import { GitHubPullRequestFileClient } from "../src/github/client.js";
import type { NormalizedPullRequestEvent } from "../src/github/events.js";

const event: NormalizedPullRequestEvent = {
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
};

describe("GitHubPullRequestFileClient", () => {
  it("retrieves changed pull request files and patches", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify([
          { filename: "src/review.ts", patch: "+ console.log('debug');" },
          { filename: "tests/review.test.ts", patch: "+ expect(review).toBeDefined();" },
        ]),
        { status: 200 },
      );
    };

    const diff = await new GitHubPullRequestFileClient({
      apiBaseUrl: "https://api.github.test",
      token: "test-token",
      fetchImpl,
    }).fetchPullRequestDiff(event);

    expect(diff.files).toEqual([
      { path: "src/review.ts", patch: "+ console.log('debug');" },
      { path: "tests/review.test.ts", patch: "+ expect(review).toBeDefined();" },
    ]);
    expect(String(calls[0]?.input)).toBe(
      "https://api.github.test/repos/Zayedkz/example/pulls/12/files?per_page=100&page=1",
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer test-token",
      accept: "application/vnd.github+json",
    });
  });

  it("keeps file paths when GitHub omits large or binary patches", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify([{ filename: "snapshots/image.png" }]), { status: 200 });

    const diff = await new GitHubPullRequestFileClient({ fetchImpl }).fetchPullRequestDiff(event);

    expect(diff.files).toEqual([{ path: "snapshots/image.png", patch: "" }]);
  });

  it("throws when GitHub file retrieval fails", async () => {
    const fetchImpl: typeof fetch = async () => new Response("rate limited", { status: 403 });

    await expect(new GitHubPullRequestFileClient({ fetchImpl }).fetchPullRequestDiff(event)).rejects.toThrow(
      "GitHub file retrieval failed with status 403",
    );
  });
});
