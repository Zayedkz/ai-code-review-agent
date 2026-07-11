import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "../src/config/settings.js";
import { createGitHubSignature } from "../src/github/signature.js";
import { createApp } from "../src/http/app.js";
import { InMemoryReviewQueue } from "../src/queue/reviewQueue.js";
import { InMemoryReviewEventStore } from "../src/storage/eventStore.js";
import { InMemoryReviewJobStore } from "../src/storage/reviewJobStore.js";

const settings = loadSettings({
  APP_ENV: "test",
  PORT: "8080",
  GITHUB_WEBHOOK_SECRET: "test-secret",
  REVIEW_JOB_MAX_ATTEMPTS: "3",
});

describe("GitHub webhook endpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts signed pull_request events and enqueues them idempotently", async () => {
    const store = new InMemoryReviewEventStore();
    const jobStore = new InMemoryReviewJobStore();
    const reviewQueue = new InMemoryReviewQueue();
    const app = createApp({ settings, store, jobStore, reviewQueue });
    const payload = pullRequestPayload();

    const first = await postWebhook(app, payload, "delivery-123");
    const second = await postWebhook(app, payload, "delivery-123");

    expect(first.statusCode).toBe(202);
    expect(first.body).toMatchObject({
      accepted: true,
      duplicate: false,
      deliveryId: "delivery-123",
      job: {
        deliveryId: "delivery-123",
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({
      accepted: true,
      duplicate: true,
      deliveryId: "delivery-123",
      job: {
        status: "queued",
      },
    });
    await expect(store.count()).resolves.toBe(0);
    expect(reviewQueue.enqueued).toHaveLength(1);
  });

  it("returns queued delivery audit details before worker completion", async () => {
    const jobStore = new InMemoryReviewJobStore();
    const app = createApp({
      settings,
      store: new InMemoryReviewEventStore(),
      jobStore,
      reviewQueue: new InMemoryReviewQueue(),
    });
    const payload = pullRequestPayload();

    await postWebhook(app, payload, "delivery-audit");
    const response = await request(app).get("/reviews/delivery-audit");

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      deliveryId: "delivery-audit",
      status: "queued",
      duplicateReplayBehavior: "duplicate deliveries return the existing review or queued job state",
      repository: "Zayedkz/example",
      pullRequestNumber: 7,
      action: "opened",
      headSha: "abc123",
      job: {
        deliveryId: "delivery-audit",
        status: "queued",
      },
    });
    expect(response.body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns 404 when a review delivery is missing", async () => {
    const app = createApp({ settings, store: new InMemoryReviewEventStore() });

    const response = await request(app).get("/reviews/missing-delivery");

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: "review delivery not found" });
  });

  it("returns 404 when retrying a missing review delivery", async () => {
    const app = createApp({
      settings,
      store: new InMemoryReviewEventStore(),
      jobStore: new InMemoryReviewJobStore(),
      reviewQueue: new InMemoryReviewQueue(),
    });

    const response = await request(app).post("/reviews/missing-delivery/retry");

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: "review delivery not found" });
  });

  it("rejects retry requests for review jobs that are not dead-lettered", async () => {
    const jobStore = new InMemoryReviewJobStore();
    const reviewQueue = new InMemoryReviewQueue();
    const app = createApp({
      settings,
      store: new InMemoryReviewEventStore(),
      jobStore,
      reviewQueue,
    });

    await postWebhook(app, pullRequestPayload(), "delivery-active");
    const response = await request(app).post("/reviews/delivery-active/retry");

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      error: "review delivery is not dead-lettered",
      job: {
        deliveryId: "delivery-active",
        status: "queued",
      },
    });
    expect(reviewQueue.enqueued).toHaveLength(1);
  });

  it("resets a dead-letter review job and re-enqueues it", async () => {
    const jobStore = new InMemoryReviewJobStore();
    const reviewQueue = new InMemoryReviewQueue();
    const app = createApp({
      settings,
      store: new InMemoryReviewEventStore(),
      jobStore,
      reviewQueue,
    });

    await postWebhook(app, pullRequestPayload(), "delivery-retry");
    await jobStore.markRunning("delivery-retry", 3);
    await jobStore.markFailed("delivery-retry", 3, 3, "provider unavailable");

    const response = await request(app).post("/reviews/delivery-retry/retry");
    const retried = await jobStore.get("delivery-retry");

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      accepted: true,
      deliveryId: "delivery-retry",
      job: {
        deliveryId: "delivery-retry",
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
      },
    });
    expect(response.body.job.lastError).toBeUndefined();
    expect(retried).toMatchObject({
      deliveryId: "delivery-retry",
      status: "queued",
      attempts: 0,
    });
    expect(retried?.lastError).toBeUndefined();
    expect(retried?.startedAt).toBeUndefined();
    expect(retried?.failedAt).toBeUndefined();
    expect(reviewQueue.enqueued.map((job) => job.event.deliveryId)).toEqual([
      "delivery-retry",
      "delivery-retry",
    ]);
  });

  it("keeps duplicate webhook deliveries idempotent after an operator retry", async () => {
    const jobStore = new InMemoryReviewJobStore();
    const reviewQueue = new InMemoryReviewQueue();
    const app = createApp({
      settings,
      store: new InMemoryReviewEventStore(),
      jobStore,
      reviewQueue,
    });
    const payload = pullRequestPayload();

    await postWebhook(app, payload, "delivery-duplicate-retry");
    await jobStore.markRunning("delivery-duplicate-retry", 3);
    await jobStore.markFailed("delivery-duplicate-retry", 3, 3, "provider unavailable");
    await request(app).post("/reviews/delivery-duplicate-retry/retry");
    const duplicate = await postWebhook(app, payload, "delivery-duplicate-retry");

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.body).toMatchObject({
      accepted: true,
      duplicate: true,
      deliveryId: "delivery-duplicate-retry",
      job: {
        status: "queued",
      },
    });
    expect(reviewQueue.enqueued.map((job) => job.event.deliveryId)).toEqual([
      "delivery-duplicate-retry",
      "delivery-duplicate-retry",
    ]);
  });

  it("rejects invalid signatures", async () => {
    const app = createApp({
      settings,
      store: new InMemoryReviewEventStore(),
      jobStore: new InMemoryReviewJobStore(),
      reviewQueue: new InMemoryReviewQueue(),
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

  it("returns health with stored event count and job state counts", async () => {
    const app = createApp({
      settings,
      store: new InMemoryReviewEventStore(),
      jobStore: new InMemoryReviewJobStore(),
      reviewQueue: new InMemoryReviewQueue(),
    });

    const response = await request(app).get("/health");

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      environment: "test",
      storedEvents: 0,
      reviewJobs: {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        dead_letter: 0,
      },
    });
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

type PullRequestPayload = {
  action: string;
  installation: {
    id: number;
  };
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
    installation: {
      id: 12345,
    },
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
