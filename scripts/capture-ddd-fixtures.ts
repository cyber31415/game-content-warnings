// Captures real DoesTheDogDie v3 responses into ebs/test/fixtures/ddd/ so schemas and
// tests can be checked against reality. Costs ~8 requests of the monthly quota.
//
//   node --env-file=.env scripts/capture-ddd-fixtures.ts
//
// DDD terms: these are cached DDD data. Re-capture (or delete ebs/test/fixtures/ddd/) at least every
// 30 days; tests and the mock server treat captures older than 30 days as missing.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DddClient } from "../ebs/src/ddd/client.ts";
import { DddItemDetailSchema, DddSearchResponseSchema } from "../ebs/src/ddd/schema.ts";

const OUT = resolve(import.meta.dirname, "../ebs/test/fixtures/ddd");
const key = process.env.DDD_API_KEY;
if (!key) throw new Error("DDD_API_KEY not set (node --env-file=.env ...)");
const ddd = new DddClient({ apiKey: key, apiBase: process.env.DDD_API_BASE ?? "https://www.doesthedogdie.com" });
mkdirSync(OUT, { recursive: true });

async function save(name: string, path: string): Promise<unknown> {
  const json = await ddd.getRaw(path);
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(json, null, 2) + "\n");
  console.log(`saved ${name}.json  (${path})`);
  return json;
}

const itemTypes = (await save("itemtypes", "/api/v3/itemtypes")) as { id: number; name: string }[];
console.log("item types:", itemTypes.map((t) => `${t.id}=${t.name}`).join(", "));
await save("topics", "/api/v3/topics");
await save("topiccategories", "/api/v3/topiccategories");
await save("topicsupercategories", "/api/v3/topicsupercategories");

for (const q of ["The Last of Us", "Celeste"]) {
  const raw = await save(`search-${q.toLowerCase().replace(/\W+/g, "-")}`, `/api/v3/items?q=${encodeURIComponent(q)}`);
  const parsed = DddSearchResponseSchema.safeParse(raw);
  console.log(parsed.success ? `  schema OK (${parsed.data.length} items)` : `  SCHEMA MISMATCH: ${parsed.error.message}`);
  const game = parsed.success ? parsed.data.find((i) => /video ?game/i.test(i.itemTypeName ?? "")) : undefined;
  if (game) {
    const item = await save(`item-${game.id}`, `/api/v3/items/${game.id}`);
    const detail = DddItemDetailSchema.safeParse(item);
    console.log(detail.success ? `  item schema OK (${detail.data.topicItemStats.length} topic stats)` : `  ITEM SCHEMA MISMATCH: ${detail.error.message}`);
  } else {
    console.log("  no item typed as a video game in these results: check itemTypeName values above");
  }
}
console.log("quota:", ddd.budget);
