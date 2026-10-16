import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_SECONDS = 60 * 5;

/**
 * Verify a Slack request signature (v0 HMAC-SHA256 over `v0:{ts}:{rawBody}`).
 * Rejects stale timestamps to block replays of captured requests.
 * https://docs.slack.dev/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(args: {
  signingSecret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds?: number;
}): boolean {
  const { signingSecret, rawBody, timestamp, signature } = args;
  if (!timestamp || !signature || !signingSecret) return false;
  const ts = Number(timestamp);
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signSlackBody(signingSecret: string, rawBody: string, timestamp: number): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}
