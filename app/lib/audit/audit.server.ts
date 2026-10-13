import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { PermanentError, registerJob, type JobContext } from "../jobs.server";
import { listArticles, listCollections, listPages, listProducts, absolute, type Resource } from "../resources.server";
import { readSettings } from "../settings";
import { storefrontUrl } from "../shop.server";
import { Storefront, mapLimit, sameHost } from "../storefront.server";
import { usageFor, spend } from "../usage.server";
import { isPasswordPage, parsePage } from "./parse";
import { checkDuplicates, checkPage, pageScore, siteScore, summarize, type Issue } from "./rules";

/**
 * The full-site audit: lists every published resource from the Admin API,
 * fetches each storefront page, runs the rules on the rendered HTML, then
 * checks every internal link found on those pages.
 */

const PAGE_CONCURRENCY = 4;
const LINK_CONCURRENCY = 8;
const MAX_LINKS = 2000;

interface Target {
  url: string;
  resourceType: string;
  resourceId: string | null;
}

async function targets(ctx: JobContext, base: string, limit: number): Promise<Target[]> {
  // Fair share per type, so a 5,000-product store still audits its pages.
  const per = Number.isFinite(limit) ? Math.max(5, Math.ceil(limit / 3)) : Infinity;
  const [products, collections, pages, articles] = await Promise.all([
    listProducts(ctx.admin, per),
    listCollections(ctx.admin, per),
    listPages(ctx.admin, per),
    listArticles(ctx.admin, per),
  ]);
  const toTarget = (resource: Resource): Target | null =>
    resource.url ? { url: absolute(resource.url, base), resourceType: resource.type, resourceId: resource.id } : null;

  // Interleave types so a cut at `limit` keeps a mix.
  const lists = [products, collections, pages, articles].map((list) =>
    list.map(toTarget).filter((t): t is Target => Boolean(t)),
  );
  const all: Target[] = [{ url: absolute("/", base), resourceType: "home", resourceId: null }];
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (i < list.length) all.push(list[i]);
  }
  return all.slice(0, Number.isFinite(limit) ? limit : undefined);
}

async function runAudit(ctx: JobContext) {
  const { shop, job } = ctx;
  const settings = readSettings(shop.settings);
  const base = storefrontUrl(shop);
  const usage = await usageFor(shop);
  const allowance = usage.left("auditPages");
  if (allowance <= 0) throw new PermanentError("No audit pages left this period. Upgrade your plan to audit more pages.");

  const audit = await prisma.audit.create({ data: { shopId: shop.id, jobId: job.id } });
  const storefront = new Storefront(base, settings.storefrontPassword);

  // A locked store: unlock with the password, or stop with a clear reason.
  const home = await storefront.get(base);
  if (isPasswordPage(home.html, home.finalUrl) && !(await storefront.unlock())) {
    await prisma.audit.delete({ where: { id: audit.id } });
    throw new PermanentError(
      settings.storefrontPassword
        ? "The storefront password in Settings didn't open the store."
        : "Your store is password protected. Add the storefront password in Settings so the audit can read your pages.",
    );
  }

  const list = await targets(ctx, base, allowance);
  await ctx.progress(0, list.length);

  const results: { url: string; resourceType: string; resourceId: string | null; status: number; title: string | null; description: string | null; issues: Issue[]; links: string[] }[] = [];
  let done = 0;
  await mapLimit(list, PAGE_CONCURRENCY, async (target) => {
    if (await ctx.cancelled()) return;
    const page = await storefront.get(target.url);
    const facts = parsePage(page.finalUrl || target.url, page.status || 599, page.html, target.resourceType);
    results.push({
      ...target,
      status: page.status,
      title: facts.title,
      description: facts.description,
      issues: checkPage(facts),
      links: facts.links.filter((link) => sameHost(link, base)),
    });
    done++;
    if (done % 5 === 0) await ctx.progress(done);
  });

  checkDuplicates(results);
  const scored = results.map((page) => ({ ...page, score: pageScore(page.issues) }));

  await prisma.auditPage.createMany({
    data: scored.map((page) => ({
      auditId: audit.id,
      url: page.url,
      resourceType: page.resourceType,
      resourceId: page.resourceId,
      status: page.status,
      title: page.title,
      description: page.description,
      score: page.score,
      issues: page.issues as unknown as Prisma.InputJsonValue,
    })),
  });
  await spend(shop, "auditPages", scored.length, `audit ${audit.id}`);

  // Internal links: each distinct target once, remembering one page it's on.
  const linkSources = new Map<string, string>();
  for (const page of scored) {
    for (const link of page.links) if (!linkSources.has(link)) linkSources.set(link, page.url);
  }
  const audited = new Map(scored.map((page) => [page.url, page.status]));
  const toCheck = [...linkSources.keys()].filter((link) => !audited.has(link)).slice(0, MAX_LINKS);
  await ctx.progress(done, list.length + toCheck.length);

  const broken: { url: string; sourceUrl: string; status: number }[] = [];
  for (const [url, status] of audited) {
    if (status >= 400 && linkSources.has(url)) broken.push({ url, sourceUrl: linkSources.get(url)!, status });
  }
  let checked = 0;
  await mapLimit(toCheck, LINK_CONCURRENCY, async (url) => {
    if (await ctx.cancelled()) return;
    const status = await storefront.status(url);
    if (status >= 400 || status === 0) broken.push({ url, sourceUrl: linkSources.get(url)!, status });
    checked++;
    if (checked % 20 === 0) await ctx.progress(done + checked);
  });

  // Links: replace the previous scan's open findings with this scan's.
  await prisma.link.deleteMany({ where: { shopId: shop.id, fixed: false } });
  if (broken.length) {
    await prisma.link.createMany({
      data: broken.map((link) => ({ shopId: shop.id, ...link })),
      skipDuplicates: true,
    });
  }

  const score = siteScore(scored);
  const summary = { ...summarize(scored), broken_links: broken.length };
  await prisma.audit.update({
    where: { id: audit.id },
    data: { score, pages: scored.length, summary, finishedAt: new Date() },
  });
  return { auditId: audit.id, score, pages: scored.length, brokenLinks: broken.length };
}

registerJob("audit", runAudit);

/** The latest finished audit and the one before it, for the trend arrow. */
export async function latestAudits(shopId: string) {
  return prisma.audit.findMany({
    where: { shopId, finishedAt: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
}
