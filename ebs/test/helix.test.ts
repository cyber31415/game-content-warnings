import { test } from "node:test";
import assert from "node:assert/strict";
import { AppTokenManager, HelixClient } from "../src/twitch/helix.ts";
import { fakeFetch, json } from "./helpers.ts";

function tokenServer() {
  let n = 0;
  return fakeFetch(() => json({ access_token: `tok${++n}`, expires_in: 3600, token_type: "bearer" }));
}

test("token manager caches the token until near expiry", async () => {
  let now = 0;
  const f = tokenServer();
  const m = new AppTokenManager({ clientId: "c", clientSecret: "s", tokenUrl: "https://id/oauth2/token", fetchFn: f.fn, now: () => now });
  assert.equal(await m.getToken(), "tok1");
  now = 3000 * 1000;
  assert.equal(await m.getToken(), "tok1");
  now = 3500 * 1000; // inside the 5 minute refresh margin
  assert.equal(await m.getToken(), "tok2");
  assert.equal(f.calls.length, 2);
  const body = new URLSearchParams(String(f.calls[0]!.init!.body));
  assert.equal(body.get("grant_type"), "client_credentials");
  assert.equal(f.calls[0]!.url, "https://id/oauth2/token");
});

test("token manager de-duplicates concurrent refreshes", async () => {
  const f = tokenServer();
  const m = new AppTokenManager({ clientId: "c", clientSecret: "s", tokenUrl: "https://id/oauth2/token", fetchFn: f.fn });
  const tokens = await Promise.all([m.getToken(), m.getToken(), m.getToken()]);
  assert.deepEqual(tokens, ["tok1", "tok1", "tok1"]);
  assert.equal(f.calls.length, 1);
});

test("token manager surfaces auth failures", async () => {
  const f = fakeFetch(() => json({ message: "invalid client secret" }, 403));
  const m = new AppTokenManager({ clientId: "c", clientSecret: "bad", tokenUrl: "https://id/oauth2/token", fetchFn: f.fn });
  await assert.rejects(m.getToken(), /HTTP 403/);
});

test("helix getChannel sends Client-Id + bearer and parses the channel", async () => {
  const tokens = new AppTokenManager({ clientId: "c", clientSecret: "s", tokenUrl: "https://id/oauth2/token", fetchFn: tokenServer().fn });
  const f = fakeFetch(() =>
    json({ data: [{ broadcaster_id: "42", broadcaster_name: "x", game_id: "509658", game_name: "Just Chatting", title: "hi" }] }),
  );
  const helix = new HelixClient({ clientId: "c", apiBase: "https://api/helix", tokens, fetchFn: f.fn });
  const ch = await helix.getChannel("42");
  assert.equal(ch?.game_name, "Just Chatting");
  assert.equal(f.calls[0]!.url, "https://api/helix/channels?broadcaster_id=42");
  const headers = f.calls[0]!.init!.headers as Record<string, string>;
  assert.equal(headers["Client-Id"], "c");
  assert.equal(headers.Authorization, "Bearer tok1");
});

test("helix retries once with a fresh token on 401", async () => {
  const tokens = new AppTokenManager({ clientId: "c", clientSecret: "s", tokenUrl: "https://id/oauth2/token", fetchFn: tokenServer().fn });
  let calls = 0;
  const f = fakeFetch(() => (++calls === 1 ? json({}, 401) : json({ data: [{ id: "1", name: "Celeste", igdb_id: "26226" }] })));
  const helix = new HelixClient({ clientId: "c", apiBase: "https://api/helix", tokens, fetchFn: f.fn });
  const game = await helix.getGame("1");
  assert.equal(game?.igdb_id, "26226");
  const second = f.calls[1]!.init!.headers as Record<string, string>;
  assert.equal(second.Authorization, "Bearer tok2");
});

test("helix getGame tolerates categories without igdb_id", async () => {
  const tokens = new AppTokenManager({ clientId: "c", clientSecret: "s", tokenUrl: "https://id/oauth2/token", fetchFn: tokenServer().fn });
  const f = fakeFetch(() => json({ data: [{ id: "509658", name: "Just Chatting", box_art_url: "" }] }));
  const helix = new HelixClient({ clientId: "c", apiBase: "https://api/helix", tokens, fetchFn: f.fn });
  assert.equal((await helix.getGame("509658"))?.igdb_id, "");
});
