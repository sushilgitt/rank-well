# RankLift — notes for agents

SEO & GEO toolkit for Shopify (React Router 7 app template, Polaris web
components, Prisma/Postgres). Plan and feature checklist: `docs/PLAN.md` —
tick items there in the same commit that finishes them.

## Layout
- `app/lib/audit/` — the audit: `parse.ts` (HTML → facts), `rules.ts` (pure
  rules + scoring), `audit.server.ts` (crawl job). Rules run on the **rendered**
  storefront HTML, never on admin fields alone.
- `app/lib/jobs.server.ts` — Postgres job queue. Long work (crawls, bulk edits,
  AI batches) is a job: `registerJob(type, handler)` in its module, imported by
  `app/lib/worker.server.ts`. The admin polls `/app/jobs/:id`.
- `app/lib/usage.server.ts` + `plans.ts` — metered usage. Charge with `spend()`
  before the work and `refund()` if it fails.
- `app/lib/settings.ts` — typed `Shop.settings` with defaults. Saving through
  `saveSettings()` (context.server.ts) republishes the storefront config.
- `app/lib/publish.server.ts` — the app-data metafield `ranklift.config` that the
  theme app extension reads. The storefront never needs theme-code edits.
- `extensions/ranklift-seo/` — app embed: JSON-LD, speed script, 404 beacon.
- `app/routes/proxy.*` — app proxy (`/apps/ranklift/*`): llms.txt, 404 reports.

## AI
All model calls go through `app/lib/ai.server.ts` (`RANKLIFT_AI_*` env vars;
Anthropic or any OpenAI-compatible API). Never add a provider SDK.

## Checks
`npm run typecheck`, `npm run lint`, `npm test` must pass before a commit.
