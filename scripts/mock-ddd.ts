// Offline stand-in for the DoesTheDogDie v3 API for local end-to-end runs (no quota used).
// Items are keyed to the category names the Twitch CLI mock API generates; the topic
// catalogue and the main item's votes are REAL captured DDD data (ebs/test/fixtures/ddd):
//
//   "Just Making a CLI"  -> real vote data of "The Last of Us" (87 Yes topics)  (status ok)
//   "Just Developing"    -> match, but no topic confirmed by voters (status ok, empty)
//   "Development Test"   -> two equally good candidates            (low_confidence)
//   "Just Chatting" etc. -> nothing                                (no_match)
//
//   node scripts/mock-ddd.ts            (listens on http://127.0.0.1:8095)
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";

const fixture = (name: string): unknown => {
  const url = new URL(`../ebs/test/fixtures/ddd/${name}.json`, import.meta.url);
  // DDD terms: cached data must be refreshed at least every 30 days.
  if (!existsSync(url) || Date.now() - statSync(url).mtimeMs > 30 * 24 * 60 * 60_000) {
    console.error("DDD fixtures missing or older than 30 days. Capture them with your own key:\n  node --env-file=.env scripts/capture-ddd-fixtures.ts");
    process.exit(1);
  }
  return JSON.parse(readFileSync(url, "utf8"));
};
const realStats = (fixture("item-14438") as { topicItemStats: unknown[] }).topicItemStats;

const PORT = Number(process.env.MOCK_DDD_PORT || 8095);

const stat = (topicId: number, topicName: string, yesSum: number, noSum: number) => ({ topicId, topicName, yesSum, noSum, numComments: 0 });

const ITEMS = [
  {
    id: 9001, name: "Just Making a CLI", releaseYear: 2021, itemTypeId: 99, itemTypeName: "Video Game",
    topicItemStats: realStats as ReturnType<typeof stat>[],
  },
  { id: 9002, name: "Just Developing", releaseYear: 2019, itemTypeId: 99, itemTypeName: "Video Game", topicItemStats: [stat(153, "a dog dies", 0, 9)] },
  { id: 9003, name: "Development Test", releaseYear: 2019, itemTypeId: 99, itemTypeName: "Video Game", topicItemStats: [] },
  { id: 9004, name: "Development Test", releaseYear: 2022, itemTypeId: 99, itemTypeName: "Video Game", topicItemStats: [] },
  { id: 9005, name: "Just Making a CLI: The Movie", releaseYear: 2023, itemTypeId: 15, itemTypeName: "Movie", topicItemStats: [] },
];

const summary = ({ topicItemStats: _omit, ...rest }: (typeof ITEMS)[number]) => rest;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "x-ratelimit-remaining-month": "4999", "x-ratelimit-limit-month": "5000" });
    res.end(JSON.stringify(body));
  };
  if (!req.headers["x-api-key"]) return send(401, { error: "missing_api_key", message: "X-API-KEY header required" });
  console.log(`${req.method} ${url.pathname}${url.search}`);

  if (url.pathname === "/api/v3/items") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return send(200, q.length < 2 ? [] : ITEMS.filter((i) => i.name.toLowerCase().includes(q)).map(summary));
  }
  if (url.pathname === "/api/v3/topics") return send(200, fixture("topics"));
  if (url.pathname === "/api/v3/topiccategories") return send(200, fixture("topiccategories"));
  if (url.pathname === "/api/v3/topicsupercategories") return send(200, fixture("topicsupercategories"));
  const m = /^\/api\/v3\/items\/(\d+)$/.exec(url.pathname);
  if (m) {
    const item = ITEMS.find((i) => i.id === Number(m[1]));
    return item ? send(200, item) : send(404, { error: "not_found", message: "Item not found" });
  }
  send(404, { error: "not_found", message: "Unknown endpoint" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`Mock DDD API on http://127.0.0.1:${PORT} (synthetic data)`));
