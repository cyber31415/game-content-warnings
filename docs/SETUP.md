# Setup: from local mocks to a live Twitch extension

## How category changes reach viewers

```
Streamer changes category
  ├─► Twitch.ext.onContext in every viewer's panel ("game" changed)
  │     └─► panel re-fetches GET /api/warnings?hint=<game>  (EBS re-checks Helix early)
  │           (works in Local Test and without any public EBS)
  └─► EventSub channel.update ──webhook──► EBS /eventsub (HMAC verified)
        └─► EBS recomputes warnings ──► Extension PubSub "broadcast" ──► every panel re-renders
              (needs the EBS on public HTTPS + EVENTSUB_* set; subscriptions are created
               automatically the first time a channel's panel or config page loads)
Safety net: each panel polls every ~5 min (jittered, paused while hidden).
```

## 0. Environment
```fish
bash scripts/bootstrap-venv.sh
source .venv/bin/activate.fish
npm install
npm test && npm run typecheck
```

## 1. Try it locally against mocks (needs only a DDD API key)
The mock DDD server replays real DDD responses, which aren't committed (DDD's terms forbid
redistributing them). Capture them once with your own key first (see step 2):
`node --env-file=.env scripts/capture-ddd-fixtures.ts`.

```fish
bash scripts/local-stack.sh            # Twitch mock API, mock DDD, EBS, HTTPS dev server
.venv/bin/python scripts/e2e-local.py  # in another terminal: browser checks + screenshots
```
Open https://localhost:8080/harness/panel.html once and accept the self-signed certificate.
Screenshots land in `data/screenshots/`.

## 2. DoesTheDogDie API key
1. Create a DDD account, copy the API key from your profile page.
2. `cp .env.example .env`, fill `DDD_API_KEY`.
3. `node --env-file=.env scripts/capture-ddd-fixtures.ts` captures real responses and checks
   them against our schemas (~6 requests). Confirm which `itemTypeName` video games use.
4. Read `docs/ddd-terms-notes.md`. Ask DDD whether a free Twitch extension used on monetized
   channels counts as commercial use **before** public release.

## 3. Twitch Developer Console (dev.twitch.tv/console/extensions)

Every field, value and upload is listed in **`docs/CONSOLE.md`**. The steps below are the short version.
1. Enable 2FA on your Twitch account, then **Create Extension**. Pick a name that doesn't use "Twitch".
2. Version settings:
   - **Asset Hosting**: Testing Base URI `https://localhost:8080/`, Panel Viewer Path `panel.html`,
     Config Path `config.html`, panel height 500. Tick **Mobile** support and set the Mobile Path
     to `panel.html` too (the layout is fluid and works at phone width).
   - **Capabilities**: configuration via **Extension Configuration Service** (segment versions blank).
     **Allowlist for URL Fetching Domains**: your EBS origin (allowlists aren't enforced in Local Test).
3. Extension **Settings**: generate the **Client Secret**, copy the **Extension Secret** (base64 key
   under Extension Client Configuration) and the **Client ID** into `.env`. Set `TWITCH_EXT_OWNER_ID`
   to your numeric user ID.
4. Check matching quality on real data: `node --env-file=.env scripts/match-audit.ts --top 50`
   (~100 DDD requests) → `data/match-audit-<date>.md` (kept out of git: it contains DDD data).
   Review every `matched` row.

## 4. Local Test on your own channel
```fish
# .env: ALLOWED_ORIGINS=https://localhost:8080,https://<client id>.ext-twitch.tv
npm run dev                                      # EBS on 127.0.0.1:8081
node --env-file=.env scripts/dev-frontend.ts     # https://localhost:8080 (proxies /ebs)
```
In the console, open the version's **Status** page → **View on Twitch and Install**, install it
on your channel, activate it as a panel, and switch categories to watch it update.

## 5. Deploy the EBS (needed for Hosted Test, review and live updates)

**Render free tier (current setup):** `render.yaml` describes the service. In Render: **New → Blueprint**,
pick this repo, and paste the five secrets it asks for (from your local `.env`). Render builds the
Dockerfile, gives it `https://<name>.onrender.com`, generates `EVENTSUB_SECRET`, and points the EventSub
callback at `$RENDER_EXTERNAL_URL/eventsub` automatically. Free services sleep after 15 minutes idle
(first request then takes ~30–60 s) and start with an empty cache; broadcaster corrections survive
because they're stored in Twitch's configuration service (`CORRECTIONS_STORE=twitch`).

**Any other host:**
Any host with HTTPS on port 443 and a persistent disk for SQLite. The `Dockerfile` runs the EBS;
mount a volume at `/data` and set the variables from `.env.example` with:
- `NODE_ENV=production`, no `DATABASE_VFS`, no localhost in `ALLOWED_ORIGINS` (leave it empty)
- `EVENTSUB_CALLBACK_URL=https://<your-ebs-host>/eventsub`, `EVENTSUB_SECRET=<random 10-100 chars>`

Add `https://<your-ebs-host>` to **Allowlist for URL Fetching Domains**.

## 6. Hosted Test
```fish
EBS_URL=https://<your-ebs-host> node scripts/build-frontend.ts --zip
```
Upload `dist/frontend-<version>.zip` under the version's **Files**, then move the version to
**Hosted Test** and test on your channel again (category switches, offline channel, config page).

## 7. Review submission
Twitch requires, before submitting: Privacy Policy URL, EULA/Terms URL, a walkthrough guide for
reviewers, changelog, and a testing channel. The frontend is already unminified; the only remote
script is the Twitch helper. Then **Submit for Review**. Once approved, **Release** it and it
appears in the extension directory for any streamer to activate.

## Operations
- `data/match-audit-*.md` and the `game_map` table (`status != 'matched'`) show categories that
  need a manual mapping. Permanent pins belong in `ebs/src/match/manual-mappings.ts` (applied at
  every start, so they reach any server); `node --env-file=.env scripts/map-game.ts list | set | clear`
  inspects or edits one database directly.
- Watch the DDD quota: `GET /health` reports `dddQuota` (from DDD's rate-limit headers). 429s open a local
  circuit until `Retry-After`; viewers keep seeing cached data meanwhile.
