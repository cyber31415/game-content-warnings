import { test } from "node:test";
import assert from "node:assert/strict";
import { coreTitle, normalizeTitle, similarity } from "../src/match/normalize.ts";
import { rankCandidates, searchQueries, splitYear } from "../src/match/matcher.ts";

const game = (id: number, name: string, releaseYear: number | null = null, itemTypeName: string | null = "Video Game") =>
  ({ id, name, releaseYear, itemTypeName }) as never;

test("normalizeTitle handles marks, punctuation, ampersands, numerals, diacritics", () => {
  assert.equal(normalizeTitle("Tom Clancy's Rainbow Six® Siege™"), "tom clancys rainbow six siege");
  assert.equal(normalizeTitle("Ratchet & Clank"), "ratchet and clank");
  assert.equal(normalizeTitle("Final Fantasy VII"), "final fantasy 7");
  assert.equal(normalizeTitle("Pokémon  Scarlet"), "pokemon scarlet");
  assert.equal(normalizeTitle("Half-Life: Alyx"), "half life alyx");
});

test("coreTitle strips edition suffixes", () => {
  assert.equal(coreTitle("The Witcher 3: Wild Hunt - Game of the Year Edition"), "the witcher 3 wild hunt");
  assert.equal(coreTitle("Dark Souls Remastered"), "dark souls");
  assert.equal(coreTitle("Skyrim Special Edition"), "skyrim");
});

test("similarity is 1 for equal strings and low for unrelated ones", () => {
  assert.equal(similarity("celeste", "celeste"), 1);
  assert.ok(similarity("celeste", "hollow knight") < 0.3);
});

test("splitYear extracts a trailing year", () => {
  assert.deepEqual(splitYear("God of War (2005)"), { title: "God of War", year: 2005 });
  assert.deepEqual(splitYear("Cyberpunk 2077"), { title: "Cyberpunk 2077", year: null });
});

test("exact match wins", () => {
  const r = rankCandidates("Celeste", [game(1, "Celeste", 2018), game(2, "Celestial")]);
  assert.equal(r.status, "matched");
  assert.equal(r.dddItemId, 1);
});

test("roman numerals vs digits match", () => {
  const r = rankCandidates("Final Fantasy VII", [game(7, "Final Fantasy 7", 1997), game(8, "Final Fantasy VIII", 1999)]);
  assert.equal(r.dddItemId, 7);
});

test("sequels are not confused: different numbers are penalised", () => {
  const r = rankCandidates("Dark Souls III", [game(2, "Dark Souls II"), game(1, "Dark Souls")]);
  assert.notEqual(r.status, "matched");
});

test("remaster of the same game matches when it's the only candidate", () => {
  const r = rankCandidates("Dark Souls: Remastered", [game(5, "Dark Souls")]);
  assert.equal(r.status, "matched");
  assert.equal(r.dddItemId, 5);
});

test("two equally good candidates are ambiguous -> low_confidence, not a guess", () => {
  const r = rankCandidates("Resident Evil 4", [game(1, "Resident Evil 4", 2005), game(2, "Resident Evil 4", 2023)]);
  assert.equal(r.status, "low_confidence");
  assert.equal(r.dddItemId, null);
  assert.equal(r.candidates.length, 2);
});

test("duplicate DDD listings of one game (one without a year) are flagged for resolution", () => {
  const r = rankCandidates("Dead by Daylight", [game(16121, "Dead By Daylight", null), game(809407, "Dead by Daylight", 2016)]);
  assert.equal(r.status, "low_confidence");
  assert.deepEqual(r.duplicateIds, [16121, 809407]);
});

test("same title with different years is a different game, not a duplicate", () => {
  const r = rankCandidates("Dead Space", [game(15100, "Dead Space", 2008), game(975640, "Dead Space", 2023)]);
  assert.equal(r.status, "low_confidence");
  assert.equal(r.duplicateIds, undefined);
});

test("a year in the Twitch name disambiguates", () => {
  const r = rankCandidates("God of War (2018)", [game(1, "God of War", 2005), game(2, "God of War", 2018)]);
  assert.equal(r.status, "matched");
  assert.equal(r.dddItemId, 2);
});

test("non-game items are excluded, untyped items are capped below acceptance", () => {
  assert.equal(rankCandidates("Alien", [game(1, "Alien", 1979, "Movie")]).status, "no_match");
  assert.equal(rankCandidates("Alien", [game(1, "Alien", 1979, null)]).status, "low_confidence");
});

test("non-game Twitch categories find nothing", () => {
  assert.equal(rankCandidates("Just Chatting", []).status, "no_match");
  assert.equal(rankCandidates("Just Chatting", [game(1, "Just Mercy", 2019, "Movie")]).status, "no_match");
});

test("searchQueries adds a core-title fallback only when it differs", () => {
  assert.deepEqual(searchQueries("Celeste"), ["Celeste"]);
  assert.deepEqual(searchQueries("Skyrim Special Edition™"), ["Skyrim Special Edition", "skyrim"]);
});
