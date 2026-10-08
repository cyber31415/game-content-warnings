// Tests against REAL DoesTheDogDie v3 responses captured by scripts/capture-ddd-fixtures.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DddItemDetailSchema, DddSearchResponseSchema } from "../src/ddd/schema.ts";
import { rankCandidates } from "../src/match/matcher.ts";
import { toWarnings } from "../src/warnings.ts";
import { LiveUpdates, PUBSUB_MAX_BYTES } from "../src/live.ts";
import { buildDictionary, fallbackGroup } from "../src/topics.ts";
import { DddTopicCategorySchema, DddTopicSchema, DddTopicSuperCategorySchema } from "../src/ddd/schema.ts";
import { TEST_SECRET_B64, fixture as load, hasRealFixtures } from "./helpers.ts";


if (!hasRealFixtures) {
  test("real DDD fixture tests", { skip: "missing or older than 30 days: run scripts/capture-ddd-fixtures.ts with your DDD key" }, () => {});
} else {
  const dict = buildDictionary(
    {
      topics: DddTopicSchema.array().parse(load("topics")),
      categories: DddTopicCategorySchema.array().parse(load("topiccategories")),
      superCategories: DddTopicSuperCategorySchema.array().parse(load("topicsupercategories")),
    },
    0,
  );
  const tlou = DddSearchResponseSchema.parse(load("search-the-last-of-us"));
  const celeste = DddSearchResponseSchema.parse(load("search-celeste"));
  const tlouItem = DddItemDetailSchema.parse(load("item-14438"));

  test("real responses validate against our schemas", () => {
    assert.ok(tlou.length > 5);
    assert.equal(DddItemDetailSchema.parse(load("item-17871")).name, "Celeste");
    assert.ok(tlouItem.topicItemStats.length > 100);
    const types = load("itemtypes") as { id: number; name: string }[];
    assert.ok(types.some((t) => t.name === "Video Game"), "itemTypeName for games is 'Video Game'");
  });

  test("matches the game, not the TV show or films of the same name", () => {
    const r = rankCandidates("The Last of Us", tlou);
    assert.equal(r.status, "matched");
    assert.equal(r.dddItemId, 14438);
  });

  test("sequel matches despite DDD's different capitalisation", () => {
    const r = rankCandidates("The Last of Us Part II", tlou);
    assert.equal(r.dddItemId, 685218);
  });

  test("the 2022 remake ('Part I') is not silently mapped to the 2013 original", () => {
    assert.notEqual(rankCandidates("The Last of Us Part I", tlou).status, "matched");
  });

  test("Celeste matches its game entry among 21 results", () => {
    assert.equal(rankCandidates("Celeste", celeste).dddItemId, 17871);
  });

  test("catalogue: 11 broad categories, Other last, spoiler topics excluded", () => {
    assert.equal(dict.groups.length, 11);
    assert.equal(dict.groups.at(-1)!.name, "Other");
    assert.ok(dict.excluded.includes(222)); // "the ending is sad"
    assert.equal(dict.topics[222], undefined);
    assert.equal(dict.topics[153]!.group, 54); // a dog dies -> Animals
    assert.ok(dict.topics[153]!.keywords.length > 0);
  });

  test("real item: only Yes topics, most-voted first", () => {
    const { warnings: w } = toWarnings(tlouItem, dict);
    assert.ok(w.length > 50 && w.length < tlouItem.topicItemStats.length);
    assert.ok(w.every((x) => x.yes > x.no));
    for (let i = 1; i < w.length; i++) assert.ok(w[i - 1]!.yes >= w[i]!.yes);
  });

  test("topics missing from DDD's catalogue are kept and grouped by keyword", () => {
    const { extraTopics } = toWarnings(tlouItem, dict);
    assert.deepEqual(
      Object.fromEntries(Object.entries(extraTopics).map(([id, t]) => [id, t.group])),
      { 252: 54, 267: 59, 281: 59, 286: 55, 326: 51 }, // dead animal, excessive gore, asphyxiates, attempts suicide, sexual assault mentioned
    );
    assert.equal(fallbackGroup("someone overdoses"), 55);
    assert.equal(fallbackGroup("a mysterious new topic"), 60);
  });

  test("a large real game (87 Yes topics) still fits in one PubSub message", async () => {
    const { warnings, extraTopics } = toWarnings(tlouItem, dict);
    const msg = JSON.stringify({ type: "warnings", data: { status: "ok", category: { id: "1", name: "The Last of Us" }, ddd: { itemId: 14438, name: "The Last of Us", url: "https://www.doesthedogdie.com/media/14438" }, matchConfidence: 1, matchSource: "auto", warnings, extraTopics, topicsVersion: "1", fetchedAt: new Date().toISOString() } });
    assert.ok(Buffer.byteLength(msg) < PUBSUB_MAX_BYTES, `${Buffer.byteLength(msg)} bytes`);
  });

  test("an oversized payload falls back to a 'refresh' broadcast", async () => {
    const data = {
      status: "ok" as const,
      category: { id: "1", name: "The Last of Us" },
      ddd: { itemId: 14438, name: tlouItem.name, url: "https://www.doesthedogdie.com/media/14438" },
      matchConfidence: 1,
      matchSource: "auto" as const,
      warnings: Array.from({ length: 400 }, (_, i) => ({ topicId: 100000 + i, yes: 1000, no: 0 })),
      extraTopics: {},
      topicsVersion: "1",
      fetchedAt: new Date().toISOString(),
    };
    assert.ok(Buffer.byteLength(JSON.stringify({ type: "warnings", data })) > PUBSUB_MAX_BYTES);
    const sent: string[] = [];
    const live = new LiveUpdates({
      store: {} as never,
      helix: { sendExtensionBroadcast: async (_jwt: string, _ch: string, msg: string) => void sent.push(msg) } as never,
      warnings: { forChannel: async () => data } as never,
      extensionSecret: new Uint8Array(Buffer.from(TEST_SECRET_B64, "base64")),
      ownerId: "1000",
      log: { info() {}, warn() {} },
    });
    await live.broadcastCurrent("12345");
    assert.deepEqual(sent.map((m) => JSON.parse(m)), [{ type: "refresh" }]);
  });
}
