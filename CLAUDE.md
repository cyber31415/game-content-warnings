# Twitch Content-Warning Extension

Twitch panel extension showing DoesTheDogDie (DDD) content warnings for the channel's
current category. Background and decisions: `PROJECT_BRIEF.md`. How to run/deploy: `docs/SETUP.md`.

## Environment (important)
- Everything runs from the project venv: `bash scripts/bootstrap-venv.sh`, then
  `source .venv/bin/activate.fish` (or `.venv/bin/activate`). It holds Node 24, npm, the
  Twitch CLI, Python + Playwright (browser in `.venv/ms-playwright`).
- The repo is on a CIFS share **without symlinks or POSIX locks**:
  - npm uses `bin-links=false`; scripts call tools by path (`node node_modules/typescript/bin/tsc`). No npm workspaces.
  - SQLite on the share needs `DATABASE_VFS=unix-dotfile`. Never delete the DB while the EBS runs.
  - Twitch CLI state lives in `~/.local/state/twitch-content-warnings` (its SQLite can't live on the share).

## Commands
- `npm test` — EBS unit/integration tests (node:test, runs .ts directly)
- `npm run typecheck` — EBS + frontend (TypeScript 7)
- `bash scripts/local-stack.sh` — full stack on mocks; then `.venv/bin/python scripts/e2e-local.py`
- `npm run build:frontend` / `EBS_URL=https://... node scripts/build-frontend.ts --zip`

## Conventions
- Node runs TypeScript natively: erasable syntax only (no enums/namespaces/parameter
  properties), relative imports end in `.ts`. Shared API types live in `shared/api.d.ts` (types only).
- Frontend: no bundler, no minification (Twitch review needs readable JS), no remote
  scripts except the Twitch helper (must be first). Render API data with `textContent` only.
- EBS: `channel_id`/role only from the verified JWT. Validate every upstream response with zod.
  Upstream failures become `status: "error"`, never a 5xx to viewers. Don't log viewer identifiers.
- DDD terms: show "Powered by DoesTheDogDie.com" (linked) wherever DDD data appears; keep the
  API key server-side; cached DDD data must never be older than 30 days; Free tier is non-commercial.
- A wrong match is worse than none: prefer `low_confidence` / `no_match`.
