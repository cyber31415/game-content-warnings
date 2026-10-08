import { test } from "node:test";
import assert from "node:assert/strict";
import { TTL, WarningsService, isWarningShown } from "../src/warnings.ts";
import { TopicCatalog } from "../src/topics.ts";
import { Corrections } from "../src/corrections.ts";
import { TEST_SECRET_B64, DDD_ITEMS } from "./helpers.ts";
import { testDeps } from "./helpers.ts";

const ORIGINAL_101 = (DDD_ITEMS as Record<number, object>)[101]!;

function service() {
  const d = testDeps();
  let now = 1_000_000_000_000;
  const topics = new TopicCatalog({ store: d.store, ddd: d.ddd, now: () => now });
  const corrections = new Corrections({
    store: d.store,
    helix: d.helix,
    extensionSecret: new Uint8Array(Buffer.from(TEST_SECRET_B64, "base64")),
    ownerId: "1000",
    mode: "local",
  });
  const svc = new WarningsService({ store: d.store, ddd: d.ddd, helix: d.helix, topics, corrections, now: () => now });
  return { ...d, svc, advance: (ms: number) => (now += ms), setNow: (n: number) => (now = n), getNow: () => now };
}

test("threshold: Yes must outnumber No; a single vote counts; ties don't", () => {
  assert.equal(isWarningShown(1, 0), true);
  assert.equal(isWarningShown(3, 2), true);
  assert.equal(isWarningShown(5, 5), false);
  assert.equal(isWarningShown(0, 0), false);
  assert.equal(isWarningShown(1, 4), false);
});

test("ok response: only Yes topics, most-voted first, spoilers excluded, unlisted topics kept", async () => {
  const { svc } = service();
  const r = await svc.forChannel("12345");
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(r.warnings.map((w) => w.topicId), [161, 153, 286, 182]);
  assert.deepEqual(r.warnings[0], { topicId: 161, yes: 30, no: 1 });
  assert.deepEqual(r.extraTopics, { 286: { name: "Someone attempts suicide", group: 55 } });
  assert.ok(r.topicsVersion);
  assert.equal(r.ddd.url, "https://www.doesthedogdie.com/media/101");
  assert.equal(r.matchSource, "auto");
});

test("topic catalogue is fetched once and cached", async () => {
  const { svc, up } = service();
  await svc.topics.get();
  await svc.topics.get();
  assert.equal(up.dddCalls.filter((c) => c.startsWith("/api/v3/topic")).length, 3);
});

test("second request is served from cache without upstream calls", async () => {
  const { svc, up } = service();
  await svc.forChannel("12345");
  const before = [up.dddCalls.length, up.helixCalls.length];
  await svc.forChannel("12345");
  assert.deepEqual([up.dddCalls.length, up.helixCalls.length], before);
});

test("concurrent requests share one upstream lookup", async () => {
  const { svc, up } = service();
  await Promise.all(Array.from({ length: 50 }, () => svc.forChannel("12345")));
  assert.equal(up.helixCalls.filter((c) => c.includes("/channels")).length, 1);
  assert.equal(up.dddCalls.length, 5); // search + item + 3 catalogue requests
});

test("no category -> no_category", async () => {
  const { svc, up } = service();
  up.channelGame = { id: "", name: "" };
  assert.deepEqual(await svc.forChannel("12345"), { status: "no_category" });
});

test("non-game category -> no_match, and the negative result is cached", async () => {
  const { svc, up, advance } = service();
  up.channelGame = { id: "509658", name: "Just Chatting" };
  const r = await svc.forChannel("12345");
  assert.equal(r.status, "no_match");
  const calls = up.dddCalls.length;
  advance(TTL.response + 1);
  await svc.forChannel("12345");
  assert.equal(up.dddCalls.length, calls, "should not search DDD again within the negative TTL");
});

