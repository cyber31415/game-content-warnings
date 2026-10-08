// Milestone M3: how well do Twitch's top categories match DoesTheDogDie entries?
// Runs the real matcher over the current top-N Twitch categories and writes a report.
// Decisions are cached in data/audit.sqlite, so re-runs only query new categories.
// DDD terms: the report and data/audit.sqlite hold cached DDD data, which may already be up to
// 30 days old when the report is written. Each report states a delete-by date (30 days after the
// oldest data it contains); delete it, and audit.sqlite if you no longer run the audit, by then.
// Cost: up to 2 DDD searches per new category (free tier: 5,000 requests/month).
//
//   node --env-file=.env scripts/match-audit.ts [--top 50]
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../ebs/src/config.ts";
import { Store } from "../ebs/src/cache/db.ts";
import { DddClient } from "../ebs/src/ddd/client.ts";
import { AppTokenManager, HelixClient } from "../ebs/src/twitch/helix.ts";
import { TTL, WarningsService } from "../ebs/src/warnings.ts";
import { TopicCatalog } from "../ebs/src/topics.ts";
import { Corrections } from "../ebs/src/corrections.ts";
import type { Candidate } from "../ebs/src/match/matcher.ts";

const top = Number(process.argv[process.argv.indexOf("--top") + 1]) || 50;
const config = loadConfig();
const tokens = new AppTokenManager({ clientId: config.twitch.clientId, clientSecret: config.twitch.clientSecret, tokenUrl: config.twitch.tokenUrl });
const helix = new HelixClient({ clientId: config.twitch.clientId, apiBase: config.twitch.apiBase, tokens });
const ddd = new DddClient({ apiKey: config.ddd.apiKey, apiBase: config.ddd.apiBase, maxQueueWaitMs: 60 * 60_000 });
const store = new Store(resolve(import.meta.dirname, "../data/audit.sqlite"), { vfs: config.database.vfs });
mkdirSync(resolve(import.meta.dirname, "../data"), { recursive: true });
// DDD terms: cached DDD data (including old audit reports) must not be kept beyond 30 days.
store.purgeItemsOlderThan(Date.now() - TTL.itemMaxStale);
// Each report is a snapshot of cached DDD data; keep only the newest one (written below).
for (const f of readdirSync(resolve(import.meta.dirname, "../data")).filter((f) => /^match-audit-.*\.md$/.test(f))) {
  unlinkSync(resolve(import.meta.dirname, "../data", f));
}
const corrections = new Corrections({ store, helix, extensionSecret: config.twitch.extensionSecret, ownerId: config.twitch.ownerId, mode: "local" });
const svc = new WarningsService({ store, ddd, helix, topics: new TopicCatalog({ store, ddd }), corrections });

const games = await helix.getTopGames(top);
console.log(`Auditing ${games.length} top Twitch categories (~3s per uncached category)...`);
let oldestData = Date.now();
const rows: { rank: number; name: string; status: string; confidence: number; picked: string; alternatives: string }[] = [];
for (const [i, g] of games.entries()) {
  try {
    const m = await svc.mapping({ id: g.id, name: g.name });
    oldestData = Math.min(oldestData, m.updatedAt);
    const cands = JSON.parse(m.candidatesJson) as Candidate[];
    const picked = m.dddItemId ? cands.find((c) => c.id === m.dddItemId) : undefined;
    rows.push({
      rank: i + 1,
      name: g.name,
      status: m.status,
      confidence: m.confidence,
      picked: picked ? `${picked.name}${picked.releaseYear ? ` (${picked.releaseYear})` : ""} #${picked.id}` : "",
      alternatives: cands.filter((c) => c.id !== m.dddItemId).slice(0, 3).map((c) => `${c.name} ${c.score.toFixed(2)}`).join("; "),
    });
    process.stdout.write(`\r${i + 1}/${games.length}`);
  } catch (err) {
    rows.push({ rank: i + 1, name: g.name, status: `error: ${String(err)}`, confidence: 0, picked: "", alternatives: "" });
  }
}

const count = (s: string) => rows.filter((r) => r.status === s).length;
const date = new Date().toISOString().slice(0, 10);
const deleteBy = new Date(oldestData + TTL.itemMaxStale).toISOString().slice(0, 10);
const md = [
  `# Match audit ${date}`,
  "",
  `> Contains DoesTheDogDie data cached as early as ${new Date(oldestData).toISOString().slice(0, 10)}. **Delete this file by ${deleteBy}** (DDD terms: 30-day cache limit).`,
  "",
  `Top ${rows.length} Twitch categories by viewers. matched: **${count("matched")}**, low confidence: **${count("low_confidence")}**, no match: **${count("no_match")}**, errors: ${rows.filter((r) => r.status.startsWith("error")).length}.`,
  "",
  "Review every `matched` row: a wrong match is worse than none. Fix mistakes with a manual mapping.",
  "",
  "| # | Twitch category | Result | Conf. | DDD item | Other candidates |",
  "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.rank} | ${r.name} | ${r.status} | ${r.confidence.toFixed(2)} | ${r.picked} | ${r.alternatives} |`),
  "",
  `DDD quota after run: ${JSON.stringify(ddd.budget)}`,
].join("\n");
mkdirSync(resolve(import.meta.dirname, "../data"), { recursive: true });
// data/ is gitignored: the report contains DDD data, which must not be published.
const out = resolve(import.meta.dirname, `../data/match-audit-${date}.md`);
writeFileSync(out, md + "\n");
console.log(`\nWrote ${out}`);
store.close();
