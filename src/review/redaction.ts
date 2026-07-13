import type { NormalizedPullRequestEvent } from "../github/events.js";
import type { PullRequestDiff } from "./reviewer.js";

const redactionRules: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bprocess\.env\.[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\b/g, "process.env.[REDACTED_ENV_NAME]"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/\b(Authorization:\s*(?:Bearer|token)\s+)[^\s'"`]+/gi, "$1[REDACTED]"],
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)(["'`]?)[^\s"'`]+(\2)/gi,
    "$1$2[REDACTED]$3",
  ],
  [
    /\b([A-Za-z0-9_]*(?:secret|token|password|apiKey|api_key|privateKey|private_key)[A-Za-z0-9_]*\s*=\s*)(["'`]?)[^\s"'`;]+(\2)/gi,
    "$1$2[REDACTED]$3",
  ],
  [
    /(["']?[A-Za-z0-9_]*(?:secret|token|password|apiKey|api_key|privateKey|private_key)[A-Za-z0-9_]*["']?\s*:\s*)(["'`])[^"'`]+(\2)/gi,
    "$1$2[REDACTED]$3",
  ],
];

export function redactPromptText(text: string): string {
  return redactionRules.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    text,
  );
}

export function redactPullRequestDiff(diff: PullRequestDiff): PullRequestDiff {
  return {
    files: diff.files.map((file) => ({
      ...file,
      patch: redactPromptText(file.patch),
    })),
  };
}

export function redactReviewEvent(event: NormalizedPullRequestEvent): NormalizedPullRequestEvent {
  return {
    ...event,
    body: event.body === null ? null : redactPromptText(event.body),
  };
}