test("a frontend hint that differs from the cached category triggers an early re-check", async () => {
  const { svc, up, advance } = service();
  await svc.forChannel("12345");
  up.channelGame = { id: "2002", name: "Celeste" };
  advance(TTL.channelHintRefresh + 1);
  const same = await svc.forChannel("12345", { hint: "The Last of Us Part I" });
  assert.equal(same.status === "ok" && same.category.name, "The Last of Us Part I");
  const changed = await svc.forChannel("12345", { hint: "Celeste" });
  assert.equal(changed.status === "ok" && changed.category.name, "Celeste");
});

test("EventSub-provided category is used immediately", async () => {
  const { svc } = service();
  await svc.forChannel("12345");
  svc.setChannelGame("12345", { id: "2002", name: "Celeste" });
  const r = await svc.forChannel("12345");
  assert.equal(r.status === "ok" && r.ddd.itemId, 202);
});

test("duplicate DDD listings resolve to the one with more votes", async () => {
  const { svc, up } = service();
  up.channelGame = { id: "491487", name: "Dead by Daylight" };
  const r = await svc.forChannel("12345");
  assert.equal(r.status, "ok");
  assert.equal(r.status === "ok" && r.ddd.itemId, 301);
  assert.equal(r.status === "ok" && r.matchConfidence, 0.95);
});

test("channel override beats the automatic match", async () => {
  const { svc, store } = service();
  store.replaceCorrections("12345", { "1001": 202 });
  const r = await svc.forChannel("12345");
  assert.equal(r.status === "ok" && r.ddd.itemId, 202);
  assert.equal(r.status === "ok" && r.matchSource, "channel");
});

test("a correction only applies to the category it was made for", async () => {
  const { svc, store, up, advance } = service();
  store.replaceCorrections("12345", { "1001": 202 }); // made while playing The Last of Us Part I
  assert.equal(((await svc.forChannel("12345")) as { ddd: { itemId: number } }).ddd.itemId, 202);
  up.channelGame = { id: "491487", name: "Dead by Daylight" }; // streamer switches games
  advance(TTL.channelGame + 1);
  const r = await svc.forChannel("12345");
  assert.equal(r.status === "ok" && r.ddd.itemId, 301, "old correction must not follow the channel to a new game");
});

test("corrections for several categories coexist", async () => {
  const { svc, store, up, advance } = service();
  store.replaceCorrections("12345", { "1001": 202, "491487": 302 });
  assert.equal(((await svc.forChannel("12345")) as { ddd: { itemId: number } }).ddd.itemId, 202);
  up.channelGame = { id: "491487", name: "Dead by Daylight" };
  advance(TTL.channelGame + 1);
  assert.equal(((await svc.forChannel("12345")) as { ddd: { itemId: number } }).ddd.itemId, 302);
});

test("topic catalogue: with DDD down and nothing cached, retries are throttled", async () => {
  const { svc, up } = service();
  up.dddDown = true;
  await assert.rejects(svc.topics.get());
  const calls = up.dddCalls.length;
  await assert.rejects(svc.topics.get());
  assert.equal(up.dddCalls.length, calls, "no new DDD calls within the backoff window");
});

test("purge drops DDD candidate data from stale automatic decisions", async () => {
  const { svc, store, up, getNow } = service();
  up.channelGame = { id: "777", name: "Resident Evil 4" };
  store.putAutoMatch({ twitchGameId: "777", twitchName: "Resident Evil 4", dddItemId: null, confidence: 1, status: "low_confidence", candidatesJson: '[{"id":1,"name":"Resident Evil 4"}]', updatedAt: getNow() - 40 * 24 * 3600_000 });
  store.purgeItemsOlderThan(getNow() - 30 * 24 * 3600_000);
  assert.equal(store.getGameMap("777")?.candidatesJson, "[]");
  assert.ok(svc);
});

test("manual global mapping is never overwritten by the auto matcher", async () => {
  const { svc, store, advance } = service();
  store.putManualMatch("1001", "The Last of Us Part I", 202);
  advance(TTL.matched * 2);
  const r = await svc.forChannel("12345");
  assert.equal(r.status === "ok" && r.ddd.itemId, 202);
  assert.equal(r.status === "ok" && r.matchSource, "manual");
});

