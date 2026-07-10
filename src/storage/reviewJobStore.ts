import { Pool, type QueryResultRow } from "pg";

import type { NormalizedPullRequestEvent } from "../github/events.js";
import type { DbClient } from "./eventStore.js";

export type ReviewJobStatus = "queued" | "running" | "completed" | "failed" | "dead_letter";

export type ReviewJobRecord = {
  deliveryId: string;
  status: ReviewJobStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  event: NormalizedPullRequestEvent;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  updatedAt: string;
};

export type CreateReviewJobResult = {
  created: boolean;
  record: ReviewJobRecord;
};

export interface ReviewJobStore {
  create(event: NormalizedPullRequestEvent, maxAttempts: number): Promise<CreateReviewJobResult>;
  get(deliveryId: string): Promise<ReviewJobRecord | undefined>;
  markRunning(deliveryId: string, attempt: number): Promise<ReviewJobRecord>;
  markCompleted(deliveryId: string): Promise<ReviewJobRecord>;
  markFailed(deliveryId: string, attempt: number, maxAttempts: number, error: string): Promise<ReviewJobRecord>;
  countByStatus(): Promise<Record<ReviewJobStatus, number>>;
}

type ReviewJobRow = QueryResultRow & {
  delivery_id: string;
  status: ReviewJobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  event: NormalizedPullRequestEvent;
  queued_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  failed_at: Date | string | null;
  updated_at: Date | string;
};

type StatusCountRow = QueryResultRow & {
  status: ReviewJobStatus;
  total: string | number;
};

export class InMemoryReviewJobStore implements ReviewJobStore {
  private readonly records = new Map<string, ReviewJobRecord>();

  async create(event: NormalizedPullRequestEvent, maxAttempts: number): Promise<CreateReviewJobResult> {
    const existing = this.records.get(event.deliveryId);
    if (existing) {
      return { created: false, record: existing };
    }

    const now = new Date().toISOString();
    const record: ReviewJobRecord = {
      deliveryId: event.deliveryId,
      status: "queued",
      attempts: 0,
      maxAttempts,
      event,
      queuedAt: now,
      updatedAt: now,
    };
    this.records.set(event.deliveryId, record);
    return { created: true, record };
  }

  async get(deliveryId: string): Promise<ReviewJobRecord | undefined> {
    return this.records.get(deliveryId);
  }

  async markRunning(deliveryId: string, attempt: number): Promise<ReviewJobRecord> {
    return this.update(deliveryId, {
      status: "running",
      attempts: attempt,
      startedAt: new Date().toISOString(),
      lastError: undefined,
    });
  }

  async markCompleted(deliveryId: string): Promise<ReviewJobRecord> {
    return this.update(deliveryId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      lastError: undefined,
    });
  }

  async markFailed(
    deliveryId: string,
    attempt: number,
    maxAttempts: number,
    error: string,
  ): Promise<ReviewJobRecord> {
    return this.update(deliveryId, {
      status: attempt >= maxAttempts ? "dead_letter" : "failed",
      attempts: attempt,
      maxAttempts,
      failedAt: new Date().toISOString(),
      lastError: error,
    });
  }

  async countByStatus(): Promise<Record<ReviewJobStatus, number>> {
    const counts = emptyStatusCounts();
    for (const record of this.records.values()) {
      counts[record.status] += 1;
    }
    return counts;
  }

  private update(
    deliveryId: string,
    patch: Partial<Omit<ReviewJobRecord, "deliveryId" | "event" | "queuedAt">>,
  ): ReviewJobRecord {
    const existing = this.records.get(deliveryId);
    if (!existing) {
      throw new Error(`review job ${deliveryId} not found`);
    }

    const updated = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(deliveryId, updated);
    return updated;
  }
}

export class PostgresReviewJobStore implements ReviewJobStore {
  constructor(private readonly db: DbClient) {}

