import { z } from "zod";
import type { CacheChange, GameMapRow, Store } from "./db.ts";
import type { Row, Statement, TursoClient } from "./turso.ts";
import { USAGE_FIELDS, emptyCounts, type UsageCounts, type UsageStats } from "../usage.ts";

// Copies the DDD cache and usage counters to Turso, because the free host wipes its disk on every
// sleep and restart. The local SQLite stays the working copy (fast, synchronous); the mirror is
// written in the background and read back once at startup. DDD terms apply to the copy as well:
// the 30-day purge runs against it, and nothing older than the cutoff is ever loaded back.

const REMOTE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS game_map (
     twitch_game_id TEXT PRIMARY KEY, twitch_name TEXT NOT NULL, ddd_item_id INTEGER, confidence REAL NOT NULL,
     status TEXT NOT NULL, candidates_json TEXT NOT NULL DEFAULT '[]', seen_count INTEGER NOT NULL DEFAULT 1,
     updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ddd_item_cache (ddd_item_id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ddd_meta (key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, ${USAGE_FIELDS.map((f) => `${f} INTEGER NOT NULL DEFAULT 0`).join(", ")})`,
];

const ITEM_PAGE = 50; // items are ~40 KB of JSON each; keep restore responses a few MB at most

type Logger = { warn: (obj: object, msg: string) => void };
type Remote = Pick<TursoClient, "batch">;

export type RestoreSummary = { games: number; items: number; meta: number; skipped: number };

// Rows read back from Turso are upstream data like any other: validated, and bad rows skipped.
const GameRowSchema = z.object({
  twitch_game_id: z.string().min(1),
  twitch_name: z.string(),
  ddd_item_id: z.number().int().nullable(),
  confidence: z.number(),
  status: z.enum(["matched", "no_match", "low_confidence"]),
  candidates_json: z.string(),
  seen_count: z.number().int(),
  updated_at: z.number().int(),
});
const ItemRowSchema = z.object({ ddd_item_id: z.number().int().positive(), payload_json: z.string().min(2), fetched_at: z.number().int() });
const MetaRowSchema = z.object({ key: z.string().min(1), payload_json: z.string().min(2), fetched_at: z.number().int() });

export class CacheMirror {
  private readonly store: Store;
  private readonly remote: Remote;
  private readonly usage: UsageStats | undefined;
  /** Replaceable so the server can route warnings into its own log once it exists. */
  log: Logger;
  private chain: Promise<void> = Promise.resolve();
  private schemaReady = false;

  constructor(opts: { store: Store; remote: Remote; usage?: UsageStats; log?: Logger }) {
    this.store = opts.store;
    this.remote = opts.remote;
    this.usage = opts.usage;
    this.log = opts.log ?? { warn: () => {} };
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.remote.batch(REMOTE_SCHEMA.map((sql) => ({ sql })));
    this.schemaReady = true;
  }

  /** Purges the copy to the DDD cutoff, then loads what's left into the local store. */
  async restore(cutoff: number): Promise<RestoreSummary> {
    await this.ensureSchema();
    await this.remote.batch(purgeStatements(cutoff));
    const [games, meta] = await this.remote.batch([
      { sql: "SELECT * FROM game_map" },
      { sql: "SELECT key, payload_json, fetched_at FROM ddd_meta WHERE fetched_at >= ?", args: [cutoff] },
    ]);
    let skipped = 0;
    const load = <T>(schema: z.ZodType<T>, row: Row, apply: (r: T) => void) => {
      const parsed = schema.safeParse(row);
      if (parsed.success) apply(parsed.data);
      else skipped++;
    };
    for (const r of games!.rows) load(GameRowSchema, r, (g) => this.store.importGameMap(toGameMapRow(g)));
    for (const r of meta!.rows) load(MetaRowSchema, r, (m) => this.store.importMeta(m.key, m.payload_json, m.fetched_at));
    let items = 0;
    for (let after = 0; ; ) {
      const [page] = await this.remote.batch([
        {
          sql: "SELECT ddd_item_id, payload_json, fetched_at FROM ddd_item_cache WHERE ddd_item_id > ? AND fetched_at >= ? ORDER BY ddd_item_id LIMIT ?",
          args: [after, cutoff, ITEM_PAGE],
        },
      ]);
      for (const r of page!.rows) load(ItemRowSchema, r, (i) => this.store.importItem(i.ddd_item_id, i.payload_json, i.fetched_at));
      items += page!.rows.length;
      if (page!.rows.length < ITEM_PAGE) break;
      after = Number(page!.rows.at(-1)!.ddd_item_id);
    }
    return { games: games!.rows.length, items, meta: meta!.rows.length, skipped };
  }

  /** From now on, copy every cache write to Turso (in the background, in order). */
  attach(): void {
    this.store.onWrite = (change) => this.enqueue(() => this.push(change));
  }

  /** Adds the unsaved usage counts to Turso. On failure they're kept for the next try. */
  flushUsage(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.usage) return;
      const taken = this.usage.take();
      if (taken.size === 0) return;
      try {
        await this.ensureSchema();
        const cols = USAGE_FIELDS.join(", ");
        const marks = USAGE_FIELDS.map(() => "?").join(", ");
        const adds = USAGE_FIELDS.map((f) => `${f} = ${f} + excluded.${f}`).join(", ");
        await this.remote.batch(
          [...taken].map(([day, c]) => ({
            sql: `INSERT INTO usage_daily (day, ${cols}) VALUES (?, ${marks}) ON CONFLICT (day) DO UPDATE SET ${adds}`,
            args: [day, ...USAGE_FIELDS.map((f) => c[f])],
          })),
        );
      } catch (err) {
        this.usage.restore(taken);
        throw err;
      }
    });
  }

  /** Saved usage for the most recent days (newest first). */
  async usageHistory(days = 31): Promise<{ day: string; counts: UsageCounts }[]> {
    await this.ensureSchema();
    const [res] = await this.remote.batch([{ sql: "SELECT * FROM usage_daily ORDER BY day DESC LIMIT ?", args: [days] }]);
    return res!.rows.map((r) => {
      const counts = emptyCounts();
      for (const f of USAGE_FIELDS) counts[f] = Number(r[f] ?? 0);
      return { day: String(r.day), counts };
    });
  }

  /** Resolves once everything queued so far has been attempted. */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task);
    // The chain itself never rejects, so one failure doesn't block later writes.
    this.chain = run.catch((err) => this.log.warn({ err: String(err) }, "Turso mirror write failed"));
    return run;
  }

  /** Copies the current local state of one key (so repeated or reordered changes converge). */
  private async push(change: CacheChange): Promise<void> {
    await this.ensureSchema();
    await this.remote.batch(this.statementsFor(change));
  }

  private statementsFor(change: CacheChange): Statement[] {
    switch (change.kind) {
      case "gameMap": {
        const r = this.store.getGameMap(change.twitchGameId);
        if (!r || r.source !== "auto") return [{ sql: "DELETE FROM game_map WHERE twitch_game_id = ?", args: [change.twitchGameId] }];
        return [
          {
            sql: `INSERT INTO game_map (twitch_game_id, twitch_name, ddd_item_id, confidence, status, candidates_json, seen_count, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (twitch_game_id) DO UPDATE SET twitch_name = excluded.twitch_name, ddd_item_id = excluded.ddd_item_id,
                    confidence = excluded.confidence, status = excluded.status, candidates_json = excluded.candidates_json,
                    seen_count = excluded.seen_count, updated_at = excluded.updated_at`,
            args: [r.twitchGameId, r.twitchName, r.dddItemId, r.confidence, r.status, r.candidatesJson, r.seenCount, r.updatedAt],
          },
        ];
      }
      case "item": {
        const r = this.store.getItem(change.dddItemId);
        if (!r) return [{ sql: "DELETE FROM ddd_item_cache WHERE ddd_item_id = ?", args: [change.dddItemId] }];
        return [
          {
            sql: `INSERT INTO ddd_item_cache (ddd_item_id, payload_json, fetched_at) VALUES (?, ?, ?)
                  ON CONFLICT (ddd_item_id) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
            args: [change.dddItemId, r.payloadJson, r.fetchedAt],
          },
        ];
      }
      case "meta": {
        const r = this.store.getMeta(change.key);
        if (!r) return [{ sql: "DELETE FROM ddd_meta WHERE key = ?", args: [change.key] }];
        return [
          {
            sql: `INSERT INTO ddd_meta (key, payload_json, fetched_at) VALUES (?, ?, ?)
                  ON CONFLICT (key) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
            args: [change.key, r.payloadJson, r.fetchedAt],
          },
        ];
      }
      case "purge":
        return purgeStatements(change.cutoff);
    }
  }
}

/** Same rules as Store.purgeItemsOlderThan (DDD terms: nothing older than 30 days). */
function purgeStatements(cutoff: number): Statement[] {
  return [
    { sql: "DELETE FROM ddd_meta WHERE fetched_at < ?", args: [cutoff] },
    { sql: "UPDATE game_map SET candidates_json = '[]' WHERE updated_at < ?", args: [cutoff] },
    { sql: "DELETE FROM ddd_item_cache WHERE fetched_at < ?", args: [cutoff] },
  ];
}

function toGameMapRow(r: z.infer<typeof GameRowSchema>): GameMapRow {
  return {
    twitchGameId: r.twitch_game_id,
    twitchName: r.twitch_name,
    dddItemId: r.ddd_item_id,
    confidence: r.confidence,
    status: r.status,
    source: "auto",
    candidatesJson: r.candidates_json,
    seenCount: r.seen_count,
    updatedAt: r.updated_at,
  };
}
