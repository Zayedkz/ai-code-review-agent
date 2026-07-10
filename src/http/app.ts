import express, { type NextFunction, type Request, type Response } from "express";

import type { Settings } from "../config/settings.js";
import {
  normalizePullRequestEvent,
  pullRequestWebhookSchema,
} from "../github/events.js";
import { verifyGitHubSignature } from "../github/signature.js";
import { InMemoryReviewQueue, type ReviewQueue } from "../queue/reviewQueue.js";
import {
  type StoredReviewEvent,
  createPostgresReviewEventStore,
  type ReviewEventStore,
} from "../storage/eventStore.js";
import {
  InMemoryReviewJobStore,
  type ReviewJobRecord,
  type ReviewJobStore,
} from "../storage/reviewJobStore.js";

type CreateAppOptions = {
  settings: Settings;
  store?: ReviewEventStore;
  jobStore?: ReviewJobStore;
  reviewQueue?: ReviewQueue;
};

type RawBodyRequest = Request & {
  rawBody?: Buffer;
};

export function createApp(options: CreateAppOptions) {
  const store = options.store ?? createPostgresReviewEventStore(options.settings.databaseUrl);
  const jobStore = options.jobStore ?? new InMemoryReviewJobStore();
  const reviewQueue = options.reviewQueue ?? new InMemoryReviewQueue();
  const app = express();

  app.use(
    express.json({
      verify: (request: RawBodyRequest, _response, buffer) => {
        request.rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.get("/health", asyncHandler(async (_request: Request, response: Response) => {
    const storedEvents = await store.count();
    const reviewJobs = await jobStore.countByStatus();
    response.json({
      status: "ok",
      environment: options.settings.appEnv,
      storedEvents,
      reviewJobs,
    });
  }));

  app.get("/reviews/:deliveryId", asyncHandler(async (request: Request, response: Response) => {
    const stored = await store.get(request.params.deliveryId);
    const job = await jobStore.get(request.params.deliveryId);
    if (!stored && !job) {
      return response.status(404).json({ error: "review delivery not found" });
    }

    return response.json(reviewAuditResponse(stored, job));
  }));

  app.post("/webhooks/github", asyncHandler(async (request: RawBodyRequest, response: Response) => {
    const eventType = request.header("x-github-event");
    const deliveryId = request.header("x-github-delivery");
    const signature = request.header("x-hub-signature-256");
    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body));

    if (!verifyGitHubSignature(options.settings.githubWebhookSecret, rawBody, signature)) {
      return response.status(401).json({ error: "invalid GitHub webhook signature" });
    }

    if (!deliveryId) {
      return response.status(400).json({ error: "missing x-github-delivery header" });
    }

    if (eventType !== "pull_request") {
      return response.status(202).json({ accepted: false, reason: "unsupported event type" });
    }

    const parsed = pullRequestWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: "invalid pull_request payload" });
    }

    const event = normalizePullRequestEvent(deliveryId, parsed.data);
    const existing = await store.get(deliveryId);
    const existingJob = await jobStore.get(deliveryId);
    if (existing) {
      return response.status(200).json({
        accepted: true,
        duplicate: true,
        deliveryId,
        job: existingJob ? reviewJobResponse(existingJob) : undefined,
        review: existing.review,
      });
    }
    if (existingJob) {
      return response.status(200).json({
        accepted: true,
        duplicate: true,
        deliveryId,
        job: reviewJobResponse(existingJob),
      });
    }

    const created = await jobStore.create(event, options.settings.reviewJobMaxAttempts);
    if (created.created) {
      await reviewQueue.enqueue(event);
    }

    return response.status(202).json({
      accepted: true,
      duplicate: false,
      deliveryId,
      job: reviewJobResponse(created.record),
    });
  }));

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    void next;
    console.error(error);
    response.status(500).json({ error: "internal server error" });
  });

  return app;
}

function reviewAuditResponse(stored?: StoredReviewEvent, job?: ReviewJobRecord) {
  return {
    deliveryId: stored?.event.deliveryId ?? job?.deliveryId,
    status: stored ? "stored" : job?.status,
    duplicateReplayBehavior: "duplicate deliveries return the existing review or queued job state",
    job: job ? reviewJobResponse(job) : undefined,
    repository: stored?.event.repository ?? job?.event.repository,
    repositoryUrl: stored?.event.repositoryUrl ?? job?.event.repositoryUrl,
    pullRequestNumber: stored?.event.pullRequestNumber ?? job?.event.pullRequestNumber,
    pullRequestTitle: stored?.event.pullRequestTitle ?? job?.event.pullRequestTitle,
    pullRequestUrl: stored?.event.pullRequestUrl ?? job?.event.pullRequestUrl,
    action: stored?.event.action ?? job?.event.action,
    headSha: stored?.event.headSha ?? job?.event.headSha,
    headRef: stored?.event.headRef ?? job?.event.headRef,
    baseSha: stored?.event.baseSha ?? job?.event.baseSha,
    baseRef: stored?.event.baseRef ?? job?.event.baseRef,
    riskLevel: stored?.review.riskLevel,
    summary: stored?.review.summary,
    findings: stored?.review.findings,
    receivedAt: stored?.receivedAt,
    updatedAt: stored?.updatedAt ?? job?.updatedAt,
  };
}

function reviewJobResponse(job: ReviewJobRecord) {
  return {
    deliveryId: job.deliveryId,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    updatedAt: job.updatedAt,
  };
}

function asyncHandler(
  handler: (request: RawBodyRequest, response: Response, next: NextFunction) => Promise<unknown>,
) {
  return (request: RawBodyRequest, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next);
  };
}
