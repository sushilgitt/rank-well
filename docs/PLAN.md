# Rank Well — plan

Rank Well is a from-scratch rebuild of the feature set of the SEO Master app (now
"SEOWILL: AI SEO & AI Blog Post", apps.shopify.com/seo-master): an SEO and GEO
(AI-search) toolkit for Shopify stores. We copy features, never their name,
copy, screenshots or branding.

Brand name "Rank Well". Existing `ranklift` technical identifiers remain for installed stores.

## Stack

Same as CartLift, so deploys and habits carry over:

- React Router 7 Shopify app template, Polaris web components (`s-*`), App Bridge
- Postgres + Prisma, deployed as one Docker container on Coolify
- Background work: a Postgres-backed job queue (`Job` table, `FOR UPDATE SKIP
  LOCKED`) with an in-process worker — no Redis to run
- Theme app extension (app embeds) for everything that touches the storefront, so
  uninstall leaves nothing behind (their #1 complaint)
- App proxy (`/apps/ranklift/*`) for llms.txt, 404 reporting and the HTML sitemap
- AI through `app/lib/ai.server.ts` (Anthropic or any OpenAI-compatible API)
- Keyword / SERP / competitor data: DataForSEO (pay per call), Google Search
  Console API (free, merchant connects with OAuth)

## Feature parity checklist

Status: [ ] todo, [~] in progress, [x] done

### Phase 1 — foundation and core SEO
- [x] App shell, nav, dashboard with SEO score
- [x] Job queue + worker (crawls, bulk edits, AI batches) with progress UI
- [x] Credits ledger (AI credits per plan per 30-day period, overage OFF by default)
- [x] Full-site audit: crawls the **rendered storefront HTML** (not admin fields)
      for products, collections, pages, articles, home
  - title missing/too short/too long (rendered `<title>`), meta description,
    H1 count, missing alt, thin content, duplicate titles/descriptions,
    canonical, noindex, broken internal links, image weight, JSON-LD present,
    Open Graph, URL length/handle quality
  - per-page score + site score, issue list with "fix" actions
- [x] Meta tags: per-resource editor + bulk editor + templates
      (`{{product.title}} | {{shop.name}}`) + auto-apply to new products
- [x] AI meta title/description generation (credits)
- [x] Image alt text: template + AI (vision) alt text, bulk
- [x] Structured data app embed: Organization, WebSite+SearchAction,
      Product (offers, aggregateRating from judge.me metafields), Breadcrumb,
      Article, FAQ (metafield), How-To (metafield), LocalBusiness
- [x] llms.txt via app proxy, generated from shop/products/collections/pages
- [x] Broken links scan + one-click and automatic redirects (`urlRedirectCreate`)
- [x] 404 monitor (app embed beacon) + auto-redirect rules
- [ ] Robots/noindex controls (`seo.hidden` metafield)
- [x] Product FAQs (AI draft + editor) → FAQPage JSON-LD (pulled forward from Phase 3)

### Phase 2 — speed and images
- [x] Image compression (sharp → re-upload media) with **backup + restore**
      (originals kept in the merchant's Files as `rankwell-original-…`)
- [x] Image file rename for SEO, WebP. Shopify ties a file's MIME type to its
      extension, so originals keep their format; the CDN already serves WebP/AVIF
- [x] Speed app embed: instant-click prefetch, lazy loading, preconnect,
      "Rocket" and "Turbo" levels
- [x] Core Web Vitals via PageSpeed Insights API, before/after report

### Phase 3 — content and AI blog
- [ ] Keyword content planner (topic clusters from catalog + DataForSEO)
- [ ] AI blog generator: outline → draft → embedded products, images, FAQ
- [ ] Bulk article creation, scheduling, multi-language
- [ ] Article editor (rich text), templates
- [ ] AI internal linking (products ↔ articles ↔ collections)
- [ ] AI content optimization (product descriptions, collection copy) by intent
- [ ] Blog storefront extras: related posts, TOC, search (app blocks)

### Phase 4 — analytics and GEO
- [ ] Google Search Console connect: clicks, impressions, queries, pages
- [ ] Rank tracking (DataForSEO SERP, daily/weekly)
- [ ] Competitor GEO & SEO analysis (crawl competitor, compare)
- [ ] AI search visibility checks (ask LLMs about the brand/category, record
      whether the store is mentioned)
- [ ] Sitemap health, HTML sitemap page, local SEO (LocalBusiness)
- [ ] Translations (`translationsRegister`) for meta and alt in all store locales

### Phase 5 — polish and launch
- [ ] Plans via Shopify managed pricing: Free / Pro / Premium (+ annual)
- [ ] Shopify Flow triggers/actions, Sidekick (app tools)
- [ ] Admin in multiple languages
- [ ] Onboarding, support, App Store listing, Built for Shopify checks
- [ ] Privacy policy page, usage-based overage billing (Shop.overage is stored but has no UI until billing exists)

## Plans (draft, mirrors their limits)

| | Free | Pro | Premium |
|---|---|---|---|
| Audit pages | 20 | 1,000 | unlimited |
| AI credits / 30 days | 30 | 200 | 500 |
| Image compressions / 30 days | 50 | 2,000 | 6,000 |
| JSON-LD, llms.txt, bulk meta, auto redirects | — | ✓ | ✓ |
| Speed | basic | Rocket | Turbo |
| Competitor analysis, internal linking | — | — | ✓ |
