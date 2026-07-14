import type { NormalizedPullRequestEvent } from "./events.js";
import type { PullRequestDiff, ReviewFinding, ReviewSummary } from "../review/reviewer.js";
import type { GitHubInstallationTokenProvider } from "./auth.js";

export interface PullRequestFileClient {
  fetchPullRequestDiff(event: NormalizedPullRequestEvent): Promise<PullRequestDiff>;
}

export interface PullRequestReviewCommentClient {
  publishReviewSummaryComment(event: NormalizedPullRequestEvent, review: ReviewSummary): Promise<PublishedComment>;
}

export type PublishedComment = {
  commentId: number;
  action: "created" | "updated";
};

type GitHubPullRequestFile = {
  filename: string;
  patch?: string;
};

type GitHubIssueComment = {
  id: number;
  body?: string;
};

export type GitHubClientOptions = {
  installationTokenProvider?: GitHubInstallationTokenProvider;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class GitHubPullRequestFileClient implements PullRequestFileClient, PullRequestReviewCommentClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly installationTokenProvider?: GitHubInstallationTokenProvider;

  constructor(options: GitHubClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.installationTokenProvider = options.installationTokenProvider;
  }

  async fetchPullRequestDiff(event: NormalizedPullRequestEvent): Promise<PullRequestDiff> {
    const files: PullRequestDiff["files"] = [];
    const [owner, repo] = parseRepository(event.repository);
    const token = await this.installationTokenProvider?.getInstallationToken(event);
    let page = 1;

    while (true) {
      const url = new URL(
        `${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${event.pullRequestNumber}/files`,
      );
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const response = await this.fetchImpl(url, {
        headers: this.headers(token),
      });

      if (!response.ok) {
        throw new Error(`GitHub file retrieval failed with status ${response.status}`);
      }

      const batch = (await response.json()) as GitHubPullRequestFile[];
      files.push(
        ...batch.map((file) => ({
          path: file.filename,
          patch: file.patch ?? "",
        })),
      );

      if (batch.length < 100) {
        break;
      }
      page += 1;
    }

    return { files };
  }

  async publishReviewSummaryComment(
    event: NormalizedPullRequestEvent,
    review: ReviewSummary,
  ): Promise<PublishedComment> {
    const [owner, repo] = parseRepository(event.repository);
    const token = await this.installationTokenProvider?.getInstallationToken(event);
    const body = formatReviewSummaryComment(event, review);
    const existingComment = await this.findManagedReviewComment(owner, repo, event, token);

    if (existingComment) {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${existingComment.id}`,
        {
          method: "PATCH",
          headers: this.headers(token),
          body: JSON.stringify({ body }),
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub review comment update failed with status ${response.status}`);
      }
      return { commentId: existingComment.id, action: "updated" };
    }

    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${event.pullRequestNumber}/comments`,
      {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub review comment creation failed with status ${response.status}`);
    }

    const created = (await response.json()) as GitHubIssueComment;
    return { commentId: created.id, action: "created" };
  }

  private async findManagedReviewComment(
    owner: string,
    repo: string,
    event: NormalizedPullRequestEvent,
    token?: string,
  ): Promise<GitHubIssueComment | undefined> {
    const marker = reviewCommentMarker(event);
    let page = 1;

    while (true) {
      const url = new URL(
        `${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${event.pullRequestNumber}/comments`,
      );
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const response = await this.fetchImpl(url, {
        headers: this.headers(token),
      });
      if (!response.ok) {
        throw new Error(`GitHub review comment lookup failed with status ${response.status}`);
      }

      const comments = (await response.json()) as GitHubIssueComment[];
      const existing = comments.find((comment) => comment.body?.includes(marker));
      if (existing) {
        return existing;
      }
      if (comments.length < 100) {
        return undefined;
      }
      page += 1;
    }
  }

  private headers(token?: string): HeadersInit {
    const headers: HeadersInit = {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "ai-code-review-agent",
      "x-github-api-version": "2022-11-28",
    };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    return headers;
  }
}

function parseRepository(repository: string): [owner: string, repo: string] {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository name: ${repository}`);
  }
  return [owner, repo];
}

function formatReviewSummaryComment(event: NormalizedPullRequestEvent, review: ReviewSummary): string {
  const findings =
    review.findings.length === 0
      ? "- No findings."
      : review.findings.map((finding) => `- ${formatFinding(finding)}`).join("\n");

  return [
    reviewCommentMarker(event),
    "## AI Code Review Summary",
    "",
    `**Risk:** ${review.riskLevel}`,
    `**Provider:** ${review.provider}`,
    `**Head SHA:** \`${event.headSha}\``,
    "",
    review.summary,
    "",
    "### Findings",
    findings,
    "",
    `_Delivery: \`${event.deliveryId}\`_`,
  ].join("\n");
}

function formatFinding(finding: ReviewFinding): string {
  const locations = finding.locations?.map((location) => `\`${location.path}\``).join(", ");
  const locationText = locations ? ` (${locations})` : "";
  return `**${finding.severity}** \`${finding.code}\`${locationText}: ${finding.message} Recommendation: ${finding.recommendation}`;
}

function reviewCommentMarker(event: NormalizedPullRequestEvent): string {
  return `<!-- ai-code-review-agent:delivery=${event.deliveryId};head=${event.headSha} -->`;
}
