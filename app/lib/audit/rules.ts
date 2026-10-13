/**
 * SEO/GEO audit rules. Pure functions over facts read from the **rendered**
 * storefront HTML — the title a search engine sees, theme suffix included —
 * never the admin field alone. (Reading admin fields is how other SEO apps end
 * up reporting "title too short" for titles the theme makes too long.)
 */

export type Severity = "error" | "warning" | "notice";

export interface PageFacts {
  url: string;
  status: number;
  resourceType: string;
  title: string | null;
  description: string | null;
  h1s: string[];
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  viewport: boolean;
  ogTitle: string | null;
  ogImage: string | null;
  images: { src: string; alt: string | null }[];
  links: string[];
  jsonLdTypes: string[];
  jsonLdErrors: number;
  wordCount: number;
  htmlBytes: number;
}

export interface Issue {
  rule: RuleId;
  severity: Severity;
  detail?: string;
}

export const RULES = {
  http_error: { severity: "error", weight: 40, label: "Page returns an error", fix: "links" },
  title_missing: { severity: "error", weight: 15, label: "Missing title tag", fix: "meta" },
  title_short: { severity: "warning", weight: 5, label: "Title too short (under 30 characters)", fix: "meta" },
  title_long: { severity: "warning", weight: 5, label: "Title too long (over 60 characters)", fix: "meta" },
  title_duplicate: { severity: "warning", weight: 5, label: "Title used on more than one page", fix: "meta" },
  description_missing: { severity: "error", weight: 10, label: "Missing meta description", fix: "meta" },
  description_short: { severity: "notice", weight: 3, label: "Meta description too short (under 70 characters)", fix: "meta" },
  description_long: { severity: "notice", weight: 3, label: "Meta description too long (over 160 characters)", fix: "meta" },
  description_duplicate: { severity: "warning", weight: 4, label: "Meta description used on more than one page", fix: "meta" },
  h1_missing: { severity: "error", weight: 10, label: "No H1 heading", fix: "theme" },
  h1_multiple: { severity: "warning", weight: 4, label: "More than one H1 heading", fix: "theme" },
  alt_missing: { severity: "warning", weight: 8, label: "Images without alt text", fix: "alt" },
  thin_content: { severity: "warning", weight: 6, label: "Thin content (under 150 words)", fix: "content" },
  canonical_missing: { severity: "notice", weight: 3, label: "No canonical URL", fix: "theme" },
  canonical_other: { severity: "notice", weight: 0, label: "Canonical points to another page", fix: null },
  noindex: { severity: "warning", weight: 0, label: "Page is hidden from search engines (noindex)", fix: "meta" },
  lang_missing: { severity: "notice", weight: 2, label: "No language set on the page", fix: "theme" },
  viewport_missing: { severity: "error", weight: 8, label: "Not mobile friendly (no viewport tag)", fix: "theme" },
  og_missing: { severity: "notice", weight: 2, label: "No Open Graph tags for social sharing", fix: "theme" },
  schema_missing: { severity: "warning", weight: 6, label: "No structured data for this page type", fix: "schema" },
  schema_invalid: { severity: "warning", weight: 4, label: "Structured data that doesn't parse", fix: "schema" },
  html_heavy: { severity: "notice", weight: 3, label: "Large HTML (over 500 KB)", fix: "speed" },
  url_long: { severity: "notice", weight: 1, label: "Long URL (over 100 characters)", fix: "meta" },
} as const satisfies Record<string, { severity: Severity; weight: number; label: string; fix: string | null }>;

export type RuleId = keyof typeof RULES;

/** The schema.org type a page of this kind should carry. */
const EXPECTED_SCHEMA: Record<string, string[]> = {
  product: ["Product", "ProductGroup"],
  article: ["Article", "BlogPosting", "NewsArticle"],
  home: ["Organization", "WebSite", "OnlineStore", "Store", "LocalBusiness"],
  collection: ["CollectionPage", "ItemList", "BreadcrumbList"],
};

function issue(rule: RuleId, detail?: string): Issue {
  return { rule, severity: RULES[rule].severity, ...(detail ? { detail } : {}) };
}

const clean = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();

