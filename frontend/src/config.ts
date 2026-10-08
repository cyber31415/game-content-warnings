import type {
  BroadcasterConfigResponse,
  DddSearchResult,
  WarningsResponse,
} from "../../shared/api.d.ts";
import { applyTheme, brandMark, ebs, el, externalLink, HttpError } from "./api.ts";
import { attribution, disclaimer, unofficialBadge } from "./render.ts";

const LOAD_RETRY_MS = 15_000;
const LOAD_MAX_RETRIES = 4;

const root = document.getElementById("app")!;
const ext = window.Twitch?.ext;

// Static shell: the page content is re-rendered, the screen-reader announcer is not.
const content = el("div");
const announcer = el("p", { className: "visually-hidden", attrs: { role: "status", "aria-live": "polite" } });
root.replaceChildren(content, announcer);

let token: string | undefined;
let state: BroadcasterConfigResponse | undefined;
let message = "";
let searchText = "";
let searchResults: DddSearchResult[] | undefined;
let busy = false;
let loadRetries = 0;
/** Element id to focus after the next render (keeps keyboard users in place). */
let focusAfterRender: string | null = null;

function announce(text: string): void {
  message = text;
  announcer.textContent = text;
}

/** Icon + sentence so the state reads at a glance (and never by colour alone). */
function statusLine(w: WarningsResponse): HTMLElement {
  const [cls, glyph, label] =
    w.status === "ok" ? ["good", "✓", "Matched"] : w.status === "low_confidence" ? ["ask", "?", "Needs your pick"] : ["none", "–", "No data"];
  return el("div", { className: "status-line" }, [
    el("span", { className: `icon ${cls}`, text: glyph, attrs: { "aria-label": label, role: "img" } }),
    el("p", { className: "status-text", text: statusText(w) }),
  ]);
}

function statusText(w: WarningsResponse): string {
  switch (w.status) {
    case "ok":
      return w.matchSource === "channel"
        ? `Using your choice: “${w.ddd.name}”.`
        : `Matched “${w.category.name}” to “${w.ddd.name}” on DoesTheDogDie (${Math.round(w.matchConfidence * 100)}% confidence).`;
    case "no_match":
      return `No DoesTheDogDie entry was found for “${w.category.name}”. You can pick one below.`;
    case "low_confidence":
      return `“${w.category.name}” has several possible matches. Pick the right one below.`;
    case "no_category":
      return "Your channel has no category set yet, so there's no game to match.";
    case "error":
      return "Couldn't reach DoesTheDogDie right now. Try again in a minute.";
  }
}

async function load(): Promise<void> {
  if (!token) return;
  try {
    state = await ebs<BroadcasterConfigResponse>(token, "/api/broadcaster/config");
    if (message.startsWith("Still loading")) announce("");
    if (state.current.status !== "error") loadRetries = 0;
    else if (loadRetries < LOAD_MAX_RETRIES) scheduleReload();
  } catch {
    // The backend may be waking up (free hosting sleeps when idle): retry a few times.
    if (loadRetries < LOAD_MAX_RETRIES) {
      announce("Still loading… the server may be waking up.");
      scheduleReload();
    } else {
      announce("Couldn't load settings. Reopen this page to try again.");
    }
  }
  render();
}

function scheduleReload(): void {
  loadRetries++;
  window.setTimeout(load, LOAD_RETRY_MS);
}

/** The Twitch category the page is showing, which a correction applies to. */
function currentCategoryId(): string | undefined {
  const c = state?.current;
  return c && "category" in c ? c.category.id : undefined;
}

async function setOverride(dddItemId: number | null): Promise<void> {
  const twitchGameId = currentCategoryId();
  if (!token || busy || !twitchGameId) return;
  busy = true;
  announce("Saving…");
  render();
  try {
    await ebs(token, "/api/broadcaster/override", { method: "PUT", body: { dddItemId, twitchGameId } });
    announce(dddItemId === null ? "Back to automatic matching." : "Saved. Viewers will see the new warnings shortly.");
    searchResults = undefined;
    searchText = "";
    state = await ebs<BroadcasterConfigResponse>(token, "/api/broadcaster/config").catch(() => state);
  } catch (err) {
    announce(err instanceof HttpError ? `Couldn't save: ${err.message}` : "Couldn't save.");
  } finally {
    busy = false;
    focusAfterRender = "match-heading";
    render();
  }
}

async function search(q: string): Promise<void> {
  if (!token || q.trim().length < 2) return;
  announce("Searching…");
  focusAfterRender = "q";
  render();
  try {
    searchResults = await ebs<DddSearchResult[]>(token, `/api/broadcaster/search?q=${encodeURIComponent(q.trim())}`);
    announce(searchResults.length ? `${searchResults.length} results.` : "No results.");
  } catch (err) {
    announce(err instanceof HttpError ? err.message : "Search failed.");
  }
  focusAfterRender = "q";
  render();
}

