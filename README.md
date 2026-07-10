# AI Code Review Agent

GitHub webhook service for automated pull request triage. It verifies signed GitHub webhook deliveries, normalizes pull request events, enqueues idempotent review jobs, and uses a worker to fetch changed pull request files and persist deterministic review findings that flag risky change patterns.

This project is built as a developer productivity portfolio piece. It demonstrates the backend foundation for a code review agent before layering in queue-backed review jobs, comment publishing, and LLM review providers.

## Why This Exists

Engineering teams lose time on repetitive pull request review checks: large changes, missing tests, temporary debug code, and secret-handling risks. A useful review agent needs reliable event intake, idempotency, auditability, and deterministic policy checks before it starts calling an LLM.

This repo focuses on that foundation:

- secure GitHub webhook verification
- pull request payload validation and normalization
- changed file and patch retrieval through a GitHub client boundary
- idempotent queued delivery handling
- persisted review job state with retry and dead-letter outcomes
- deterministic review findings
- testable provider boundaries
- CI-friendly local behavior

## Architecture

```mermaid
flowchart LR
    GitHub[GitHub Pull Request Webhook] --> API[Express API]
    API --> Signature[x-hub-signature-256 Verification]
    Signature --> Validate[Zod Payload Validation]
    Validate --> Normalize[Normalized Review Event]
    Normalize --> Jobs[PostgreSQL Review Job State]
    Jobs --> Queue[Redis / BullMQ Review Queue]
    Queue --> Worker[Review Worker]
    Worker --> GitHubAuth[GitHub App Installation Token]
    GitHubAuth --> GitHubFiles[GitHub PR Files API]
    GitHubFiles --> Reviewer[Deterministic Reviewer]
    Reviewer --> Store[PostgreSQL Review Event Store]
    Reviewer --> Findings[Risk Level + Findings]
    Jobs --> Response[Accepted / Duplicate Response]
    Store --> Audit[Review Audit Endpoint]
    Findings --> Audit
```

The service stores normalized review jobs and completed deterministic findings in PostgreSQL with GitHub delivery IDs as the idempotency key. Webhook intake creates or reuses durable job state and enqueues BullMQ work, while the worker owns GitHub file retrieval, deterministic review execution, completion marking, and dead-letter state after bounded retries.

## What Reviewers Should Notice

- Express/TypeScript service with narrow route boundaries.
- Raw request body preservation for GitHub HMAC validation.
- `x-hub-signature-256` verification before payload processing.
- Zod schema validation for pull request webhook payloads.
- Normalized internal event model separate from GitHub's raw payload shape.
- GitHub PR files client boundary that retrieves changed paths and patches with scoped GitHub App installation tokens.
- Idempotent job and event stores keyed by GitHub delivery ID.
- PostgreSQL-backed review event persistence with a SQL migration.
- Redis/BullMQ review queue boundary with persisted job state and dead-letter outcomes.
- Worker entrypoint for independently scaling review execution.
- Migration runner for applying checked-in SQL migrations.
- Read-only review audit endpoint for delivery lookup and duplicate replay inspection.
- Deterministic reviewer with explicit findings, severity, recommendations, and risk levels.
- Tests covering signature verification, webhook behavior, duplicate handling, audit lookup, migration execution, health checks, and reviewer rules.
- Lint, typecheck, and test scripts ready for CI.

## Features

- `GET /health` returns service status, environment, and stored event count.
- `GET /reviews/:deliveryId` returns read-only audit details for queued, running, completed, failed, or dead-letter deliveries.
- `POST /webhooks/github` accepts signed GitHub `pull_request` events.
- Unsupported signed GitHub event types return `202` without processing.
- Duplicate delivery IDs return the existing review or queued job state without creating another job or refetching GitHub diff data.
- Review jobs track queued, running, completed, failed, and dead-letter state with attempts, timestamps, and last error context.
- BullMQ applies bounded retry with exponential backoff.
- Review events persist repository, PR number, action, head SHA, risk level, full normalized event JSON, review findings JSON, and timestamps.
- The worker mints a scoped GitHub App installation token before fetching changed pull request file paths and patches from GitHub.
- If GitHub omits a patch for a large or binary file, the file path is still included with an empty patch.
- If token minting, file retrieval, or empty file responses fail, review falls back to the pull request body so webhook intake remains resilient.
- Review rules flag:
  - large change sets
  - missing test changes
  - debug or placeholder markers
  - secret-handling patterns
- Docker Compose includes PostgreSQL and Redis for the persistent/queued path.

## Tech Stack

- Node.js 22
- TypeScript
- Express
- Zod
- Vitest
- Supertest
- ESLint
- PostgreSQL
- Redis
- BullMQ
- GitHub Actions

## Repository Tour

```text
src/http/             Express app and webhook route wiring
src/github/           GitHub signature verification, event normalization, and PR file client
src/queue/            BullMQ queue adapter and review worker processor
src/review/           Deterministic review provider and finding model
migrations/           SQL schema for persisted review events and review jobs
src/storage/          Review event/job store interfaces, PostgreSQL, and in-memory implementations
src/config/           Environment-driven settings
tests/                Unit and API tests
docs/                 System design and production tradeoffs
docker-compose.yml    Local PostgreSQL and Redis services
```

