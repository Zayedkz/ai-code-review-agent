import type { NormalizedPullRequestEvent } from "../github/events.js";

export type ReviewSeverity = "info" | "warning" | "critical";

export type ReviewFinding = {
  code: string;
  severity: ReviewSeverity;
  message: string;
  recommendation: string;
};

export type ReviewSummary = {
  provider: "deterministic";
  riskLevel: "low" | "medium" | "high";
  summary: string;
  findings: ReviewFinding[];
};

export type PullRequestDiff = {
  files: Array<{
    path: string;
    patch: string;
  }>;
};

export class DeterministicReviewer {
  review(event: NormalizedPullRequestEvent, diff: PullRequestDiff = { files: [] }): ReviewSummary {
    const findings: ReviewFinding[] = [];

    if (event.changedFiles >= 20 || event.additions + event.deletions >= 800) {
      findings.push({
        code: "large-change-set",
        severity: "warning",
        message: "This pull request changes a large amount of code.",
        recommendation: "Split the work or add a reviewer checklist for high-risk areas.",
      });
    }

    if (!this.hasTestChange(diff)) {
      findings.push({
        code: "missing-test-change",
        severity: "warning",
        message: "No test files were changed in this pull request.",
        recommendation: "Add or update tests that cover the behavior changed by this PR.",
      });
    }

    if (this.containsRiskyPattern(diff, ["TODO", "FIXME", "console.log("])) {
      findings.push({
        code: "debug-or-placeholder-code",
        severity: "info",
        message: "The diff contains debug output or placeholder markers.",
        recommendation: "Remove temporary debugging and convert placeholders into tracked work.",
      });
    }

    if (this.containsRiskyPattern(diff, ["process.env", "secret", "token", "password"])) {
      findings.push({
        code: "secret-handling-review",
        severity: "critical",
        message: "The diff touches environment variables or secret-like terms.",
        recommendation: "Verify no credentials are committed and secret access is audited.",
      });
    }

    const riskLevel = this.riskLevel(findings);
    return {
      provider: "deterministic",
      riskLevel,
      summary: `${event.repository}#${event.pullRequestNumber} reviewed with ${findings.length} finding(s).`,
      findings,
    };
  }

  private hasTestChange(diff: PullRequestDiff): boolean {
    return diff.files.some((file) => /(^|\/)(__tests__|tests?)\/|\.test\.|\.spec\./.test(file.path));
  }

  private containsRiskyPattern(diff: PullRequestDiff, patterns: string[]): boolean {
    const changedText = diff.files.map((file) => file.patch).join("\n").toLowerCase();
    return patterns.some((pattern) => changedText.includes(pattern.toLowerCase()));
  }

  private riskLevel(findings: ReviewFinding[]): ReviewSummary["riskLevel"] {
    if (findings.some((finding) => finding.severity === "critical")) {
      return "high";
    }
    if (findings.some((finding) => finding.severity === "warning")) {
      return "medium";
    }
    return "low";
  }
}