function pickButton(id: number, label: string, itemName: string): HTMLButtonElement {
  const b = el("button", { text: label, attrs: { type: "button", "aria-label": `${label}: ${itemName}` } });
  b.disabled = busy;
  b.addEventListener("click", () => void setOverride(id));
  return b;
}

function itemLabel(name: string, year: number | null): string {
  return year ? `${name} (${year})` : name;
}

function render(): void {
  const parts: (Node | null)[] = [
    el("h1", {}, [brandMark(22), el("span", { text: "Content Warnings settings" }), unofficialBadge()]),
    el("p", { className: "note", text: "Your panel lists the content warnings DoesTheDogDie voters confirmed for the game you're streaming. It updates by itself when you change category." }),
  ];

  if (!state) {
    parts.push(el("p", { className: "state", text: message || "Loading…" }));
    finish(parts);
    return;
  }

  // --- Which game ---
  const match = el("section", {}, [el("h2", { text: "Game match", attrs: { id: "match-heading", tabindex: "-1" } }), statusLine(state.current)]);
  if (state.current.status === "no_category") {
    // The search below corrects a match; it can't set the Twitch category, so don't offer it here.
    match.append(
      el("p", { text: "Set your category on Twitch: Stream Manager → Edit Stream Info → Category (you don't need to be live). Then reopen this page." }),
    );
    parts.push(match);
    finish(parts);
    return;
  }
  if (state.current.status === "error") {
    // No category info to correct against right now; corrections would have nothing to apply to.
    match.append(el("p", { text: loadRetries > 0 && loadRetries <= LOAD_MAX_RETRIES ? "Retrying automatically…" : "Reopen this page in a minute to try again." }));
    parts.push(match);
    finish(parts);
    return;
  }
  if (state.current.status === "ok") match.append(el("p", {}, [externalLink(state.current.ddd.url, "Check it on DoesTheDogDie")]));
  if (state.overrideDddItemId !== null) {
    const reset = el("button", { text: "Use automatic matching", attrs: { type: "button" } });
    reset.disabled = busy;
    reset.addEventListener("click", () => void setOverride(null));
    match.append(reset);
  }
  const candidates = state.candidates.filter((c) => !(state!.current.status === "ok" && state!.current.ddd.itemId === c.id));
  if (candidates.length) {
    match.append(
      el("h3", { text: "Possible matches" }),
      el(
        "ul",
        { className: "choices" },
        candidates.map((c) => el("li", {}, [el("span", { text: itemLabel(c.name, c.releaseYear) }), pickButton(c.id, "Use this", itemLabel(c.name, c.releaseYear))])),
      ),
    );
  }

  const input = el("input", { attrs: { type: "search", id: "q", placeholder: "Search DoesTheDogDie", maxlength: "100" } });
  input.value = searchText;
  input.addEventListener("input", () => (searchText = input.value));
  const form = el("form", { className: "search" }, [
    el("label", { text: "Wrong game? Search for the right one:", attrs: { for: "q" } }),
    input,
    el("button", { text: "Search", attrs: { type: "submit" } }),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void search(input.value);
  });
  match.append(form);
  if (searchResults?.length) {
    match.append(
      el(
        "ul",
        { className: "choices" },
        searchResults.map((r) => {
          const label = itemLabel(r.name, r.releaseYear) + (r.isVideoGame ? "" : " (not a video game)");
          return el("li", {}, [el("span", { text: label }), pickButton(r.id, "Use this", label)]);
        }),
      ),
    );
  }
  parts.push(match);

  parts.push(
    el("section", {}, [
      el("h2", { text: "Live updates" }),
      el("p", {
        text: state.liveUpdates
          ? "On: when you change category, viewers get the new warnings within seconds."
          : "Viewers' panels pick up category changes on their own within seconds to a few minutes.",
      }),
    ]),
  );

  if (message) parts.push(el("p", { className: "message", text: message }));
  finish(parts);
}

function finish(parts: (Node | null)[]): void {
  // Background re-renders (automatic reloads) keep whatever the user was focused on.
  const active = document.activeElement;
  const keepId = !focusAfterRender && active instanceof HTMLElement && content.contains(active) && active.id ? active.id : null;
  const selection = active instanceof HTMLInputElement ? { start: active.selectionStart, end: active.selectionEnd } : null;
  parts.push(el("div", { className: "credits" }, [disclaimer(), attribution()]));
  content.replaceChildren(...parts.filter((p): p is Node => p !== null));
  const target = focusAfterRender ?? keepId;
  focusAfterRender = null;
  if (target) {
    const el2 = document.getElementById(target);
    el2?.focus();
    if (keepId && selection && el2 instanceof HTMLInputElement) el2.setSelectionRange(selection.start, selection.end);
  }
}

if (!ext) {
  message = "Open this page from the Twitch extension settings.";
  render();
} else {
  render();
  ext.onAuthorized((auth) => {
    const first = token === undefined;
    token = auth.token;
    if (first) void load();
  });
  ext.onContext((ctx, changed) => {
    if (changed.includes("theme")) applyTheme(ctx.theme);
  });
}
