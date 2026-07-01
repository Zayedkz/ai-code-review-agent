import express, { type Request, type Response } from "express";

import type { Settings } from "../config/settings.js";
import {
  normalizePullRequestEvent,
  pullRequestWebhookSchema,
  type PullRequestWebhook,
} from "../github/events.js";
import { verifyGitHubSignature } from "../github/signature.js";
import { DeterministicReviewer, type PullRequestDiff } from "../review/reviewer.js";
import { InMemoryReviewEventStore, type ReviewEventStore } from "../storage/eventStore.js";

type CreateAppOptions = {
  settings: Settings;
  store?: ReviewEventStore;
  reviewer?: DeterministicReviewer;
};

type RawBodyRequest = Request & {
  rawBody?: Buffer;
};

export function createApp(options: CreateAppOptions) {
  const store = options.store ?? new InMemoryReviewEventStore();
  const reviewer = options.reviewer ?? new DeterministicReviewer();
  const app = express();

  app.use(
    express.json({
      verify: (request: RawBodyRequest, _response, buffer) => {
        request.rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.get("/health", (_request: Request, response: Response) => {
    response.json({
      status: "ok",
      environment: options.settings.appEnv,
      storedEvents: store.count(),
    });
  });

  app.post("/webhooks/github", (request: RawBodyRequest, response: Response) => {
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
    const saved = store.save(event, review);

    return response.status(saved.stored ? 202 : 200).json({
      accepted: true,
      duplicate: !saved.stored,
      deliveryId,
      review: saved.record.review,
    });
  });

  return app;
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
