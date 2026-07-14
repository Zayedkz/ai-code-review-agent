import { z } from "zod";

const settingsSchema = z.object({
  appEnv: z.string().default("local"),
  port: z.coerce.number().int().positive().default(8080),
  githubWebhookSecret: z.string().min(1).default("local-development-secret"),
  githubAppId: z.string().optional(),
  githubAppPrivateKey: z.string().optional(),
  githubAppPrivateKeyPath: z.string().optional(),
  githubAppInstallationId: z.coerce.number().int().positive().optional(),
  githubApiBaseUrl: z.string().url().default("https://api.github.com"),
  databaseUrl: z.string().default("postgresql://postgres:postgres@localhost:5432/code_review_agent"),
  redisUrl: z.string().default("redis://localhost:6379/0"),
  reviewJobMaxAttempts: z.coerce.number().int().positive().default(3),
  reviewWorkerConcurrency: z.coerce.number().int().positive().default(2),
  llmProvider: z.enum(["deterministic", "mock", "local"]).default("deterministic"),
  publishReviewComments: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return settingsSchema.parse({
    appEnv: env.APP_ENV,
    port: env.PORT,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    githubAppPrivateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH,
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID,
    githubApiBaseUrl: env.GITHUB_API_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    reviewJobMaxAttempts: env.REVIEW_JOB_MAX_ATTEMPTS,
    reviewWorkerConcurrency: env.REVIEW_WORKER_CONCURRENCY,
    llmProvider: env.LLM_PROVIDER,
    publishReviewComments: env.PUBLISH_REVIEW_COMMENTS,
  });
}
