import type { Prisma, SpeedTest } from "@prisma/client";
import prisma from "../db.server";
import { PermanentError, registerJob } from "./jobs.server";
import { isPasswordRedirect, parsePsi, type PsiResult, type SpeedPage, type Strategy } from "./psi";
import { absolute, listCollections, listProducts } from "./resources.server";
import { storefrontUrl, type AdminGraphql } from "./shop.server";

/**
 * Core Web Vitals through Google's PageSpeed Insights API. Works without a
 * key on Google's shared quota; set RANKLIFT_PSI_KEY (a Google Cloud API key
 * with the PageSpeed Insights API enabled) for a quota of its own.
 */

const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
export const STRATEGIES: Strategy[] = ["mobile", "desktop"];

async function runPsi(url: string, strategy: Strategy): Promise<PsiResult> {
  const query = new URLSearchParams({ url, strategy, category: "performance" });
  if (process.env.RANKLIFT_PSI_KEY) query.set("key", process.env.RANKLIFT_PSI_KEY);
  const response = await fetch(`${PSI}?${query}`, { signal: AbortSignal.timeout(150_000) });
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (response.status === 429) {
    throw new PermanentError("Google's PageSpeed service is busy right now. Try again in a few minutes.");
  }
  if (!response.ok || !body || body.error) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    console.error(`PageSpeed Insights failed for ${url} (${strategy}): ${message}`);
    // Lighthouse errors (page didn't load, timed out) won't change on a retry.
    if (response.status >= 400 && response.status < 500) throw new PermanentError(`PageSpeed couldn't test ${url}: ${message}`);
    throw new Error(`PageSpeed couldn't test ${url}: ${message}`);
  }
  return parsePsi(body);
}

/** The storefront URL to test for a page type: the home page, or the newest published product / a collection. */
export async function pageUrl(admin: AdminGraphql, shop: { domain: string; primaryUrl: string | null }, page: SpeedPage) {
  const base = storefrontUrl(shop);
  if (page === "home") return `${base}/`;
  if (page === "product") {
    const products = await listProducts(admin, 10, "status:active");
    const url = products.find((p) => p.url)?.url;
    if (!url) throw new PermanentError("No product is published to the online store yet.");
    return absolute(new URL(url).pathname, base);
  }
  const collection = (await listCollections(admin, 1))[0];
  if (!collection?.url) throw new PermanentError("The store has no collections yet.");
  return absolute(collection.url, base);
}

export interface SpeedPayload {
  page: SpeedPage;
}

registerJob("speed.test", async (ctx) => {
  const { page } = ctx.job.payload as unknown as SpeedPayload;
  const url = await pageUrl(ctx.admin, ctx.shop, page);
  await ctx.progress(0, STRATEGIES.length);
  const results: Record<string, number | null> = {};
  for (let i = 0; i < STRATEGIES.length; i++) {
    if (await ctx.cancelled()) break;
    const strategy = STRATEGIES[i];
    const result = await runPsi(url, strategy);
    if (isPasswordRedirect(result.finalUrl)) {
      throw new PermanentError(
        "Your storefront is password-protected, so Google can only see the password page. Remove the password (Online Store → Preferences) to measure real pages.",
      );
    }
    await prisma.speedTest.create({
      data: {
        shopId: ctx.shop.id,
        url,
        page,
        strategy,
        score: result.score,
        lcpMs: result.lcpMs,
        cls: result.cls,
        tbtMs: result.tbtMs,
        fcpMs: result.fcpMs,
        siMs: result.siMs,
        field: (result.field ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    results[strategy] = result.score;
    await ctx.progress(i + 1);
  }
  return { page, url, scores: results };
});

/**
 * Before/after per page and device: the first test since the history was last
 * cleared is "before", the newest is "after".
 */
export async function speedReport(shopId: string) {
  const tests = await prisma.speedTest.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } });
  const rows: { page: SpeedPage; strategy: Strategy; before: SpeedTest; after: SpeedTest | null; runs: number }[] = [];
  for (const page of ["home", "product", "collection"] as SpeedPage[]) {
    for (const strategy of STRATEGIES) {
      const runs = tests.filter((t) => t.page === page && t.strategy === strategy);
      if (!runs.length) continue;
      rows.push({ page, strategy, before: runs[0], after: runs.length > 1 ? runs[runs.length - 1] : null, runs: runs.length });
    }
  }
  return rows;
}
