import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedPullRequestEvent } from "../src/github/events.js";
import type { DbClient } from "../src/storage/eventStore.js";
import {
  PostgresReviewJobStore,
  type ReviewJobStore,
} from "../src/storage/reviewJobStore.js";

type TestPool = DbClient & {
  end(): Promise<void>;
};

type TestPoolConstructor = {
  new (): TestPool;
};

const openPools: TestPool[] = [];

afterEach(async () => {
  await Promise.all(openPools.splice(0).map((pool) => pool.end()));
});

describe("PostgresReviewJobStore", () => {
  it("creates review jobs idempotently by delivery ID", async () => {
    const store = await createMemoryBackedJobStore();
    const event = normalizedEvent("delivery-job");

    const first = await store.create(event, 3);
    const duplicate = await store.create({ ...event, action: "synchronize" }, 5);

    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({
      deliveryId: "delivery-job",
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.event.action).toBe("opened");
    expect(duplicate.record.maxAttempts).toBe(3);
  });

  it("tracks running, completed, failed, and dead-letter state counts", async () => {
    const store = await createMemoryBackedJobStore();
    await store.create(normalizedEvent("completed"), 3);
    await store.create(normalizedEvent("failed"), 3);
    await store.create(normalizedEvent("dead"), 2);

    await store.markRunning("completed", 1);
    await store.markCompleted("completed");
    await store.markRunning("failed", 1);
    const failed = await store.markFailed("failed", 1, 3, "temporary outage");
    await store.markRunning("dead", 2);
    const dead = await store.markFailed("dead", 2, 2, "provider unavailable");

    expect(failed).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "temporary outage",
    });
    expect(dead).toMatchObject({
      status: "dead_letter",
      attempts: 2,
      lastError: "provider unavailable",
    });
    await expect(store.countByStatus()).resolves.toEqual({
      queued: 0,
      running: 0,
      completed: 1,
      failed: 1,
      dead_letter: 1,
    });
  });

  it("resets only dead-letter jobs for retry", async () => {
    const store = await createMemoryBackedJobStore();
    await store.create(normalizedEvent("queued"), 3);
    await store.create(normalizedEvent("dead"), 3);
    await store.markRunning("dead", 3);
    await store.markFailed("dead", 3, 3, "provider unavailable");

    const queuedReset = await store.resetDeadLetterForRetry("queued");
    const missingReset = await store.resetDeadLetterForRetry("missing");
    const deadReset = await store.resetDeadLetterForRetry("dead");

    expect(queuedReset).toBeUndefined();
    expect(missingReset).toBeUndefined();
    expect(deadReset).toMatchObject({
      deliveryId: "dead",
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
    });
    expect(deadReset?.lastError).toBeUndefined();
    expect(deadReset?.startedAt).toBeUndefined();
    expect(deadReset?.failedAt).toBeUndefined();
    await expect(store.countByStatus()).resolves.toEqual({
      queued: 2,
      running: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
    });
  });
});

async function createMemoryBackedJobStore(): Promise<ReviewJobStore> {
  const db = newDb();
  const adapters = db.adapters.createPg();
  const TestPoolClass = adapters.Pool as unknown as TestPoolConstructor;
  const pool = new TestPoolClass();
  openPools.push(pool);

  const migration = await readFile(migrationPath(), "utf8");
  await pool.query(migration);

  return new PostgresReviewJobStore(pool);
}

function migrationPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(
    path.dirname(currentFile),
    "../migrations/20260710_0002_create_review_jobs.sql",
  );
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
    installationId: 12345,
  };
}
