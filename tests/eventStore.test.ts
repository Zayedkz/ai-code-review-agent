import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings.js";
import type { NormalizedPullRequestEvent } from "../src/github/events.js";
import { createGitHubSignature } from "../src/github/signature.js";
import { createApp } from "../src/http/app.js";
import type { ReviewSummary } from "../src/review/reviewer.js";
import {
  type DbClient,
  PostgresReviewEventStore,
  type ReviewEventStore,
} from "../src/storage/eventStore.js";

type TestPool = DbClient & {
  end(): Promise<void>;
};

type TestPoolConstructor = {
  new (): TestPool;
};

const settings = loadSettings({
  APP_ENV: "test",
  PORT: "8080",
  GITHUB_WEBHOOK_SECRET: "test-secret",
});

const openPools: TestPool[] = [];

afterEach(async () => {
  await Promise.all(openPools.splice(0).map((pool) => pool.end()));
});

describe("PostgresReviewEventStore", () => {
  it("saves review events idempotently by delivery ID", async () => {
    const store = await createMemoryBackedStore();
    const event = normalizedEvent("delivery-1");
    const review = reviewSummary("high");

    const first = await store.save(event, review);
    const duplicate = await store.save(
      { ...event, action: "synchronize", headSha: "different-sha" },
      reviewSummary("low"),
    );

    expect(first.stored).toBe(true);
    expect(duplicate.stored).toBe(false);
    expect(duplicate.record.review.riskLevel).toBe("high");
    expect(duplicate.record.event.action).toBe("opened");
    await expect(store.count()).resolves.toBe(1);
  });

  it("reads stored events with review findings and timestamps", async () => {
    const store = await createMemoryBackedStore();
    const event = normalizedEvent("delivery-2");
    const review = reviewSummary("medium");

    await store.save(event, review);
    const stored = await store.get("delivery-2");

    expect(stored?.event.repository).toBe("Zayedkz/example");
    expect(stored?.event.pullRequestNumber).toBe(7);
    expect(stored?.review.findings[0]?.code).toBe("missing-test-change");
    expect(stored?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stored?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("webhook persistence", () => {
  it("persists webhook review events through the configured store", async () => {
    const store = await createMemoryBackedStore();
    const app = createApp({ settings, store });
    const payload = pullRequestPayload();

    const response = await postWebhook(app, payload, "delivery-webhook");

    expect(response.statusCode).toBe(202);
    const stored = await store.get("delivery-webhook");
    expect(stored?.event.repository).toBe("Zayedkz/example");
    expect(stored?.event.headSha).toBe("abc123");
    expect(stored?.review.riskLevel).toBe("high");
  });
});

async function createMemoryBackedStore(): Promise<ReviewEventStore> {
  const db = newDb();
  const adapters = db.adapters.createPg();
  const TestPoolClass = adapters.Pool as unknown as TestPoolConstructor;
  const pool = new TestPoolClass();
  openPools.push(pool);

  const migration = await readFile(migrationPath(), "utf8");
  await pool.query(migration);

  return new PostgresReviewEventStore(pool);
}

function migrationPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(
    path.dirname(currentFile),
    "../migrations/20260703_0001_create_review_events.sql",
  );
}

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

function normalizedEvent(deliveryId: string): NormalizedPullRequestEvent {
  return {
    deliveryId,
    action: "opened",
    repository: "Zayedkz/example",
    repositoryUrl: "https://github.com/Zayedkz/example",
    pullRequestNumber: 7,
    pullRequestTitle: "Add webhook handler",
    pullRequestUrl: "https://github.com/Zayedkz/example/pull/7",
    author: "zayedkz",
    headSha: "abc123",
    headRef: "feature/webhook",
    baseSha: "def456",
    baseRef: "main",
    changedFiles: 25,
    additions: 900,
    deletions: 40,
    body: "This PR uses process.env.GITHUB_TOKEN and has TODO follow-up work.",
  };
}

function reviewSummary(riskLevel: ReviewSummary["riskLevel"]): ReviewSummary {
  return {
    provider: "deterministic",
    riskLevel,
    summary: "Zayedkz/example#7 reviewed with 1 finding(s).",
    findings: [
      {
        code: "missing-test-change",
        severity: "warning",
        message: "No test files were changed in this pull request.",
        recommendation: "Add or update tests that cover the behavior changed by this PR.",
      },
    ],
  };
}

function pullRequestPayload() {
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
    },
  };
}
