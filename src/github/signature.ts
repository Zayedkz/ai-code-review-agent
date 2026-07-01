import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

export function createGitHubSignature(secret: string, payload: Buffer | string): string {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

export function verifyGitHubSignature(
  secret: string,
  payload: Buffer,
  signatureHeader: string | string[] | undefined,
): boolean {
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const expected = Buffer.from(createGitHubSignature(secret, payload), "utf8");
  const actual = Buffer.from(signatureHeader, "utf8");

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