test("DDD outage: stale item served up to 30 days, then error", async () => {
  const { svc, up, advance } = service();
  await svc.forChannel("12345");
  up.dddDown = true;
  advance(TTL.item + 1);
  svc.invalidateResponses();
  assert.equal((await svc.forChannel("12345")).status, "ok");
  advance(TTL.itemMaxStale);
  svc.invalidateResponses();
  assert.equal((await svc.forChannel("12345")).status, "error");
});

test("DDD outage with nothing cached -> error status, not an exception", async () => {
  const { svc, up } = service();
  up.dddDown = true;
  assert.deepEqual(await svc.forChannel("12345"), { status: "error" });
});

test("a category lookup that started before an EventSub update can't overwrite it", async () => {
  const d = testDeps();
  let now = 1_000_000_000_000;
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const helix = {
    getChannel: async () => {
      await slow; // still waiting on Twitch when the EventSub notification arrives
      return { broadcaster_id: "12345", broadcaster_name: "x", game_id: "1001", game_name: "The Last of Us Part I" };
    },
  } as never;
  const corrections = new Corrections({ store: d.store, helix, extensionSecret: new Uint8Array(32), ownerId: "1000", mode: "local" });
  const svc = new WarningsService({ store: d.store, ddd: d.ddd, helix, topics: new TopicCatalog({ store: d.store, ddd: d.ddd }), corrections, now: () => now });
  const lookup = svc.channelGame("12345");
  now += 1000;
  svc.setChannelGame("12345", { id: "2002", name: "Celeste" });
  release();
  assert.equal((await lookup).name, "Celeste");
  assert.equal((await svc.channelGame("12345")).name, "Celeste");
});

test("a newer Helix answer isn't discarded because another lookup finished in between", async () => {
  const d = testDeps();
  let now = 1_000_000_000_000;
  const answers = [
    { delay: 30, game: { id: "1001", name: "Old" } }, // slow lookup that started first
    { delay: 0, game: { id: "2002", name: "New" } }, // fresh lookup started later
  ];
  let call = 0;
  const helix = {
    getChannel: async () => {
      const a = answers[call++]!;
      await new Promise((r) => setTimeout(r, a.delay));
      now += 10;
      return { broadcaster_id: "1", broadcaster_name: "x", game_id: a.game.id, game_name: a.game.name };
    },
  } as never;
  const corrections = new Corrections({ store: d.store, helix, extensionSecret: new Uint8Array(32), ownerId: "1000", mode: "local" });
  const svc = new WarningsService({ store: d.store, ddd: d.ddd, helix, topics: new TopicCatalog({ store: d.store, ddd: d.ddd }), corrections, now: () => now });
  const slow = svc.channelGame("1");
  now += 1;
  const fresh = await svc.channelGame("1", undefined, { fresh: true });
  await slow;
  assert.equal(fresh.name, "New");
});

test("a lagging Helix answer right after an EventSub change doesn't revert it", async () => {
  const { svc, up, advance } = service();
  up.channelGame = { id: "1001", name: "The Last of Us Part I" }; // Helix still reports the old game
  svc.setChannelGame("12345", { id: "2002", name: "Celeste" }); // EventSub: switched to Celeste
  advance(2_000);
  const fresh = await svc.channelGame("12345", undefined, { fresh: true }); // e.g. a correction save
  assert.equal(fresh.name, "Celeste");
  advance(TTL.eventTrust); // after the trust window, Helix is believed again
  assert.equal((await svc.channelGame("12345", undefined, { fresh: true })).name, "The Last of Us Part I");
});

