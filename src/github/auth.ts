import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Settings } from "../config/settings.js";
import type { NormalizedPullRequestEvent } from "./events.js";

export interface GitHubInstallationTokenProvider {
  getInstallationToken(event: NormalizedPullRequestEvent): Promise<string | undefined>;
}

type GitHubAppInstallationTokenProviderOptions = {
  appId: string;
  privateKey: string;
  fallbackInstallationId?: number;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type InstallationTokenResponse = {
  token?: string;
};

export class GitHubAppInstallationTokenProvider implements GitHubInstallationTokenProvider {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly fallbackInstallationId?: number;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: GitHubAppInstallationTokenProviderOptions) {
    this.appId = options.appId;
    this.privateKey = normalizePrivateKey(options.privateKey);
    this.fallbackInstallationId = options.fallbackInstallationId;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getInstallationToken(event: NormalizedPullRequestEvent): Promise<string | undefined> {
    const installationId = event.installationId ?? this.fallbackInstallationId;
    if (!installationId) {
      return undefined;
    }

    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.createJwt()}`,
          "user-agent": "ai-code-review-agent",
          "x-github-api-version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub installation token minting failed with status ${response.status}`);
    }

    const body = (await response.json()) as InstallationTokenResponse;
    if (!body.token) {
      throw new Error("GitHub installation token response did not include a token");
    }

    return body.token;
  }

  private createJwt(): string {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    const header = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
    const payload = base64UrlEncodeJson({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: this.appId,
    });
    const unsignedToken = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(unsignedToken).sign(this.privateKey);

    return `${unsignedToken}.${base64UrlEncode(signature)}`;
  }
}

export function createGitHubInstallationTokenProvider(
  settings: Settings,
): GitHubInstallationTokenProvider | undefined {
  const privateKey = loadConfiguredPrivateKey(settings);
  if (!settings.githubAppId || !privateKey) {
    return undefined;
  }

  return new GitHubAppInstallationTokenProvider({
    appId: settings.githubAppId,
    privateKey,
    fallbackInstallationId: settings.githubAppInstallationId,
    apiBaseUrl: settings.githubApiBaseUrl,
  });
}

function loadConfiguredPrivateKey(settings: Settings): string | undefined {
  if (settings.githubAppPrivateKey) {
    return settings.githubAppPrivateKey;
  }

  if (settings.githubAppPrivateKeyPath) {
    return readFileSync(settings.githubAppPrivateKeyPath, "utf8");
  }

  return undefined;
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(Buffer.from(JSON.stringify(value)));
}

function base64UrlEncode(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
