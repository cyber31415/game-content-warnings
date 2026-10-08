# DoesTheDogDie API: terms and limits (summary)

Read 2026-10-07 from https://www.doesthedogdie.com/api, /api/3.0 and /api/terms
(Terms v1.0, effective 2026-08-07). This is a summary, not legal advice; re-read before launch.

| Topic | What it says | What we do |
|---|---|---|
| Tiers | Free: 30 req/min, 5,000/month, **non-commercial only**. Commercial: $50/mo, 600/min, 500,000/month | Client limits itself to 20/min; aggressive caching; quota tracked from `X-RateLimit-*` headers |
| Commercial use (§9.1) | Free tier may not be used by apps that charge users, earn from ads/sponsorship/affiliates, or are run for a for-profit business | Extension is free with no monetization. **Open question:** does running it on monetized Twitch channels count? Ask DDD before public launch |
| Attribution (§6) | Exact phrase "Powered by DoesTheDogDie.com", linked to https://www.doesthedogdie.com, on every view showing the data | Footer on panel and config page |
| Caching | Allowed "solely to improve performance"; refresh at least every 30 days; delete on termination | Items refreshed weekly, stale copies served only up to 30 days, purge job every 6 h |
| API key | Must not be shared | Lives only in the EBS environment |
| User-Agent | Generic client UAs (curl, node, axios, python-requests…) get HTTP 403 | EBS sends `TwitchContentWarningsEBS/0.1` |
| Spoiler/sensitive flags | Not in v3. v3 has a "Spoiler" topic category (cliffhanger, sad ending, end-credits scene, Santa spoiled) | Those topics are excluded (`SPOILER_CATEGORY_ID` in `ebs/src/topics.ts`); categories start collapsed |
| Display rule | DDD's site highlights Yes when yes > no; ties highlight nothing; voting needs a login + reCAPTCHA; some answers are moderator-"VERIFIED" (not exposed in v3) | Same rule: shown when yes > no, a single vote counts, ties hidden; "few votes" tag when fewer than 3 votes |
| Catalogue gaps | Item stats reference topics `/topics` doesn't list (e.g. "Someone attempts suicide") | Kept, grouped by keyword (`fallbackGroup`), logged once |

## Quota math (free tier)
- New category: 1–2 searches + 1 item fetch. Each matched item refreshes weekly (~4/month).
- ~5,000/month supports roughly 1,000 actively-streamed matched games. Beyond that, or if DDD
  says Twitch use is commercial, move to the Commercial tier.
