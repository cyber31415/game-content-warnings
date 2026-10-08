import type { ExtraTopics, TopicDictionary, Warning } from "../../shared/api.d.ts";
import { ebs } from "./api.ts";

let cached: TopicDictionary | undefined;
let inflight: Promise<TopicDictionary> | undefined;

/** Loads DDD's topic dictionary once per page (and per catalogue version). */
export async function loadTopics(token: string, version: string): Promise<TopicDictionary> {
  if (cached && cached.version === version) return cached;
  inflight ??= ebs<TopicDictionary>(token, `/api/topics?v=${encodeURIComponent(version)}`)
    .then((d) => (cached = d))
    .finally(() => (inflight = undefined));
  return inflight;
}

export type ShownTopic = Warning & { name: string; keywords: string };
export type Group = { id: number; name: string; topics: ShownTopic[] };

/** Buckets confirmed topics under DDD's broad categories, in dictionary order; empty groups dropped. */
export function groupWarnings(warnings: Warning[], extra: ExtraTopics, dict: TopicDictionary): Group[] {
  const groups = new Map<number, Group>(dict.groups.map((g) => [g.id, { id: g.id, name: g.name, topics: [] }]));
  const other = dict.groups.at(-1)!;
  for (const w of warnings) {
    const info = dict.topics[w.topicId];
    const extraInfo = extra[w.topicId];
    const name = info?.name ?? extraInfo?.name ?? `Topic ${w.topicId}`;
    const groupId = info?.group ?? extraInfo?.group ?? other.id;
    const group = groups.get(groupId) ?? groups.get(other.id)!;
    group.topics.push({ ...w, name, keywords: info?.keywords ?? "" });
  }
  return [...groups.values()].filter((g) => g.topics.length > 0);
}

/** Case-insensitive match on topic name, DDD keywords and category name; "spiders" also finds "spider". */
export function matchesQuery(topic: ShownTopic, groupName: string, query: string): boolean {
  const haystack = `${topic.name} ${topic.keywords} ${groupName}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token) || (token.length > 3 && token.endsWith("s") && haystack.includes(token.slice(0, -1))));
}
