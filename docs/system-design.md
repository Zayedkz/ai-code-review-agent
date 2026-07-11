# System Design

## 1. Goals

- Receive GitHub pull request webhook events securely.
- Normalize and enqueue review events idempotently.
- Retrieve changed pull request file paths and patches from GitHub.
- Analyze pull request metadata and fetched diffs for risk signals.
- Produce actionable summaries, findings, and recommendations.
- Publish review output back to GitHub once comment publishing is connected.

## 2. Non-Goals

- Replacing human code reviewers.
- Running paid LLM calls in local development or CI.
- Claiming production deployment before hosting exists.
- Storing long-lived GitHub tokens in source or logs.

## 3. Functional Requirements

- Verify `x-hub-signature-256` using the configured webhook secret.
- Accept pull request webhook events and ignore unsupported event types.
- Deduplicate events by GitHub delivery ID.
- Persist review job state for queued, running, completed, failed, and dead-letter outcomes.
- Run review work through Redis/BullMQ with bounded retry.
- Mint scoped GitHub App installation tokens for changed file metadata and patch retrieval.
- Fetch changed file metadata and patches through a GitHub client boundary.
- Generate review findings from deterministic local rules.
- Expose stored delivery audit details through a read-only endpoint.
- Support future async processing with retry and dead-letter behavior.

## 4. Non-Functional Requirements

- Webhook response latency should stay low enough for GitHub delivery expectations.
- Event processing should be idempotent.
- Review outputs should be auditable and reproducible.
- Provider failures should not create duplicate comments.
- Secrets and proprietary diffs should not be logged by default.

## 5. Data Model

Current entities:

- `review_events`: unique delivery ID, repository, repository URL, PR number, action, head SHA, risk level, normalized event JSON, review JSON, received timestamp, updated timestamp.
- `review_jobs`: unique delivery ID, status, attempt count, max attempts, last error, normalized event JSON, queued/started/completed/failed timestamps, updated timestamp.

Planned entities:

- `review_findings`: run ID, code, severity, message, recommendation, optional file path and line.
- `published_comments`: run ID, GitHub comment ID, head SHA, body hash, timestamps.

## 6. API Design

Initial endpoints:

- `GET /health`: service health, persisted event count, and review job counts by state.
- `GET /reviews/{deliveryId}`: inspect review job status, duplicate replay behavior, repository, PR number, action, head SHA, attempts, last error, and completed findings when available.
- `POST /reviews/{deliveryId}/retry`: reset a dead-letter review job to queued state and re-enqueue the original normalized pull request event.
- `POST /webhooks/github`: signed GitHub webhook intake for pull request events.

## 7. Processing Flow

1. GitHub sends a pull request webhook.
2. API verifies the raw body signature.
3. API validates and normalizes the pull request payload.
4. API checks for an existing completed review or existing job and returns that state immediately on duplicate replay.
5. API creates durable `review_jobs` state and enqueues a BullMQ job keyed by delivery ID.
6. Worker claims the job, marks it running, and mints a short-lived GitHub App installation token for the webhook installation ID.
7. Worker retrieves changed pull request files from GitHub's PR files endpoint with the installation token.
8. Deterministic reviewer providers generate findings and a summary from real file paths and available patches.
9. Worker stores the normalized event and review result idempotently by delivery ID, then marks the job completed.
10. Future publisher writes a single idempotent PR summary comment.

The current implementation keeps webhook intake queue-first, mints GitHub App installation tokens through an injectable provider in the worker, fetches PR files through an injectable GitHub client, stores review jobs and completed review events in PostgreSQL, and uses BullMQ for Redis-backed retry. Tests exercise the same store contracts through isolated in-memory PostgreSQL adapters, while route and worker tests inject in-memory queue/store implementations for dependency-free API behavior.

Schema changes are applied with `npm run migrate`, which executes checked-in `migrations/*.sql` files in filename order using `DATABASE_URL`. The current migrations create the durable `review_events` audit table, `review_jobs` run-state table, and supporting lookup indexes.

## 8. Scaling Strategy

- Keep API replicas stateless.
- Use PostgreSQL for event and run state.
- Use Redis/BullMQ for queued review jobs.
- Scale workers independently by queue depth.
- Apply GitHub API rate limits per installation and repository.

## 9. Failure Handling

- Return `401` for invalid webhook signatures.
- Return `202` for unsupported but valid GitHub event types.
- Treat duplicate delivery IDs as successful idempotent replays.
- Return `404` for audit lookups when a delivery ID has not been stored.
- Fall back to pull request body text when GitHub App token minting, file retrieval, or empty file responses fail.
- Keep file paths when GitHub omits patches for large or binary files.
- Retry provider failures with bounded BullMQ attempts.
- Move terminal worker failures into a dead-letter state with last error context.
- Retry only dead-letter jobs through the operator endpoint, returning `409` for active or completed jobs.

## 10. Observability

- Structured logs for delivery ID, repository, PR number, action, and result.
- Metrics for webhook latency, queue depth, review latency, provider failures, and publish failures.
- Read-only audit lookup for review deliveries, including queue state, attempts, replay behavior, and generated findings.
- Future audit trail for published comments.
- Redacted traces across webhook, queue, GitHub API, and provider calls.

## 11. Security

- Verify webhook signatures before payload processing.
- Keep webhook secrets and GitHub App private keys outside source control.
- Load GitHub App credentials from environment variables or mounted private-key files, never checked-in files.
- Mint short-lived installation access tokens per webhook installation instead of storing long-lived GitHub API tokens.
- Avoid logging raw diffs by default.
- Redact likely credentials before provider calls.
- Scope GitHub App permissions to pull requests read access for PR file retrieval, adding contents read or pull request write only when later features require them.

## 12. Tradeoffs

- TypeScript/Express keeps the webhook surface straightforward and portfolio-readable; NestJS could help if the service grows significantly.
- Deterministic rules are less capable than LLM review but make local behavior reproducible and testable.
- Queue-backed review work keeps GitHub webhook intake fast and lets workers scale independently, at the cost of operating Redis and a separate worker process.
- PostgreSQL gives durable replay/audit behavior; the explicit store interface keeps local tests and future queue workers from depending on Express route internals.
- Fetching files in the worker improves review quality, while a fallback path keeps review completion resilient when GitHub API calls fail.

## 13. Future Improvements

- File-level finding locations.
- LLM provider abstraction with prompt redaction.
- PR comment publishing and update-in-place behavior.