## Local Setup

Install dependencies:

```bash
npm install
```

Create an environment file:

```bash
cp .env.example .env
```

Run the API:

```bash
npm run dev
```

The service listens on `http://localhost:8080` by default.

Run a review worker in a separate shell:

```bash
npm run worker
```

Health check:

```bash
curl http://localhost:8080/health
```

Start local infrastructure:

```bash
docker compose up -d
```

Apply the current schema migration:

```bash
npm run migrate
```

The migration runner applies every `migrations/*.sql` file in filename order using the configured `DATABASE_URL`.

## Demo Flow

GitHub webhook delivery requires a valid `x-hub-signature-256` header generated from the raw request body and `GITHUB_WEBHOOK_SECRET`.

Create a sample body:

```bash
export BODY='{"action":"opened","repository":{"full_name":"Zayedkz/example","html_url":"https://github.com/Zayedkz/example"},"pull_request":{"number":7,"title":"Add webhook handler","html_url":"https://github.com/Zayedkz/example/pull/7","user":{"login":"zayedkz"},"head":{"sha":"abc123","ref":"feature/webhook"},"base":{"sha":"def456","ref":"main"},"changed_files":25,"additions":900,"deletions":40,"body":"This PR uses process.env.GITHUB_TOKEN and has TODO follow-up work."}}'
```

Generate the signature:

```bash
SIGNATURE=$(node -e 'const crypto = require("crypto"); const body = process.env.BODY; const secret = process.env.GITHUB_WEBHOOK_SECRET || "local-development-secret"; console.log("sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex"));')
```

Post the webhook:

```bash
curl -X POST http://localhost:8080/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: local-delivery-id" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -d "$BODY"
```

Expected behavior:

- The first delivery returns `202` with `accepted: true`, `duplicate: false`, and queued job state.
- Reusing the same delivery ID returns `200` with `duplicate: true`.
- Invalid signatures return `401`.

Inspect a stored delivery:

```bash
curl http://localhost:8080/reviews/local-delivery-id
```

The audit response includes delivery status, duplicate replay behavior, job attempts, last error if any, repository, pull request number, action, head SHA, and, after worker completion, risk level, findings, and received/updated timestamps.

## Environment Variables

| Variable | Purpose | Example |
| --- | --- | --- |
| `APP_ENV` | Runtime environment label | `local` |
| `PORT` | HTTP port | `8080` |
| `GITHUB_WEBHOOK_SECRET` | Shared secret for GitHub webhook HMAC verification | `replace-with-local-secret` |
| `GITHUB_APP_ID` | GitHub App ID used to create short-lived JWTs for installation token minting | `123456` |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key PEM; escaped `\n` sequences are supported | `-----BEGIN PRIVATE KEY-----\n...` |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Alternative path to a mounted GitHub App private key PEM file | `/run/secrets/github-app.pem` |
| `GITHUB_APP_INSTALLATION_ID` | Optional fallback installation ID when a webhook payload does not include one | `987654321` |
| `GITHUB_API_BASE_URL` | GitHub API base URL for GitHub.com or Enterprise Server | `https://api.github.com` |
| `DATABASE_URL` | PostgreSQL connection string for the persistent event store | `postgresql://...` |
| `REDIS_URL` | Redis connection string for BullMQ review jobs | `redis://localhost:6379/0` |
| `REVIEW_JOB_MAX_ATTEMPTS` | Maximum worker attempts before a job enters dead-letter state | `3` |
| `REVIEW_WORKER_CONCURRENCY` | Number of BullMQ review jobs processed concurrently by one worker | `2` |
| `LLM_PROVIDER` | Reserved review provider selector | `mock` |

The GitHub App needs read-only `Pull requests` permission to list pull request files. If private repository file metadata or future source-content reads are needed, add read-only `Contents` permission. Future comment publishing should add `Pull requests: Read and write` only when that feature is implemented.

## Testing

```bash
npm run lint
npm run typecheck
npm test
```

## Design Notes

More detail is available in [docs/system-design.md](docs/system-design.md).

Key tradeoffs:

- Deterministic rules are less flexible than LLM review, but they make behavior auditable and reproducible.
- Store and queue interfaces keep webhook and worker logic independent from PostgreSQL/Redis details; tests can use an isolated in-memory PostgreSQL adapter.
- The GitHub file client and installation-token provider are injectable, which keeps worker tests deterministic while exercising production-style GitHub App authentication.
- Webhook intake is fast and idempotent because review execution runs behind a queue boundary.
- File retrieval falls back to the PR body when GitHub is unavailable, trading depth for reliable webhook acceptance.

## Future Improvements

- Add an LLM provider behind the deterministic policy checks.
- Publish or update a single PR review summary comment per delivery/head SHA.
- Add an operator retry endpoint for dead-letter review jobs.
