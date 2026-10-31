# DoesTheDogDie API: terms and limits (summary)

Read 2026-10-07 and re-checked 2026-10-31 (still Terms v1.0, effective 2026-08-07) from
https://www.doesthedogdie.com/api, /api/3.0 and /api/terms. This is a summary, not legal advice; re-read
it before changing how the extension uses the data.

| Topic | What it says | What we do |
|---|---|---|
| Tiers | Free: 30 req/min, 5,000/month, **non-commercial only**. Commercial: $50/mo, 600/min, 500,000/month. Limits are per account. §10 lets DDD add other caps (e.g. unique titles per day); none are published as of 2026-10-31 | Client limits itself to 20/min; aggressive caching; quota tracked from `X-RateLimit-*` headers and shown on `/health` and `/usage` |
| Commercial use (§9.1) | Free tier may not be used by apps that charge users, earn from ads/sponsorship/affiliates, or are run for a for-profit business | §9.1 applies to the Application (this extension): it charges nothing, has no ads, Bits, sponsorship, affiliate links or data sales, and isn't run for a for-profit business, so Free tier fits. Streamers monetizing their own channels isn't the extension generating revenue (owner's decision, 2026-10-31). Revisit if the extension itself ever adds Bits, sponsorship or similar |
| Attribution (§6) | Exact phrase "Powered by DoesTheDogDie.com" (or a phrase they approve in writing), reasonably visible, on every view showing the data; hyperlink to https://www.doesthedogdie.com only "where the medium permits" | Plain-text footer on panel and config page. Twitch forbids off-site links (guideline 4.5; 0.1.0 was rejected for them), so no hyperlink |
| Caching | Allowed "solely to improve performance"; refresh at least every 30 days; delete on termination | Items refreshed weekly, stale copies served only up to 30 days, purge job every 6 h. The optional Turso copy keeps DDD data for 8 days only (`REMOTE_RETENTION_MS`): it can only be cleaned while the EBS runs (at startup and with the 6-hourly purge), so a row could outlive 30 days there only if the EBS slept 3+ weeks straight, and it's deleted before anything is loaded at the next start. Retiring the extension: delete the Turso database |
| API key | §2.1: "You may not share your API Key with any third party", and no letting a third party use your credentials. A key authenticates *your* Application; its users are your "End Users" | Lives only in the EBS environment. One key (ours) serves every channel. Streamers can't bring their own keys: our backend using their key would be a third party using their credentials, and Twitch's configuration segments are readable by every viewer |
| User-Agent | Generic client UAs (curl, node, axios, python-requests…) get HTTP 403 | EBS sends `TwitchContentWarningsEBS/0.1` |
| Spoiler/sensitive flags | Not in v3. v3 has a "Spoiler" topic category (cliffhanger, sad ending, end-credits scene, Santa spoiled) | Those topics are excluded (`SPOILER_CATEGORY_ID` in `ebs/src/topics.ts`); categories start collapsed |
| Display rule | DDD's site highlights Yes when yes > no; ties highlight nothing; voting needs a login + reCAPTCHA; some answers are moderator-"VERIFIED" (not exposed in v3) | Same rule: shown when yes > no, a single vote counts, ties hidden; "few votes" tag when fewer than 3 votes |
| Listing screenshots | Data may be shown to End Users within the Application, never redistributed "as data" | `assets/listing/screenshot-*.png` show real usage: The Last of Us's actual warnings as the panel displays them, with the attribution. Kept real on purpose (owner's decision, 2026-10-31: no made-up content without a good reason). Raw API responses stay out of the repo |
| Catalogue gaps | Item stats reference topics `/topics` doesn't list (e.g. "Someone attempts suicide") | Kept, grouped by keyword (`fallbackGroup`), logged once |

## Quota math (free tier)
- New category: 1–2 searches + 1 item fetch. Each matched item refreshes weekly (~4/month).
- Waking the free host: without Turso, each start re-fetches the topic catalogue (3 requests) and
  every game it then serves. With Turso, data saved in the last 8 days is reloaded instead, at no
  cost (verified 2026-10-31: a restart made zero DDD requests); after a longer sleep it's re-fetched.
- ~5,000/month supports roughly 1,000 actively-streamed matched games once the cache survives
  restarts. Beyond that, or if the extension itself ever becomes commercial, move to the Commercial tier.
