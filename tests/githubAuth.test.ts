import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GitHubAppInstallationTokenProvider } from "../src/github/auth.js";
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

describe("GitHubAppInstallationTokenProvider", () => {
  it("mints scoped installation tokens with a GitHub App JWT", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
    };

    const token = await new GitHubAppInstallationTokenProvider({
      appId: "98765",
      privateKey: testPrivateKey(),
      apiBaseUrl: "https://api.github.test",
      fetchImpl,
      now: () => new Date("2026-07-09T16:33:00.000Z"),
    }).getInstallationToken(event);

    expect(token).toBe("installation-token");
    expect(calls[0]?.input).toBe("https://api.github.test/app/installations/12345/access_tokens");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      "user-agent": "ai-code-review-agent",
    });

    const authorization = (calls[0]?.init?.headers as Record<string, string>).authorization;
    expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    const [, payload] = authorization.replace("Bearer ", "").split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toMatchObject({
      iss: "98765",
    });
  });

  it("uses a configured fallback installation ID when the event has none", async () => {
    const calls: Array<string | URL | Request> = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(input);
      return new Response(JSON.stringify({ token: "fallback-token" }), { status: 201 });
    };

    const token = await new GitHubAppInstallationTokenProvider({
      appId: "98765",
      privateKey: testPrivateKey(),
      fallbackInstallationId: 67890,
      apiBaseUrl: "https://api.github.test",
      fetchImpl,
    }).getInstallationToken({ ...event, installationId: null });

    expect(token).toBe("fallback-token");
    expect(calls[0]).toBe("https://api.github.test/app/installations/67890/access_tokens");
  });
});

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
