import { test } from "node:test";
import assert from "node:assert/strict";
import { DddClient, DddError, DDD_USER_AGENT } from "../src/ddd/client.ts";
import { fakeFetch, json } from "./helpers.ts";

test("sends API key and a non-generic User-Agent (DDD blocks default UAs)", async () => {
  const f = fakeFetch(() => json([]));
  const c = new DddClient({ apiKey: "KEY", apiBase: "https://ddd", fetchFn: f.fn });
  await c.search("celeste");
  const h = f.calls[0]!.init!.headers as Record<string, string>;
  assert.equal(h["X-API-KEY"], "KEY");
  assert.equal(h["User-Agent"], DDD_USER_AGENT);
  assert.equal(f.calls[0]!.url, "https://ddd/api/v3/items?q=celeste");
});

test("tracks monthly budget from rate-limit headers", async () => {
  const f = fakeFetch(() => new Response("[]", { headers: { "x-ratelimit-remaining-month": "4321", "x-ratelimit-limit-month": "5000" } }));
  const c = new DddClient({ apiKey: "k", apiBase: "https://ddd", fetchFn: f.fn });
  await c.search("x");
  assert.equal(c.budget.remainingMonth, 4321);
  assert.equal(c.budget.limitMonth, 5000);
});

test("429 opens a local circuit until Retry-After", async () => {
  let now = 0;
  const f = fakeFetch(() => new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { status: 429, headers: { "retry-after": "30" } }));
  const c = new DddClient({ apiKey: "k", apiBase: "https://ddd", fetchFn: f.fn, now: () => now, sleep: async () => {} });
  await assert.rejects(c.search("x"), (e: DddError) => e.code === "rate_limit_exceeded");
  await assert.rejects(c.search("x"), (e: DddError) => e.code === "rate_limited_local");
  assert.equal(f.calls.length, 1);
  now = 31_000;
  await assert.rejects(c.search("x"), (e: DddError) => e.code === "rate_limit_exceeded");
  assert.equal(f.calls.length, 2);
});

test("spaces requests to respect the per-minute limit (no burst)", async () => {
  const waits: number[] = [];
  const c = new DddClient({ apiKey: "k", apiBase: "https://ddd", fetchFn: fakeFetch(() => json([])).fn, perMinute: 20, burst: 1, now: () => 0, sleep: async (ms) => void waits.push(ms) });
  await Promise.all([c.search("a"), c.search("b"), c.search("c")]);
  assert.deepEqual(waits, [3000, 6000]);
});

test("allows a small burst, then spaces the rest", async () => {
  const waits: number[] = [];
  const c = new DddClient({ apiKey: "k", apiBase: "https://ddd", fetchFn: fakeFetch(() => json([])).fn, perMinute: 20, burst: 5, now: () => 0, sleep: async (ms) => void waits.push(ms) });
  await Promise.all(Array.from({ length: 7 }, (_, i) => c.search(String(i))));
  assert.deepEqual(waits, [3000, 6000]); // first 5 immediately
});

test("validates responses and rejects bad item ids", async () => {
  const c = new DddClient({ apiKey: "k", apiBase: "https://ddd", fetchFn: fakeFetch(() => json({ nope: true })).fn });
  await assert.rejects(c.getItem(5));
  await assert.rejects(c.getItem(-1), RangeError);
});

test("retries once on a transient 502 from DDD", async () => {
  let n = 0;
  const f = fakeFetch(() => (++n === 1 ? json({ error: "bad_gateway" }, 502) : json([{ id: 1, name: "Celeste" }])));
  const c = new DddClient({ apiKey: "k", apiBase: "https://ddd", fetchFn: f.fn, sleep: async () => {} });
  assert.equal((await c.search("celeste"))[0]!.name, "Celeste");
  assert.equal(f.calls.length, 2);
});

test("gives up after the retry if DDD is still failing", async () => {
  const f = fakeFetch(() => json({ error: "bad_gateway" }, 502));
  const c = new DddClient({ apiKey: "k", apiBase: "https://ddd", fetchFn: f.fn, sleep: async () => {} });
  await assert.rejects(c.search("x"), (e: DddError) => e.status === 502);
  assert.equal(f.calls.length, 2);
});
