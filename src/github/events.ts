import { z } from "zod";

export const pullRequestWebhookSchema = z.object({
  action: z.string(),
  repository: z.object({
    full_name: z.string(),
    html_url: z.string().url(),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    html_url: z.string().url(),
    user: z.object({
      login: z.string(),
    }),
    head: z.object({
      sha: z.string(),
      ref: z.string(),
    }),
    base: z.object({
      sha: z.string(),
      ref: z.string(),
    }),
    changed_files: z.number().int().nonnegative().optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    body: z.string().nullable().optional(),
  }),
});

export type PullRequestWebhook = z.infer<typeof pullRequestWebhookSchema>;

export type NormalizedPullRequestEvent = {
  deliveryId: string;
  action: string;
  repository: string;
  repositoryUrl: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  author: string;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  body: string | null;
};

export function normalizePullRequestEvent(
  deliveryId: string,
  payload: PullRequestWebhook,
): NormalizedPullRequestEvent {
  return {
    deliveryId,
    action: payload.action,
    repository: payload.repository.full_name,
    repositoryUrl: payload.repository.html_url,
    pullRequestNumber: payload.pull_request.number,
    pullRequestTitle: payload.pull_request.title,
    pullRequestUrl: payload.pull_request.html_url,
    author: payload.pull_request.user.login,
    headSha: payload.pull_request.head.sha,
    headRef: payload.pull_request.head.ref,
    baseSha: payload.pull_request.base.sha,
    baseRef: payload.pull_request.base.ref,
    changedFiles: payload.pull_request.changed_files ?? 0,
    additions: payload.pull_request.additions ?? 0,
    deletions: payload.pull_request.deletions ?? 0,
    body: payload.pull_request.body ?? null,
  };
}
