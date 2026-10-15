# Rank Well: AI SEO

SEO and AI-search (GEO) toolkit for Shopify stores: full-site audit, meta tags,
image alt text, structured data, llms.txt, broken links and 404 redirects,
image optimization, speed, and (coming) AI blog posts, rank tracking and competitor analysis.
See `docs/PLAN.md` for the roadmap.

## Run locally

```sh
npm install
shopify app config link     # once: creates/links the Partner app, fills client_id
shopify app dev
```

Needs a Postgres `DATABASE_URL` (e.g. a local Docker Postgres).

## Environment

| Variable | |
|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | from the Partner dashboard |
| `SHOPIFY_APP_URL` | public URL of this server |
| `SCOPES` | same list as `shopify.app.toml` |
| `DATABASE_URL` | Postgres |
| `RANKLIFT_AI_KEY` | Anthropic or OpenAI-compatible key (`RANKLIFT_AI_PROVIDER`, `RANKLIFT_AI_MODEL`, `RANKLIFT_AI_MODEL_BIG`, `RANKLIFT_AI_BASE_URL` optional) |
| `RANKLIFT_PSI_KEY` | optional Google API key (PageSpeed Insights API enabled) for speed tests; without it they use Google's shared quota |
| `RANKLIFT_WORKERS` | parallel background jobs per process (default 3) |
| `RANKLIFT_WORKER=off` | run a web-only container |

## Deploy

Docker image (see `Dockerfile`); `npm run docker-start` runs migrations then the
server. App config and the theme extension deploy with `shopify app deploy`.
