# Developer Console worksheet

Field-by-field values for https://dev.twitch.tv/console/extensions. Field names as Twitch
documents them (labels can drift slightly). Requirements checked 2026-10-07; character limits
marked * come from third-party guides, so trust the console's own counter.

Backend: `https://game-content-warnings.onrender.com` (Render free tier).

## 1. Create Extension
| Field | Value |
|---|---|
| Name (unique, ≤40*, no "Twitch"/"extension") | **Game Content Warnings (Unofficial)** *(34 chars. Keep "DoesTheDogDie" out of the name: it's their trademark, and their API terms (§5) only allow their marks under their guidelines, with attribution per §6. To rename, change `EXT_NAME` and rerun `scripts/make-listing-assets.py`)* |
| Type | **Panel** + **Mobile** |
| Version | `0.1.0` |

## 2. Asset Hosting
| Field | Value |
|---|---|
| Testing Base URI | `https://localhost:8080/` (must end with `/`) |
| Panel Viewer Path | `panel.html` |
| Panel Height | **500** (console default is 300; layout pins header + search and fits 10 categories) |
| Mobile Path | `panel.html` (console pre-fills `mobile.html`: replace it; same page, fluid layout) |
| Config Path | `config.html` |
| Live Config Path | *(blank)* |
| Video / component fields | *(blank: not used)* |

## 3. Capabilities
| Field | Value |
|---|---|
| Request Identity Link | **No** (we never need viewer identities) |
| Chat Capabilities | **No** |
| Configuration | **Extension Configuration Service** (the EBS saves broadcasters' game-match corrections in each channel's developer segment, so they survive the free host wiping its disk) |
| Broadcaster Writable Channel Segment Version | *(blank: setup is optional; a value here would block activation)* |
| Developer Writable Channel Segment Version | *(blank)* |
| Allowlist for URL Fetching Domains | `https://game-content-warnings.onrender.com` |
| Allowlist for Image Domains | *(blank)* |
| Allowlist for Media Domains | *(blank)* |
| Allowlisted Panel URLs | `https://www.doesthedogdie.com/` (attribution link + the current game's DDD page) |
| Allowlisted Config URLs | `https://www.doesthedogdie.com/` (match check + attribution links) |

## 4. Monetization (required to reach Hosted Test)
| Field | Value |
|---|---|
| Will you monetize (Bits) | **No** |
| Subscription Status | **None** |

## 5. Settings (extension level, not per version)
Copy into the EBS environment (`.env` locally, host secrets in production):

| Console item | Env var |
|---|---|
| Client ID | `TWITCH_EXT_CLIENT_ID` |
| Client Secret (generate) | `TWITCH_EXT_CLIENT_SECRET` |
| Extension Secret (base64 key under Extension Client Configuration) | `TWITCH_EXT_SECRET` |
| Your numeric Twitch user ID | `TWITCH_EXT_OWNER_ID` |

## 6. Version Details (listing / Discovery)
| Field | Value |
|---|---|
| Summary (≤140*) | See the content warnings voters confirmed for the game being streamed, grouped by category and searchable. Spoiler-free. *(120 chars)* |
| Description (≤1,024) | Text below *(824 chars)* |
| Viewer Summary (≤140) | Tap a category to see its confirmed warnings, or search for a specific trigger. Updates when the streamer switches games. *(121 chars)* |
| Author Name | cyber31415 |
| General Category | **Extension for Games** |
| Category (required, up to 15 Twitch categories; discovery only, the panel works on every game) | Story-heavy / horror games, e.g. The Last of Us Part I, The Last of Us Part II, Resident Evil 4, Silent Hill 2, Alan Wake 2, Dead Space, Outlast, Phasmophobia, Baldur's Gate 3, Red Dead Redemption 2 |
| Taskbar Icon Image (24×24) | *(skip: video extensions only)* |
| Logo Image (100×100 PNG) | `assets/listing/logo-100.png` |
| Discovery Image (300×200 PNG) | `assets/listing/discovery-300x200.png` |
| Screenshots (4:3, 1024×768, <10 MB) | `assets/listing/screenshot-1.png`, `-2.png`, `-3.png` |
| Author Email (private; click the verification mail) | *your email* |
| Support Email (public) | CyberSpaceman09@proton.me |
| Privacy Policy URL | `https://cyber31415.github.io/game-content-warnings/privacy.html` (GitHub Pages; rebuild with `scripts/build-legal-pages.ts`) |
| EULA / Terms of Service URL | `https://cyber31415.github.io/game-content-warnings/terms.html` |

Description:

```
An unofficial panel that lists the content warnings DoesTheDogDie.com voters have confirmed for the game the channel is playing, such as animal death, jump scares, gore or self-harm. Not affiliated with or endorsed by DoesTheDogDie.com.

- Only confirmed "Yes" warnings, grouped into clear categories that start collapsed
- Search at the top, including synonyms ("dog" also finds "a pet dies")
- Updates automatically when the streamer switches category
- No story spoilers and no extra detail, just the triggers
- Light and dark mode, works on mobile

Streamers can correct the matched game from the configuration page. Warnings describe the game in general, not necessarily what happens on stream, and are crowd-sourced, so they may be incomplete.

The extension stores no viewer information. Powered by DoesTheDogDie.com.
```

## 7. Files (Hosted Test)
```fish
EBS_URL=https://game-content-warnings.onrender.com node scripts/build-frontend.ts --zip     # -> dist/frontend-0.1.0.zip (~15 KB)
```
Upload the zip, then **Move to Hosted Test**. Access tab: the owner account is allowed by default;
add test accounts or streamers if others should see it.

## 8. Submit for Review
The form has two fields plus a checkbox. Before submitting, activate the extension as a panel on the
review channel: the version under review must stay activated there for the whole review.

- **Name of Channel for Review:** `https://www.twitch.tv/cyberspaceman_`
- **Walkthrough Guide and Change Log** (one box, v0.1.0 as submitted):

```
WALKTHROUGH

What it does: a panel that lists the content warnings DoesTheDogDie.com voters have confirmed for the channel's current game category. Viewers only read it (no input, no accounts, no viewer data stored). It updates by itself when the broadcaster changes category. It is labelled "Unofficial" and states that it is not affiliated with DoesTheDogDie.com.

Review channel: the extension is installed and activated as a panel on twitch.tv/cyberspaceman_. It is a panel, so the channel does not need to be live. The category will stay on "The Last of Us Part I" during the review so the panel has data to show. If you need the category changed at a set time, email CyberSpaceman09@proton.me.

Viewer panel (below the video on twitch.tv/cyberspaceman_):
1. The header reads "Content warnings" with an "Unofficial" badge and the number of confirmed warnings.
2. Warnings are grouped under broad categories, all collapsed at first, each showing a count. Click a category to expand it.
3. Type in the search box at the top (for example "dog"). Matching warnings from every category appear, including related terms. Clear the box to go back to the categories.
4. At the bottom: a short disclaimer, an "Updated" date, "Powered by DoesTheDogDie.com", and a link to the current game's DoesTheDogDie page. Both links go to doesthedogdie.com, open in a new tab and are marked with ↗.
5. When the broadcaster changes category, the panel switches to the new game within seconds without reloading. A non-game category such as "Just Chatting" shows "No content warning data found for this category."

Broadcaster configuration page (Extensions manager > Configure), optional:
6. Shows which DoesTheDogDie entry was matched to the current category, with a link to check it.
7. "Wrong game? Search for the right one" lets the broadcaster pick a different entry ("Use this"). "Use automatic matching" undoes that. There are no other settings. Viewers always see every confirmed warning, unedited.

Note: the backend runs on a free host that sleeps after 15 minutes without traffic. The first load after a quiet period can take up to about a minute. The panel shows a loading state and retries by itself, and after that it responds immediately.

Technical details:
- Backend: https://game-content-warnings.onrender.com (Node.js/TypeScript, open source at https://github.com/cyber31415/game-content-warnings). The frontend fetches only /api/warnings, /api/topics and /api/broadcaster/* on that domain, which is in "Allowlist for URL Fetching Domains".
- The backend uses the Twitch API (channel info, EventSub channel.update, Extension PubSub, and the Extension Configuration Service developer segment, which stores broadcasters' game-match corrections) and the DoesTheDogDie API.
- Frontend: unminified TypeScript compiled to plain ES modules, no third-party libraries. The Twitch helper is the first script on every page.
- The Streamer Allowlist is intentionally limited to two channels for a small first release.

CHANGE LOG
0.1.0: initial release.
```

## Gotchas
- Only one version can be in Review, and an approved-but-unreleased version also blocks the slot.
- Editing any version field sends it back to Local Test.
- In Hosted Test the allowlists are enforced: if the panel shows "unavailable", check
  "Allowlist for URL Fetching Domains" first.
- Mobile testing: the phone must be signed in as the owner or an allowlisted test account.
