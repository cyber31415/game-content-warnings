import type { Category, ExtraTopics, MatchSource, TopicDictionary, Warning, WarningsResponse } from "../../shared/api.d.ts";
import type { GameMapRow, Store } from "./cache/db.ts";
import { DddError, type DddClient } from "./ddd/client.ts";
import { DddItemDetailSchema, type DddItemDetail, type DddItemSummary } from "./ddd/schema.ts";
import { rankCandidates, searchQueries, type Candidate } from "./match/matcher.ts";
import type { HelixClient } from "./twitch/helix.ts";
import { fallbackGroup, type TopicCatalog } from "./topics.ts";
import type { Corrections } from "./corrections.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const TTL = {
  channelGame: 90_000, // Helix channel -> category lookup
  channelHintRefresh: 10_000, // min age before a frontend hint can force a re-lookup
  eventTrust: 30_000, // an EventSub category beats a disagreeing Helix answer for this long
  itemNotFoundBackoff: 60 * MINUTE, // DDD said the item doesn't exist: don't ask again for a while
  itemFailureBackoff: 2 * MINUTE, // other DDD failures: retry no more often than this
  response: 60_000, // assembled response per (game, override)
  matched: 30 * DAY,
  unmatched: 7 * DAY, // no_match / low_confidence: retry periodically
  item: 7 * DAY, // refresh DDD data weekly...
  itemMaxStale: 30 * DAY, // ...and never serve anything older (DDD terms §cache)
  channelTouch: 10 * MINUTE,
};

/** Confidence recorded when a duplicate-listing tie is resolved by vote count. */
const DUPLICATE_CONFIDENCE = 0.95;

/**
 * A topic is shown when "Yes" votes outnumber "No" votes. One vote is enough: newer or
 * less popular games may have very few voters, and a missed warning is worse than an
 * extra one. Ties are not shown. Single source of truth for the threshold.
 */
export const MIN_YES_VOTES = 1;
export function isWarningShown(yes: number, no: number): boolean {
  return yes >= MIN_YES_VOTES && yes > no;
}

export const dddItemUrl = (id: number) => `https://www.doesthedogdie.com/media/${id}`;

/** Confirmed topics, most-voted first, minus excluded (spoiler) topics. */
export function toWarnings(
  item: DddItemDetail,
  dict: TopicDictionary,
  onUnknown: (topicId: number, name: string) => void = () => {},
): { warnings: Warning[]; extraTopics: ExtraTopics } {
  const excluded = new Set(dict.excluded);
  const extraTopics: ExtraTopics = {};
  const warnings = item.topicItemStats
    .filter((s) => isWarningShown(s.yesSum, s.noSum) && !excluded.has(s.topicId))
    .sort((a, b) => b.yesSum - a.yesSum || a.topicName.localeCompare(b.topicName))
    .map((s) => {
      if (!dict.topics[s.topicId]) {
        extraTopics[s.topicId] = { name: s.topicName, group: fallbackGroup(s.topicName) };
        onUnknown(s.topicId, s.topicName);
      }
      return { topicId: s.topicId, yes: s.yesSum, no: s.noSum };
    });
  return { warnings, extraTopics };
}

/** Runs one computation per key at a time; concurrent callers share the promise. */
class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}

type Logger = { warn: (obj: object, msg: string) => void };

export class WarningsService {
  private readonly store: Store;
  private readonly ddd: DddClient;
  private readonly helix: HelixClient;
  readonly topics: TopicCatalog;
  readonly corrections: Corrections;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly flights = new SingleFlight();
  /** `source: "event"` entries came from EventSub; a Helix answer that started earlier must not replace them. */
  private readonly channelGames = new Map<string, { game: Category; at: number; source: "helix" | "event" }>();
  private readonly responses = new Map<string, { body: WarningsResponse; expires: number }>();
  private readonly touched = new Map<string, number>();
  /** Recent failed item fetches, so a missing/unavailable item isn't re-requested on every view (DDD quota). */
  private readonly itemFailures = new Map<number, { at: number; notFound: boolean }>();

  constructor(opts: {
    store: Store;
    ddd: DddClient;
    helix: HelixClient;
    topics: TopicCatalog;
    corrections: Corrections;
    now?: () => number;
    log?: Logger;
  }) {
    this.store = opts.store;
    this.ddd = opts.ddd;
    this.helix = opts.helix;
    this.topics = opts.topics;
    this.corrections = opts.corrections;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? { warn: () => {} };
  }

  /**
   * Warnings for the category a channel is currently set to.
   * `hint` is the game name the frontend sees in Twitch.ext.onContext; if it differs
   * from our cached category we re-check Helix early instead of waiting for the TTL.
   */
  async forChannel(channelId: string, opts: { hint?: string } = {}): Promise<WarningsResponse> {
    try {
      const game = await this.channelGame(channelId, opts.hint);
      if (!game.id) return { status: "no_category" };
      const override = await this.corrections.for(channelId, game.id);
      return await this.forGame(game, override);
    } catch (err) {
      this.log.warn({ err: String(err) }, "warnings lookup failed");
      return { status: "error" };
    }
  }

