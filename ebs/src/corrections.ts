import { z } from "zod";
import type { Store } from "./cache/db.ts";
import { signEbsJwt } from "./auth/jwt.ts";
import type { HelixClient } from "./twitch/helix.ts";

/** Twitch configuration segments are capped at 5 KB; ~25 bytes per correction. */
export const MAX_CORRECTIONS = 100;

const SegmentSchema = z.object({ v: z.literal(1), c: z.record(z.string().regex(/^\d+$/), z.number().int().positive()) });

type Logger = { warn: (obj: object, msg: string) => void };

/**
 * Broadcaster game-match corrections (Twitch category id -> DDD item id), per channel.
 *
 * "twitch" mode stores them in the channel's developer configuration segment, so they survive
 * hosts with ephemeral disks (Render free tier wipes the SQLite file when it sleeps). SQLite keeps
 * a local mirror. "local" mode (development, Twitch CLI mock) uses SQLite only.
 */
/** Thrown when a channel already has the maximum number of corrections. */
export class CorrectionLimitError extends Error {}

export class Corrections {
  private readonly store: Store;
  private readonly helix: HelixClient;
  private readonly secret: Uint8Array;
  private readonly ownerId: string;
  private readonly mode: "twitch" | "local";
  private readonly log: Logger;
  private readonly loaded = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();
  /** Saves run one at a time per channel, so overlapping saves can't diverge. */
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(opts: { store: Store; helix: HelixClient; extensionSecret: Uint8Array; ownerId: string; mode: "twitch" | "local"; log?: Logger }) {
    this.store = opts.store;
    this.helix = opts.helix;
    this.secret = opts.extensionSecret;
    this.ownerId = opts.ownerId;
    this.mode = opts.mode;
    this.log = opts.log ?? { warn: () => {} };
  }

  /** The correction for this channel and category, if the broadcaster made one. */
  async for(channelId: string, twitchGameId: string): Promise<number | null> {
    await this.ensureLoaded(channelId);
    return this.store.getCorrections(channelId)[twitchGameId] ?? null;
  }

  /** Saves (or clears with null) the correction for one category. Throws if it can't be stored durably. */
  set(channelId: string, twitchGameId: string, dddItemId: number | null): Promise<void> {
    const prev = this.saveQueues.get(channelId) ?? Promise.resolve();
    const run = prev.then(() => this.save(channelId, twitchGameId, dddItemId));
    const tail = run.catch(() => {}).finally(() => {
      if (this.saveQueues.get(channelId) === tail) this.saveQueues.delete(channelId);
    });
    this.saveQueues.set(channelId, tail);
    return run;
  }

  private async save(channelId: string, twitchGameId: string, dddItemId: number | null): Promise<void> {
    if (this.mode === "twitch") {
      // Never write a map built from an incomplete mirror: that would erase the channel's other
      // corrections in Twitch. Load now (ignoring the read backoff) or refuse to save.
      if (!this.loaded.has(channelId)) {
        this.failedAt.delete(channelId);
        await this.ensureLoaded(channelId);
      }
      if (!this.loaded.has(channelId)) throw new Error("couldn't read existing corrections from Twitch");
    }
    const next = { ...this.store.getCorrections(channelId) };
    if (dddItemId === null) delete next[twitchGameId];
    else next[twitchGameId] = dddItemId;
    if (Object.keys(next).length > MAX_CORRECTIONS) throw new CorrectionLimitError("too many corrections for this channel");
    if (this.mode === "twitch") {
      const jwt = await signEbsJwt(this.secret, { ownerId: this.ownerId, channelId });
      await this.helix.setDeveloperSegment(jwt, channelId, JSON.stringify({ v: 1, c: next }));
    }
    this.store.touchChannel(channelId);
    this.store.replaceCorrections(channelId, next);
  }

  private async ensureLoaded(channelId: string): Promise<void> {
    if (this.mode === "local" || this.loaded.has(channelId)) return;
    if (Date.now() - (this.failedAt.get(channelId) ?? 0) < 60_000) return; // recent failure: use the mirror
    let p = this.pending.get(channelId);
    if (!p) {
      p = this.load(channelId).finally(() => this.pending.delete(channelId));
      this.pending.set(channelId, p);
    }
    return p;
  }

  private async load(channelId: string): Promise<void> {
    try {
      const jwt = await signEbsJwt(this.secret, { ownerId: this.ownerId, channelId });
      const content = await this.helix.getDeveloperSegment(jwt, channelId);
      let json: unknown;
      try {
        json = content ? JSON.parse(content) : undefined;
      } catch {
        json = null; // unparseable content counts as malformed, not as a Twitch failure
      }
      const parsed = json === undefined ? undefined : SegmentSchema.safeParse(json);
      if (parsed && !parsed.success) this.log.warn({ channelId }, "ignoring malformed corrections segment");
      this.store.replaceCorrections(channelId, parsed?.success ? parsed.data.c : {});
      this.loaded.add(channelId);
      this.failedAt.delete(channelId);
    } catch (err) {
      // Fall back to whatever the local mirror has; try Twitch again on the next request.
      this.failedAt.set(channelId, Date.now());
      this.log.warn({ channelId, err: String(err) }, "could not load corrections from Twitch");
    }
  }
}
