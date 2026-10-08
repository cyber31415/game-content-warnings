import type { PubSubMessage, TopicDictionary, WarningsResponse } from "../../shared/api.d.ts";
import { applyTheme, brandMark, ebs, el } from "./api.ts";
import { footer, renderGroups, renderStatus, unofficialBadge } from "./render.ts";
import { groupWarnings, loadTopics, type Group } from "./topics.ts";

// How the panel stays current when the streamer switches category:
//  1. Twitch.ext.onContext reports the new game name -> re-fetch (works everywhere).
//  2. EBS pushes fresh warnings over Extension PubSub (when EventSub is configured).
//  3. Polling every ~5 minutes as a safety net, paused while the panel is hidden.
const POLL_MS = 5 * 60_000;
const POLL_JITTER_MS = 60_000;
// The EBS may briefly still report the previous category; re-check a few times.
const HINT_RETRY_MS = 12_000;
const HINT_MAX_RETRIES = 3;

const ERROR_RETRY_MS = 15_000; // first retry after a failure; doubles up to the poll interval

const root = document.getElementById("app")!;
const ext = window.Twitch?.ext;

let token: string | undefined;
let gameHint: string | undefined;
let data: WarningsResponse | "loading" = "loading";
let dict: TopicDictionary | undefined;
let topicsFailed = false;
let visible = true;
let pollTimer: number | undefined;
let inflight = false;
let hintRetries = 0;
let errorDelay = ERROR_RETRY_MS;
/** Bumped whenever data is applied, so an older in-flight response can't overwrite newer data. */
let generation = 0;
let query = "";
let announceTimer: number | undefined;
const openGroups = new Set<number>();

