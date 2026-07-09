import type { NormalizedPullRequestEvent } from "./events.js";
import type { PullRequestDiff } from "../review/reviewer.js";
import type { GitHubInstallationTokenProvider } from "./auth.js";

export interface PullRequestFileClient {
  fetchPullRequestDiff(event: NormalizedPullRequestEvent): Promise<PullRequestDiff>;
}

type GitHubPullRequestFile = {
  filename: string;
  patch?: string;
};

export type GitHubClientOptions = {
  installationTokenProvider?: GitHubInstallationTokenProvider;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class GitHubPullRequestFileClient implements PullRequestFileClient {
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

  private headers(token?: string): HeadersInit {
    const headers: HeadersInit = {
      accept: "application/vnd.github+json",
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
