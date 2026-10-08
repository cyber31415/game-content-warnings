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
