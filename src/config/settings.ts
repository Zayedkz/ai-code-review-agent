import { z } from "zod";

const settingsSchema = z.object({
  appEnv: z.string().default("local"),
  port: z.coerce.number().int().positive().default(8080),
  githubWebhookSecret: z.string().min(1).default("local-development-secret"),
  githubToken: z.string().optional(),
  githubApiBaseUrl: z.string().url().default("https://api.github.com"),
  databaseUrl: z.string().default("postgresql://postgres:postgres@localhost:5432/code_review_agent"),
  redisUrl: z.string().default("redis://localhost:6379/0"),
  llmProvider: z.string().default("mock"),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return settingsSchema.parse({
    appEnv: env.APP_ENV,
    port: env.PORT,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    githubToken: env.GITHUB_TOKEN,
    githubApiBaseUrl: env.GITHUB_API_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    llmProvider: env.LLM_PROVIDER,
  });
}
