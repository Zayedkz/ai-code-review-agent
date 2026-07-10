import { createApp } from "./http/app.js";
import { loadSettings } from "./config/settings.js";
import { BullMQReviewQueue } from "./queue/reviewQueue.js";
import { createPostgresReviewEventStore } from "./storage/eventStore.js";
import { createPostgresReviewJobStore } from "./storage/reviewJobStore.js";

const settings = loadSettings();
const app = createApp({
  settings,
  store: createPostgresReviewEventStore(settings.databaseUrl),
  jobStore: createPostgresReviewJobStore(settings.databaseUrl),
  reviewQueue: new BullMQReviewQueue(settings.redisUrl, settings.reviewJobMaxAttempts),
});

app.listen(settings.port, () => {
  console.log(
    JSON.stringify({
      message: "ai-code-review-agent listening",
      port: settings.port,
      env: settings.appEnv,
    }),
  );
});
