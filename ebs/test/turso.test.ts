import { test } from "node:test";
import assert from "node:assert/strict";
import { TursoClient, TursoError } from "../src/cache/turso.ts";
import { fakeFetch, json } from "./helpers.ts";

const ok = (cols: string[], rows: unknown[][]) => ({
  type: "ok",
  response: { type: "execute", result: { cols: cols.map((name) => ({ name, decltype: null })), rows, affected_row_count: 0 } },
});

test("sends typed arguments to /v2/pipeline on the https host, with the token", async () => {
  const f = fakeFetch(() => json({ baton: null, base_url: null, results: [ok([], []), { type: "ok", response: { type: "close" } }] }));
  const c = new TursoClient({ url: "libsql://db-org.turso.io", authToken: "tok", fetchFn: f.fn });
  await c.execute({ sql: "INSERT INTO t VALUES (?, ?, ?, ?)", args: [42, 1.5, "hi", null] });
  assert.equal(f.calls[0]!.url, "https://db-org.turso.io/v2/pipeline");
  assert.equal(new Headers(f.calls[0]!.init?.headers).get("authorization"), "Bearer tok");
  const body = JSON.parse(String(f.calls[0]!.init?.body));
  assert.deepEqual(body.requests[0].stmt.args, [
    { type: "integer", value: "42" },
    { type: "float", value: 1.5 },
    { type: "text", value: "hi" },
    { type: "null" },
  ]);
  assert.equal(body.requests.at(-1).type, "close");
});

test("decodes rows into objects with numbers, text and nulls", async () => {
  const f = fakeFetch(() =>
    json({ results: [ok(["id", "name", "x", "f"], [[{ type: "integer", value: "1712345678901" }, { type: "text", value: "a" }, { type: "null" }, { type: "float", value: 0.5 }]])] }),
  );
  const { rows } = await new TursoClient({ url: "https://h", fetchFn: f.fn }).execute({ sql: "SELECT 1" });
  assert.deepEqual(rows, [{ id: 1712345678901, name: "a", x: null, f: 0.5 }]);
});

test("a failed statement or HTTP error throws, without echoing the token or response body", async () => {
  const bad = fakeFetch(() => json({ results: [{ type: "error", error: { message: "no such table: t", code: "SQLITE_ERROR" } }] }));
  await assert.rejects(new TursoClient({ url: "https://h", authToken: "secret-token", fetchFn: bad.fn }).execute({ sql: "SELECT * FROM t" }), (e: Error) => {
    assert.ok(e instanceof TursoError);
    assert.ok(!e.message.includes("secret-token"));
    return true;
  });
  const down = fakeFetch(() => new Response("upstream says: secret-token", { status: 401 }));
  await assert.rejects(new TursoClient({ url: "https://h", authToken: "secret-token", fetchFn: down.fn }).execute({ sql: "SELECT 1" }), (e: Error) => {
    assert.equal(e.message, "Turso request failed: HTTP 401");
    return true;
  });
});

test("malformed responses are rejected", async () => {
  const f = fakeFetch(() => json({ results: [{ type: "ok", response: { type: "execute", result: { cols: "nope" } } }] }));
  await assert.rejects(new TursoClient({ url: "https://h", fetchFn: f.fn }).execute({ sql: "SELECT 1" }));
});

// Optional: against a real libSQL server (e.g. `.venv/bin/sqld --http-listen-addr 127.0.0.1:8097`).
const LIVE = process.env.TURSO_TEST_URL;
test("round-trips against a real libSQL server", { skip: !LIVE && "set TURSO_TEST_URL to run" }, async () => {
  const c = new TursoClient({ url: LIVE!, ...(process.env.TURSO_TEST_TOKEN && { authToken: process.env.TURSO_TEST_TOKEN }) });
  const t = `t_${Date.now()}`;
  const [, , sel] = await c.batch([
    { sql: `CREATE TABLE ${t} (id INTEGER PRIMARY KEY, name TEXT, v REAL)` },
    { sql: `INSERT INTO ${t} VALUES (?, ?, ?)`, args: [1712345678901, "x", 2.5] },
    { sql: `SELECT * FROM ${t}` },
    { sql: `DROP TABLE ${t}` },
  ]);
  assert.deepEqual(sel!.rows, [{ id: 1712345678901, name: "x", v: 2.5 }]);
});
