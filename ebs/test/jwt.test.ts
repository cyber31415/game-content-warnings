import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyExtensionJwt, extractToken, signEbsJwt, AuthError } from "../src/auth/jwt.ts";
import { signViewerToken, TEST_SECRET_B64 } from "./helpers.ts";

const secret = new Uint8Array(Buffer.from(TEST_SECRET_B64, "base64"));

test("accepts a valid viewer token", async () => {
  const claims = await verifyExtensionJwt(await signViewerToken(), secret);
  assert.equal(claims.channel_id, "12345");
  assert.equal(claims.role, "viewer");
});

test("rejects an expired token", async () => {
  const token = await signViewerToken({}, { expSeconds: -60 });
  await assert.rejects(verifyExtensionJwt(token, secret), (e: Error) => e instanceof AuthError && /expired/.test(e.message));
});

test("rejects a token signed with another secret (forged)", async () => {
  const token = await signViewerToken({}, { secretB64: Buffer.from("some-other-secret-value-32-bytes").toString("base64") });
  await assert.rejects(verifyExtensionJwt(token, secret), AuthError);
});

test("rejects alg=none", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ channel_id: "1", opaque_user_id: "U", role: "broadcaster", exp: 9999999999 })).toString("base64url");
  await assert.rejects(verifyExtensionJwt(`${header}.${body}.`, secret), AuthError);
});

test("rejects tokens signed with a different HMAC algorithm", async () => {
  const token = await signViewerToken({}, { alg: "HS512" });
  await assert.rejects(verifyExtensionJwt(token, secret), AuthError);
});

test("rejects a token whose claims don't match the extension shape", async () => {
  const token = await signViewerToken({ channel_id: "not-a-number" });
  await assert.rejects(verifyExtensionJwt(token, secret), /unexpected token claims/);
});

test("rejects garbage", async () => {
  await assert.rejects(verifyExtensionJwt("not.a.jwt", secret), AuthError);
});

test("extractToken prefers Authorization: Bearer, falls back to x-extension-jwt", () => {
  assert.equal(extractToken({ authorization: "Bearer abc" }), "abc");
  assert.equal(extractToken({ "x-extension-jwt": "def" }), "def");
  assert.equal(extractToken({ authorization: "Basic xyz" }), undefined);
  assert.equal(extractToken({}), undefined);
});

test("signEbsJwt produces an external-role token verifiable with the same secret", async () => {
  const token = await signEbsJwt(secret, { ownerId: "1000", channelId: "12345", pubsubSend: ["broadcast"] });
  const claims = await verifyExtensionJwt(token, secret).catch(() => undefined);
  // external tokens lack opaque_user_id, so they intentionally fail the viewer schema...
  assert.equal(claims, undefined);
  // ...but the signature and claims are as Twitch expects.
  const { jwtVerify } = await import("jose");
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
  assert.equal(payload.role, "external");
  assert.equal(payload.user_id, "1000");
  assert.deepEqual(payload.pubsub_perms, { send: ["broadcast"] });
});
