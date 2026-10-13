import prisma from "../db.server";
import { listCollections, listPages, listProducts, type Resource } from "./resources.server";
import { assertNoUserErrors, gql, type AdminGraphql } from "./shop.server";

/** URL redirects (Shopify's own), the 404 log, and finding a good target. */

export interface Redirect {
  id: string;
  path: string;
  target: string;
}

export async function listRedirects(admin: AdminGraphql, first = 100, after: string | null = null, query?: string) {
  const data = await gql<{
    urlRedirects: { nodes: Redirect[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  }>(
    admin,
    `#graphql
      query rankliftRedirects($first: Int!, $after: String, $query: String) {
        urlRedirects(first: $first, after: $after, query: $query) {
          nodes { id path target }
          pageInfo { hasNextPage endCursor }
        }
      }`,
    { first, after, query: query ?? null },
  );
  return data.urlRedirects;
}

/** Normalises what a merchant types into a path Shopify accepts. */
export function toPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return decodeURI(url.pathname + url.search) || "/";
  } catch {
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
}

export async function createRedirect(admin: AdminGraphql, path: string, target: string) {
  const from = toPath(path);
  const to = /^https?:\/\//.test(target.trim()) ? target.trim() : toPath(target);
  if (!from || !to) throw new Error("Both the old path and the target are needed.");
  if (from === to) throw new Error("A page can't redirect to itself.");
  const data = await gql<{
    urlRedirectCreate: { urlRedirect: Redirect | null; userErrors: { message: string }[] };
  }>(
    admin,
    `#graphql
      mutation rankliftRedirectCreate($urlRedirect: UrlRedirectInput!) {
        urlRedirectCreate(urlRedirect: $urlRedirect) {
          urlRedirect { id path target }
          userErrors { field message }
        }
      }`,
    { urlRedirect: { path: from, target: to } },
  );
  assertNoUserErrors(data.urlRedirectCreate.userErrors, "Redirect");
  return data.urlRedirectCreate.urlRedirect!;
}

export async function deleteRedirect(admin: AdminGraphql, id: string) {
  const data = await gql<{ urlRedirectDelete: { userErrors: { message: string }[] } }>(
    admin,
    `#graphql
      mutation rankliftRedirectDelete($id: ID!) {
        urlRedirectDelete(id: $id) { userErrors { field message } }
      }`,
    { id },
  );
  assertNoUserErrors(data.urlRedirectDelete.userErrors, "Redirect");
}

/** Words of a URL path or title, for matching a dead URL to a live page. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\.(html?|php|aspx?)$/, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !["products", "collections", "pages", "blogs", "the", "and", "for", "all"].includes(t));
}

/**
 * The live page most like a dead path: same section first (a dead product
 * goes to a product), then word overlap with the handle and title.
 */
export function bestMatch(path: string, candidates: Pick<Resource, "type" | "handle" | "title" | "url">[]) {
  const wanted = new Set(tokens(path));
  if (!wanted.size) return null;
  const section = path.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(products|collections|pages|blogs)\//i)?.[1]?.toLowerCase();
  let best: { url: string; score: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.url) continue;
    const words = new Set([...tokens(candidate.handle), ...tokens(candidate.title)]);
    let overlap = 0;
    for (const word of wanted) if (words.has(word)) overlap++;
    if (!overlap) continue;
    const sameSection = section && `${candidate.type}s` === section ? 0.5 : 0;
    const score = overlap / wanted.size + sameSection;
    if (!best || score > best.score) best = { url: new URL(candidate.url, "https://x").pathname, score };
  }
  return best && best.score >= 0.5 ? best.url : null;
}

/** Live pages to match dead URLs against (cached per process for a few minutes). */
const candidateCache = new Map<string, { at: number; list: Resource[] }>();
export async function matchCandidates(shopDomain: string, admin: AdminGraphql) {
  const cached = candidateCache.get(shopDomain);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.list;
  const [products, collections, pages] = await Promise.all([
    listProducts(admin, 2000, "status:active"),
    listCollections(admin, 500),
    listPages(admin, 200),
  ]);
  const list = [...products, ...collections, ...pages];
  candidateCache.set(shopDomain, { at: Date.now(), list });
  return list;
}

/** Records a 404 the storefront embed reported. */
export async function recordNotFound(shopId: string, rawPath: string, referrer: string | null) {
  const path = toPath(rawPath).slice(0, 500);
  if (!path || path === "/" || /^\/(cdn|checkouts?|cart|account|apps|admin|services|\.well-known)\b/.test(path)) return null;
  return prisma.notFound.upsert({
    where: { shopId_path: { shopId, path } },
    create: { shopId, path, referrer: referrer?.slice(0, 500) ?? null },
    update: { hits: { increment: 1 }, lastSeen: new Date(), ...(referrer ? { referrer: referrer.slice(0, 500) } : {}) },
  });
}