test("a response built from a nearly 30-day-old stale item isn't cached past 30 days", async () => {
  const { svc, store, up, setNow, getNow } = service();
  await svc.forChannel("12345"); // caches item 101
  const fetchedAt = store.getItem(101)!.fetchedAt;
  up.dddDown = true;
  setNow(fetchedAt + TTL.itemMaxStale - 10_000); // 10 s before the item turns 30 days old
  svc.invalidateResponses();
  assert.equal((await svc.forChannel("12345")).status, "ok"); // still within 30 days: served stale
  setNow(getNow() + 11_000); // now past 30 days: the cached response must not be reused
  assert.equal((await svc.forChannel("12345")).status, "error");
});

test("pruneCaches drops expired responses and stale channel entries", async () => {
  const { svc, advance } = service();
  await svc.forChannel("12345");
  advance(TTL.channelTouch + 1);
  svc.pruneCaches();
  const internals = svc as unknown as { responses: Map<string, unknown>; channelGames: Map<string, unknown>; touched: Map<string, unknown> };
  assert.equal(internals.responses.size, 0);
  assert.equal(internals.channelGames.size, 0);
  assert.equal(internals.touched.size, 0);
});

test("a deleted DDD item isn't re-requested on every view (quota protection)", async () => {
  const { svc, store, up } = service();
  store.replaceCorrections("12345", { "1001": 999 }); // correction points at an item DDD no longer has
  const first = await svc.forChannel("12345");
  assert.equal(first.status === "ok" && first.ddd.itemId, 101, "falls back to the automatic match");
  const calls = up.dddCalls.filter((c) => c.endsWith("/items/999")).length;
  svc.invalidateResponses();
  await svc.forChannel("12345");
  await svc.forChannel("12345");
  assert.equal(up.dddCalls.filter((c) => c.endsWith("/items/999")).length, calls, "no new requests for the missing item");
});

test("an automatic match whose DDD item disappeared is dropped and re-matched later", async () => {
  const { svc, store, up } = service();
  store.putAutoMatch({ twitchGameId: "1001", twitchName: "The Last of Us Part I", dddItemId: 999, confidence: 1, status: "matched", candidatesJson: "[]", updatedAt: Date.now() });
  const r = await svc.forChannel("12345");
  assert.equal(r.status, "no_match");
  assert.equal(store.getGameMap("1001"), undefined, "stale auto decision removed");
  assert.ok(up);
});

test("a merged/deleted duplicate listing doesn't break the match; the surviving one is used", async () => {
  const { svc, up, advance } = service();
  up.channelGame = { id: "555", name: "Duplicate with a merged listing" }; // DDD: 301 exists, 999 is gone
  const r = await svc.forChannel("12345");
  assert.equal(r.status === "ok" && r.ddd.itemId, 301);
  const searches = up.dddCalls.filter((c) => c.startsWith("/api/v3/items?")).length;
  advance(TTL.response + 1);
  await svc.forChannel("12345");
  assert.equal(up.dddCalls.filter((c) => c.startsWith("/api/v3/items?")).length, searches, "no re-search");
});

test("a failed match isn't re-searched on every request", async () => {
  const { svc, up } = service();
  up.channelGame = { id: "777", name: "Celeste" };
  up.dddDown = true;
  assert.equal((await svc.forChannel("12345")).status, "error");
  const calls = up.dddCalls.length;
  await svc.forChannel("12345");
  await svc.forChannel("12345");
  assert.equal(up.dddCalls.length, calls, "backoff: no new DDD calls");
});

test("an item DDD deleted after we cached it is dropped, not served stale", async () => {
  const { svc, store, up, advance } = service();
  await svc.forChannel("12345"); // caches item 101 via the auto match
  assert.ok(store.getItem(101));
  delete (DDD_ITEMS as Record<number, object>)[101]; // DDD deletes/merges it
  try {
    advance(TTL.item + 1); // our copy is due for a refresh
    svc.invalidateResponses();
    const r = await svc.forChannel("12345");
    assert.notEqual(r.status === "ok" && r.ddd.itemId, 101, "deleted entry must not be served");
    assert.equal(store.getItem(101), undefined, "cached copy removed");
    assert.ok(up);
  } finally {
    (DDD_ITEMS as Record<number, object>)[101] = ORIGINAL_101;
  }
});
