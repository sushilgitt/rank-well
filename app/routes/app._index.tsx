import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { latestAudits } from "../lib/audit/audit.server";
import { RULES, type RuleId } from "../lib/audit/rules";
import { activeJob, jobView } from "../lib/jobs.server";
import { embedLink, embedStatus } from "../lib/publish.server";
import { PLANS } from "../lib/plans";
import { usageFor } from "../lib/usage.server";
import { Bar, JobProgress, ScoreRing } from "../components/JobProgress";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const [audits, embed, usage, job, notFound, broken] = await Promise.all([
    latestAudits(shop.id),
    embedStatus(admin),
    usageFor(shop),
    activeJob(shop.id, "audit"),
    prisma.notFound.count({ where: { shopId: shop.id, redirectTo: null } }),
    prisma.link.count({ where: { shopId: shop.id, fixed: false } }),
  ]);
  const [latest, previous] = audits;
  const summary = (latest?.summary ?? {}) as Partial<Record<RuleId, number>>;
  const top = (Object.entries(summary) as [RuleId, number][])
    .filter(([rule]) => rule in RULES && RULES[rule].weight > 0)
    .sort((a, b) => RULES[b[0]].weight * b[1] - RULES[a[0]].weight * a[1])
    .slice(0, 6)
    .map(([rule, count]) => ({ rule, count, label: RULES[rule].label, severity: RULES[rule].severity, fix: RULES[rule].fix }));

  return {
    shopName: shop.name ?? shop.domain,
    plan: PLANS[shop.plan].name,
    score: latest?.score ?? null,
    delta: latest?.score != null && previous?.score != null ? latest.score - previous.score : null,
    pages: latest?.pages ?? 0,
    auditedAt: latest?.finishedAt?.toISOString() ?? null,
    top,
    embedOn: embed.seo,
    embedUrl: embedLink(shop.domain),
    job: jobView(job),
    usage: {
      ai: [usage.used.ai, usage.limits.ai],
      images: [usage.used.images, usage.limits.images],
      auditPages: [usage.used.auditPages, usage.limits.auditPages],
      resetsAt: usage.resetsAt.toISOString(),
    },
    notFound,
    broken,
  };
};

const FIX_LINKS: Record<string, string> = {
  meta: "/app/meta",
  alt: "/app/images",
  schema: "/app/schema",
  links: "/app/links",
  speed: "/app/speed",
  content: "/app/meta",
  theme: "/app/audit",
};

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="Dashboard">
      <s-button slot="primary-action" variant="primary" href="/app/audit">
        {d.score === null ? "Run first audit" : "Open audit"}
      </s-button>

      {!d.embedOn ? (
        <s-banner tone="warning" heading="Turn on the RankLift app embed">
          <s-stack gap="small-200">
            <s-paragraph>
              Structured data, speed boosts and 404 tracking need the RankLift SEO embed switched on in your theme. It's
              one toggle and it's removed cleanly if you uninstall.
            </s-paragraph>
            <s-button href={d.embedUrl} target="_blank">
              Open theme editor
            </s-button>
          </s-stack>
        </s-banner>
      ) : null}

      <JobProgress job={d.job} label="Audit" />

      <s-section heading="SEO score">
        <s-stack direction="inline" gap="large" alignItems="center">
          <ScoreRing score={d.score} />
          <s-stack gap="small-200">
            {d.score === null ? (
              <s-paragraph>Run an audit to measure how search engines and AI assistants see {d.shopName}.</s-paragraph>
            ) : (
              <>
                <s-heading>
                  {d.score >= 80 ? "Looking good" : d.score >= 50 ? "Room to improve" : "Needs work"}
                  {d.delta ? ` (${d.delta > 0 ? "+" : ""}${d.delta} since last audit)` : ""}
                </s-heading>
                <s-text color="subdued">
                  {d.pages} pages checked {d.auditedAt ? `on ${new Date(d.auditedAt).toLocaleDateString()}` : ""}
                </s-text>
              </>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {d.top.length ? (
        <s-section heading="Fix these first">
          <s-stack gap="small-300">
            {d.top.map((item) => (
              <s-stack key={item.rule} direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={item.severity === "error" ? "critical" : item.severity === "warning" ? "warning" : "info"}>
                    {item.count} pages
                  </s-badge>
                  <s-text>{item.label}</s-text>
                </s-stack>
                <s-link href={item.fix ? FIX_LINKS[item.fix] : `/app/audit?rule=${item.rule}`}>Fix</s-link>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
        <s-section heading="Broken links">
          <s-stack gap="small-200">
            <s-heading>{d.broken}</s-heading>
            <s-link href="/app/links">Review links</s-link>
          </s-stack>
        </s-section>
        <s-section heading="Unresolved 404s">
          <s-stack gap="small-200">
            <s-heading>{d.notFound}</s-heading>
            <s-link href="/app/links?tab=404">Add redirects</s-link>
          </s-stack>
        </s-section>
        <s-section heading={`Usage · ${d.plan}`}>
          <s-stack gap="small-200">
            <Meter label="AI credits" pair={d.usage.ai} />
            <Meter label="Image compressions" pair={d.usage.images} />
            <Meter label="Audit pages" pair={d.usage.auditPages} />
            <s-text color="subdued">Resets {new Date(d.usage.resetsAt).toLocaleDateString()}</s-text>
          </s-stack>
        </s-section>
      </s-grid>
    </s-page>
  );
}

function Meter({ label, pair }: { label: string; pair: number[] }) {
  const [used, limit] = pair;
  const unlimited = limit === null || !Number.isFinite(limit);
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <s-stack gap="small-100">
      <s-text>
        {label}: {used} / {unlimited ? "unlimited" : limit}
      </s-text>
      {!unlimited ? <Bar pct={pct} tone={pct >= 100 ? "critical" : pct >= 80 ? "warning" : undefined} /> : null}
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