  /** Called from EventSub when a channel's category changes: updates our view immediately. */
  setChannelGame(channelId: string, game: Category): void {
    this.channelGames.set(channelId, { game, at: this.now(), source: "event" });
  }

  /** The category currently cached for a channel (no lookup). */
  peekChannelGame(channelId: string): Category | undefined {
    return this.channelGames.get(channelId)?.game;
  }

  /** Drops expired in-memory entries (called periodically): keeps memory bounded and holds no DDD data past its expiry. */
  pruneCaches(): void {
    const now = this.now();
    for (const [k, v] of this.responses) if (now >= v.expires) this.responses.delete(k);
    for (const [k, v] of this.channelGames) if (now - v.at > Math.max(TTL.channelGame, TTL.eventTrust)) this.channelGames.delete(k);
    for (const [k, at] of this.touched) if (now - at > TTL.channelTouch) this.touched.delete(k);
    for (const [k, f] of this.itemFailures) if (now - f.at > TTL.itemNotFoundBackoff) this.itemFailures.delete(k);
  }

  /** Records that a channel uses the extension; returns true when it was not seen recently. */
  noteChannelSeen(channelId: string): boolean {
    const last = this.touched.get(channelId) ?? 0;
    if (this.now() - last < TTL.channelTouch) return false;
    this.touched.set(channelId, this.now());
    try {
      this.store.touchChannel(channelId, this.now());
    } catch (err) {
      // Registry bookkeeping must never break the viewer's request.
      this.log.warn({ channelId, err: String(err) }, "channel registry write failed");
      return false;
    }
    return true;
  }

  /** Channel's current category. `fresh` skips the cache (used before saving a correction). */
  async channelGame(channelId: string, hint?: string, opts: { fresh?: boolean } = {}): Promise<Category> {
    const cached = this.channelGames.get(channelId);
    const age = cached ? this.now() - cached.at : Infinity;
    const hintDiffers = hint !== undefined && cached !== undefined && hint !== cached.game.name;
    if (!opts.fresh && cached && age < TTL.channelGame && !(hintDiffers && age >= TTL.channelHintRefresh)) return cached.game;

    return this.flights.run(`channel:${channelId}${opts.fresh ? ":fresh" : ""}`, async () => {
      const startedAt = this.now();
      const ch = await this.helix.getChannel(channelId);
      const game = { id: ch?.game_id ?? "", name: ch?.game_name ?? "" };
      // An EventSub update is authoritative while recent: Helix can lag behind it for a few seconds,
      // so a disagreeing Helix answer doesn't replace it (LiveUpdates re-checks Helix and corrects
      // a genuinely stale event). Other Helix answers don't block this one.
      const latest = this.channelGames.get(channelId);
      if (latest?.source === "event" && latest.game.id !== game.id && (latest.at > startedAt || this.now() - latest.at < TTL.eventTrust)) {
        return latest.game;
      }
      this.channelGames.set(channelId, { game, at: this.now(), source: "helix" });
      return game;
    });
  }

  async forGame(game: Category, channelOverride: number | null): Promise<WarningsResponse> {
    const key = `${game.id}:${channelOverride ?? ""}`;
    const hit = this.responses.get(key);
    if (hit && this.now() < hit.expires) return hit.body;
    if (hit) this.responses.delete(key);

    return this.flights.run(`resp:${key}`, async () => {
      const body = await this.buildResponse(game, channelOverride);
      if (body.status !== "error") {
        // Never cache past the moment the underlying DDD data turns 30 days old.
        const dataLimit = body.status === "ok" ? Date.parse(body.fetchedAt) + TTL.itemMaxStale : Infinity;
        this.responses.set(key, { body, expires: Math.min(this.now() + TTL.response, dataLimit) });
      }
      return body;
    });
  }

  private async buildResponse(game: Category, channelOverride: number | null): Promise<WarningsResponse> {
    let itemId: number;
    let source: MatchSource;
    let confidence: number;
    if (channelOverride !== null) {
      [itemId, source, confidence] = [channelOverride, "channel", 1];
    } else {
      const m = await this.mapping(game);
      if (m.status !== "matched" || m.dddItemId === null) {
        return { status: m.status === "low_confidence" ? "low_confidence" : "no_match", category: game };
      }
      [itemId, source, confidence] = [m.dddItemId, m.source, m.confidence];
    }
    let fetched: { item: DddItemDetail; fetchedAt: number };
    try {
      fetched = await this.item(itemId);
    } catch (err) {
      if (!(err instanceof DddError && err.status === 404)) throw err;
      // DDD deleted or merged this entry.
      if (source === "channel") {
        this.log.warn({ itemId }, "corrected DDD item no longer exists; using automatic match");
        return this.buildResponse(game, null);
      }
      if (source === "auto") this.store.deleteAutoMatch(game.id); // re-match on a later request
      return { status: "no_match", category: game };
    }
    const { item, fetchedAt } = fetched;
    const dict = await this.topics.get();
    const { warnings, extraTopics } = toWarnings(item, dict, (id, name) => this.topics.noteUnknown(id, name));
    return {
      status: "ok",
      category: game,
      ddd: { itemId, name: item.name, url: dddItemUrl(itemId) },
      matchConfidence: Math.round(confidence * 100) / 100,
      matchSource: source,
      warnings,
      extraTopics,
      topicsVersion: dict.version,
      fetchedAt: new Date(fetchedAt).toISOString(),
    };
  }

