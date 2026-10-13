import type { Shop } from "@prisma/client";
import { listArticles, listCollections, listPages, listProducts, absolute, type Resource } from "./resources.server";
import { readSettings } from "./settings";
import { gql, storefrontUrl, type AdminGraphql } from "./shop.server";
import { excerpt } from "./templates";

/**
 * llms.txt (llmstxt.org): a Markdown map of the store for AI assistants —
 * what the store is, then links to its key pages with one line each.
 * Served by the app proxy at /apps/ranklift/llms.txt and reached from
 * /llms.txt through a Shopify URL redirect.
 */

const cache = new Map<string, { at: number; text: string }>();
const TTL = 60 * 60 * 1000;

export function clearLlmsCache(domain: string) {
  cache.delete(domain);
}

function line(resource: Resource, base: string) {
  const description = excerpt(resource.seoDescription || resource.text, 160);
  return `- [${resource.title.replace(/[[\]]/g, "")}](${absolute(resource.url!, base)})${description ? `: ${description}` : ""}`;
}

export async function buildLlmsTxt(admin: AdminGraphql, shop: Shop): Promise<string> {
  const cached = cache.get(shop.domain);
  if (cached && Date.now() - cached.at < TTL) return cached.text;

  const settings = readSettings(shop.settings).llms;
  const base = storefrontUrl(shop);
  const info = await gql<{ shop: { name: string; description: string | null; shopPolicies: { title: string; url: string }[] } }>(
    admin,
    `#graphql
      query rankliftLlmsShop { shop { name description shopPolicies { title url } } }`,
  );

  const [products, collections, pages, articles] = await Promise.all([
    settings.includeProducts ? listProducts(admin, settings.maxProducts, "status:active") : [],
    settings.includeCollections ? listCollections(admin, 100) : [],
    settings.includePages ? listPages(admin, 100) : [],
    settings.includeArticles ? listArticles(admin, 50) : [],
  ]);
  const published = (list: Resource[]) => list.filter((r) => r.url);

  const parts = [`# ${info.shop.name}`, ""];
  const summary = settings.summary.trim() || info.shop.description?.trim();
  if (summary) parts.push(`> ${summary.replace(/\n+/g, " ")}`, "");
  parts.push(`Online store: ${base}`, "");

  const section = (title: string, list: Resource[]) => {
    const live = published(list);
    if (!live.length) return;
    parts.push(`## ${title}`, "", ...live.map((r) => line(r, base)), "");
  };
  section("Collections", collections);
  section("Products", products);
  section("Pages", pages);
  section("Blog", articles);

  if (info.shop.shopPolicies.length) {
    parts.push("## Policies", "", ...info.shop.shopPolicies.map((p) => `- [${p.title}](${p.url})`), "");
  }
  parts.push("## Optional", "", `- [Sitemap](${absolute("/sitemap.xml", base)})`, "");

  const text = parts.join("\n");
  cache.set(shop.domain, { at: Date.now(), text });
  return text;
}
