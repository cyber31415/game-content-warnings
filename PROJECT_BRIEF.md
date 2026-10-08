# Project Brief: Twitch Content-Warning Extension

> Handoff document for Claude Code. Drop this in the repo root (or `docs/`), then see **Section 12** for the first prompt to give Claude Code.

## 1. What we're building

A **Twitch Extension** (the official add-on type that streamers enable from their dashboard) that shows viewers **content/trigger warnings for the game category the channel is currently streaming**. Warning data comes from **DoesTheDogDie.com (DDD)**, a crowd-sourced trigger-warning database.

Flow:

1. Viewer opens a channel that has the extension enabled.
2. Extension frontend asks our backend for warnings for this channel.
3. Backend finds the channel's current Twitch category, matches it to a DDD entry, and returns the warnings (cached).
4. Frontend renders them in a panel (v1), optionally a video component later.

**Why an extension and not a browser add-on:** the goal is something that lives inside Twitch and that a *streamer* can add to their channel so all viewers see it.

**Initial scope (v1):** read-only warnings panel + a streamer config page (override the matched game, choose what to display). No accounts, no user-submitted data, no monetization.

## 2. Verification status: read this first

Facts below were checked against docs/sources during research unless marked otherwise. **Claude Code should re-verify every item marked UNVERIFIED against live docs before building on it.**

| Item | Status (re-checked 2026-10-07 against live docs) |
|---|---|
| Extension types: panel, video component, video overlay; panels can be always-on | Confirmed (Twitch docs) |
| Streamer limits: up to 3 panels, 1 overlay, 2 components | Likely (help.twitch.tv, seen via search snippet only) |
| Twitch review: human-readable JS, everything in the zip (no remote scripts except the helper, which must load first), no Twitch branding; ≤1 MB initial mobile load | Confirmed (guidelines 2.5, 2.6, 2.8, 3.2) |
| Panel-only extensions don't need a continuously live review channel | Confirmed (Twitch review docs) |
| Frontend JWT via `onAuthorized`; EBS verifies HS256 with the **base64-decoded** extension secret. Claims: `channel_id`, `opaque_user_id`, `role`, `user_id` (if shared), `is_unlinked`, `pubsub_perms`, `exp`. Auth object also has `helixToken` | Confirmed |
| Configuration service: broadcaster/developer/global segments, **5 KB each**; EBS access via Helix with an EBS-signed `role: external` JWT (20 reads + 20 writes/min per segment) | Confirmed |
| DDD API | **Changed:** v3 at `/api/v3` (`/items?q=`, `/items/{id}` with `topicItemStats[{topicId, topicName, yesSum, noSum}]`). `X-API-KEY` header; no IGDB/Steam IDs. Legacy `/dddsearch`, `/media/{id}` still respond. **Generic User-Agents get 403.** |
| Helix Get Games returns `igdb_id` | Confirmed, but no longer used: non-game categories simply find no DDD match |
| Helix Get Channel Information returns `game_id`/`game_name` (current or last played); app token OK | Confirmed |
| EBS app access token via client credentials with the extension's Client ID + **Client Secret** (≠ Extension Secret) | Confirmed (forum; docs imply) |
| Frontend fetch allowlist | Confirmed: **"Allowlist for URL Fetching Domains"** (CSP enforced). Local Test serves from the Testing Base URI (default `https://localhost:8080/`, HTTPS required). Frontend origin `https://<client-id>.ext-twitch.tv` |
| Developer Rig | **Dead** (end of support Jan 2023). Use Local Test → Hosted Test |
| Live updates | Confirmed: EventSub `channel.update` v2 (category changes, no authorization needed) via **webhook + app token** (WebSocket needs a user token); Extension PubSub broadcast still supported after the 2025 PubSub shutdown (5 KB messages; design for 1 msg/s per channel). `onContext` has a `game` field; `onVisibilityChanged` exists |
| Finding installed channels | No "all installs" endpoint (Get Extension Live Channels = live only). EBS registers channels when their panel/config page calls it |
| **DDD terms** | **Read** (see `docs/ddd-terms-notes.md`): Free tier 30/min + 5,000/month, **non-commercial only**; attribution "Powered by DoesTheDogDie.com" required; cache ≤ 30 days. **Open: is a free extension on monetized channels "commercial"? Ask DDD before launch** |
| DDD API key | From the DDD profile page (account required) |
| Privacy policy / EULA URLs | Confirmed required before review submission |
| DDD video-game `itemTypeId` / exact v3 JSON | Verified 2026-10-07 with a real key: Video Game = `itemTypeId` 17 / `itemTypeName` "Video Game"; schemas validate (fixtures in `ebs/test/fixtures/ddd/`). Popular games carry ~200 topic stats, so payloads can exceed 5 KB. DDD web search has no deep-link URL |
| Max zip size | Not verified |