  async create(event: NormalizedPullRequestEvent, maxAttempts: number): Promise<CreateReviewJobResult> {
    const existing = await this.get(event.deliveryId);
    if (existing) {
      return { created: false, record: existing };
    }

    const inserted = await this.db.query<ReviewJobRow>(
      `
        INSERT INTO review_jobs (delivery_id, status, max_attempts, event)
        VALUES ($1, 'queued', $2, $3::jsonb)
        ON CONFLICT (delivery_id) DO NOTHING
        RETURNING *
      `,
      [event.deliveryId, maxAttempts, JSON.stringify(event)],
    );

    const row = inserted.rows[0];
    if (row) {
      return { created: true, record: rowToReviewJob(row) };
    }

    const concurrentlyInserted = await this.get(event.deliveryId);
    if (!concurrentlyInserted) {
      throw new Error(`review job ${event.deliveryId} was not inserted and could not be read`);
    }
    return { created: false, record: concurrentlyInserted };
  }

  async get(deliveryId: string): Promise<ReviewJobRecord | undefined> {
    const result = await this.db.query<ReviewJobRow>("SELECT * FROM review_jobs WHERE delivery_id = $1", [
      deliveryId,
    ]);
    const row = result.rows[0];
    return row ? rowToReviewJob(row) : undefined;
  }

  async markRunning(deliveryId: string, attempt: number): Promise<ReviewJobRecord> {
    return this.updateAndReturn(
      `
        UPDATE review_jobs
        SET status = 'running',
            attempts = $2,
            started_at = COALESCE(started_at, NOW()),
            last_error = NULL,
            updated_at = NOW()
        WHERE delivery_id = $1
        RETURNING *
      `,
      [deliveryId, attempt],
    );
  }

  async markCompleted(deliveryId: string): Promise<ReviewJobRecord> {
    return this.updateAndReturn(
      `
        UPDATE review_jobs
        SET status = 'completed',
            completed_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
        WHERE delivery_id = $1
        RETURNING *
      `,
      [deliveryId],
    );
  }

  async markFailed(
    deliveryId: string,
    attempt: number,
    maxAttempts: number,
    error: string,
  ): Promise<ReviewJobRecord> {
    return this.updateAndReturn(
      `
        UPDATE review_jobs
        SET status = $4,
            attempts = $2,
            max_attempts = $3,
            failed_at = NOW(),
            last_error = $5,
            updated_at = NOW()
        WHERE delivery_id = $1
        RETURNING *
      `,
      [deliveryId, attempt, maxAttempts, attempt >= maxAttempts ? "dead_letter" : "failed", error],
    );
  }

  async countByStatus(): Promise<Record<ReviewJobStatus, number>> {
    const result = await this.db.query<StatusCountRow>(
      "SELECT status, COUNT(*) AS total FROM review_jobs GROUP BY status",
    );
    const counts = emptyStatusCounts();
    for (const row of result.rows) {
      counts[row.status] = Number(row.total);
    }
    return counts;
  }

  private async updateAndReturn(sql: string, params: readonly unknown[]): Promise<ReviewJobRecord> {
    const result = await this.db.query<ReviewJobRow>(sql, params);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`review job ${params[0]} not found`);
    }
    return rowToReviewJob(row);
  }
}

export function createPostgresReviewJobStore(databaseUrl: string): PostgresReviewJobStore {
  return new PostgresReviewJobStore(new Pool({ connectionString: databaseUrl }));
}

function rowToReviewJob(row: ReviewJobRow): ReviewJobRecord {
  return {
    deliveryId: row.delivery_id,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error ?? undefined,
    event: row.event,
    queuedAt: toOptionalIsoString(row.queued_at) ?? new Date(0).toISOString(),
    startedAt: toOptionalIsoString(row.started_at),
    completedAt: toOptionalIsoString(row.completed_at),
    failedAt: toOptionalIsoString(row.failed_at),
    updatedAt: toOptionalIsoString(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function emptyStatusCounts(): Record<ReviewJobStatus, number> {
  return {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    dead_letter: 0,
  };
}

function toOptionalIsoString(value: Date | string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
