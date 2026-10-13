import { describe, expect, it } from "vitest";
import { isPasswordPage, parsePage } from "./parse";
import { checkDuplicates, checkPage, pageScore, siteScore, summarize, type Issue, type PageFacts } from "./rules";

const page = (head: string, body: string, lang = ' lang="en"') =>
  `<!doctype html><html${lang}><head>${head}</head><body>${body}</body></html>`;

const goodHead = [
  "<title>Organic Cotton Tee – Soft Everyday Shirt | Acme</title>",
  '<meta name="description" content="A soft organic cotton tee cut for everyday wear. Breathable, pre-shrunk and made to last. Free returns within 30 days.">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<link rel="canonical" href="https://acme.com/products/tee">',
  '<meta property="og:title" content="Tee"><meta property="og:image" content="https://cdn/x.jpg">',
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Tee"}</script>',
].join("");
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("parsePage", () => {
  it("reads the rendered title, not an admin field", () => {
    const facts = parsePage("https://acme.com/products/tee", 200, page(goodHead, "<main><h1>Tee</h1></main>"), "product");
    expect(facts.title).toBe("Organic Cotton Tee – Soft Everyday Shirt | Acme");
    expect(facts.jsonLdTypes).toEqual(["Product"]);
    expect(facts.viewport).toBe(true);
    expect(facts.lang).toBe("en");
  });

  it("counts a logo H1 in the header, and words only in main content", () => {
    const html = page(goodHead, `<header><h1>Acme</h1><nav>${words(50)}</nav></header><main><h1>Tee</h1><p>${words(20)}</p></main><footer>${words(80)}</footer>`);
    const facts = parsePage("https://acme.com/products/tee", 200, html, "product");
    expect(facts.h1s).toEqual(["Acme", "Tee"]);
    expect(facts.wordCount).toBe(21);
  });

  it("skips decorative and noscript images, reads lazy data-src", () => {
    const html = page(
      goodHead,
      '<main><img src="/a.jpg" alt="A"><img data-src="/b.jpg"><img src="/c.jpg" role="presentation"><noscript><img src="/a.jpg"></noscript></main>',
    );
    const facts = parsePage("https://acme.com/", 200, html, "home");
    expect(facts.images).toEqual([
      { src: "/a.jpg", alt: "A" },
      { src: "/b.jpg", alt: null },
    ]);
  });

  it("collects absolute internal links without fragments or mailto", () => {
    const html = page(goodHead, '<a href="/collections/all#top">x</a><a href="mailto:a@b.c">m</a><a href="https://other.com/x">o</a>');
    const facts = parsePage("https://acme.com/", 200, html, "home");
    expect(facts.links).toEqual(["https://acme.com/collections/all", "https://other.com/x"]);
  });

  it("finds @graph types and counts broken JSON-LD", () => {
    const html = page(
      `${goodHead}<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":["WebSite"]}]}</script><script type="application/ld+json">{oops</script>`,
      "",
    );
    const facts = parsePage("https://acme.com/", 200, html, "home");
    expect(facts.jsonLdTypes).toEqual(["Product", "Organization", "WebSite"]);
    expect(facts.jsonLdErrors).toBe(1);
  });

  it("recognises Shopify's password page", () => {
    expect(isPasswordPage("<html>", "https://acme.com/password")).toBe(true);
    expect(isPasswordPage('<body class="template-password">', "https://acme.com/")).toBe(true);
    expect(isPasswordPage("<body>", "https://acme.com/")).toBe(false);
  });
});

function facts(overrides: Partial<PageFacts> = {}): PageFacts {
  return {
    url: "https://acme.com/products/tee",
    status: 200,
    resourceType: "product",
    title: "Organic Cotton Tee – Soft Everyday Shirt | Acme",
    description: "A soft organic cotton tee cut for everyday wear. Breathable, pre-shrunk and made to last. Free returns.",
    h1s: ["Tee"],
    canonical: "https://acme.com/products/tee",
    robots: null,
    lang: "en",
    viewport: true,
    ogTitle: "Tee",
    ogImage: "x",
    images: [{ src: "a", alt: "A" }],
    links: [],
    jsonLdTypes: ["Product"],
    jsonLdErrors: 0,
    wordCount: 300,
    htmlBytes: 1000,
    ...overrides,
  };
}

describe("checkPage", () => {
  it("passes a well-optimised product page", () => {
    expect(checkPage(facts())).toEqual([]);
    expect(pageScore([])).toBe(100);
  });

  it("flags a rendered title that is too long, even when the admin field is short", () => {
    const issues = checkPage(facts({ title: "Tee | Organic Cotton Everyday Shirt for Men and Women | Acme Clothing Co." }));
    expect(issues.map((i) => i.rule)).toEqual(["title_long"]);
  });

  it("reports one H1 problem per page, not one per heading", () => {
    const issues = checkPage(facts({ h1s: ["A", "B", "C", "D"] }));
    expect(issues.filter((i) => i.rule === "h1_multiple")).toHaveLength(1);
  });

  it("returns only the HTTP error for an error page", () => {
    expect(checkPage(facts({ status: 404, title: null })).map((i) => i.rule)).toEqual(["http_error"]);
  });

  it("expects Product data on products, but not on pages", () => {
    expect(checkPage(facts({ jsonLdTypes: [] })).map((i) => i.rule)).toContain("schema_missing");
    expect(checkPage(facts({ resourceType: "page", jsonLdTypes: [] })).map((i) => i.rule)).not.toContain("schema_missing");
  });

  it("treats a canonical with a trailing slash or different case as the same page", () => {
    expect(checkPage(facts({ canonical: "https://ACME.com/products/tee/" })).map((i) => i.rule)).not.toContain("canonical_other");
  });
});

describe("site-wide", () => {
  it("marks duplicate titles and descriptions on every page that shares them", () => {
    const pages = [
      { url: "a", title: "Same", description: "One", issues: [] as Issue[] },
      { url: "b", title: "same ", description: "Two", issues: [] as Issue[] },
      { url: "c", title: "Other", description: "Two", issues: [] as Issue[] },
    ];
    checkDuplicates(pages);
    expect(pages[0].issues.map((i) => i.rule)).toEqual(["title_duplicate"]);
    expect(pages[1].issues.map((i) => i.rule)).toEqual(["title_duplicate", "description_duplicate"]);
    expect(summarize(pages)).toEqual({ title_duplicate: 2, description_duplicate: 2 });
  });

  it("weights the home page in the site score", () => {
    expect(siteScore([{ resourceType: "home", score: 40 }, { resourceType: "product", score: 100 }])).toBe(55);
    expect(siteScore([])).toBe(0);
  });
});
