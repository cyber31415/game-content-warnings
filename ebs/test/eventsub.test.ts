import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplayGuard, signEventSub, verifyEventSub } from "../src/twitch/eventsub.ts";

const secret = "0123456789abcdef";
function headers(body: string, opts: { ts?: string; sig?: string; type?: string } = {}) {
  const id = "msg-1";
  const ts = opts.ts ?? new Date().toISOString();
  return {
    "twitch-eventsub-message-id": id,
    "twitch-eventsub-message-timestamp": ts,
    "twitch-eventsub-message-signature": opts.sig ?? signEventSub(secret, id, ts, body),
    "twitch-eventsub-message-type": opts.type ?? "notification",
  };
}

test("accepts a correctly signed, fresh message", () => {
  const body = '{"a":1}';
  assert.deepEqual(verifyEventSub(secret, headers(body), body), { ok: true, messageId: "msg-1", messageType: "notification" });
});

test("rejects a tampered body", () => {
  const h = headers('{"a":1}');
  assert.equal(verifyEventSub(secret, h, '{"a":2}').ok, false);
});

test("rejects a wrong secret", () => {
  const body = "{}";
  assert.equal(verifyEventSub("another-secret!!", headers(body), body).ok, false);
});

test("rejects stale timestamps (replay window)", () => {
  const body = "{}";
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  assert.deepEqual(verifyEventSub(secret, headers(body, { ts: old }), body), { ok: false, reason: "stale timestamp" });
});

test("rejects missing headers", () => {
  assert.equal(verifyEventSub(secret, {}, "{}").ok, false);
});

test("replay guard drops duplicate message ids", () => {
  const g = new ReplayGuard();
  assert.equal(g.firstTime("a"), true);
  assert.equal(g.firstTime("a"), false);
  assert.equal(g.firstTime("b"), true);
});

import { LiveUpdates } from "../src/live.ts";
import { HelixClient, AppTokenManager } from "../src/twitch/helix.ts";
import { fakeFetch, json } from "./helpers.ts";

test("an error result is never broadcast over viewers' good data", async () => {
  const sent: string[] = [];
  const live = new LiveUpdates({
    store: {} as never,
    helix: { sendExtensionBroadcast: async (_j: string, _c: string, m: string) => void sent.push(m) } as never,
    warnings: { forChannel: async () => ({ status: "error" }) } as never,
    extensionSecret: new Uint8Array(32),
    ownerId: "1000",
    log: { info() {}, warn() {} },
  });
  await live.broadcastCurrent("12345");
  assert.deepEqual(sent, []);
});

test("broadcasts for one channel run in order", async () => {
  const sent: string[] = [];
  let n = 0;
  const live = new LiveUpdates({
    store: {} as never,
    helix: { sendExtensionBroadcast: async (_j: string, _c: string, m: string) => void sent.push(JSON.parse(m).data.category.name) } as never,
    // First lookup is slow, second fast: order must still be preserved.
    warnings: {
      forChannel: async () => {
        const i = ++n;
        await new Promise((r) => setTimeout(r, i === 1 ? 50 : 0));
        return { status: "no_match", category: { id: String(i), name: `game${i}` } };
      },
    } as never,
    extensionSecret: new Uint8Array(32),
    ownerId: "1000",
    log: { info() {}, warn() {} },
  });
  await Promise.all([live.broadcastCurrent("1"), live.broadcastCurrent("1")]);
  assert.deepEqual(sent, ["game1", "game2"]);
});

test("an existing subscription is found after a 409 by filtering on user only", async () => {
  const tokens = new AppTokenManager({ clientId: "c", clientSecret: "s", tokenUrl: "https://id/token", fetchFn: fakeFetch(() => json({ access_token: "t", expires_in: 3600, token_type: "bearer" })).fn });
  const f = fakeFetch((url, init) => {
    if (init?.method === "POST") return json({ message: "conflict" }, 409);
    assert.ok(!url.includes("type="), "must not combine filters");
    return json({ data: [{ id: "other", type: "stream.online", status: "enabled" }, { id: "sub-9", type: "channel.update", status: "enabled" }] });
  });
  const helix = new HelixClient({ clientId: "c", apiBase: "https://api/helix", tokens, fetchFn: f.fn });
  assert.equal(await helix.subscribeChannelUpdate("42", "https://x/eventsub", "secret-123456"), "sub-9");
});

function verifyHarness(helixGames: string[]) {
  const sent: string[] = [];
  let cached = "";
  let helixCall = 0;
  const live = new LiveUpdates({
    store: {} as never,
    helix: {
      sendExtensionBroadcast: async (_j: string, _c: string, m: string) => void sent.push(JSON.parse(m).data.category.name),
      getChannel: async () => {
        const name = helixGames[Math.min(helixCall++, helixGames.length - 1)]!;
        return { broadcaster_id: "1", broadcaster_name: "x", game_id: name, game_name: name };
      },
    } as never,
    warnings: {
      setChannelGame: (_c: string, g: { name: string }) => void (cached = g.name),
      forChannel: async () => ({ status: "no_match", category: { id: cached, name: cached } }),
    } as never,
    extensionSecret: new Uint8Array(32),
    ownerId: "1000",
    log: { info() {}, warn() {} },
    verifyDelayMs: 0,
  });
  return { live, sent };
}
const settle = async (sent: string[], n: number) => {
  for (let i = 0; i < 300 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10)); // broadcasts are spaced 1.5 s apart
  await new Promise((r) => setTimeout(r, 50));
};

test("a retried old channel.update is corrected once Helix disagrees twice", async () => {
  const { live, sent } = verifyHarness(["B", "B"]);
  await live.onCategoryChange("1", { id: "A", name: "A" }); // stale retry; the channel really plays B
  await settle(sent, 2);
  assert.deepEqual(sent, ["A", "B"]);
});

test("Helix briefly lagging behind EventSub doesn't revert a new category", async () => {
  const { live, sent } = verifyHarness(["Old", "New"]); // first check still sees the old game
  await live.onCategoryChange("1", { id: "New", name: "New" });
  await settle(sent, 2);
  assert.deepEqual(sent, ["New"]);
});

test("a failed subscription blocking a new one is replaced, never reported as active", async () => {
  const tokens = new AppTokenManager({ clientId: "c", clientSecret: "s", tokenUrl: "https://id/token", fetchFn: fakeFetch(() => json({ access_token: "t", expires_in: 3600, token_type: "bearer" })).fn });
  let posts = 0;
  const deleted: string[] = [];
  const f = fakeFetch((url, init) => {
    if (init?.method === "POST") return ++posts === 1 ? json({ message: "conflict" }, 409) : json({ data: [{ id: "sub-new" }] }, 202);
    if (init?.method === "DELETE") {
      deleted.push(new URL(url).searchParams.get("id")!);
      return new Response(null, { status: 204 });
    }
    return json({ data: [{ id: "sub-dead", type: "channel.update", status: "webhook_callback_verification_failed" }] });
  });
  const helix = new HelixClient({ clientId: "c", apiBase: "https://api/helix", tokens, fetchFn: f.fn });
  assert.equal(await helix.subscribeChannelUpdate("42", "https://x/eventsub", "secret-123456"), "sub-new");
  assert.deepEqual(deleted, ["sub-dead"]);
});
