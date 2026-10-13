import { load } from "cheerio";
import type { PageFacts } from "./rules";

/** Reads the SEO-relevant facts out of a rendered storefront page. */
export function parsePage(url: string, status: number, html: string, resourceType: string): PageFacts {
  const $ = load(html);
  const meta = (selector: string) => $(selector).first().attr("content")?.trim() || null;

  const jsonLdTypes: string[] = [];
  let jsonLdErrors = 0;
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      collectTypes(JSON.parse($(element).text()), jsonLdTypes);
    } catch {
      jsonLdErrors++;
    }
  });

  const base = new URL(url);
  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href")?.trim();
    if (!href || /^(#|mailto:|tel:|javascript:|sms:)/i.test(href)) return;
    try {
      const absolute = new URL(href, base);
      if (!/^https?:$/.test(absolute.protocol)) return;
      absolute.hash = "";
      links.add(absolute.toString());
    } catch {
      // unparseable href; ignored
    }
  });

  // Images in <noscript> duplicate the lazy ones; count what a crawler indexes.
  $("noscript").remove();
  const images = $("img")
    .toArray()
    // Decorative images marked role=presentation / aria-hidden don't need alt.
    .filter((element) => $(element).attr("role") !== "presentation" && $(element).attr("aria-hidden") !== "true")
    .map((element) => ({
      src: $(element).attr("src") || $(element).attr("data-src") || "",
      alt: $(element).attr("alt") ?? null,
    }))
    .filter((image) => image.src);

  // Read before the header is removed below: a logo H1 in the header is real.
  const h1s = $("h1")
    .toArray()
    .map((element) => $(element).text().trim());

  // Words in the main content; header, footer and menus repeat on every page.
  $("script, style, template, header, footer, nav").remove();
  const content = $("main").length ? $("main") : $("body");
  // .text() glues block elements together ("Tee" + "word" = "Teeword").
  content.find("*").append(" ");
  const words = content
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => /\p{L}/u.test(word));

  return {
    url,
    status,
    resourceType,
    title: $("head title").first().text().trim() || null,
    description: meta('meta[name="description"]'),
    h1s,
    canonical: $('link[rel="canonical"]').first().attr("href")?.trim() || null,
    robots: meta('meta[name="robots"]'),
    lang: $("html").attr("lang")?.trim() || null,
    viewport: $('meta[name="viewport"]').length > 0,
    ogTitle: meta('meta[property="og:title"]'),
    ogImage: meta('meta[property="og:image"]'),
    images,
    links: [...links],
    jsonLdTypes,
    jsonLdErrors,
    wordCount: words.length,
    htmlBytes: Buffer.byteLength(html),
  };
}

function collectTypes(node: unknown, out: string[]) {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  if (typeof type === "string") out.push(type);
  if (Array.isArray(type)) out.push(...type.filter((t): t is string => typeof t === "string"));
  if (record["@graph"]) collectTypes(record["@graph"], out);
}

/** Shopify's password page: the store isn't open to crawlers yet. */
export function isPasswordPage(html: string, finalUrl: string) {
  return /\/password\/?$/.test(new URL(finalUrl).pathname) || /template-password/.test(html);
}
