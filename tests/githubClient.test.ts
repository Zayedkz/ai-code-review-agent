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
  installationId: 12345,
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
      installationTokenProvider: {
        getInstallationToken: async () => "installation-token",
      },
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
      authorization: "Bearer installation-token",
      accept: "application/vnd.github+json",
    });
  });

  it("retrieves files without auth when no installation token provider is configured", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await new GitHubPullRequestFileClient({ fetchImpl }).fetchPullRequestDiff(event);

    expect(calls[0]?.init?.headers).not.toMatchObject({
      authorization: expect.any(String),
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

  it("creates a managed review summary comment when none exists for the delivery and head SHA", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith("/issues/12/comments?per_page=100&page=1")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 456 }), { status: 201 });
    };

    const result = await new GitHubPullRequestFileClient({
      apiBaseUrl: "https://api.github.test",
      installationTokenProvider: {
        getInstallationToken: async () => "installation-token",
      },
      fetchImpl,
    }).publishReviewSummaryComment(event, {
      provider: "deterministic",
      riskLevel: "medium",
      summary: "Zayedkz/example#12 reviewed with 1 finding(s).",
      findings: [
        {
          code: "missing-test-change",
          severity: "warning",
          message: "No test files were changed in this pull request.",
          recommendation: "Add or update tests.",
          locations: [{ path: "src/review.ts" }],
        },
      ],
    });

    expect(result).toEqual({ commentId: 456, action: "created" });
    expect(calls.map((call) => String(call.input))).toEqual([
      "https://api.github.test/repos/Zayedkz/example/issues/12/comments?per_page=100&page=1",
      "https://api.github.test/repos/Zayedkz/example/issues/12/comments",
    ]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.headers).toMatchObject({
      authorization: "Bearer installation-token",
      "content-type": "application/json",
    });
    expect(String(calls[1]?.init?.body)).toContain(
      "<!-- ai-code-review-agent:delivery=delivery-1;head=abc -->",
    );
    expect(String(calls[1]?.init?.body)).toContain("missing-test-change");
    expect(String(calls[1]?.init?.body)).toContain("src/review.ts");
  });

  it("updates the managed review summary comment for the same delivery and head SHA", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith("/issues/12/comments?per_page=100&page=1")) {
        return new Response(
          JSON.stringify([
            { id: 100, body: "unrelated comment" },
            { id: 101, body: "<!-- ai-code-review-agent:delivery=delivery-1;head=abc -->\nold body" },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 101 }), { status: 200 });
    };

    const result = await new GitHubPullRequestFileClient({
      apiBaseUrl: "https://api.github.test",
      fetchImpl,
    }).publishReviewSummaryComment(event, {
      provider: "deterministic",
      riskLevel: "low",
      summary: "Zayedkz/example#12 reviewed with 0 finding(s).",
      findings: [],
    });

    expect(result).toEqual({ commentId: 101, action: "updated" });
    expect(String(calls[1]?.input)).toBe("https://api.github.test/repos/Zayedkz/example/issues/comments/101");
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(String(calls[1]?.init?.body)).toContain("- No findings.");
  });

  it("throws when review comment lookup fails", async () => {
    const fetchImpl: typeof fetch = async () => new Response("forbidden", { status: 403 });

    await expect(
      new GitHubPullRequestFileClient({ fetchImpl }).publishReviewSummaryComment(event, {
        provider: "deterministic",
        riskLevel: "low",
        summary: "reviewed",
        findings: [],
      }),
    ).rejects.toThrow("GitHub review comment lookup failed with status 403");
  });
});
