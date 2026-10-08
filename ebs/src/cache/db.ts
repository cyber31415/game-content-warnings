import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type MatchStatus = "matched" | "no_match" | "low_confidence";

export type GameMapRow = {
  twitchGameId: string;
  twitchName: string;
  dddItemId: number | null;
  confidence: number;
  status: MatchStatus;
  source: "auto" | "manual";
  candidatesJson: string;
  seenCount: number;
  updatedAt: number;
};

export type ChannelRow = {
  channelId: string;
  overrideDddItemId: number | null;
  /** The Twitch category the override was made for; it only applies while the channel plays it. */
  overrideTwitchGameId: string | null;
  eventsubSubscriptionId: string | null;
  registeredAt: number;
  lastSeenAt: number;
};

const MIGRATIONS = [
  `CREATE TABLE game_map (
     twitch_game_id TEXT PRIMARY KEY,
     twitch_name TEXT NOT NULL,
     ddd_item_id INTEGER,
     confidence REAL NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('matched','no_match','low_confidence')),
     source TEXT NOT NULL CHECK (source IN ('auto','manual')),
     candidates_json TEXT NOT NULL DEFAULT '[]',
     seen_count INTEGER NOT NULL DEFAULT 1,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE ddd_item_cache (
     ddd_item_id INTEGER PRIMARY KEY,
     payload_json TEXT NOT NULL,
     fetched_at INTEGER NOT NULL
   )`,
  `CREATE TABLE channels (
     channel_id TEXT PRIMARY KEY,
     override_ddd_item_id INTEGER,
     eventsub_subscription_id TEXT,
     registered_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL
   )`,
  `CREATE TABLE ddd_meta (
     key TEXT PRIMARY KEY,
     payload_json TEXT NOT NULL,
     fetched_at INTEGER NOT NULL
   )`,
  // Overrides made before this column existed have no category and are therefore ignored.
  `ALTER TABLE channels ADD COLUMN override_twitch_game_id TEXT`,
  // Per-category corrections (one channel can correct several games). Local mirror of the
  // Twitch configuration segment; the channels.override_* columns are no longer used.
  `CREATE TABLE channel_corrections (
     channel_id TEXT NOT NULL,
     twitch_game_id TEXT NOT NULL,
     ddd_item_id INTEGER NOT NULL,
     PRIMARY KEY (channel_id, twitch_game_id)
   )`,
];

