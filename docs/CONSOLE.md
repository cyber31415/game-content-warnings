# Developer Console worksheet

Field-by-field values for https://dev.twitch.tv/console/extensions. Field names as Twitch
documents them (labels can drift slightly). Requirements checked 2026-10-07; character limits
marked * come from third-party guides, so trust the console's own counter.

Backend: `https://game-content-warnings.onrender.com` (Render free tier).

## 1. Create Extension
| Field | Value |
|---|---|
| Name (unique, ≤40*, no "Twitch"/"extension") | **Game Content Warnings (Unofficial)** *(34 chars. Keep "DoesTheDogDie" out of the name: it's their trademark and their API terms §19.4 forbid implying endorsement. To rename, change `EXT_NAME` and rerun `scripts/make-listing-assets.py`)* |
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
| Configuration | **Custom/My Own Service** (the only per-channel setting, a game-match correction, is stored by our EBS) |
| Required Per Channel Configuration | *(blank: no setup required before activation)* |
| Allowlist for URL Fetching Domains | `https://game-content-warnings.onrender.com` (add `https://localhost:8080` while testing; not enforced in Local Test) |
| Allowlist for Image Domains | *(blank)* |
| Allowlist for Media Domains | *(blank)* |
| Allowlisted Panel URLs | `https://www.doesthedogdie.com/` (attribution link + the current game's DDD page) |
| Allowlisted Config URLs | `https://www.doesthedogdie.com` (match check + attribution links) |

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
| Privacy Policy URL | `https://game-content-warnings.onrender.com/privacy` (served by the EBS; set `CONTACT_EMAIL`, `OPERATOR_NAME`) |
| EULA / Terms of Service URL | `https://game-content-warnings.onrender.com/terms` |

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
EBS_URL=https://game-content-warnings.onrender.com node scripts/build-frontend.ts --zip     # -> dist/frontend-0.1.0.zip (~12 KB)
```
Upload the zip, then **Move to Hosted Test**. Access tab: the owner account is allowed by default;
add test accounts or streamers if others should see it.

## 8. Submit for Review
- **Review Channel URL:** your channel (panel-only extensions don't need to be live; offer 9am–5pm PT
  windows if asked).
- **Walkthrough Guide** (v1):

```
What it does: a panel listing DoesTheDogDie.com content warnings confirmed for the channel's current game category.

Testing steps
1. Activate the extension as a panel on the review channel (no configuration needed).
2. Set the channel category to a game, e.g. "The Last of Us". The panel shows categories with counts; tap one to expand. Use the search box ("dog").
3. Change the category to another game: the panel updates within seconds without reloading.
4. Set the category to "Just Chatting": the panel says no data was found.
5. Configuration page (broadcaster): shows the matched game; "Wrong game? Search" lets the broadcaster pick a different DoesTheDogDie entry.

Backend: https://game-content-warnings.onrender.com (Node.js/TypeScript). Endpoints fetched by the frontend: https://game-content-warnings.onrender.com/api/warnings, https://game-content-warnings.onrender.com/api/topics, https://game-content-warnings.onrender.com/api/broadcaster/*. All are listed in "Allowlist for URL Fetching Domains". The EBS calls the Twitch API (channel info, EventSub channel.update, Extension PubSub) and the DoesTheDogDie API.
Frontend: unminified TypeScript compiled to plain ES modules, no third-party libraries; the Twitch helper is the first script on every page.
Off-site links (all marked with ↗, all to doesthedogdie.com): "Powered by DoesTheDogDie.com" (attribution required by the DDD API terms), the current game's DDD page at the bottom of the panel, and on the config page a link to check the matched game. The panel labels itself "Unofficial" and states it is not affiliated with DoesTheDogDie.com.
```

- **Change Log:** `0.1.0: initial release.`

## Gotchas
- Only one version can be in Review, and an approved-but-unreleased version also blocks the slot.
- Editing any version field sends it back to Local Test.
- In Hosted Test the allowlists are enforced: if the panel shows "unavailable", check
  "Allowlist for URL Fetching Domains" first.
- Mobile testing: the phone must be signed in as the owner or an allowlisted test account.
