import request from "supertest";
import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings.js";
import type { PullRequestFileClient } from "../src/github/client.js";
import { createGitHubSignature } from "../src/github/signature.js";
import { createApp } from "../src/http/app.js";
import { InMemoryReviewEventStore } from "../src/storage/eventStore.js";

const settings = loadSettings({
  APP_ENV: "test",
  PORT: "8080",
  GITHUB_WEBHOOK_SECRET: "test-secret",
});

describe("GitHub webhook endpoint", () => {
  it("accepts signed pull_request events and stores them idempotently", async () => {
    const store = new InMemoryReviewEventStore();
    const pullRequestFileClient = new CountingPullRequestFileClient();
    const app = createApp({ settings, store, pullRequestFileClient });
    const payload = pullRequestPayload();

    const first = await postWebhook(app, payload, "delivery-123");
    const second = await postWebhook(app, payload, "delivery-123");

    expect(first.statusCode).toBe(202);
    expect(first.body.accepted).toBe(true);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.review.riskLevel).toBe("high");
    expect(second.statusCode).toBe(200);
    expect(second.body.duplicate).toBe(true);
    await expect(store.count()).resolves.toBe(1);
    expect(pullRequestFileClient.calls).toBe(1);
  });

  it("returns stored review delivery audit details", async () => {
    const store = new InMemoryReviewEventStore();
    const app = createApp({ settings, store, pullRequestFileClient: new BodyFallbackPullRequestFileClient() });
    const payload = pullRequestPayload();

    await postWebhook(app, payload, "delivery-audit");
    const response = await request(app).get("/reviews/delivery-audit");

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      deliveryId: "delivery-audit",
      status: "stored",
      duplicateReplayBehavior: "duplicate deliveries return the originally stored review",
      repository: "Zayedkz/example",
      pullRequestNumber: 7,
      action: "opened",
      headSha: "abc123",
      riskLevel: "high",
    });
    expect(response.body.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "secret-handling-review", severity: "critical" }),
      ]),
    );
    expect(response.body.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns 404 when a review delivery is missing", async () => {
    const app = createApp({ settings, store: new InMemoryReviewEventStore() });

    const response = await request(app).get("/reviews/missing-delivery");

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: "review delivery not found" });
  });

  it("rejects invalid signatures", async () => {
    const app = createApp({
      settings,
      store: new InMemoryReviewEventStore(),
      pullRequestFileClient: new BodyFallbackPullRequestFileClient(),
    });
    const payload = pullRequestPayload();

    const response = await request(app)
      .post("/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-github-delivery", "delivery-456")
      .set("x-hub-signature-256", "sha256=bad")
      .send(payload);

    expect(response.statusCode).toBe(401);
  });

  it("returns health with stored event count", async () => {
    const app = createApp({ settings, store: new InMemoryReviewEventStore() });

    const response = await request(app).get("/health");

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      environment: "test",
      storedEvents: 0,
    });
  });

  it("reviews fetched GitHub file paths instead of only pull request body text", async () => {
    const store = new InMemoryReviewEventStore();
    const app = createApp({
      settings,
      store,
      pullRequestFileClient: {
        fetchPullRequestDiff: async () => ({
          files: [
            { path: "src/config.ts", patch: "+ const token = process.env.GITHUB_TOKEN;" },
            { path: "tests/config.test.ts", patch: "+ expect(config).toBeDefined();" },
          ],
        }),
      },
    });
    const payload = pullRequestPayload({
      changed_files: 2,
      additions: 40,
      deletions: 2,
      body: "Safe body text without implementation details.",
    });

    const response = await postWebhook(app, payload, "delivery-real-diff");

    expect(response.statusCode).toBe(202);
    expect(response.body.review.riskLevel).toBe("high");
    expect(response.body.review.findings.map((finding: { code: string }) => finding.code)).toEqual([
      "secret-handling-review",
    ]);
  });
});

async function postWebhook(
  app: ReturnType<typeof createApp>,
  payload: ReturnType<typeof pullRequestPayload>,
  deliveryId: string,
) {
  const body = JSON.stringify(payload);
  return request(app)
    .post("/webhooks/github")
    .set("content-type", "application/json")
    .set("x-github-event", "pull_request")
    .set("x-github-delivery", deliveryId)
    .set("x-hub-signature-256", createGitHubSignature(settings.githubWebhookSecret, body))
    .send(body);
}

class BodyFallbackPullRequestFileClient implements PullRequestFileClient {
  async fetchPullRequestDiff() {
    return { files: [] };
  }
}

class CountingPullRequestFileClient extends BodyFallbackPullRequestFileClient {
  calls = 0;

  override async fetchPullRequestDiff() {
    this.calls += 1;
    return super.fetchPullRequestDiff();
  }
}

type PullRequestPayload = {
  action: string;
  repository: {
    full_name: string;
    html_url: string;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string };
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    changed_files: number;
    additions: number;
    deletions: number;
    body: string;
  };
};

function pullRequestPayload(overrides: Partial<PullRequestPayload["pull_request"]> = {}): PullRequestPayload {
  return {
    action: "opened",
    repository: {
      full_name: "Zayedkz/example",
      html_url: "https://github.com/Zayedkz/example",
    },
    pull_request: {
      number: 7,
      title: "Add webhook handler",
      html_url: "https://github.com/Zayedkz/example/pull/7",
      user: { login: "zayedkz" },
      head: { sha: "abc123", ref: "feature/webhook" },
      base: { sha: "def456", ref: "main" },
      changed_files: 25,
      additions: 900,
      deletions: 40,
      body: "This PR uses process.env.GITHUB_TOKEN and has TODO follow-up work.",
      ...overrides,
    },
  };
}
