import { SignJWT } from "jose";
import { loadConfig } from "../src/config.ts";

export const TEST_SECRET_B64 = Buffer.from("test-extension-secret-32-bytes!!").toString("base64");

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    TWITCH_EXT_CLIENT_ID: "testclientid",
    TWITCH_EXT_CLIENT_SECRET: "testclientsecret",
    TWITCH_EXT_SECRET: TEST_SECRET_B64,
    TWITCH_EXT_OWNER_ID: "1000",
    DDD_API_KEY: "test-ddd-key",
    ...overrides,
  });
}

/** Signs a token shaped like the one Twitch gives the frontend. */
export async function signViewerToken(
  claims: Record<string, unknown> = {},
  opts: { secretB64?: string; expSeconds?: number; alg?: string } = {},
): Promise<string> {
  const secret = new Uint8Array(Buffer.from(opts.secretB64 ?? TEST_SECRET_B64, "base64"));
  return new SignJWT({ channel_id: "12345", opaque_user_id: "U123", role: "viewer", ...claims })
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expSeconds ?? 300))
    .sign(secret);
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Minimal fetch stub that records calls. */
export function fakeFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

import { AppTokenManager, HelixClient } from "../src/twitch/helix.ts";
import { DddClient } from "../src/ddd/client.ts";
import { Store } from "../src/cache/db.ts";

import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * Real DDD responses captured by scripts/capture-ddd-fixtures.ts. Not committed (DDD's terms
 * don't allow redistributing their data), so tests that need them skip when they're absent.
 */
const REAL_FIXTURES = ["topics", "topiccategories", "topicsupercategories", "itemtypes", "search-the-last-of-us", "search-celeste", "item-14438", "item-17871"];
/** DDD terms: cached DDD data must be refreshed at least every 30 days; older captures count as missing. */
const FIXTURE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const hasRealFixtures = REAL_FIXTURES.every((f) => {
  const url = new URL(`./fixtures/ddd/${f}.json`, import.meta.url);
  return existsSync(url) && Date.now() - statSync(url).mtimeMs < FIXTURE_MAX_AGE_MS;
});
export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/ddd/${name}.json`, import.meta.url), "utf8"));

/** Small made-up topic catalogue in DDD's v3 shape (committed; used by the normal tests). */
const synthetic = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/synthetic/${name}.json`, import.meta.url), "utf8"));

/** SYNTHETIC items in the real v3 shape, using real DDD topic ids. */
export const DDD_ITEMS: Record<number, object> = {
  101: {
    id: 101, name: "The Last of Us Part I", releaseYear: 2022, itemTypeId: 17, itemTypeName: "Video Game",
    topicItemStats: [
      { topicId: 153, topicName: "a dog dies", yesSum: 12, noSum: 2 }, // Animals
      { topicId: 161, topicName: "there are jump scares", yesSum: 30, noSum: 1 }, // Phobias & Sensory
      { topicId: 165, topicName: "there are spiders", yesSum: 1, noSum: 20 }, // No wins: hidden
      { topicId: 182, topicName: "someone is sexually assaulted", yesSum: 2, noSum: 0 }, // few votes, still shown
      { topicId: 188, topicName: "there's blood/gore", yesSum: 3, noSum: 3 }, // tie: hidden
      { topicId: 222, topicName: "the ending is sad", yesSum: 9, noSum: 0 }, // Spoiler category: excluded
      { topicId: 286, topicName: "Someone attempts suicide", yesSum: 5, noSum: 0 }, // not in /topics
    ],
  },
  202: { id: 202, name: "Celeste", releaseYear: 2018, itemTypeId: 99, itemTypeName: "Video Game", topicItemStats: [] },
  // Duplicate listings of one game: the older entry (no year) has more votes.
  301: { id: 301, name: "Dead By Daylight", releaseYear: null, itemTypeId: 17, itemTypeName: "Video Game",
         topicItemStats: [{ topicId: 188, topicName: "there's blood/gore", yesSum: 90, noSum: 2 }] },
  302: { id: 302, name: "Dead by Daylight", releaseYear: 2016, itemTypeId: 17, itemTypeName: "Video Game",
         topicItemStats: [{ topicId: 188, topicName: "there's blood/gore", yesSum: 5, noSum: 0 }] },
};
export const DDD_SEARCH: Record<string, object[]> = {
  "the last of us part i": [
    { id: 101, name: "The Last of Us Part I", releaseYear: 2022, itemTypeName: "Video Game" },
    { id: 102, name: "The Last of Us Part II", releaseYear: 2020, itemTypeName: "Video Game" },
    { id: 103, name: "The Last of Us", releaseYear: 2023, itemTypeName: "TV Show" },
  ],
  celeste: [{ id: 202, name: "Celeste", releaseYear: 2018, itemTypeName: "Video Game" }],
  "duplicate with a merged listing": [
    { id: 301, name: "Duplicate With A Merged Listing", releaseYear: null, itemTypeName: "Video Game" },
    { id: 999, name: "Duplicate with a merged listing", releaseYear: 2016, itemTypeName: "Video Game" },
  ],
  "dead by daylight": [
    { id: 301, name: "Dead By Daylight", releaseYear: null, itemTypeName: "Video Game" },
    { id: 302, name: "Dead by Daylight", releaseYear: 2016, itemTypeName: "Video Game" },
  ],
};