/** Thin typed wrapper over node:sqlite. All timestamps are epoch milliseconds. */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, opts: { vfs?: string } = {}) {
    if (path === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      const abs = resolve(path);
      mkdirSync(dirname(abs), { recursive: true });
      // A VFS (e.g. unix-dotfile for CIFS shares) can only be chosen through a file: URI.
      this.db = new DatabaseSync(opts.vfs ? new URL(`${pathToFileURL(abs).href}?vfs=${encodeURIComponent(opts.vfs)}`) : abs);
    }
    this.migrate();
  }

  private migrate(): void {
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  getGameMap(twitchGameId: string): GameMapRow | undefined {
    const r = this.db.prepare("SELECT * FROM game_map WHERE twitch_game_id = ?").get(twitchGameId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      twitchGameId: String(r.twitch_game_id),
      twitchName: String(r.twitch_name),
      dddItemId: r.ddd_item_id == null ? null : Number(r.ddd_item_id),
      confidence: Number(r.confidence),
      status: r.status as MatchStatus,
      source: r.source as "auto" | "manual",
      candidatesJson: String(r.candidates_json),
      seenCount: Number(r.seen_count),
      updatedAt: Number(r.updated_at),
    };
  }

  /** Records an automatic match decision. Never overwrites a manual mapping. */
  putAutoMatch(row: Omit<GameMapRow, "source" | "seenCount">): void {
    this.db
      .prepare(
        `INSERT INTO game_map (twitch_game_id, twitch_name, ddd_item_id, confidence, status, source, candidates_json, updated_at)
         VALUES (?, ?, ?, ?, ?, 'auto', ?, ?)
         ON CONFLICT (twitch_game_id) DO UPDATE SET
           twitch_name = excluded.twitch_name, ddd_item_id = excluded.ddd_item_id,
           confidence = excluded.confidence, status = excluded.status,
           candidates_json = excluded.candidates_json, updated_at = excluded.updated_at,
           seen_count = seen_count + 1
         WHERE game_map.source = 'auto'`,
      )
      .run(row.twitchGameId, row.twitchName, row.dddItemId, row.confidence, row.status, row.candidatesJson, row.updatedAt);
  }

  /** Operator-curated mapping (global, applies to every channel). Pass null to delete. */
  putManualMatch(twitchGameId: string, twitchName: string, dddItemId: number | null, now = Date.now()): void {
    if (dddItemId === null) {
      this.db.prepare("DELETE FROM game_map WHERE twitch_game_id = ? AND source = 'manual'").run(twitchGameId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO game_map (twitch_game_id, twitch_name, ddd_item_id, confidence, status, source, updated_at)
         VALUES (?, ?, ?, 1, 'matched', 'manual', ?)
         ON CONFLICT (twitch_game_id) DO UPDATE SET
           twitch_name = excluded.twitch_name, ddd_item_id = excluded.ddd_item_id, confidence = 1,
           status = 'matched', source = 'manual', candidates_json = '[]', updated_at = excluded.updated_at`,
      )
      .run(twitchGameId, twitchName, dddItemId, now);
  }

  /** Forgets an automatic decision (e.g. its DDD item was deleted) so the matcher runs again. */
  deleteAutoMatch(twitchGameId: string): void {
    this.db.prepare("DELETE FROM game_map WHERE twitch_game_id = ? AND source = 'auto'").run(twitchGameId);
  }

  /** Keeps manual mappings exactly in sync with a list (removes manual rows not in it). */
  syncManualMatches(pins: { twitchGameId: string; twitchName: string; dddItemId: number }[], now = Date.now()): void {
    const keep = new Set(pins.map((p) => p.twitchGameId));
    const rows = this.db.prepare("SELECT twitch_game_id FROM game_map WHERE source = 'manual'").all() as { twitch_game_id: string }[];
    for (const r of rows) if (!keep.has(String(r.twitch_game_id))) this.putManualMatch(String(r.twitch_game_id), "", null);
    for (const p of pins) this.putManualMatch(p.twitchGameId, p.twitchName, p.dddItemId, now);
  }

  listUnresolved(limit = 100): GameMapRow[] {
    const ids = this.db
      .prepare("SELECT twitch_game_id FROM game_map WHERE status != 'matched' ORDER BY seen_count DESC LIMIT ?")
      .all(limit) as { twitch_game_id: string }[];
    return ids.map((r) => this.getGameMap(r.twitch_game_id)!);
  }

  getItem(dddItemId: number): { payloadJson: string; fetchedAt: number } | undefined {
    const r = this.db.prepare("SELECT payload_json, fetched_at FROM ddd_item_cache WHERE ddd_item_id = ?").get(dddItemId) as
      | { payload_json: string; fetched_at: number }
      | undefined;
    return r && { payloadJson: r.payload_json, fetchedAt: Number(r.fetched_at) };
  }

  putItem(dddItemId: number, payloadJson: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO ddd_item_cache (ddd_item_id, payload_json, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (ddd_item_id) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
      )
      .run(dddItemId, payloadJson, now);
  }

  deleteItem(dddItemId: number): void {
    this.db.prepare("DELETE FROM ddd_item_cache WHERE ddd_item_id = ?").run(dddItemId);
  }

  /** DDD terms: cached data must not be older than 30 days. */
  purgeItemsOlderThan(cutoff: number): number {
    this.db.prepare("DELETE FROM ddd_meta WHERE fetched_at < ?").run(cutoff);
    // Candidate names/years come from DDD too; drop them from stale automatic decisions.
    this.db.prepare("UPDATE game_map SET candidates_json = '[]' WHERE source = 'auto' AND updated_at < ?").run(cutoff);
    return Number(this.db.prepare("DELETE FROM ddd_item_cache WHERE fetched_at < ?").run(cutoff).changes);
  }

  getMeta(key: string): { payloadJson: string; fetchedAt: number } | undefined {
    const r = this.db.prepare("SELECT payload_json, fetched_at FROM ddd_meta WHERE key = ?").get(key) as
      | { payload_json: string; fetched_at: number }
      | undefined;
    return r && { payloadJson: r.payload_json, fetchedAt: Number(r.fetched_at) };
  }

  putMeta(key: string, payloadJson: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO ddd_meta (key, payload_json, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
      )
      .run(key, payloadJson, now);
  }

  getChannel(channelId: string): ChannelRow | undefined {
    const r = this.db.prepare("SELECT * FROM channels WHERE channel_id = ?").get(channelId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      channelId: String(r.channel_id),
      overrideDddItemId: r.override_ddd_item_id == null ? null : Number(r.override_ddd_item_id),
      overrideTwitchGameId: r.override_twitch_game_id == null ? null : String(r.override_twitch_game_id),
      eventsubSubscriptionId: r.eventsub_subscription_id == null ? null : String(r.eventsub_subscription_id),
      registeredAt: Number(r.registered_at),
      lastSeenAt: Number(r.last_seen_at),
    };
  }

  touchChannel(channelId: string, now = Date.now()): ChannelRow {
    this.db
      .prepare(
        `INSERT INTO channels (channel_id, registered_at, last_seen_at) VALUES (?, ?, ?)
         ON CONFLICT (channel_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(channelId, now, now);
    return this.getChannel(channelId)!;
  }

  /** Broadcaster corrections for a channel: Twitch category id -> DDD item id. */
  getCorrections(channelId: string): Record<string, number> {
    const rows = this.db.prepare("SELECT twitch_game_id, ddd_item_id FROM channel_corrections WHERE channel_id = ?").all(channelId) as {
      twitch_game_id: string;
      ddd_item_id: number;
    }[];
    return Object.fromEntries(rows.map((r) => [String(r.twitch_game_id), Number(r.ddd_item_id)]));
  }

  /** Replaces a channel's corrections (e.g. after loading them from Twitch's configuration service). */
  replaceCorrections(channelId: string, corrections: Record<string, number>): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM channel_corrections WHERE channel_id = ?").run(channelId);
      const insert = this.db.prepare("INSERT INTO channel_corrections (channel_id, twitch_game_id, ddd_item_id) VALUES (?, ?, ?)");
      for (const [gameId, itemId] of Object.entries(corrections)) insert.run(channelId, gameId, itemId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  setChannelSubscription(channelId: string, subscriptionId: string | null): void {
    this.db.prepare("UPDATE channels SET eventsub_subscription_id = ? WHERE channel_id = ?").run(subscriptionId, channelId);
  }

  close(): void {
    this.db.close();
  }
}
