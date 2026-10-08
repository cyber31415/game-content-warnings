import { test } from "node:test";
import assert from "node:assert/strict";
import { TTL, WarningsService, isWarningShown } from "../src/warnings.ts";
import { TopicCatalog } from "../src/topics.ts";
import { Corrections } from "../src/corrections.ts";
import { TEST_SECRET_B64 } from "./helpers.ts";
import { testDeps } from "./helpers.ts";

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
