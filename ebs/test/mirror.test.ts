import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { Store } from "../src/cache/db.ts";
import { CacheMirror } from "../src/cache/mirror.ts";
import { UsageStats } from "../src/usage.ts";
import { fakeTurso, signViewerToken, testDeps } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;
const auth = async () => ({ authorization: `Bearer ${await signViewerToken({ channel_id: "12345" })}` });

/** One EBS "process": fresh local store (the free host's wiped disk), shared Turso. */
async function boot(turso: ReturnType<typeof fakeTurso>) {
  const d = testDeps();
  const usage = new UsageStats();
  usage.add("wakeups");
  const mirror = new CacheMirror({ store: d.store, remote: turso.remote, usage });
  const app = await buildServer({ ...d, usage, mirror });
  await app.ready();
  return { app, mirror, usage, ...d };
}

test("after a restart with a wiped disk, warnings come from Turso without asking DDD again", async () => {
  const turso = fakeTurso();
  const first = await boot(turso);
  const res1 = await first.app.inject({ url: "/api/warnings", headers: await auth() });
  assert.equal(res1.json().status, "ok");
  assert.ok(first.up.dddCalls.length > 0, "first run fetches from DDD");
  await first.mirror.idle();
  await first.app.close();

  const second = await boot(turso);
  const res2 = await second.app.inject({ url: "/api/warnings", headers: await auth() });
  assert.equal(res2.json().status, "ok");
  assert.deepEqual(res2.json().warnings, res1.json().warnings);
  assert.deepEqual(second.up.dddCalls, [], "no DDD requests: match, item and topic catalogue all restored");
  await second.app.close();
});

test("the 30-day DDD limit applies to the copy: old rows are purged there and never loaded back", async () => {
  const turso = fakeTurso();
  const store = new Store(":memory:");
  const mirror = new CacheMirror({ store, remote: turso.remote });
  mirror.attach();
  const now = Date.now();
  store.putItem(1, '{"old":true}', now - 31 * DAY);
  store.putItem(2, '{"new":true}', now - 1 * DAY);
  store.putMeta("old-meta", "{}", now - 40 * DAY);
  await mirror.idle();

  const fresh = new Store(":memory:");
  const summary = await new CacheMirror({ store: fresh, remote: turso.remote }).restore(now - 30 * DAY);
  assert.equal(summary.items, 1);
  assert.equal(fresh.getItem(1), undefined);
  assert.ok(fresh.getItem(2));
  assert.equal(fresh.getMeta("old-meta"), undefined);
  const left = turso.db.prepare("SELECT ddd_item_id FROM ddd_item_cache").all();
  assert.deepEqual(left.map((r) => Number(r.ddd_item_id)), [2], "purged from Turso too");

  // A purge on the live store is mirrored as well.
  store.purgeItemsOlderThan(now);
  await mirror.idle();
  assert.equal(turso.db.prepare("SELECT COUNT(*) AS n FROM ddd_item_cache").get()!.n, 0);
});

test("deletes are mirrored, and manual pins are never stored in or restored from Turso", async () => {
  const turso = fakeTurso();
  const store = new Store(":memory:");
  const mirror = new CacheMirror({ store, remote: turso.remote });
  mirror.attach();
  const now = Date.now();
  store.putAutoMatch({ twitchGameId: "g1", twitchName: "Game", dddItemId: 7, confidence: 1, status: "matched", candidatesJson: "[]", updatedAt: now });
  store.putItem(7, "{}", now);
  await mirror.idle();
  store.deleteItem(7);
  store.putManualMatch("g1", "Game", 8, now + 1); // a pin takes over the category
  await mirror.idle();
  assert.equal(turso.db.prepare("SELECT COUNT(*) AS n FROM ddd_item_cache").get()!.n, 0);
  assert.equal(turso.db.prepare("SELECT COUNT(*) AS n FROM game_map").get()!.n, 0);

  // A stale auto row in Turso can't override a pin on restore.
  turso.db.prepare("INSERT INTO game_map (twitch_game_id, twitch_name, ddd_item_id, confidence, status, updated_at) VALUES ('g2', 'Other', 1, 1, 'matched', ?)").run(now + 99);
  const fresh = new Store(":memory:");
  fresh.putManualMatch("g2", "Other", 5, now);
  await new CacheMirror({ store: fresh, remote: turso.remote }).restore(now - 30 * DAY);
  assert.equal(fresh.getGameMap("g2")!.source, "manual");
  assert.equal(fresh.getGameMap("g2")!.dddItemId, 5);
});

