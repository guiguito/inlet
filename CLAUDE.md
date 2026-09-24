# Inlet

Self-hosted feedback + crash collector. npm workspaces monorepo, Node ≥22.
Read first: `CONTRIBUTING.md` (rules), `docs/DECISIONS.md` (why things are the way they are), `docs/PRD.md` + `docs/prd/*.md` (requirements, cited in code as `FR-xxx`).

## Layout
- `packages/shared` — domain types/schemas; build it before anything else (`npm run build:deps`)
- `packages/sdk` — `inlet-sdk`, the only package published to npm; versioned independently
- `apps/api` — Fastify 5 + Drizzle + Postgres + S3 (MinIO locally)
- `apps/web` — React 19 + Vite
- `apps/mcp` — MCP tools (stdio, and HTTP at `/v1/mcp` via the API's `app.inject`)
- `e2e/` — Playwright (`api/`, `ui/`)

## Commands
```bash
npm run services:up        # local Postgres (:5433) + MinIO (:9010) binaries, no Docker
npm run dev                # API :3000, web :5173 (needs .env from .env.example)
npm run typecheck
npm run test:all           # unit + integration + e2e; the gate before any PR
npm run test:unit -w @inlet/api     # fast loop
npm run openapi            # regenerate docs/openapi.json after any route/schema change; commit it
npm run db:generate        # then rename the migration + fix the tag in apps/api/drizzle/meta/_journal.json
```
There is no lint script. There is no CI either: typecheck and `test:all` are enforced by hand.

## Rules
- A behaviour change updates the PRD in the **same commit**: the Notion page and its `docs/prd/` mirror. Check drift with `node scripts/prd-parity.mjs <notion-fetch.json> docs/prd/x.md`.
- Every logic change needs a test that fails before it and passes after. Integration tests use a real Postgres/MinIO (the global setup starts them) through `apps/api/test/setup/harness.ts`. Don't use fakes.
- Migrations are additive only.
- `inlet-sdk` must stay zero-dependency and framework-free; `build.mjs` fails if a `.d.ts` still imports `@inlet/shared`. Run `npm pack -w inlet-sdk --dry-run` before publishing.
- Hosted forms are additive: the API submission path stays first-class, and no second submission path gets added.
- Test fixtures must not look like real credentials (secret scanners block pushes).
- Comments explain *why*. UI copy uses second person, present tense, no exclamation marks (PRD §20.6).
