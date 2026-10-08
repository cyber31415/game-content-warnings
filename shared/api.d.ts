// Types shared by the EBS and the extension frontend (declaration file: no runtime
// code, so the bundler-less frontend build and Node type stripping both just erase it).

export type Category = { id: string; name: string };

/** A topic voters confirmed ("Yes" outvotes "No"). Names/grouping come from the TopicDictionary. */
export type Warning = { topicId: number; yes: number; no: number };

/** Topics seen on an item but missing from DDD's catalogue (keyed by topicId). */
export type ExtraTopics = Record<string, { name: string; group: number }>;

/**
 * DDD's topic catalogue, fetched once per viewer (GET /api/topics) and cached.
 * `groups` are DDD's broad "super categories" (Violence, Animals, ...), in display order.
 */
export type TopicDictionary = {
  version: string;
  groups: { id: number; name: string }[];
  topics: Record<string, { name: string; group: number; keywords: string }>;
  /** Topic ids deliberately not shown (DDD "Spoiler" category: plot spoilers, not content warnings). */
  excluded: number[];
};

export type MatchSource = "auto" | "manual" | "channel";

export type WarningsResponse =
  | {
      status: "ok";
      category: Category;
      ddd: { itemId: number; name: string; url: string };
      matchConfidence: number;
      matchSource: MatchSource;
      warnings: Warning[];
      extraTopics: ExtraTopics;
      topicsVersion: string;
      fetchedAt: string;
    }
  | { status: "no_match" | "low_confidence"; category: Category }
  | { status: "no_category" }
  | { status: "error" };

/** Extension PubSub "broadcast" messages sent by the EBS (max 5 KB each). */
export type PubSubMessage =
  | { type: "warnings"; data: WarningsResponse }
  // Payload didn't fit in 5 KB: viewers should re-fetch from the EBS (with jitter).
  | { type: "refresh" };

export type BroadcasterConfigResponse = {
  overrideDddItemId: number | null;
  current: WarningsResponse;
  candidates: { id: number; name: string; releaseYear: number | null; score: number }[];
  liveUpdates: boolean;
};

export type DddSearchResult = { id: number; name: string; releaseYear: number | null; isVideoGame: boolean };
