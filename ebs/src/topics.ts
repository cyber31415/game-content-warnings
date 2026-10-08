import type { TopicDictionary } from "../../shared/api.d.ts";
import type { Store } from "./cache/db.ts";
import type { DddClient } from "./ddd/client.ts";
import type { DddTopic, DddTopicCategory, DddTopicSuperCategory } from "./ddd/schema.ts";

const DAY = 24 * 60 * 60_000;
const CATALOG_TTL = 7 * DAY;
const CATALOG_MAX_STALE = 30 * DAY; // DDD terms: never use cached data older than 30 days
const META_KEY = "topic-catalog";

/** DDD's "Spoiler" topic category (cliffhangers, sad endings...): plot spoilers, not content warnings. */
export const SPOILER_CATEGORY_ID = 13;
/** DDD super category "Other". Unknown topics land here when no rule matches. */
export const OTHER_GROUP_ID = 60;

type Catalog = { topics: DddTopic[]; categories: DddTopicCategory[]; superCategories: DddTopicSuperCategory[] };

// Item stats reference some topics that /topics doesn't list (e.g. "Someone attempts suicide",
// "sexual assault is mentioned"). They must never be dropped, so place them by keyword.
// First match wins; ids are DDD super categories.
const FALLBACK_RULES: [RegExp, number][] = [
  [/\b(animal|dog|cat|horse|pet|bird|fish)s?\b/i, 54], // Animals
  [/\b(kid|child|baby|babies|infant|pregnan)/i, 53], // Children & Babies
  [/\b(sexual|rape|molest|incest)/i, 51], // Sexual Content/Assault
  [/\b(suicide|kill myself|self[- ]?harm|overdos|addict|drug|alcohol)/i, 55], // Mental Health
  [/\b(gore|blood|asphyxiat|chok|strangl|amputat|torture|mutilat)/i, 59], // Bodily Harm
  [/\b(die|dies|death|dead|corpse|grief)/i, 52], // Death, Grief & Loss
  [/\b(shot|stab|murder|kill|fight|war|gun|violen)/i, 50], // Violence
];

export function fallbackGroup(topicName: string): number {
  return FALLBACK_RULES.find(([re]) => re.test(topicName))?.[1] ?? OTHER_GROUP_ID;
}

/** Turns DDD's catalogue into the compact dictionary the frontend uses for names, grouping and search. */
export function buildDictionary(c: Catalog, fetchedAt: number): TopicDictionary {
  const superOf = new Map(c.categories.map((cat) => [cat.id, cat.topicSuperCategoryId ?? OTHER_GROUP_ID]));
  const groups = [...c.superCategories]
    .sort((a, b) => Number(a.id === OTHER_GROUP_ID) - Number(b.id === OTHER_GROUP_ID) || a.name.localeCompare(b.name))
    .map((s) => ({ id: s.id, name: s.name }));
  const topics: TopicDictionary["topics"] = {};
  for (const t of c.topics) {
    if (t.topicCategoryId === SPOILER_CATEGORY_ID) continue;
    topics[t.id] = {
      name: t.name,
      group: superOf.get(t.topicCategoryId ?? -1) ?? fallbackGroup(t.name),
      keywords: t.keywords ?? "", // search only; never displayed
    };
  }
  return { version: String(fetchedAt), groups, topics, excluded: c.topics.filter((t) => t.topicCategoryId === SPOILER_CATEGORY_ID).map((t) => t.id) };
}

type Logger = { warn: (obj: object, msg: string) => void };

/** Topic catalogue cached in SQLite (3 DDD requests per refresh, weekly). */
export class TopicCatalog {
  private readonly store: Store;
  private readonly ddd: DddClient;
  private readonly now: () => number;
  private readonly log: Logger;
  private memo: { dict: TopicDictionary; fetchedAt: number } | undefined;
  private inflight: Promise<TopicDictionary> | undefined;
  private readonly reportedUnknown = new Set<number>();

  constructor(opts: { store: Store; ddd: DddClient; now?: () => number; log?: Logger }) {
    this.store = opts.store;
    this.ddd = opts.ddd;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? { warn: () => {} };
  }

  async get(): Promise<TopicDictionary> {
    if (this.memo && this.now() - this.memo.fetchedAt < CATALOG_TTL) return this.memo.dict;
    const cached = this.store.getMeta(META_KEY);
    if (cached && this.now() - cached.fetchedAt < CATALOG_TTL) {
      this.memo = { dict: buildDictionary(JSON.parse(cached.payloadJson) as Catalog, cached.fetchedAt), fetchedAt: cached.fetchedAt };
      return this.memo.dict;
    }
    this.inflight ??= (async () => {
      try {
        const catalog = await this.ddd.getTopicCatalog();
        const now = this.now();
        this.store.putMeta(META_KEY, JSON.stringify(catalog), now);
        this.memo = { dict: buildDictionary(catalog, now), fetchedAt: now };
        return this.memo.dict;
      } catch (err) {
        if (cached && this.now() - cached.fetchedAt < CATALOG_MAX_STALE) {
          this.log.warn({ err: String(err) }, "serving stale DDD topic catalogue");
          return buildDictionary(JSON.parse(cached.payloadJson) as Catalog, cached.fetchedAt);
        }
        throw err;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /** Logs (once per process) topics seen in item stats that the catalogue doesn't know. */
  noteUnknown(topicId: number, topicName: string): void {
    if (this.reportedUnknown.has(topicId)) return;
    this.reportedUnknown.add(topicId);
    this.log.warn({ topicId, topicName, group: fallbackGroup(topicName) }, "topic missing from DDD catalogue; grouped by keyword");
  }
}
