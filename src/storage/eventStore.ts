import { Pool, type QueryResult, type QueryResultRow } from "pg";

import type { NormalizedPullRequestEvent } from "../github/events.js";
import type { ReviewSummary } from "../review/reviewer.js";

export type StoredReviewEvent = {
  event: NormalizedPullRequestEvent;
  review: ReviewSummary;
  receivedAt: string;
  updatedAt: string;
};

export type StoreEventResult = {
  stored: boolean;
  record: StoredReviewEvent;
};

export interface ReviewEventStore {
  save(event: NormalizedPullRequestEvent, review: ReviewSummary): Promise<StoreEventResult>;
  get(deliveryId: string): Promise<StoredReviewEvent | undefined>;
  count(): Promise<number>;
}

export type DbClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
};

type ReviewEventRow = QueryResultRow & {
  delivery_id: string;
  event: NormalizedPullRequestEvent;
  review: ReviewSummary;
  received_at: Date | string;
  updated_at: Date | string;
};

type CountRow = QueryResultRow & {
  total: string | number;
};

export class InMemoryReviewEventStore implements ReviewEventStore {
  private readonly records = new Map<string, StoredReviewEvent>();

  async save(event: NormalizedPullRequestEvent, review: ReviewSummary): Promise<StoreEventResult> {
    const existing = this.records.get(event.deliveryId);
    if (existing) {
      return { stored: false, record: existing };
    }

    const now = new Date().toISOString();
    const record = {
      event,
      review,
      receivedAt: now,
      updatedAt: now,
    };
    this.records.set(event.deliveryId, record);
    return { stored: true, record };
  }

  async get(deliveryId: string): Promise<StoredReviewEvent | undefined> {
    return this.records.get(deliveryId);
  }

  async count(): Promise<number> {
    return this.records.size;
  }
}

export class PostgresReviewEventStore implements ReviewEventStore {
  constructor(private readonly db: DbClient) {}

  async save(event: NormalizedPullRequestEvent, review: ReviewSummary): Promise<StoreEventResult> {
    const existing = await this.get(event.deliveryId);
    if (existing) {
      return { stored: false, record: existing };
    }

    const inserted = await this.db.query<ReviewEventRow>(
      `
        INSERT INTO review_events (
          delivery_id,
          repository,
          repository_url,
          pull_request_number,
          action,
          head_sha,
          risk_level,
          event,
          review
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
        ON CONFLICT (delivery_id) DO NOTHING
        RETURNING delivery_id, event, review, received_at, updated_at
      `,
      [
        event.deliveryId,
        event.repository,
        event.repositoryUrl,
        event.pullRequestNumber,
        event.action,
        event.headSha,
        review.riskLevel,
        JSON.stringify(event),
        JSON.stringify(review),
      ],
    );

    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      return { stored: true, record: rowToStoredReviewEvent(insertedRow) };
    }

    const concurrentlyInserted = await this.get(event.deliveryId);
    if (!concurrentlyInserted) {
      throw new Error(`review event ${event.deliveryId} was not inserted and could not be read`);
    }
    return { stored: false, record: concurrentlyInserted };
  }

  async get(deliveryId: string): Promise<StoredReviewEvent | undefined> {
    const result = await this.db.query<ReviewEventRow>(
      `
        SELECT delivery_id, event, review, received_at, updated_at
        FROM review_events
        WHERE delivery_id = $1
      `,
      [deliveryId],
    );
    const row = result.rows[0];
    return row ? rowToStoredReviewEvent(row) : undefined;
  }

  async count(): Promise<number> {
    const result = await this.db.query<CountRow>("SELECT COUNT(*) AS total FROM review_events");
    return Number(result.rows[0]?.total ?? 0);
  }
}

export function createPostgresReviewEventStore(databaseUrl: string): PostgresReviewEventStore {
  return new PostgresReviewEventStore(new Pool({ connectionString: databaseUrl }));
}

function rowToStoredReviewEvent(row: ReviewEventRow): StoredReviewEvent {
  return {
    event: row.event,
    review: row.review,
    receivedAt: toIsoString(row.received_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
