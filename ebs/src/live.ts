import type { Category, PubSubMessage } from "../../shared/api.d.ts";
import type { Store } from "./cache/db.ts";
import { signEbsJwt } from "./auth/jwt.ts";
import type { HelixClient } from "./twitch/helix.ts";
import type { WarningsService } from "./warnings.ts";

/** Extension PubSub messages are limited to 5 KB. */
export const PUBSUB_MAX_BYTES = 5 * 1024;
/** Twitch documents 1 message/second per channel; stay comfortably under it. */
const MIN_BROADCAST_GAP_MS = 1_500;

type Logger = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/**
 * Pushes category changes to viewers:
 *   EventSub channel.update (webhook) -> recompute warnings -> Extension PubSub broadcast.
 * Disabled (frontend falls back to onContext + polling) when no public callback URL is configured.
 */
export class LiveUpdates {
  private readonly store: Store;
  private readonly helix: HelixClient;
  private readonly warnings: WarningsService;
  private readonly extensionSecret: Uint8Array;
  private readonly ownerId: string;
  private readonly eventsub: { callbackUrl: string; secret: string } | undefined;
  private readonly log: Logger;
  private readonly lastBroadcast = new Map<string, number>();
  /** Broadcasts run one at a time per channel, so a slow older lookup can't land after a newer one. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Promise<void>>();
  /** Channels whose subscription was confirmed with Twitch since this process started. */
  private readonly verified = new Set<string>();

  constructor(opts: {
    store: Store;
    helix: HelixClient;
    warnings: WarningsService;
    extensionSecret: Uint8Array;
    ownerId: string;
    eventsub?: { callbackUrl: string; secret: string };
    log: Logger;
    /** How long after a notification to confirm the category with Helix (tests use 0). */
    verifyDelayMs?: number;
  }) {
    this.verifyDelayMs = opts.verifyDelayMs ?? 5_000;
    this.store = opts.store;
    this.helix = opts.helix;
    this.warnings = opts.warnings;
    this.extensionSecret = opts.extensionSecret;
    this.ownerId = opts.ownerId;
    this.eventsub = opts.eventsub;
    this.log = opts.log;
  }

  get enabled(): boolean {
    return this.eventsub !== undefined;
  }

  /** Ensures a channel.update subscription exists for a channel using the extension. */
  async ensureSubscribed(channelId: string): Promise<void> {
    if (!this.eventsub) return;
    // A stored id may be stale (e.g. Twitch revoked it while we were down and the revocation
    // was lost), so confirm once per process: subscribing again finds or replaces it (409 path).
    if (this.verified.has(channelId) && this.store.getChannel(channelId)?.eventsubSubscriptionId) return;
    let p = this.pending.get(channelId);
    if (!p) {
      const { callbackUrl, secret } = this.eventsub;
      p = this.helix
        .subscribeChannelUpdate(channelId, callbackUrl, secret)
        .then((id) => {
          this.store.touchChannel(channelId);
          this.store.setChannelSubscription(channelId, id);
          this.verified.add(channelId);
          this.log.info({ subscriptionId: id }, "subscribed to channel.update");
        })
        .catch((err) => this.log.warn({ channelId, err: String(err) }, "EventSub subscribe failed"))
        .finally(() => this.pending.delete(channelId));
      this.pending.set(channelId, p);
    }
    return p;
  }

  onRevoked(subscriptionId: string, channelId: string | undefined): void {
    if (channelId && this.store.getChannel(channelId)?.eventsubSubscriptionId === subscriptionId) {
      this.store.setChannelSubscription(channelId, null);
    }
  }

  /** EventSub said the category changed: refresh our view and push it to viewers. */
  private readonly verifyDelayMs: number;

  /**
   * EventSub said the category changed: apply it right away (fast for viewers), then confirm with
   * Helix a few seconds later. Notifications can be retried or arrive out of order, and the payload
   * carries no event time, so Helix is the tiebreaker: if it disagrees, correct and re-broadcast.
   */
  async onCategoryChange(channelId: string, category: Category): Promise<void> {
    const verify = setTimeout(() => void this.verifyCategory(channelId, category), this.verifyDelayMs);
    verify.unref?.();
    this.warnings.setChannelGame(channelId, category);
    await this.broadcastCurrent(channelId);
  }

  /**
   * Reads Helix directly (without touching the cache). Helix can briefly lag behind EventSub, so a
   * single disagreement is re-checked later; only a repeated one replaces the notified category.
   */
  private async verifyCategory(channelId: string, applied: Category, attempt = 1): Promise<void> {
    try {
      const ch = await this.helix.getChannel(channelId);
      const actualId = ch?.game_id ?? "";
      if (actualId === applied.id) return;
      // A newer notification already replaced this one; its own check takes over.
      if (this.warnings.peekChannelGame(channelId)?.id !== applied.id) return;
      if (attempt < 2) {
        const again = setTimeout(() => void this.verifyCategory(channelId, applied, attempt + 1), this.verifyDelayMs * 3);
        again.unref?.();
        return;
      }
      this.log.warn({ appliedGameId: applied.id, actualGameId: actualId }, "EventSub category superseded; re-broadcasting");
      this.warnings.setChannelGame(channelId, { id: actualId, name: ch?.game_name ?? "" });
      await this.broadcastCurrent(channelId);
    } catch (err) {
      this.log.warn({ err: String(err) }, "could not confirm category after EventSub");
    }
  }

  /** Recomputes the channel's warnings and broadcasts them (e.g. after an override change). */
  broadcastCurrent(channelId: string): Promise<void> {
    const prev = this.queues.get(channelId) ?? Promise.resolve();
    const next = prev.then(() => this.broadcastNow(channelId));
    const tail = next.catch(() => {}).finally(() => {
      if (this.queues.get(channelId) === tail) this.queues.delete(channelId);
    });
    this.queues.set(channelId, tail);
    return next;
  }

  private async broadcastNow(channelId: string): Promise<void> {
    const wait = (this.lastBroadcast.get(channelId) ?? 0) + MIN_BROADCAST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    // Computed after any wait, so what we send reflects the latest category.
    const data = await this.warnings.forChannel(channelId);
    // A transient upstream failure must not blank viewers' panels; they keep what they have.
    if (data.status === "error") return;
    let message: PubSubMessage = { type: "warnings", data };
    if (Buffer.byteLength(JSON.stringify(message)) > PUBSUB_MAX_BYTES) message = { type: "refresh" };

    this.lastBroadcast.set(channelId, Date.now());
    try {
      const jwt = await signEbsJwt(this.extensionSecret, { ownerId: this.ownerId, channelId, pubsubSend: ["broadcast"] });
      await this.helix.sendExtensionBroadcast(jwt, channelId, JSON.stringify(message));
    } catch (err) {
      // Viewers still converge through onContext + polling.
      this.log.warn({ channelId, err: String(err) }, "PubSub broadcast failed");
    }
  }
}