export function checkPage(page: PageFacts): Issue[] {
  if (page.status >= 400) return [issue("http_error", `HTTP ${page.status}`)];

  const issues: Issue[] = [];
  const title = clean(page.title);
  if (!title) issues.push(issue("title_missing"));
  else if (title.length < 30) issues.push(issue("title_short", `${title.length} characters: "${title}"`));
  else if (title.length > 60) issues.push(issue("title_long", `${title.length} characters: "${title}"`));

  const description = clean(page.description);
  if (!description) issues.push(issue("description_missing"));
  else if (description.length < 70) issues.push(issue("description_short", `${description.length} characters`));
  else if (description.length > 160) issues.push(issue("description_long", `${description.length} characters`));

  const h1s = page.h1s.map(clean).filter(Boolean);
  if (!h1s.length) issues.push(issue("h1_missing"));
  else if (h1s.length > 1) issues.push(issue("h1_multiple", h1s.slice(0, 3).map((h) => `"${h}"`).join(", ")));

  const noAlt = page.images.filter((image) => !clean(image.alt));
  if (noAlt.length) issues.push(issue("alt_missing", `${noAlt.length} of ${page.images.length} images`));

  if (["product", "article", "page", "collection"].includes(page.resourceType) && page.wordCount < 150) {
    issues.push(issue("thin_content", `${page.wordCount} words`));
  }

  if (!page.canonical) issues.push(issue("canonical_missing"));
  else if (normalizeUrl(page.canonical) !== normalizeUrl(page.url)) {
    issues.push(issue("canonical_other", page.canonical));
  }

  if (/noindex/i.test(page.robots ?? "")) issues.push(issue("noindex"));
  if (!page.lang) issues.push(issue("lang_missing"));
  if (!page.viewport) issues.push(issue("viewport_missing"));
  if (!page.ogTitle || !page.ogImage) issues.push(issue("og_missing"));

  const expected = EXPECTED_SCHEMA[page.resourceType];
  if (expected && !expected.some((type) => page.jsonLdTypes.includes(type))) {
    issues.push(issue("schema_missing", `Expected ${expected[0]}`));
  }
  if (page.jsonLdErrors) issues.push(issue("schema_invalid", `${page.jsonLdErrors} block(s)`));

  if (page.htmlBytes > 500_000) issues.push(issue("html_heavy", `${Math.round(page.htmlBytes / 1024)} KB`));
  if (new URL(page.url).pathname.length > 100) issues.push(issue("url_long"));

  return issues;
}

/** Site-wide checks that need every page: duplicate titles and descriptions. */
export function checkDuplicates(pages: { url: string; title: string | null; description: string | null; issues: Issue[] }[]) {
  const mark = (field: "title" | "description", rule: RuleId) => {
    const groups = new Map<string, typeof pages>();
    for (const page of pages) {
      const value = clean(page[field]).toLowerCase();
      if (!value) continue;
      groups.set(value, [...(groups.get(value) ?? []), page]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const page of group) page.issues.push(issue(rule, `Also on ${group.length - 1} other page(s)`));
    }
  };
  mark("title", "title_duplicate");
  mark("description", "description_duplicate");
}

/** 0–100. Each rule counts once per page, whatever its detail says. */
export function pageScore(issues: Issue[]): number {
  const rules = new Set(issues.map((i) => i.rule));
  let lost = 0;
  for (const rule of rules) lost += RULES[rule].weight;
  return Math.max(0, 100 - lost);
}

/** The site score: mean page score, with the home page counted three times. */
export function siteScore(pages: { resourceType: string; score: number }[]): number {
  if (!pages.length) return 0;
  let sum = 0;
  let count = 0;
  for (const page of pages) {
    const weight = page.resourceType === "home" ? 3 : 1;
    sum += page.score * weight;
    count += weight;
  }
  return Math.round(sum / count);
}

export function summarize(pages: { issues: Issue[] }[]): Partial<Record<RuleId, number>> {
  const summary: Partial<Record<RuleId, number>> = {};
  for (const page of pages) {
    for (const rule of new Set(page.issues.map((i) => i.rule))) summary[rule] = (summary[rule] ?? 0) + 1;
  }
  return summary;
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
