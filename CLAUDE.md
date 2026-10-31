# Twitch Content-Warning Extension

Twitch panel extension showing DoesTheDogDie (DDD) content warnings for the channel's
current category. Background and decisions: `PROJECT_BRIEF.md`. How to run/deploy: `docs/SETUP.md`.

## Environment (important)
- Everything runs from the project venv: `bash scripts/bootstrap-venv.sh`, then
  `source .venv/bin/activate.fish` (or `.venv/bin/activate`). It holds Node 24, npm, the
  Twitch CLI, the GitHub CLI, `sqld` (local libSQL server) and the Turso CLI, Python + Playwright
  (browser in `.venv/ms-playwright`).
- The repo is on a CIFS share **without symlinks or POSIX locks**:
  - npm uses `bin-links=false`; scripts call tools by path (`node node_modules/typescript/bin/tsc`). No npm workspaces.
  - SQLite on the share needs `DATABASE_VFS=unix-dotfile`. Never delete the DB while the EBS runs.
  - Twitch CLI state lives in `~/.local/state/twitch-content-warnings` (its SQLite can't live on the share);
    the Turso CLI's config is kept there too.

## Commands
- `npm test` — EBS unit/integration tests (node:test, runs .ts directly)
- `npm run typecheck` — EBS + frontend (TypeScript 7)
- `bash scripts/local-stack.sh` — full stack on mocks; then `.venv/bin/python scripts/e2e-local.py`
- `npm run build:frontend` / `EBS_URL=https://... node scripts/build-frontend.ts --zip`
- `TURSO_TEST_URL=http://127.0.0.1:8097 npm test` — also runs the real libSQL round trip (start
  `.venv/bin/sqld --http-listen-addr 127.0.0.1:8097 --db-path <local dir>` first; not on the CIFS share)
- `.venv/bin/python scripts/usage-report.py` — readable `/usage` summary (`--save`/`--since` for
  before/after snapshots). It contacts the live backend: only run it when the owner asks.

## Conventions
- Node runs TypeScript natively: erasable syntax only (no enums/namespaces/parameter
  properties), relative imports end in `.ts`. Shared API types live in `shared/api.d.ts` (types only).
- Frontend: no bundler, no minification (Twitch review needs readable JS), no remote
  scripts except the Twitch helper (must be first). Render API data with `textContent` only.
- EBS: `channel_id`/role only from the verified JWT. Validate every upstream response with zod.
  Upstream failures become `status: "error"`, never a 5xx to viewers. Don't log viewer identifiers.
- DDD terms: show "Powered by DoesTheDogDie.com" wherever DDD data appears, as plain text; keep the
  API key server-side; cached DDD data must never be older than 30 days; Free tier is non-commercial.
- A wrong match is worse than none: prefer `low_confidence` / `no_match`.
- Broadcaster corrections are per Twitch category and stored in the channel's Twitch developer
  configuration segment in production (`CORRECTIONS_STORE=twitch`); SQLite is only a cache/mirror,
  because Render's free disk is wiped whenever the service sleeps.
- With `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` set, `cache/mirror.ts` copies the DDD cache and usage
  totals to Turso (HTTP API, `cache/turso.ts`) and restores them at startup. Local SQLite stays the
  working copy; Turso must never be able to break serving. The Turso copy keeps DDD data for 8 days
  only (`REMOTE_RETENTION_MS`), because it can't be cleaned while the free host sleeps. Local libSQL
  server for tests: `.venv/bin/sqld`.
- Product rules: Yes-only list, no story spoilers, no descriptions/vote counts, no topic hiding,
  always labelled "Unofficial" (see README).
- No links in the extension at all: Twitch rejected 0.1.0 under guideline 4.5 for its
  doesthedogdie.com links, and text that points viewers to the site instead isn't allowed either.