// --- Page shell: built once so the search box keeps focus and text across updates.
const title = el("h1", {}, [brandMark(), el("span", { text: "Content warnings" }), unofficialBadge()]);
const game = el("span", { className: "game" });
const total = el("span", { className: "total" });
const search = el("input", {
  attrs: { type: "search", id: "search", placeholder: "Search warnings (e.g. spiders)", autocomplete: "off", maxlength: "60" },
});
const expandAll = el("button", { className: "expand", attrs: { type: "button" } });
const toolbar = el("div", { className: "toolbar", attrs: { role: "search" } }, [
  el("label", { className: "visually-hidden", text: "Search confirmed warnings", attrs: { for: "search" } }),
  search,
]);
const body = el("div", { className: "body" });
const foot = el("div");
// Short status messages for screen readers (the list itself is not a live region).
const announcer = el("p", { className: "visually-hidden", attrs: { role: "status", "aria-live": "polite" } });
// Compact pinned header (title, game + total + expand/collapse, search); the list scrolls under it.
const top = el("div", { className: "top" }, [
  el("header", {}, [el("div", { className: "row" }, [title]), el("div", { className: "row sub" }, [el("span", { className: "meta" }, [game, total]), expandAll])]),
  toolbar,
]);
root.replaceChildren(top, body, foot, announcer);
// Open category headings stick just below the pinned header while their topics scroll.
new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${top.offsetHeight}px`)).observe(top);

search.addEventListener("input", () => {
  query = search.value;
  renderBody();
  // Announce the result count once typing pauses.
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    const n = body.querySelectorAll("li.topic").length;
    announcer.textContent = query.trim() ? (n ? `${n} matching warning${n === 1 ? "" : "s"}` : "No matching warnings") : "";
  }, 600);
});
expandAll.addEventListener("click", () => {
  const groups = currentGroups();
  const allOpen = groups.length > 0 && groups.every((g) => openGroups.has(g.id));
  for (const g of groups) allOpen ? openGroups.delete(g.id) : openGroups.add(g.id);
  renderBody();
});

function currentGroups(): Group[] {
  if (data === "loading" || data.status !== "ok" || !dict) return [];
  return groupWarnings(data.warnings, data.extraTopics, dict);
}

function hasGoodData(): boolean {
  return data !== "loading" && data.status !== "error";
}

function render(): void {
  game.textContent = data !== "loading" && "category" in data ? data.category.name : "";
  game.hidden = !game.textContent;
  renderBody();
  foot.replaceChildren(footer(data));
}

function setExpandLabel(allOpen: boolean): void {
  expandAll.textContent = allOpen ? "Collapse all" : "Expand all";
  expandAll.setAttribute("aria-expanded", String(allOpen));
}

function renderBody(): void {
  const groups = currentGroups();
  const hasList = groups.length > 0;
  toolbar.hidden = !hasList;
  total.hidden = !hasList;
  // Search forces matching categories open, so expand/collapse has nothing to do while searching.
  expandAll.hidden = !hasList || query.trim() !== "";
  if (!hasList) {
    const showing: WarningsResponse | "loading" =
      data !== "loading" && data.status === "ok" && !dict ? (topicsFailed ? { status: "error" } : "loading") : data;
    body.replaceChildren(renderStatus(showing));
    return;
  }
  const count = groups.reduce((n, g) => n + g.topics.length, 0);
  total.textContent = ` · ${count} confirmed`;
  setExpandLabel(groups.every((g) => openGroups.has(g.id)));

  // Keep keyboard focus on the same category heading across re-renders.
  const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement)
    ? document.activeElement.closest("details.group")?.getAttribute("data-group")
    : null;
  body.replaceChildren(
    renderGroups(groups, {
      query,
      openGroups,
      onToggleGroup: (id, open) => {
        open ? openGroups.add(id) : openGroups.delete(id);
        setExpandLabel(groups.every((g) => openGroups.has(g.id)));
      },
    }),
  );
  if (focused) (body.querySelector(`details.group[data-group="${focused}"] > summary`) as HTMLElement | null)?.focus();
}

/** Applies new data; returns false when it changes nothing visible. */
function apply(next: WarningsResponse): boolean {
  // Never replace good data with a transient error; keep showing what we have.
  if (next.status === "error" && hasGoodData()) return false;
  if (data !== "loading" && JSON.stringify(data) === JSON.stringify(next)) return false;
  if (data !== "loading" && "category" in data && "category" in next && data.category.id !== next.category.id) {
    openGroups.clear(); // new game: start collapsed again
  }
  const firstOrChanged = data === "loading" || !("category" in data) || !("category" in next) || data.category.id !== next.category.id;
  data = next;
  generation++;
  if (firstOrChanged && "category" in next) announcer.textContent = `Content warnings for ${next.category.name}`;
  return true;
}

async function ensureTopics(): Promise<void> {
  if (!token || data === "loading" || data.status !== "ok") return;
  if (dict?.version === data.topicsVersion) return;
  try {
    dict = await loadTopics(token, data.topicsVersion);
    topicsFailed = false;
  } catch {
    topicsFailed = !dict; // an older dictionary still renders names; only fail without one
  }
}

async function refresh(): Promise<void> {
  if (!token || inflight) return;
  inflight = true;
  const startedAt = generation;
  let failed = false;
  try {
    const q = gameHint ? `?hint=${encodeURIComponent(gameHint)}` : "";
    const next = await ebs<WarningsResponse>(token, `/api/warnings${q}`);
    failed = next.status === "error";
    // A PubSub update arrived while we were waiting: it's newer, keep it.
    if (generation === startedAt) apply(next);
    await ensureTopics();
  } catch {
    failed = true;
    if (data === "loading") apply({ status: "error" });
  } finally {
    inflight = false;
  }
  render();
  scheduleNext(failed || topicsFailed);
}

/** Next check: quick backoff after failures, a few retries while the EBS lags a category change, else the poll. */
function scheduleNext(failed: boolean): void {
  window.clearTimeout(pollTimer);
  if (!visible) return;
  if (failed) {
    pollTimer = window.setTimeout(refresh, errorDelay);
    errorDelay = Math.min(errorDelay * 2, POLL_MS);
    return;
  }
  errorDelay = ERROR_RETRY_MS;
  if (categoryLagsHint() && hintRetries < HINT_MAX_RETRIES) {
    hintRetries++;
    pollTimer = window.setTimeout(refresh, HINT_RETRY_MS);
    return;
  }
  pollTimer = window.setTimeout(refresh, POLL_MS + Math.random() * POLL_JITTER_MS);
}

/** True when Twitch says the game changed but the EBS answer is still for another category. */
function categoryLagsHint(): boolean {
  if (!gameHint || data === "loading") return false;
  if (data.status === "no_category") return true;
  return "category" in data && data.category.name !== gameHint;
}

/** Spread viewer requests out so a category change doesn't hit the EBS all at once. */
function refreshSoon(maxDelayMs: number): void {
  window.setTimeout(refresh, Math.random() * maxDelayMs);
}

if (!ext) {
  data = { status: "error" };
  render();
} else {
  render();

  ext.onAuthorized((auth) => {
    const first = token === undefined;
    token = auth.token; // re-issued periodically; always keep the latest
    if (first) void refresh();
  });

  ext.onContext((ctx, changed) => {
    if (changed.includes("theme")) applyTheme(ctx.theme);
    if (changed.includes("game") && ctx.game !== undefined && ctx.game !== gameHint) {
      const firstContext = gameHint === undefined;
      gameHint = ctx.game;
      hintRetries = 0;
      if (!firstContext) refreshSoon(3_000);
    }
  });

  ext.onVisibilityChanged((isVisible) => {
    visible = isVisible;
    if (isVisible) void refresh();
    else window.clearTimeout(pollTimer);
  });

  ext.listen("broadcast", (_target, _contentType, message) => {
    let msg: PubSubMessage;
    try {
      msg = JSON.parse(message) as PubSubMessage;
    } catch {
      return;
    }
    if (msg.type === "warnings") {
      if ("category" in msg.data) {
        gameHint = msg.data.category.name;
        hintRetries = 0;
      }
      if (!apply(msg.data)) return;
      void ensureTopics().then(() => {
        render();
        scheduleNext(topicsFailed);
      });
    } else if (msg.type === "refresh") {
      refreshSoon(15_000);
    }
  });
}