  /** Twitch category -> DDD item decision, cached in SQLite. */
  async mapping(game: Category): Promise<GameMapRow> {
    const row = this.store.getGameMap(game.id);
    if (row) {
      const ttl = row.status === "matched" ? TTL.matched : TTL.unmatched;
      if (row.source === "manual" || this.now() - row.updatedAt < ttl) return row;
    }
    return this.flights.run(`match:${game.id}`, async () => {
      try {
        const result = await this.runMatcher(game.name);
        this.store.putAutoMatch({
          twitchGameId: game.id,
          twitchName: game.name,
          dddItemId: result.dddItemId,
          confidence: result.confidence,
          status: result.status,
          candidatesJson: JSON.stringify(result.candidates),
          updatedAt: this.now(),
        });
        return this.store.getGameMap(game.id)!;
      } catch (err) {
        if (row) return row; // stale decision beats no decision while DDD is unavailable
        throw err;
      }
    });
  }

  private async runMatcher(twitchName: string) {
    let seen: DddItemSummary[] = [];
    let result = rankCandidates(twitchName, []);
    for (const q of searchQueries(twitchName)) {
      seen = dedupe([...seen, ...(await this.ddd.search(q))]);
      result = rankCandidates(twitchName, seen);
      if (result.status === "matched" || result.duplicateIds) break;
    }
    if (result.duplicateIds) {
      // Duplicate listings of one game: use the one more people voted on (fetches are cached).
      const scored = await Promise.all(
        result.duplicateIds.map(async (id) => {
          const { item } = await this.item(id);
          return { id, votes: item.topicItemStats.reduce((n, s) => n + s.yesSum + s.noSum, 0) };
        }),
      );
      const pick = scored.reduce((a, b) => (b.votes > a.votes ? b : a));
      result = { ...result, status: "matched", dddItemId: pick.id, confidence: DUPLICATE_CONFIDENCE };
    }
    return result;
  }

  async item(itemId: number): Promise<{ item: DddItemDetail; fetchedAt: number }> {
    const cached = this.store.getItem(itemId);
    const age = cached ? this.now() - cached.fetchedAt : Infinity;
    if (cached && age < TTL.item) return { item: DddItemDetailSchema.parse(JSON.parse(cached.payloadJson)), fetchedAt: cached.fetchedAt };

    const serveStale = () =>
      cached && this.now() - cached.fetchedAt < TTL.itemMaxStale
        ? { item: DddItemDetailSchema.parse(JSON.parse(cached.payloadJson)), fetchedAt: cached.fetchedAt }
        : undefined;
    const failure = this.itemFailures.get(itemId);
    if (failure && this.now() - failure.at < (failure.notFound ? TTL.itemNotFoundBackoff : TTL.itemFailureBackoff)) {
      const stale = serveStale();
      if (stale) return stale;
      throw new DddError(`DDD item ${itemId} recently ${failure.notFound ? "not found" : "unavailable"}`, {
        code: failure.notFound ? "not_found" : "recent_failure",
        status: failure.notFound ? 404 : 503,
      });
    }

    return this.flights.run(`item:${itemId}`, async () => {
      try {
        const item = await this.ddd.getItem(itemId);
        const now = this.now();
        this.store.putItem(itemId, JSON.stringify(item), now);
        this.itemFailures.delete(itemId);
        return { item, fetchedAt: now };
      } catch (err) {
        this.itemFailures.set(itemId, { at: this.now(), notFound: err instanceof DddError && err.status === 404 });
        // Re-measure after the failed fetch (it can take tens of seconds); responses built from this
        // copy are cached only until it turns 30 days old (see forGame).
        if (cached && this.now() - cached.fetchedAt < TTL.itemMaxStale) {
          this.log.warn({ itemId, err: String(err) }, "serving stale DDD item");
          return { item: DddItemDetailSchema.parse(JSON.parse(cached.payloadJson)), fetchedAt: cached.fetchedAt };
        }
        throw err;
      }
    });
  }

  candidatesFor(gameId: string): Candidate[] {
    const row = this.store.getGameMap(gameId);
    return row ? (JSON.parse(row.candidatesJson) as Candidate[]) : [];
  }

  /** Drops cached responses so the next request reflects a changed override. */
  invalidateResponses(): void {
    this.responses.clear();
  }
}

function dedupe(items: DddItemSummary[]): DddItemSummary[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return [...byId.values()];
}
