import { describe, expect, it } from "vitest";

import { createGitHubSignature, verifyGitHubSignature } from "../src/github/signature.js";

describe("GitHub webhook signatures", () => {
  it("accepts a valid sha256 signature", () => {
    const payload = Buffer.from(JSON.stringify({ action: "opened" }));
    const signature = createGitHubSignature("secret", payload);

    expect(verifyGitHubSignature("secret", payload, signature)).toBe(true);
  });

  it("rejects missing or invalid signatures", () => {
    const payload = Buffer.from("{}");

    expect(verifyGitHubSignature("secret", payload, undefined)).toBe(false);
    expect(verifyGitHubSignature("secret", payload, "sha1=abc")).toBe(false);
    expect(verifyGitHubSignature("secret", payload, createGitHubSignature("wrong", payload))).toBe(
      false,
    );
  });
});