## 3. Architecture

```
Viewer's Twitch page
  └─ Panel iframe (frontend, hosted on Twitch CDN)
        │  window.Twitch.ext.onAuthorized -> JWT
        │  GET /api/warnings   (header: x-extension-jwt)
        ▼
  EBS (our backend, HTTPS)
     ├─ verify JWT (extension secret) -> channel_id
     ├─ Twitch Helix: channel -> current game (id, name, igdb_id)
     ├─ Matcher: Twitch game -> DDD item (cached mapping + manual overrides)
     ├─ DDD client: /dddsearch, /media/{id} (cached, rate-limited)
     └─ Response: normalized warnings JSON
```

Key design points:

- **DDD API key and Twitch client secret live only on the EBS.** Never ship them in frontend code.
- **Cache aggressively.** Viewer load should almost never trigger a live DDD call. Cache `twitchGameId -> dddItemId` mapping (long TTL) and `dddItemId -> warnings` (e.g. 24 h). Cache the channel-to-current-game lookup briefly (e.g. 60 to 120 s) so a popular channel doesn't hammer Helix.
- **v2 optimization (not v1):** use the Twitch configuration service so the EBS writes the current warnings into the channel's config segment when the category changes, letting viewer frontends read config without calling the EBS at all.
- **Category changes mid-stream:** v1 = frontend fetches on load and re-fetches every ~5 minutes. v2 = EventSub `channel.update` -> EBS -> Twitch Extension PubSub push.

## 4. Recommended stack

- **Backend (EBS):** Node.js + TypeScript, Fastify (or Express), `jsonwebtoken`/`jose` for JWT verification, SQLite (`better-sqlite3`) for the cache and mapping tables (swap to Postgres/Redis only if needed), `zod` for validating external API responses, `vitest` for tests.
- **Frontend:** TypeScript + Vite, vanilla or Preact (small bundle). **Configure the build so output is not minified/obfuscated**, because Twitch review requires human-readable JS. Load the official helper: `<script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"></script>`.
- **Hosting:** any HTTPS host for the EBS (Fly.io, Render, Railway, etc.). Frontend assets are uploaded to Twitch's CDN as a zip via the Developer Console.
- **Tooling:** Twitch Developer Rig for local development; Developer Console at dev.twitch.tv/console/extensions.

## 5. Suggested repo layout

```
twitch-warnings-extension/
  PROJECT_BRIEF.md
  CLAUDE.md                 # short: conventions + pointer to this brief
  ebs/
    src/
      server.ts
      config.ts             # env vars, validated
      auth/jwt.ts           # verify extension JWT, extract channel_id/role
      twitch/helix.ts       # app token manager, getChannelGame(), getGame()
      ddd/client.ts         # search(), getMedia(), rate limiting, retries
      ddd/schema.ts         # zod schemas (built from captured real responses)
      match/normalize.ts    # title normalization
      match/matcher.ts      # Twitch game -> DDD item w/ confidence
      cache/db.ts           # SQLite setup + migrations
      routes/warnings.ts
      routes/health.ts
    test/
      fixtures/             # captured real DDD + Helix responses
      matcher.test.ts
      warnings.test.ts
  frontend/
    src/
      panel.html / panel.ts
      config.html / config.ts     # broadcaster settings
      api.ts
      render.ts
      styles.css
    vite.config.ts          # minify: false
  scripts/
    capture-ddd-fixtures.ts # saves real responses for tests/schema
    match-audit.ts          # runs matcher over top Twitch categories, outputs report
  .env.example
```

## 6. Backend spec

### Environment variables
```
TWITCH_EXT_CLIENT_ID=
TWITCH_EXT_CLIENT_SECRET=      # for Helix app access token
TWITCH_EXT_SECRET=             # base64 extension shared secret, for JWT verification
DDD_API_KEY=
DATABASE_PATH=./data/cache.sqlite
ALLOWED_ORIGIN=                # extension frontend origin(s)
```

### `GET /api/warnings`
- Auth: `x-extension-jwt` header. Verify signature and expiry with the extension secret. Take `channel_id` from the verified token, **never from a query param**.
- Optional query: `dddItemId` (streamer override, must be a positive integer; validate).
- Steps:
  1. Resolve channel's current game via Helix (cache 60 to 120 s). If no game or game has no `igdb_id` (e.g. Just Chatting): return `{status: "no_game"}`.
  2. If an override was supplied, use it. Else look up cached mapping `twitchGameId -> dddItemId`; on miss run the matcher.
  3. Fetch DDD media (cache ~24 h). Normalize.
  4. Return:
```json
{
  "status": "ok" | "no_game" | "no_match" | "low_confidence" | "error",
  "game": { "twitchId": "...", "name": "..." },
  "ddd": { "itemId": 0, "name": "...", "url": "https://www.doesthedogdie.com/media/..." },
  "matchConfidence": 0.0,
  "warnings": [
    { "topic": "...", "yesVotes": 0, "noVotes": 0, "sensitive": false }
  ],
  "fetchedAt": "ISO-8601"
}
```
- Never return a hard error to the viewer UI for upstream failures; return `status: "error"` and let the UI show a quiet fallback.
- Rate-limit per IP and per channel. Do not log viewer identifiers (opaque user IDs included).

### Matcher (this is the riskiest component; invest in tests)
1. Input: Twitch game `{id, name, igdb_id}`.
2. Check manual-override table first, then the mapping cache.
3. Normalize names: lowercase, strip punctuation/™/®, normalize `&`/`and`, roman numerals vs digits, collapse whitespace, optionally strip edition suffixes ("Remastered", "Definitive Edition", "Game of the Year").
4. Query DDD `/dddsearch?q=<normalized name>`. If the result schema has an item-type field, filter to video games.
5. Score candidates (string similarity, exact-normalized match bonus, release year agreement if available, e.g. from IGDB). Accept only above a threshold; if two candidates are close, return `low_confidence` rather than guessing.
6. Persist the decision with its confidence. Log all non-matches to a table for periodic review and to build the override list.
7. Investigate whether DDD items expose any external ID (IGDB/Steam). If so, match on that and skip fuzzy matching.

**Principle:** a wrong warning set is worse than no data. When in doubt, say "no data found," and link to DDD.

### Data model (SQLite)
- `game_map(twitch_game_id PK, ddd_item_id, confidence, source ['auto'|'manual'], updated_at)`
- `ddd_media_cache(ddd_item_id PK, payload_json, fetched_at)`
- `unmatched(twitch_game_id PK, twitch_name, last_seen_at, seen_count)`
- `overrides(twitch_game_id PK, ddd_item_id, note)`

## 7. Frontend spec (panel)

- On `onAuthorized`: call `/api/warnings`; show a loading state; render by `status`.
- **`ok`:** heading "Content warnings: {game}". List topics where yes-votes clearly outweigh no-votes (define the threshold in one place; default to showing a topic when yes > no and yes ≥ some minimum). Each item shows the topic name. Optionally an expandable "details" with vote counts. Footer: "Source: DoesTheDogDie.com (crowd-sourced; may be incomplete)" with a link to the DDD page. Treat attribution wording as provisional until DDD's terms are confirmed.
- **`no_match` / `low_confidence`:** "No warning data found for this game." + link to search DDD.
- **`no_game`:** "No game category is set, so there are no game warnings." (Just Chatting etc.)
- **`error`:** quiet fallback, with retry on next interval.
- Sensitive topics: consider collapsing items DDD flags as sensitive behind a click-to-reveal, since the viewer may be using this *because* they want to avoid seeing certain things.
- Accessibility: keyboard navigable, sufficient contrast, no reliance on color alone. Respect panel size constraints and Twitch's design guidelines. Dark-theme aware (use the `onContext` theme).
- Copy must state clearly that warnings describe the *game*, not necessarily what happens in this specific stream.
- Refresh every ~5 minutes; pause refresh when the panel is not visible if the helper exposes that.

### Config view (broadcaster)
- *(Updated 2026-10-07)* Only setting: a game-match correction (`overrideDddItemId`), stored by the EBS via a broadcaster-only endpoint. Topic hiding and vote counts were dropped: viewers should always see every confirmed warning, unedited.
- Keep the stored JSON small (segment size limits apply; verify the limit).
- Frontend reads the segment and passes `overrideDddItemId` to the EBS.
- Nice-to-have: a "wrong game matched?" search box in config that calls an EBS endpoint to search DDD and let the streamer pick.

## 8. Twitch Developer Console setup (manual steps for the human)