test("invalid rows in Turso are skipped, not loaded", async () => {
  const turso = fakeTurso();
  await new CacheMirror({ store: new Store(":memory:"), remote: turso.remote }).restore(0); // creates the tables
  const now = Date.now();
  turso.db.prepare("INSERT INTO game_map (twitch_game_id, twitch_name, ddd_item_id, confidence, status, updated_at) VALUES ('g', 'G', 1, 1, 'bogus', ?)").run(now);
  turso.db.prepare("INSERT INTO ddd_item_cache VALUES (5, '', ?)").run(now);
  const fresh = new Store(":memory:");
  const summary = await new CacheMirror({ store: fresh, remote: turso.remote }).restore(now - DAY);
  assert.equal(summary.skipped, 2);
  assert.equal(fresh.getGameMap("g"), undefined);
  assert.equal(fresh.getItem(5), undefined);
});

test("a Turso outage never breaks serving: startup continues empty, writes fail quietly", async () => {
  const turso = fakeTurso();
  turso.state.down = true;
  const { app, up } = await boot(turso); // restore fails -> empty cache, still starts
  const res = await app.inject({ url: "/api/warnings", headers: await auth() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
  assert.ok(up.dddCalls.length > 0);
  await app.close(); // usage flush fails quietly too
});

test("usage counts are saved across restarts and shown on /usage (counts only)", async () => {
  const turso = fakeTurso();
  const first = await boot(turso);
  await first.app.inject({ url: "/api/warnings", headers: await auth() });
  await first.app.inject({ method: "OPTIONS", url: "/api/warnings", headers: { origin: "https://testclientid.ext-twitch.tv", "access-control-request-method": "GET" } });
  await first.app.close(); // flushes

  const second = await boot(turso);
  await second.app.inject({ url: "/api/warnings", headers: await auth() });
  const u = (await second.app.inject({ url: "/usage" })).json();
  assert.equal(u.persisted, true);
  assert.equal(u.totals.wakeups, 2);
  assert.equal(u.totals.viewerRequests, 2);
  assert.equal(u.totals.preflights, 1);
  assert.ok(u.totals.dddRequests > 0);
  assert.ok(u.totals.bytesSent > 0);
  assert.equal(typeof u.cache.savedItems, "number");
  assert.ok(!JSON.stringify(u).includes("12345"), "no channel or viewer identifiers");
  await second.app.close();
});

test("usage counts survive a failed save and go out with the next one", async () => {
  const turso = fakeTurso();
  const usage = new UsageStats();
  const mirror = new CacheMirror({ store: new Store(":memory:"), remote: turso.remote, usage });
  usage.add("viewerRequests", 3);
  turso.state.down = true;
  await assert.rejects(mirror.flushUsage());
  turso.state.down = false;
  usage.add("viewerRequests", 2);
  await mirror.flushUsage();
  const [today] = await mirror.usageHistory();
  assert.equal(today!.counts.viewerRequests, 5);
});

test("a usage table created before a counter existed gets the new column (old rows read 0)", async () => {
  const turso = fakeTurso();
  // The table as the first release created it: no healthChecks column.
  turso.db.exec("CREATE TABLE usage_daily (day TEXT PRIMARY KEY, wakeups INTEGER NOT NULL DEFAULT 0, viewerRequests INTEGER NOT NULL DEFAULT 0, configRequests INTEGER NOT NULL DEFAULT 0, preflights INTEGER NOT NULL DEFAULT 0, eventsubNotifications INTEGER NOT NULL DEFAULT 0, otherRequests INTEGER NOT NULL DEFAULT 0, bytesSent INTEGER NOT NULL DEFAULT 0, dddRequests INTEGER NOT NULL DEFAULT 0)");
  turso.db.exec("INSERT INTO usage_daily (day, otherRequests) VALUES ('2026-10-30', 7)");
  const usage = new UsageStats();
  const mirror = new CacheMirror({ store: new Store(":memory:"), remote: turso.remote, usage });
  usage.add("healthChecks", 4);
  await mirror.flushUsage();
  const history = await mirror.usageHistory();
  const today = history.find((d) => d.day !== "2026-10-30")!;
  const old = history.find((d) => d.day === "2026-10-30")!;
  assert.equal(today.counts.healthChecks, 4);
  assert.equal(old.counts.healthChecks, 0);
  assert.equal(old.counts.otherRequests, 7);
});

test("the host's health checks are counted on their own and left out of data sent", async () => {
  const turso = fakeTurso();
  const { app, usage } = await boot(turso);
  for (let i = 0; i < 3; i++) await app.inject({ url: "/health" });
  const [counts] = [...usage.peek().values()];
  assert.equal(counts!.healthChecks, 3);
  assert.equal(counts!.otherRequests, 0);
  assert.equal(counts!.bytesSent, 0);
  await app.inject({ url: "/api/warnings", headers: await auth() });
  assert.ok([...usage.peek().values()][0]!.bytesSent > 0, "real requests still count bytes");
  await app.close();
});
