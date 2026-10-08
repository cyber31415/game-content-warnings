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

test("an older (re)delivered channel.update can't undo a newer one", async () => {
  const applied: string[] = [];
  const live = new LiveUpdates({
    store: {} as never,
    helix: { sendExtensionBroadcast: async () => {} } as never,
    warnings: { setChannelGame: (_c: string, g: { name: string }) => void applied.push(g.name), forChannel: async () => ({ status: "error" }) } as never,
    extensionSecret: new Uint8Array(32),
    ownerId: "1000",
    log: { info() {}, warn() {} },
  });
  await live.onCategoryChange("1", { id: "2", name: "B" }, 2_000);
  await live.onCategoryChange("1", { id: "1", name: "A" }, 1_000); // redelivered older event
  assert.deepEqual(applied, ["B"]);
});
