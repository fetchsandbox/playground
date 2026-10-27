import { createHmac, timingSafeEqual } from "node:crypto";
import type { Engine } from "./engine";
import { errorMessage } from "./errors";
import type { Logger } from "./log";

/** Stripe's default tolerance for the signed timestamp (seconds). */
export const STRIPE_TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true } | { ok: false; code: "missing_signature" | "malformed_signature" | "bad_signature" | "timestamp_outside_tolerance" };

/**
 * Stripe-Signature: `t=<unix seconds>,v1=<hex hmac>[,v1=...]` over `${t}.${rawBody}`
 * with the endpoint's signing secret. The raw body is checked byte for byte, so a
 * re-serialised or mutated body fails, and an old timestamp fails even with a valid MAC.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, nowSeconds: number, tolerance = STRIPE_TOLERANCE_SECONDS): SignatureCheck {
  if (!header) return { ok: false, code: "missing_signature" };
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v!);
  if (!t || !/^\d+$/.test(t) || !sigs.length) return { ok: false, code: "malformed_signature" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const match = sigs.some((s) => /^[a-f0-9]{64}$/.test(s) && timingSafeEqual(expected, Buffer.from(s, "hex")));
  if (!match) return { ok: false, code: "bad_signature" };
  if (Math.abs(nowSeconds - Number(t)) > tolerance) return { ok: false, code: "timestamp_outside_tolerance" };
  return { ok: true };
}

/** Test helper and documentation of the format: the header Stripe would send. */
export function signStripePayload(rawBody: string, secret: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex")}`;
}

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * One Stripe delivery. The signature is checked against the raw body, the
 * workflow's mapper turns the event into a run (re-reading provider state; the
 * payload is only a hint), and the run's id makes repeated, replayed or
 * concurrent deliveries of the same business event land on one run.
 * Non-2xx replies make Stripe retry, so provider and engine errors answer 500.
 */
export async function handleStripeWebhook(
  engine: Engine<unknown>,
  rawBody: string,
  headers: Record<string, string | undefined>,
  opts: { secret?: string; correlation: Record<string, string>; log: Logger; now?: () => number },
): Promise<WebhookReply> {
  const mapper = engine.workflow.events?.stripe;
  if (!mapper) return { status: 404, body: { error: "this runtime accepts no Stripe events" } };
  // Never accept unsigned events, even in development.
  if (!opts.secret) return { status: 503, body: { error: "webhook signing secret not configured" } };
  const check = verifyStripeSignature(rawBody, headers["stripe-signature"], opts.secret, Math.floor((opts.now ?? Date.now)() / 1000));
  if (!check.ok) {
    opts.log.warn("stripe webhook refused", { code: check.code });
    return { status: 400, body: { error: "signature verification failed", code: check.code } };
  }
  let event: { id?: unknown; type?: unknown; data?: { object?: { id?: unknown } } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "body is not JSON" } };
  }
  if (typeof event.id !== "string" || typeof event.type !== "string") return { status: 400, body: { error: "not a Stripe event" } };
  const eventId = event.id;
  try {
    const start = await mapper({ id: eventId, type: event.type, data: event.data }, engine.providersFor(opts.correlation));
    if (!start) return { status: 200, body: { received: true, eventId, ignored: true } };
    const origin = start.labelsFromRun ? await engine.load(start.labelsFromRun) : undefined;
    const reply = await engine.handle(
      { action: "start", runId: start.runId, input: start.input, requestedBy: { userId: "stripe-webhook" }, labels: { ...(origin?.labels ?? {}), trigger: "stripe_webhook" } },
      opts.correlation,
    );
    if (reply.status !== 200) return { status: reply.status === 400 ? 422 : 500, body: { error: "event could not start a run", eventId, detail: reply.body } };
    opts.log.info("stripe webhook", { eventId, type: event.type, runId: start.runId, duplicate: reply.body.duplicate });
    return { status: 200, body: { received: true, eventId, runId: start.runId, duplicate: !!reply.body.duplicate, phase: reply.body.phase } };
  } catch (err) {
    opts.log.error("stripe webhook failed", { eventId, err: errorMessage(err) });
    return { status: 500, body: { error: "event handling failed; retry", eventId } };
  }
}
