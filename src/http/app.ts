import express, { type NextFunction, type Request, type Response } from "express";

import type { Settings } from "../config/settings.js";
import {
  normalizePullRequestEvent,
  pullRequestWebhookSchema,
  type PullRequestWebhook,
} from "../github/events.js";
import { verifyGitHubSignature } from "../github/signature.js";
import { DeterministicReviewer, type PullRequestDiff } from "../review/reviewer.js";
import {
  type StoredReviewEvent,
  createPostgresReviewEventStore,
  type ReviewEventStore,
} from "../storage/eventStore.js";

type CreateAppOptions = {
  settings: Settings;
  store?: ReviewEventStore;
  reviewer?: DeterministicReviewer;
};

type RawBodyRequest = Request & {
  rawBody?: Buffer;
};

export function createApp(options: CreateAppOptions) {
  const store = options.store ?? createPostgresReviewEventStore(options.settings.databaseUrl);
  const reviewer = options.reviewer ?? new DeterministicReviewer();
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
    response.json({
      status: "ok",
      environment: options.settings.appEnv,
      storedEvents,
    });
  }));

  app.get("/reviews/:deliveryId", asyncHandler(async (request: Request, response: Response) => {
    const stored = await store.get(request.params.deliveryId);
    if (!stored) {
      return response.status(404).json({ error: "review delivery not found" });
    }

    return response.json(reviewAuditResponse(stored));
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
    const review = reviewer.review(event, extractDiff(parsed.data));
    const saved = await store.save(event, review);

    return response.status(saved.stored ? 202 : 200).json({
      accepted: true,
      duplicate: !saved.stored,
      deliveryId,
      review: saved.record.review,
    });
  }));

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    void next;
    console.error(error);
    response.status(500).json({ error: "internal server error" });
  });

  return app;
}

function reviewAuditResponse(stored: StoredReviewEvent) {
  return {
    deliveryId: stored.event.deliveryId,
    status: "stored",
    duplicateReplayBehavior: "duplicate deliveries return the originally stored review",
    repository: stored.event.repository,
    repositoryUrl: stored.event.repositoryUrl,
    pullRequestNumber: stored.event.pullRequestNumber,
    pullRequestTitle: stored.event.pullRequestTitle,
    pullRequestUrl: stored.event.pullRequestUrl,
    action: stored.event.action,
    headSha: stored.event.headSha,
    headRef: stored.event.headRef,
    baseSha: stored.event.baseSha,
    baseRef: stored.event.baseRef,
    riskLevel: stored.review.riskLevel,
    summary: stored.review.summary,
    findings: stored.review.findings,
    receivedAt: stored.receivedAt,
    updatedAt: stored.updatedAt,
  };
}

function extractDiff(payload: PullRequestWebhook): PullRequestDiff {
  const body = payload.pull_request.body ?? "";
  return {
    files: [
      {
        path: "pull-request-description.md",
        patch: body,
      },
    ],
  };
}

function asyncHandler(
  handler: (request: RawBodyRequest, response: Response, next: NextFunction) => Promise<unknown>,
) {
  return (request: RawBodyRequest, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next);
  };
}
