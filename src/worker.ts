import { loadSettings } from "./config/settings.js";
import { createBullMQReviewWorker } from "./queue/reviewWorker.js";

const settings = loadSettings();
const worker = createBullMQReviewWorker(settings);

worker.on("ready", () => {
  console.log(
    JSON.stringify({
      message: "ai-code-review-agent worker ready",
      queue: "review-jobs",
      concurrency: settings.reviewWorkerConcurrency,
    }),
  );
});

worker.on("failed", (job, error) => {
  console.error(
    JSON.stringify({
      message: "review job failed",
      deliveryId: job?.data.event.deliveryId,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    }),
  );
});
