import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { RULES, type Issue, type RuleId } from "../lib/audit/rules";
import { activeJob, enqueueOnce, jobView } from "../lib/jobs.server";
import { usageFor } from "../lib/usage.server";
import { JobProgress, ScoreRing } from "../components/JobProgress";

const PAGE_SIZE = 50;

const FIX_LINKS: Record<string, { href: string; label: string }> = {
  meta: { href: "/app/meta", label: "Edit meta tags" },
  alt: { href: "/app/images", label: "Fix alt text" },
  schema: { href: "/app/schema", label: "Structured data" },
  links: { href: "/app/links", label: "Fix links" },
  speed: { href: "/app/speed", label: "Speed settings" },
  content: { href: "/app/meta", label: "Improve content" },
};

const THEME_HELP: Partial<Record<RuleId, string>> = {
  h1_missing: "Your theme template doesn't output an H1 here. In the theme editor, make the page or product title a 'Heading 1', or ask your theme developer.",
  h1_multiple: "Usually the logo or a section heading is also an H1. Change the extra ones to H2 in the theme editor or theme code.",
  canonical_missing: "Add {{ canonical_url }} as <link rel=\"canonical\"> in theme.liquid — most themes already do.",
  lang_missing: "Set lang=\"{{ request.locale.iso_code }}\" on the <html> tag in theme.liquid.",
  viewport_missing: "Add <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"> to theme.liquid.",
  og_missing: "Add Open Graph tags (most themes include a 'meta-tags' snippet), and set a social sharing image in theme settings.",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const rule = url.searchParams.get("rule") as RuleId | null;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));

  const [audit, job, usage] = await Promise.all([
    prisma.audit.findFirst({ where: { shopId: shop.id, finishedAt: { not: null } }, orderBy: { createdAt: "desc" } }),
    activeJob(shop.id, "audit"),
    usageFor(shop),
  ]);
  const lastJob = job ?? (await prisma.job.findFirst({ where: { shopId: shop.id, type: "audit" }, orderBy: { createdAt: "desc" } }));

  let pages: { id: string; url: string; resourceType: string; resourceId: string | null; score: number; status: number; title: string | null; issues: Issue[] }[] = [];
  let total = 0;
  if (audit) {
    const where = {
      auditId: audit.id,
      ...(rule && rule in RULES ? { issues: { array_contains: [{ rule }] } } : {}),
    };
    [pages, total] = await Promise.all([
      prisma.auditPage
        .findMany({ where, orderBy: { score: "asc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE })
        .then((rows) => rows.map((row) => ({ ...row, issues: row.issues as unknown as Issue[] }))),
      prisma.auditPage.count({ where }),
    ]);
  }

  const summary = (audit?.summary ?? {}) as Record<string, number>;
  return {
    audit: audit
      ? { id: audit.id, score: audit.score, pages: audit.pages, finishedAt: audit.finishedAt!.toISOString(), summary }
      : null,
    job: jobView(lastJob),
    rule: rule && rule in RULES ? rule : null,
    page,
    pages,
    total,
    pageSize: PAGE_SIZE,
    pagesLeft: usage.left("auditPages"),
    passwordSet: Boolean((shop.settings as { storefrontPassword?: string })?.storefrontPassword),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  const usage = await usageFor(shop);
  if (usage.left("auditPages") <= 0) {
    return { error: "You've used this period's audit pages. Upgrade to audit again before it resets." };
  }
  const job = await enqueueOnce(shop.id, "audit");
  return { job: jobView(job) };
};

export default function AuditPage() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [params, setParams] = useSearchParams();
  const job = (fetcher.data && "job" in fetcher.data ? fetcher.data.job : null) ?? d.job;
  const running = job && (job.status === "QUEUED" || job.status === "RUNNING");

  const issues = (Object.entries(d.audit?.summary ?? {}) as [string, number][])
    .filter(([rule]) => rule in RULES)
    .map(([rule, count]) => ({ rule: rule as RuleId, count, ...RULES[rule as RuleId] }))
    .sort((a, b) => b.weight * b.count - a.weight * a.count);
  const brokenLinks = d.audit?.summary.broken_links ?? 0;

  const choose = (rule: string | null) => {
    const next = new URLSearchParams(params);
    if (rule) next.set("rule", rule);
    else next.delete("rule");
    next.delete("page");
    setParams(next);
  };

  return (
    <s-page heading="SEO & GEO audit">
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={Boolean(running) || d.pagesLeft <= 0}
        onClick={() => fetcher.submit({}, { method: "post" })}
      >
        {d.audit ? "Run new audit" : "Run audit"}
      </s-button>

      {fetcher.data && "error" in fetcher.data ? <s-banner tone="warning">{fetcher.data.error}</s-banner> : null}
      <JobProgress job={job} label="Audit" />
      {job?.status === "FAILED" && /password/i.test(job.error ?? "") ? (
        <s-button href="/app/settings">{d.passwordSet ? "Check storefront password" : "Add storefront password"}</s-button>
      ) : null}

      {!d.audit ? (
        <s-section>
          <s-stack gap="base">
            <s-paragraph>
              The audit opens your live store the way Google and AI crawlers do, page by page — home, products,
              collections, pages and blog posts — and checks titles, descriptions, headings, images, structured data,
              mobile-friendliness and every internal link.
            </s-paragraph>
            <s-paragraph color="subdued">Your plan includes {d.pagesLeft} more audit pages this period.</s-paragraph>
          </s-stack>
        </s-section>
      ) : (
        <>
          <s-section>
            <s-stack direction="inline" gap="large" alignItems="center">
              <ScoreRing score={d.audit.score} />
              <s-stack gap="small-200">
                <s-heading>{d.audit.pages} pages checked</s-heading>
                <s-text color="subdued">Finished {new Date(d.audit.finishedAt).toLocaleString()}</s-text>
                {brokenLinks ? <s-link href="/app/links">{brokenLinks} broken links found</s-link> : null}
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Issues">
            <s-stack gap="small-300">
              <s-stack direction="inline" gap="small-200">
                <s-button variant={d.rule ? "tertiary" : "secondary"} onClick={() => choose(null)}>
                  All pages
                </s-button>
              </s-stack>
              {issues.length === 0 ? <s-paragraph>No issues found. Nice work.</s-paragraph> : null}
              {issues.map((item) => (
                <s-clickable key={item.rule} onClick={() => choose(item.rule)} padding="small-200" borderRadius="base" background={d.rule === item.rule ? "subdued" : undefined}>
                  <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-badge tone={item.severity === "error" ? "critical" : item.severity === "warning" ? "warning" : "info"}>
                        {item.severity}
                      </s-badge>
                      <s-text>{item.label}</s-text>
                    </s-stack>
                    <s-text color="subdued">{item.count} pages</s-text>
                  </s-stack>
                </s-clickable>
              ))}
            </s-stack>
          </s-section>

          {d.rule ? <RuleHelp rule={d.rule} /> : null}

          <s-section heading={d.rule ? `Pages with: ${RULES[d.rule].label}` : "Pages, lowest score first"}>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Page</s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header format="numeric">Score</s-table-header>
                <s-table-header>Issues</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {d.pages.map((page) => (
                  <s-table-row key={page.id}>
                    <s-table-cell>
                      <s-stack gap="small-100">
                        <s-link href={page.url} target="_blank">
                          {page.title || new URL(page.url).pathname}
                        </s-link>
                        <s-text color="subdued">{new URL(page.url).pathname}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{page.resourceType}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={page.score >= 80 ? "success" : page.score >= 50 ? "warning" : "critical"}>{page.score}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack gap="small-100">
                        {page.issues
                          .filter((i) => !d.rule || i.rule === d.rule)
                          .slice(0, 4)
                          .map((issue, n) => (
                            <s-text key={n} color={issue.severity === "notice" ? "subdued" : undefined}>
                              {RULES[issue.rule]?.label ?? issue.rule}
                              {issue.detail ? ` — ${issue.detail}` : ""}
                            </s-text>
                          ))}
                        {page.issues.length > 4 && !d.rule ? <s-text color="subdued">+{page.issues.length - 4} more</s-text> : null}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <Pager page={d.page} total={d.total} size={d.pageSize} />
          </s-section>
        </>
      )}
    </s-page>
  );
}

function RuleHelp({ rule }: { rule: RuleId }) {
  const def = RULES[rule];
  const fix = def.fix ? FIX_LINKS[def.fix] : null;
  const theme = THEME_HELP[rule];
  if (!fix && !theme) return null;
  return (
    <s-banner tone="info" heading="How to fix">
      <s-stack gap="small-200">
        {theme ? <s-paragraph>{theme}</s-paragraph> : null}
        {fix ? <s-button href={fix.href}>{fix.label}</s-button> : null}
      </s-stack>
    </s-banner>
  );
}

export function Pager({ page, total, size }: { page: number; total: number; size: number }) {
  const [params, setParams] = useSearchParams();
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  const go = (n: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(n));
    setParams(next);
  };
  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="center">
      <s-button variant="tertiary" disabled={page <= 1} onClick={() => go(page - 1)}>
        Previous
      </s-button>
      <s-text>
        Page {page} of {pages}
      </s-text>
      <s-button variant="tertiary" disabled={page >= pages} onClick={() => go(page + 1)}>
        Next
      </s-button>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