export type Upstream = {
  channelGame: { id: string; name: string };
  dddCalls: string[];
  helixCalls: string[];
  dddDown: boolean;
  /** Fake Twitch developer configuration segments, by broadcaster id. */
  segments: Map<string, string>;
  segmentsDown: boolean;
};

/** Wires real clients to a fake Twitch + DDD upstream. */
export function testDeps(configOverrides: Record<string, string> = {}) {
  const up: Upstream = {
    channelGame: { id: "1001", name: "The Last of Us Part I" },
    dddCalls: [],
    helixCalls: [],
    dddDown: false,
    segments: new Map(),
    segmentsDown: false,
  };
  const f = fakeFetch((url, init) => {
    if (url.startsWith("https://id.twitch.test/")) return json({ access_token: "apptoken", expires_in: 3600, token_type: "bearer" });
    if (url.startsWith("https://api.twitch.test/helix/")) {
      up.helixCalls.push(`${init?.method ?? "GET"} ${url.slice("https://api.twitch.test/helix".length)}`);
      if (url.includes("/channels?"))
        return json({ data: [{ broadcaster_id: "12345", broadcaster_name: "x", game_id: up.channelGame.id, game_name: up.channelGame.name }] });
      if (url.includes("/eventsub/subscriptions")) return json({ data: [{ id: "sub-1", status: "webhook_callback_verification_pending" }] }, 202);
      if (url.endsWith("/extensions/pubsub")) return new Response(null, { status: 204 });
      if (url.includes("/extensions/configurations")) {
        if (up.segmentsDown) return json({ message: "unavailable" }, 503);
        if (init?.method === "PUT") {
          const b = JSON.parse(String(init.body)) as { broadcaster_id: string; content: string; segment: string };
          up.segments.set(b.broadcaster_id, b.content);
          return new Response(null, { status: 204 });
        }
        const id = new URL(url).searchParams.get("broadcaster_id")!;
        const content = up.segments.get(id);
        return json({ data: content === undefined ? [] : [{ segment: "developer", broadcaster_id: id, content, version: "1" }] });
      }
    }
    if (url.startsWith("https://ddd.test/")) {
      up.dddCalls.push(url.slice("https://ddd.test".length));
      if (up.dddDown) return json({ error: "server_error" }, 500);
      const u = new URL(url);
      const m = /^\/api\/v3\/items\/(\d+)$/.exec(u.pathname);
      if (m) {
        const item = DDD_ITEMS[Number(m[1])];
        return item ? json(item) : json({ error: "not_found", message: "Item not found" }, 404);
      }
      if (u.pathname === "/api/v3/items") return json(DDD_SEARCH[(u.searchParams.get("q") ?? "").toLowerCase()] ?? []);
      if (u.pathname === "/api/v3/topics") return json(synthetic("topics"));
      if (u.pathname === "/api/v3/topiccategories") return json(synthetic("topiccategories"));
      if (u.pathname === "/api/v3/topicsupercategories") return json(synthetic("topicsupercategories"));
    }
    return json({ error: "unexpected " + url }, 500);
  });
  const config = testConfig({ TWITCH_API_BASE: "https://api.twitch.test/helix", TWITCH_TOKEN_URL: "https://id.twitch.test/oauth2/token", DDD_API_BASE: "https://ddd.test", ...configOverrides });
  const tokens = new AppTokenManager({ clientId: "c", clientSecret: "s", tokenUrl: config.twitch.tokenUrl, fetchFn: f.fn });
  const helix = new HelixClient({ clientId: "c", apiBase: config.twitch.apiBase, tokens, fetchFn: f.fn });
  const ddd = new DddClient({ apiKey: "k", apiBase: config.ddd.apiBase, fetchFn: f.fn, perMinute: 6000, sleep: async () => {} });
  const store = new Store(":memory:");
  return { config, helix, ddd, store, up, fetch: f };
}
