import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// https://dev.twitch.tv/docs/eventsub/handling-webhook-events/
export const EVENTSUB_HEADERS = {
  id: "twitch-eventsub-message-id",
  timestamp: "twitch-eventsub-message-timestamp",
  signature: "twitch-eventsub-message-signature",
  type: "twitch-eventsub-message-type",
} as const;

const MAX_AGE_MS = 10 * 60_000;

export function signEventSub(secret: string, id: string, timestamp: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(id + timestamp + rawBody).digest("hex");
}

export type VerifyResult = { ok: true; messageId: string; messageType: string } | { ok: false; reason: string };

/** Verifies the HMAC signature and timestamp freshness of a webhook delivery. */
export function verifyEventSub(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  now = Date.now(),
): VerifyResult {
  const h = (k: string) => (typeof headers[k] === "string" ? (headers[k] as string) : undefined);
  const id = h(EVENTSUB_HEADERS.id);
  const ts = h(EVENTSUB_HEADERS.timestamp);
  const sig = h(EVENTSUB_HEADERS.signature);
  const type = h(EVENTSUB_HEADERS.type);
  if (!id || !ts || !sig || !type) return { ok: false, reason: "missing headers" };

  const expected = Buffer.from(signEventSub(secret, id, ts, rawBody));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad signature" };

  const age = now - Date.parse(ts);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) return { ok: false, reason: "stale timestamp" };
  return { ok: true, messageId: id, messageType: type };
}

/** Remembers recent message ids: Twitch may redeliver the same notification. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  firstTime(id: string): boolean {
    const t = this.now();
    for (const [k, at] of this.seen) {
      if (t - at > MAX_AGE_MS) this.seen.delete(k);
      else break; // Map iterates in insertion order
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, t);
    return true;
  }
}

export const ChannelUpdateNotificationSchema = z.object({
  subscription: z.object({ id: z.string(), type: z.literal("channel.update") }),
  event: z.object({
    broadcaster_user_id: z.string(),
    category_id: z.string(),
    category_name: z.string(),
  }),
});

export const VerificationSchema = z.object({ challenge: z.string() });
export const RevocationSchema = z.object({
  subscription: z.object({ id: z.string(), status: z.string(), condition: z.record(z.string(), z.string()) }),
});
