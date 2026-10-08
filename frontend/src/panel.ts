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

const root = document.getElementById("app")!;
const ext = window.Twitch?.ext;

let token: string | undefined;
let gameHint: string | undefined;
let data: WarningsResponse | "loading" = "loading";
let dict: TopicDictionary | undefined;
let visible = true;
let pollTimer: number | undefined;
let inflight = false;
let hintRetries = 0;
let query = "";
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
// Compact pinned header (title + expand/collapse, game + total, search); the list scrolls under it.
const top = el("div", { className: "top" }, [
  el("header", {}, [el("div", { className: "row" }, [title]), el("div", { className: "row sub" }, [el("span", { className: "meta" }, [game, total]), expandAll])]),
  toolbar,
]);
root.replaceChildren(top, body, foot);
// Open category headings stick just below the pinned header while their topics scroll.
new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${top.offsetHeight}px`)).observe(top);

search.addEventListener("input", () => {
  query = search.value;
  renderBody();
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

function render(): void {
  game.textContent = data !== "loading" && "category" in data ? data.category.name : "";
  game.hidden = !game.textContent;
  renderBody();
  foot.replaceChildren(footer(data));
}

function renderBody(): void {
  const groups = currentGroups();
  const hasList = groups.length > 0;
  toolbar.hidden = !hasList;
  expandAll.hidden = !hasList;
  total.hidden = !hasList;
  if (!hasList) {
    body.replaceChildren(data !== "loading" && data.status === "ok" && !dict ? renderStatus("loading") : renderStatus(data));
    return;
  }
  const count = groups.reduce((n, g) => n + g.topics.length, 0);
  total.textContent = ` · ${count} confirmed`;
  const allOpen = groups.every((g) => openGroups.has(g.id));
  expandAll.textContent = allOpen ? "Collapse all" : "Expand all";
  expandAll.setAttribute("aria-expanded", String(allOpen));
  body.replaceChildren(
    renderGroups(groups, {
      query,
      openGroups,
      onToggleGroup: (id, open) => {
        open ? openGroups.add(id) : openGroups.delete(id);
        const nowAllOpen = groups.every((g) => openGroups.has(g.id));
        expandAll.textContent = nowAllOpen ? "Collapse all" : "Expand all";
      },
    }),
  );
}

async function ensureTopics(): Promise<void> {
  if (!token || data === "loading" || data.status !== "ok") return;
  if (dict?.version === data.topicsVersion) return;
  try {
    dict = await loadTopics(token, data.topicsVersion);
  } catch {
    data = { status: "error" };
  }
}

async function refresh(): Promise<void> {
  if (!token || inflight) return;
  inflight = true;
  try {
    const q = gameHint ? `?hint=${encodeURIComponent(gameHint)}` : "";
    const next = await ebs<WarningsResponse>(token, `/api/warnings${q}`);
    if (data !== "loading" && "category" in data && "category" in next && data.category.id !== next.category.id) {
      openGroups.clear(); // new game: start collapsed again
    }
    data = next;
    await ensureTopics();
  } catch {
    // Keep showing the last good data; only show the fallback if we never had any.
    if (data === "loading") data = { status: "error" };
  } finally {
    inflight = false;
  }
  render();
  if (categoryLagsHint() && hintRetries < HINT_MAX_RETRIES) {
    hintRetries++;
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(refresh, HINT_RETRY_MS);
  } else {
    schedulePoll();
  }
}

/** True when Twitch says the game changed but the EBS answer is still for another category. */
function categoryLagsHint(): boolean {
  if (!gameHint || data === "loading") return false;
  if (data.status === "no_category") return true;
  return "category" in data && data.category.name !== gameHint;
}

function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  if (!visible) return;
  pollTimer = window.setTimeout(refresh, POLL_MS + Math.random() * POLL_JITTER_MS);
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
      if (data !== "loading" && "category" in data && "category" in msg.data && data.category.id !== msg.data.category.id) openGroups.clear();
      data = msg.data;
      if ("category" in msg.data) gameHint = msg.data.category.name;
      void ensureTopics().then(render);
      schedulePoll();
    } else if (msg.type === "refresh") {
      refreshSoon(15_000);
    }
  });

}
