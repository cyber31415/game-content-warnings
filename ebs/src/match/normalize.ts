const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
  xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16",
};

// Suffixes that usually denote the same game's content (not a different game).
const EDITION_SUFFIXES = [
  "game of the year edition", "goty edition", "game of the year", "goty",
  "definitive edition", "complete edition", "enhanced edition", "deluxe edition",
  "special edition", "ultimate edition", "anniversary edition", "directors cut", "director s cut",
  "remastered", "hd remaster", "remaster",
];

/**
 * Canonical comparison form of a title: lowercase ASCII, no marks or punctuation,
 * "&" -> "and", roman numerals -> digits, collapsed whitespace.
 */
export function normalizeTitle(raw: string): string {
  let s = raw
    .replace(/[™®©]/g, "") // before NFKD, which would turn ™ into "TM"
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "") // "Assassin's" -> "assassins"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  s = s
    .split(" ")
    .map((w) => ROMAN[w] ?? w)
    .join(" ");
  return s.replace(/\s+/g, " ").trim();
}

/** normalizeTitle plus removal of trailing edition/remaster suffixes. */
export function coreTitle(raw: string): string {
  let s = normalizeTitle(raw);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of EDITION_SUFFIXES) {
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -suffix.length - 1).trim();
        changed = true;
      }
    }
  }
  return s;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, "");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient over character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of A) {
    overlap += Math.min(n, B.get(g) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return (2 * overlap) / total;
}

/** Numbers in a title ("2", "2077", "4") — differing numbers almost always mean a different game. */
export function numberTokens(normalized: string): string[] {
  return normalized.split(" ").filter((w) => /^\d+$/.test(w));
}
