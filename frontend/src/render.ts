import type { WarningsResponse } from "../../shared/api.d.ts";
import { el, externalLink } from "./api.ts";
import { matchesQuery, type Group } from "./topics.ts";

const ATTRIBUTION_URL = "https://www.doesthedogdie.com";

/** Required on every view that shows DDD data (DDD API terms §6). */
export function attribution(): HTMLElement {
  return el("p", { className: "attribution" }, [externalLink(ATTRIBUTION_URL, "Powered by DoesTheDogDie.com")]);
}

/** DDD API terms §19.4: never state or imply DDD reviewed or endorsed this extension. */
export function disclaimer(): HTMLElement {
  return el("p", { className: "note disclaimer", text: "Unofficial: not affiliated with or endorsed by DoesTheDogDie.com." });
}

/** Small "Unofficial" badge shown beside the extension's title. */
export function unofficialBadge(): HTMLElement {
  return el("span", { className: "badge", text: "Unofficial", attrs: { title: "Not affiliated with or endorsed by DoesTheDogDie.com" } });
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type GroupsOptions = {
  query: string;
  openGroups: Set<number>;
  onToggleGroup: (id: number, open: boolean) => void;
};

/** The collapsible category list (re-rendered on every search keystroke; the search box itself is not). */
export function renderGroups(groups: Group[], opts: GroupsOptions): HTMLElement {
  const q = opts.query.trim();
  const visible = groups
    .map((g) => ({ ...g, topics: q ? g.topics.filter((t) => matchesQuery(t, g.name, q)) : g.topics }))
    .filter((g) => g.topics.length > 0);

  if (q && visible.length === 0) {
    return el("div", { className: "groups" }, [
      el("p", { className: "state", text: `No confirmed warning matches “${q}”.` }),
      el("p", { className: "note", text: "That isn't a guarantee it's absent: some games have few votes so far." }),
    ]);
  }

  return el(
    "div",
    { className: "groups" },
    visible.map((g) => {
      const details = el("details", { className: "group", attrs: { "data-group": String(g.id) } }, [
        el("summary", {}, [
          el("span", { className: "group-name", text: g.name }),
          el("span", { className: "count" }, [
            el("span", { text: String(g.topics.length) }),
            el("span", { className: "visually-hidden", text: g.topics.length === 1 ? " warning" : " warnings" }),
          ]),
        ]),
        el("ul", { className: "topics" }, g.topics.map((t) => topicItem(t))),
      ]);
      // While searching, matching groups open automatically.
      details.open = q ? true : opts.openGroups.has(g.id);
      details.addEventListener("toggle", () => {
        if (!q) opts.onToggleGroup(g.id, details.open);
      });
      return details;
    }),
  );
}

/** Just the trigger. A "few votes" tag marks topics with fewer than 3 votes in total. */
function topicItem(t: Group["topics"][number]): HTMLElement {
  const fewVotes = t.yes + t.no < 3;
  return el("li", { className: "topic" }, [
    el("span", { text: capitalize(t.name) }),
    fewVotes ? el("span", { className: "tag", text: "few votes", attrs: { title: "Fewer than 3 votes so far" } }) : null,
  ]);
}

/** Everything except an "ok" result with warnings. */
export function renderStatus(data: WarningsResponse | "loading"): HTMLElement {
  if (data === "loading") {
    return el("div", { attrs: { role: "status", "aria-label": "Loading content warnings" } }, [
      el("div", { className: "skeleton" }),
      el("div", { className: "skeleton" }),
      el("div", { className: "skeleton short" }),
    ]);
  }
  switch (data.status) {
    case "ok":
      return el("p", { className: "state", text: "No content warnings have been confirmed by voters for this game yet." });
    case "no_match":
    case "low_confidence":
      return el("p", { className: "state", text: "No content warning data found for this category." });
    case "no_category":
      return el("p", { className: "state", text: "No category is set for this channel, so there are no game warnings to show." });
    case "error":
      return el("p", { className: "state", text: "Content warnings are unavailable right now. Trying again shortly…" });
  }
}

/** "Updated Oct 7" (or "Updated today"): when the votes were last fetched from DDD. */
export function freshness(fetchedAt: string, now = new Date()): string {
  const d = new Date(fetchedAt);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) return "Updated today";
  const sameYear = d.getFullYear() === now.getFullYear();
  return `Updated ${d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" })}`;
}

export function footer(data: WarningsResponse | "loading"): HTMLElement {
  const showsData = data !== "loading" && (data.status === "ok" || data.status === "no_match" || data.status === "low_confidence");
  const ok = data !== "loading" && data.status === "ok" ? data : undefined;
  return el("footer", {}, [
    ok ? el("p", { className: "note", text: "Describes the game, not necessarily this stream. Crowd-sourced; may be incomplete." }) : null,
    ok ? el("p", { className: "note freshness", text: freshness(ok.fetchedAt), attrs: { title: new Date(ok.fetchedAt).toLocaleString() } }) : null,
    showsData ? el("div", { className: "credits" }, [
      disclaimer(),
      attribution(),
      // Very bottom: this game's page on DoesTheDogDie (only when we matched one).
      ok ? el("p", { className: "item-link" }, [externalLink(ok.ddd.url, `${ok.category.name} on DoesTheDogDie`)]) : null,
    ]) : null,
  ]);
}
