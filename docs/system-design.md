# System Design

## 1. Goals

- Receive GitHub pull request webhook events securely.
- Normalize and persist review events idempotently.
- Analyze pull request metadata and diffs for risk signals.
- Produce actionable summaries, findings, and recommendations.
- Publish review output back to GitHub once GitHub App auth is connected.

## 2. Non-Goals

- Replacing human code reviewers.
- Running paid LLM calls in local development or CI.
- Claiming production deployment before hosting exists.
- Storing long-lived GitHub tokens in source or logs.

## 3. Functional Requirements

- Verify `x-hub-signature-256` using the configured webhook secret.
- Accept pull request webhook events and ignore unsupported event types.
- Deduplicate events by GitHub delivery ID.
- Generate review findings from deterministic local rules.
- Support future async processing with retry and dead-letter behavior.

## 4. Non-Functional Requirements

- Webhook response latency should stay low enough for GitHub delivery expectations.
- Event processing should be idempotent.
- Review outputs should be auditable and reproducible.
- Provider failures should not create duplicate comments.
- Secrets and proprietary diffs should not be logged by default.

## 5. Data Model

Current entity:

- `review_events`: unique delivery ID, repository, repository URL, PR number, action, head SHA, risk level, normalized event JSON, review JSON, received timestamp, updated timestamp.

Planned entities:

- `review_runs`: event ID, provider, status, risk level, attempt count, last error, timestamps.
- `review_findings`: run ID, code, severity, message, recommendation, optional file path and line.
- `published_comments`: run ID, GitHub comment ID, head SHA, body hash, timestamps.

## 6. API Design

Initial endpoints:

- `GET /health`: service health and persisted event count.
- `POST /webhooks/github`: signed GitHub webhook intake for pull request events.

Planned endpoints:

- `GET /reviews/{deliveryId}`: inspect review event and generated findings.
- `POST /reviews/{deliveryId}/retry`: retry a failed review run.

## 7. Processing Flow

1. GitHub sends a pull request webhook.
2. API verifies the raw body signature.
3. API validates and normalizes the pull request payload.
4. Deterministic reviewer providers generate findings and a summary.
5. API stores the normalized event and review result idempotently by delivery ID.
6. Future review workers retrieve PR diff context from GitHub for deeper analysis.
7. Future publisher writes a single idempotent PR summary comment.

The current implementation runs deterministic review inline and stores review events in PostgreSQL. Tests exercise the same store contract through an isolated in-memory PostgreSQL adapter, while route tests can still inject the in-memory implementation for dependency-free API behavior.

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
- Retry transient GitHub API and provider failures with bounded attempts.
- Move terminal failures into a dead-letter state with last error context.

## 10. Observability

- Structured logs for delivery ID, repository, PR number, action, and result.
- Metrics for webhook latency, queue depth, review latency, provider failures, and publish failures.
- Audit trail for each review run and published comment.
- Redacted traces across webhook, queue, GitHub API, and provider calls.

## 11. Security

- Verify webhook signatures before payload processing.
- Keep webhook secrets and GitHub App private keys outside source control.
- Avoid logging raw diffs by default.
- Redact likely credentials before provider calls.
- Scope GitHub App permissions to pull requests and contents read access unless publishing requires more.

## 12. Tradeoffs

- TypeScript/Express keeps the webhook surface straightforward and portfolio-readable; NestJS could help if the service grows significantly.
- Deterministic rules are less capable than LLM review but make local behavior reproducible and testable.
- Inline review is acceptable for the first slice; production review work should move to a queue.
- PostgreSQL gives durable replay/audit behavior; the explicit store interface keeps local tests and future queue workers from depending on Express route internals.

## 13. Future Improvements

- Migration runner for applying SQL migrations in deploy environments.
- BullMQ worker and dead-letter queue.
- GitHub App installation authentication.
- Diff retrieval and file-level findings.
- LLM provider abstraction with prompt redaction.
- PR comment publishing and update-in-place behavior.
