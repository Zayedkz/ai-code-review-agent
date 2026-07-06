import type { NormalizedPullRequestEvent } from "./events.js";
import type { PullRequestDiff } from "../review/reviewer.js";

export interface PullRequestFileClient {
  fetchPullRequestDiff(event: NormalizedPullRequestEvent): Promise<PullRequestDiff>;
}

type GitHubPullRequestFile = {
  filename: string;
  patch?: string;
};

export type GitHubClientOptions = {
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class GitHubPullRequestFileClient implements PullRequestFileClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token?: string;

  constructor(options: GitHubClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token;
  }

  async fetchPullRequestDiff(event: NormalizedPullRequestEvent): Promise<PullRequestDiff> {
    const files: PullRequestDiff["files"] = [];
    const [owner, repo] = parseRepository(event.repository);
    let page = 1;

    while (true) {
      const url = new URL(
        `${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${event.pullRequestNumber}/files`,
      );
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const response = await this.fetchImpl(url, {
        headers: this.headers(),
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

  private headers(): HeadersInit {
    const headers: HeadersInit = {
      accept: "application/vnd.github+json",
      "user-agent": "ai-code-review-agent",
      "x-github-api-version": "2022-11-28",
    };

    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
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
