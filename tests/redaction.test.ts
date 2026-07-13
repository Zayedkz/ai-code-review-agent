import { describe, expect, it } from "vitest";

import { redactPromptText, redactPullRequestDiff } from "../src/review/redaction.js";

describe("prompt redaction", () => {
  it("redacts likely token, password, and authorization values", () => {
    const redacted = redactPromptText([
      "+ const token = 'ghp_123456789012345678901234567890123456';",
      "+ API_TOKEN=super-secret-token",
      "+ password: \"hunter2\"",
      "+ Authorization: Bearer abc.def.ghi",
    ].join("\n"));

    expect(redacted).not.toContain("ghp_123456789012345678901234567890123456");
    expect(redacted).not.toContain("super-secret-token");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).toContain("token = '[REDACTED]'");
    expect(redacted).toContain("API_TOKEN=[REDACTED]");
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
  });

  it("preserves file paths while redacting patch text", () => {
    const diff = redactPullRequestDiff({
      files: [
        {
          path: "src/config.ts",
          patch: "+ const apiKey = \"live-key\";",
        },
      ],
    });

    expect(diff.files).toEqual([
      {
        path: "src/config.ts",
        patch: "+ const apiKey = \"[REDACTED]\";",
      },
    ]);
  });
});
