import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { signEventSub } from "../src/twitch/eventsub.ts";
import { signViewerToken, testConfig, testDeps } from "./helpers.ts";

const EVENTSUB = { EVENTSUB_CALLBACK_URL: "https://ebs.example/eventsub", EVENTSUB_SECRET: "eventsub-secret-123" };

async function app(overrides: Record<string, string> = {}) {
  const d = testDeps(overrides);
  return { app: await buildServer(d), ...d };
}
const auth = async (claims: Record<string, unknown> = {}) => ({ authorization: `Bearer ${await signViewerToken(claims)}` });

test("GET /health", async () => {
  const { app: a } = await app();
  const res = await a.inject({ url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test("API rejects missing, expired and forged tokens", async () => {
  const { app: a } = await app();
  assert.equal((await a.inject({ url: "/api/warnings" })).statusCode, 401);
  const expired = await signViewerToken({}, { expSeconds: -10 });
  assert.equal((await a.inject({ url: "/api/warnings", headers: { authorization: `Bearer ${expired}` } })).statusCode, 401);
  const forged = await signViewerToken({}, { secretB64: Buffer.from("x".repeat(32)).toString("base64") });
  assert.equal((await a.inject({ url: "/api/warnings", headers: { authorization: `Bearer ${forged}` } })).statusCode, 401);
});

test("GET /api/warnings uses the channel from the token, never the query", async () => {
  const { app: a, up } = await app();
  const res = await a.inject({ url: "/api/warnings?channel_id=999", headers: await auth({ channel_id: "12345" }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
  assert.ok(up.helixCalls.some((c) => c.includes("broadcaster_id=12345")));
  assert.ok(!up.helixCalls.some((c) => c.includes("999")));
});

test("broadcaster endpoints refuse viewers", async () => {
  const { app: a } = await app();
  const res = await a.inject({ url: "/api/broadcaster/config", headers: await auth({ role: "viewer" }) });
  assert.equal(res.statusCode, 403);
});

test("broadcaster can set and clear an override", async () => {
  const { app: a } = await app();
  const headers = await auth({ role: "broadcaster" });
  const put = await a.inject({ method: "PUT", url: "/api/broadcaster/override", headers, payload: { dddItemId: 202 } });
  assert.equal(put.statusCode, 200);
  const w = (await a.inject({ url: "/api/warnings", headers: await auth() })).json();
  assert.equal(w.ddd.itemId, 202);
  const bad = await a.inject({ method: "PUT", url: "/api/broadcaster/override", headers, payload: { dddItemId: 999999 } });
  assert.equal(bad.statusCode, 422);
  const clear = await a.inject({ method: "PUT", url: "/api/broadcaster/override", headers, payload: { dddItemId: null } });
  assert.equal(clear.statusCode, 200);
  assert.equal((await a.inject({ url: "/api/warnings", headers: await auth() })).json().ddd.itemId, 101);
});

test("a correction can't be saved while the channel has no category", async () => {
  const { app: a, up } = await app();
  up.channelGame = { id: "", name: "" };
  const res = await a.inject({ method: "PUT", url: "/api/broadcaster/override", headers: await auth({ role: "broadcaster" }), payload: { dddItemId: 202 } });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /Stream Manager/);
});

test("broadcaster override rejects junk", async () => {
  const { app: a } = await app();
  const headers = await auth({ role: "broadcaster" });
  for (const payload of [{ dddItemId: -1 }, { dddItemId: 1.5 }, { dddItemId: "7" }, {}]) {
    const res = await a.inject({ method: "PUT", url: "/api/broadcaster/override", headers, payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test("broadcaster search returns games first", async () => {
  const { app: a } = await app();
  const res = await a.inject({ url: "/api/broadcaster/search?q=the%20last%20of%20us%20part%20i", headers: await auth({ role: "broadcaster" }) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().map((r: { isVideoGame: boolean }) => r.isVideoGame), [true, true, false]);
});

test("CORS only allows the extension origin", async () => {
  const { app: a } = await app();
  const ok = await a.inject({ url: "/health", headers: { origin: "https://testclientid.ext-twitch.tv" } });
  assert.equal(ok.headers["access-control-allow-origin"], "https://testclientid.ext-twitch.tv");
  const bad = await a.inject({ url: "/health", headers: { origin: "https://evil.example" } });
  assert.equal(bad.headers["access-control-allow-origin"], undefined);
});

test("EventSub endpoint is absent unless configured", async () => {
  const { app: a } = await app();
  assert.equal((await a.inject({ method: "POST", url: "/eventsub", payload: {} })).statusCode, 404);
});

function eventsubRequest(type: string, body: object, id = "m-" + Math.random()) {
  const raw = JSON.stringify(body);
  const ts = new Date().toISOString();
  return {
    method: "POST" as const,
    url: "/eventsub",
    payload: raw,
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": id,
      "twitch-eventsub-message-timestamp": ts,
      "twitch-eventsub-message-type": type,
      "twitch-eventsub-message-signature": signEventSub(EVENTSUB.EVENTSUB_SECRET, id, ts, raw),
    },
  };
}

test("EventSub challenge is echoed as plain text", async () => {
  const { app: a } = await app(EVENTSUB);
  const res = await a.inject(eventsubRequest("webhook_callback_verification", { challenge: "abc123", subscription: {} }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "abc123");
  assert.match(String(res.headers["content-type"]), /text\/plain/);
});

test("EventSub rejects bad signatures", async () => {
  const { app: a } = await app(EVENTSUB);
  const req = eventsubRequest("notification", {});
  req.headers["twitch-eventsub-message-signature"] = "sha256=00";
  assert.equal((await a.inject(req)).statusCode, 403);
});

test("category change notification -> warnings recomputed and broadcast over PubSub", async () => {
  const { app: a, up, fetch } = await app(EVENTSUB);
  const res = await a.inject(
    eventsubRequest("notification", {
      subscription: { id: "sub-1", type: "channel.update" },
      event: { broadcaster_user_id: "12345", category_id: "2002", category_name: "Celeste", title: "t" },
    }),
  );
  assert.equal(res.statusCode, 204);
  for (let i = 0; i < 50 && !up.helixCalls.some((c) => c.includes("/extensions/pubsub")); i++) await new Promise((r) => setTimeout(r, 10));
  const call = fetch.calls.find((c) => c.url.endsWith("/extensions/pubsub"))!;
  assert.ok(call, "PubSub message sent");
  const body = JSON.parse(String(call.init!.body));
  assert.deepEqual(body.target, ["broadcast"]);
  assert.equal(body.broadcaster_id, "12345");
  const msg = JSON.parse(body.message);
  assert.equal(msg.type, "warnings");
  assert.equal(msg.data.category.name, "Celeste");
  // Authenticated with an EBS-signed external JWT, not the app token.
  assert.notEqual((call.init!.headers as Record<string, string>).Authorization, "Bearer apptoken");
});

test("first viewer request from a channel subscribes it to channel.update", async () => {
  const { app: a, up } = await app(EVENTSUB);
  await a.inject({ url: "/api/warnings", headers: await auth() });
  for (let i = 0; i < 50 && !up.helixCalls.some((c) => c.startsWith("POST /eventsub")); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(up.helixCalls.some((c) => c === "POST /eventsub/subscriptions"));
});

test("privacy and terms pages render with the configured contact", async () => {
  const { app: a } = await app({ CONTACT_EMAIL: "owner@example.com", EXT_NAME: "Test Warnings" });
  for (const path of ["/privacy", "/terms"]) {
    const res = await a.inject({ url: path });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/html/);
    assert.match(res.body, /owner@example\.com/);
    assert.match(res.body, /Test Warnings/);
  }
  assert.match((await a.inject({ url: "/terms" })).body, /absence of a warning never means/);
});

test("curated manual mappings are applied at startup", async () => {
  const { store } = await app();
  const row = store.getGameMap("778386489");
  assert.equal(row?.source, "manual");
  assert.equal(row?.dddItemId, 14438);
});

test("on Render, the EventSub callback defaults to the service's public URL", () => {
  const c = testConfig({ EVENTSUB_SECRET: "a-long-random-secret", RENDER_EXTERNAL_URL: "https://cw.onrender.com" });
  assert.deepEqual(c.eventsub, { callbackUrl: "https://cw.onrender.com/eventsub", secret: "a-long-random-secret" });
  assert.throws(() => testConfig({ EVENTSUB_SECRET: "a-long-random-secret" }), /no public callback/);
});

test("config validation", () => {
  assert.throws(() => testConfig({ NODE_ENV: "production" }), /CONTACT_EMAIL/);
  assert.throws(() => testConfig({ TWITCH_EXT_SECRET: "not base64!" }), /base64/);
  assert.throws(() => testConfig({ EVENTSUB_CALLBACK_URL: "https://x/eventsub" }), /both/);
});