1. Enable 2FA on the Twitch account; open dev.twitch.tv/console/extensions and create an extension.
2. Type: **Panel** for v1. Add a **Config path** (config.html) and set a panel height.
3. Capabilities: choose the configuration option you'll use (Extension Configuration Service for broadcaster settings).
4. Note the **Client ID**, generate the **Client Secret**, and the **extension shared secret**: these go in the EBS env vars.
5. Allowlist the EBS domain for the frontend to call (find the correct field in the console; UNVERIFIED name).
6. Use Developer Rig / **Local Test** during development, then **Hosted Test** (upload built frontend zip) with a real channel.
7. Prepare review materials: walkthrough guide, change log, review channel URL, screenshots, privacy policy URL (verify requirement).

## 9. Milestones and acceptance criteria

| # | Milestone | Done when |
|---|---|---|
| M0 | Recon | DDD API key obtained; DDD terms read and summarized in `docs/ddd-terms-notes.md`; real DDD search + media responses captured as fixtures; DDD item schema documented; unverified items in Section 2 resolved or marked |
| M1 | EBS skeleton | `/health` works; JWT verification middleware tested with valid/expired/forged tokens; Helix app-token manager refreshes automatically |
| M2 | Data layer | DDD client with retries + rate limiting; zod schemas; SQLite cache with TTLs; tests using fixtures |
| M3 | Matcher | `scripts/match-audit.ts` runs over a list of ~200 popular Twitch categories and outputs match/no-match/low-confidence counts; unit tests cover tricky names (sequels, remasters, punctuation, numerals) |
| M4 | Panel UI | Renders every `status` correctly in Developer Rig using EBS in dev mode |
| M5 | Config view | Streamer override + hidden topics persist and affect the panel |
| M6 | Hosted Test | Works end-to-end on a real channel; category switch picked up within the refresh interval; offline channel behaves sensibly |
| M7 | Hardening | Rate limits, structured logs (no viewer IDs), graceful degradation when DDD or Helix is down, load test of cached path |
| M8 | Review submission | Review package complete; non-minified frontend build; DDD terms compliance confirmed |

## 10. Risks and open questions

1. **DDD terms of use are unknown.** Do not make this public until commercial-use, caching, rate-limit, and attribution rules are confirmed. Consider contacting the DDD maintainers. This could change the whole design (e.g. cache limits).
2. **Matching quality** between Twitch categories and DDD titles is the main technical risk. Measure it in M3 before investing heavily in UI.
3. **Coverage.** DDD coverage of games is uneven and non-game categories have no entries. Decide the UX for "no data" early.
4. **Adoption.** Only channels whose streamers install it benefit. Plan how streamers will discover it (Twitch extension directory after approval).
5. **Review risk.** Twitch review criteria and turnaround can change; read the current guidelines before M8.
6. **Data accuracy.** DDD is crowd-sourced; the UI should say so and not present warnings as authoritative.
7. **Privacy.** Don't store viewer identifiers; only `channel_id` is needed.

## 11. Security checklist

- Verify the extension JWT on every EBS request; take `channel_id` and role only from the verified token.
- Secrets only in env vars; `.env` in `.gitignore`; commit `.env.example` only.
- Validate and bound all inputs (`dddItemId` integer range, etc.).
- Validate all upstream (DDD, Helix) responses with schemas; treat them as untrusted data, and escape everything when rendering (use `textContent`, never `innerHTML` with API data).
- CORS locked to the extension's origin(s).
- Rate limit; set sensible timeouts on upstream calls.

## 12. First prompt for Claude Code

Paste this after placing this file in the repo:

> Read `PROJECT_BRIEF.md` fully. We're building the Twitch panel extension it describes. Start with **Milestone M0 and M1 only**. First, use web fetch against the official Twitch Extensions docs and the DDD API page to resolve or confirm every item marked UNVERIFIED in Section 2, and report what you found (with sources) before writing code. Then scaffold the repo layout from Section 5, create `CLAUDE.md` with project conventions, and implement the EBS skeleton (config validation, `/health`, JWT verification with tests, Helix app-token manager). Don't build the matcher or UI yet. Ask me for the DDD API key and Twitch credentials when you need them rather than inventing values. Show me your plan before making changes.

## 13. Reference links

- Twitch Extensions docs: https://dev.twitch.tv/docs/extensions/ (building, reference, reviews, guidelines-and-policies, designing, required-technical-background)
- Twitch Developer Console (extensions): https://dev.twitch.tv/console/extensions
- Twitch Developer Rig and Hello World sample: https://github.com/twitchdev/extension-getting-started
- Twitch Helix API reference (Get Games, Get Channel Information, Extension configuration endpoints): https://dev.twitch.tv/docs/api/reference
- DoesTheDogDie API: https://www.doesthedogdie.com/api
- Prior art using DDD data (for reference on caching/proxy patterns): DoesTheDogWatchPlex (GitHub), Kometa PR #1913
