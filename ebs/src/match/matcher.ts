import type { DddItemSummary } from "../ddd/schema.ts";
import type { MatchStatus } from "../cache/db.ts";
import { coreTitle, normalizeTitle, numberTokens, similarity } from "./normalize.ts";

export const ACCEPT_THRESHOLD = 0.9;
export const REVIEW_THRESHOLD = 0.75;
/** Two candidates scoring within this margin of each other are treated as ambiguous. */
export const AMBIGUITY_MARGIN = 0.05;

export type Candidate = { id: number; name: string; releaseYear: number | null; score: number };

export type MatchResult = {
  status: MatchStatus;
  dddItemId: number | null;
  confidence: number;
  candidates: Candidate[];
  /**
   * Set when the tie is between duplicate DDD listings of one game (same title, at most one
   * release year among them). The caller resolves it by picking the listing with more votes.
   */
  duplicateIds?: number[];
};

const isVideoGame = (item: DddItemSummary) => /video ?game/i.test(item.itemTypeName ?? "");

/** Splits a trailing "(2005)" off Twitch names like "God of War (2005)". */
export function splitYear(twitchName: string): { title: string; year: number | null } {
  const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(twitchName);
  return m ? { title: m[1]!, year: Number(m[2]) } : { title: twitchName, year: null };
}

export function scoreCandidate(twitchTitle: string, year: number | null, item: DddItemSummary): number {
  const a = normalizeTitle(twitchTitle);
  const b = normalizeTitle(item.name);
  let score: number;
  if (a === b) score = 1;
  else if (coreTitle(twitchTitle) === coreTitle(item.name)) score = 0.95;
  else score = similarity(coreTitle(twitchTitle), coreTitle(item.name));

  // "Dark Souls 2" vs "Dark Souls 3": differing numbers mean a different game.
  const na = numberTokens(a).join(" ");
  const nb = numberTokens(b).join(" ");
  if (na !== nb) score *= 0.5;

  if (year !== null && item.releaseYear !== null) score += year === item.releaseYear ? 0.02 : -0.2;
  // Without a known item type we can't rule out a film/book of the same name.
  if (!isVideoGame(item)) score = Math.min(score, REVIEW_THRESHOLD);
  return Math.max(0, Math.min(1, score));
}

/** Pure decision step: ranks search results for a Twitch category name. */
export function rankCandidates(twitchName: string, results: DddItemSummary[]): MatchResult {
  const { title, year } = splitYear(twitchName);
  // Items explicitly typed as something other than a video game are never candidates.
  const pool = results.filter((r) => r.itemTypeName == null || isVideoGame(r));
  const candidates = pool
    .map((r) => ({ id: r.id, name: r.name, releaseYear: r.releaseYear, score: scoreCandidate(title, year, r) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 5);

  const [best, second] = candidates;
  if (!best || best.score < REVIEW_THRESHOLD) {
    return { status: "no_match", dddItemId: null, confidence: best?.score ?? 0, candidates };
  }
  const ambiguous = second !== undefined && best.score - second.score < AMBIGUITY_MARGIN;
  if (best.score >= ACCEPT_THRESHOLD && !ambiguous) {
    return { status: "matched", dddItemId: best.id, confidence: best.score, candidates };
  }
  const tied = candidates.filter((c) => c.score >= ACCEPT_THRESHOLD && best.score - c.score < AMBIGUITY_MARGIN);
  const duplicateIds = isDuplicateListing(tied) ? tied.map((c) => c.id) : undefined;
  return { status: "low_confidence", dddItemId: null, confidence: best.score, candidates, ...(duplicateIds && { duplicateIds }) };
}

/**
 * DDD sometimes lists one game twice (e.g. an old entry without a year plus a newer one with it).
 * Same normalized title and no conflicting years means duplicates; different years (Dead Space
 * 2008 vs the 2023 remake) mean genuinely different games, which stay ambiguous.
 */
export function isDuplicateListing(tied: Candidate[]): boolean {
  if (tied.length < 2) return false;
  const titles = new Set(tied.map((c) => normalizeTitle(c.name)));
  const years = new Set(tied.map((c) => c.releaseYear).filter((y) => y !== null));
  return titles.size === 1 && years.size <= 1;
}

/** Search queries to try, most specific first (each costs one DDD request). */
export function searchQueries(twitchName: string): string[] {
  const { title } = splitYear(twitchName);
  const plain = title.replace(/[™®©]/g, "").trim();
  const core = coreTitle(plain);
  const queries = [plain];
  if (core && core !== normalizeTitle(plain)) queries.push(core);
  return queries;
}
