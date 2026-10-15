import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { SpeedTest } from "@prisma/client";
import prisma from "../db.server";
import { adminContext, jsonBody, saveSettings } from "../lib/context.server";
import { activeJob, enqueue, jobView, type JobView } from "../lib/jobs.server";
import { PLANS } from "../lib/plans";
import { formatMs, rate, type FieldData, type Rating, type SpeedPage } from "../lib/psi";
import { embedLink, embedStatus } from "../lib/publish.server";
import type { Settings } from "../lib/settings";
import { speedReport, type SpeedPayload } from "../lib/speed.server";
import { Checkbox } from "../components/fields";
import { JobProgress } from "../components/JobProgress";

const PAGES: SpeedPage[] = ["home", "product", "collection"];

function testView(test: SpeedTest) {
  return {
    score: test.score,
    lcpMs: test.lcpMs,
    cls: test.cls,
    tbtMs: test.tbtMs,
    field: test.field as FieldData | null,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  return {
    speed: settings.speed,
    level: PLANS[shop.plan].features.speed,
    embedOn: (await embedStatus(admin)).seo,
    embedUrl: embedLink(shop.domain),
    report: (await speedReport(shop.id)).map((row) => ({
      page: row.page,
      strategy: row.strategy,
      runs: row.runs,
      url: row.before.url,
      before: testView(row.before),
      after: row.after ? testView(row.after) : null,
    })),
    job: jobView(await activeJob(shop.id, "speed.test")),
  };
};

type Body =
  | { intent?: "save"; speed: Settings["speed"] }
  | { intent: "test"; page: SpeedPage }
  | { intent: "clear"; page: SpeedPage };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const body = await jsonBody<Body>(request);
  if (body.intent === "test") {
    if (!PAGES.includes(body.page)) return { ok: false, message: "Unknown page" };
    if (await activeJob(shop.id, "speed.test")) return { ok: false, message: "A speed test is already running." };
    const job = await enqueue(shop.id, "speed.test", { page: body.page } satisfies SpeedPayload);
    return { ok: true, job: jobView(job) };
  }
  if (body.intent === "clear") {
    await prisma.speedTest.deleteMany({ where: { shopId: shop.id, page: body.page } });
    return { ok: true };
  }
  await saveSettings(admin, shop, { speed: body.speed });
  return { ok: true, saved: true };
};

const LEVELS = {
  basic: "Basic: pages start loading the moment a shopper taps a link.",
  rocket: "Rocket: pages start loading when a shopper hovers over a link, so most clicks feel instant.",
  turbo: "Turbo: the browser fully prerenders the likely next page (Speculation Rules), for near-zero load time on click.",
};

export default function Speed() {
  const d = useLoaderData<typeof loader>();
  const [speed, setSpeed] = useState(d.speed);
  const fetcher = useFetcher<typeof action>();
  useEffect(() => {
    if (fetcher.data && "saved" in fetcher.data) window.shopify?.toast.show("Speed settings saved");
  }, [fetcher.data]);
  const set = (key: keyof Settings["speed"], value: boolean) => setSpeed({ ...speed, [key]: value });

  return (
    <s-page heading="Speed">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={fetcher.state !== "idle" || undefined}
        onClick={() => fetcher.submit({ speed }, { method: "post", encType: "application/json" })}
      >
        Save
      </s-button>
      {!d.embedOn ? (
        <s-banner tone="warning" heading="The Rank Well embed is off">
          <s-button href={d.embedUrl} target="_blank">
            Turn it on in the theme editor
          </s-button>
        </s-banner>
      ) : null}

      <s-section heading={`Your speed level: ${d.level[0].toUpperCase()}${d.level.slice(1)}`}>
        <s-stack gap="small-200">
          <s-paragraph>{LEVELS[d.level]}</s-paragraph>
          {d.level !== "turbo" ? <s-link href="/app/plans">Upgrade for {d.level === "basic" ? "Rocket or Turbo" : "Turbo"}</s-link> : null}
        </s-stack>
      </s-section>

      <s-section heading="Optimizations">
        <s-stack gap="base">
          <Checkbox label="Instant page loads (prefetch)" details="Loads the next page early, as described above." checked={speed.prefetch} onChange={(v) => set("prefetch", v)} />
          <Checkbox
            label="Lazy-load images below the fold"
            details="Images further down the page load only when shoppers scroll to them."
            checked={speed.lazyImages}
            onChange={(v) => set("lazyImages", v)}
          />
          <Checkbox label="Preconnect to Shopify's CDN" details="Opens the connection for images and scripts sooner." checked={speed.preconnect} onChange={(v) => set("preconnect", v)} />
          <s-link href="/app/optimize">Compress product images in the Image optimizer</s-link>
        </s-stack>
      </s-section>

      <Measure report={d.report} job={d.job} />
    </s-page>
  );
}

const PAGE_LABEL: Record<SpeedPage, string> = { home: "Home page", product: "Product page", collection: "Collection page" };
const TONE: Record<Rating, "success" | "warning" | "critical"> = { good: "success", average: "warning", poor: "critical" };

type Report = ReturnType<typeof useLoaderData<typeof loader>>["report"];
type Test = Report[number]["before"];

function Measure({ report, job: initial }: { report: Report; job: JobView | null }) {
  const run = useFetcher<typeof action>();
  const clear = useFetcher<typeof action>();
  const [done, setDone] = useState<JobView | null>(null);
  const job = (run.data && "job" in run.data ? run.data.job : null) ?? initial;
  const busy = Boolean(job && (job.status === "QUEUED" || job.status === "RUNNING"));
  const onDone = useCallback((j: JobView) => setDone(j), []);
  const test = (page: SpeedPage) => {
    setDone(null);
    run.submit({ intent: "test", page }, { method: "post", encType: "application/json" });
  };

  return (
    <s-section heading="Core Web Vitals">
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Google tests the page on a mid-range phone and on a desktop, which takes about a minute. Test before you change
          something and again after: the first test stays the &quot;before&quot; until you clear the history.
        </s-paragraph>
        <s-stack direction="inline" gap="small-200">
          {PAGES.map((page) => (
            <s-button key={page} disabled={busy || undefined} onClick={() => test(page)}>
              Test {PAGE_LABEL[page].toLowerCase()}
            </s-button>
          ))}
        </s-stack>
        <JobProgress job={job} label="Speed test" onDone={onDone} />
        {run.data && !run.data.ok && "message" in run.data ? <s-banner tone="warning">{run.data.message}</s-banner> : null}
        {done?.status === "DONE" ? (
          <s-banner tone="success" dismissible>
            Speed test finished.
          </s-banner>
        ) : null}

        {report.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Page</s-table-header>
              <s-table-header>Score</s-table-header>
              <s-table-header>LCP</s-table-header>
              <s-table-header>CLS</s-table-header>
              <s-table-header>TBT</s-table-header>
              <s-table-header>Real visitors (28 days)</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {report.map((row) => (
                <s-table-row key={`${row.page}-${row.strategy}`}>
                  <s-table-cell>
                    <s-stack gap="small-100">
                      <s-text type="strong">
                        {PAGE_LABEL[row.page]}, {row.strategy}
                      </s-text>
                      <s-text color="subdued">
                        {row.runs} test{row.runs === 1 ? "" : "s"} · {new URL(row.url).pathname}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <Compare metric="score" before={row.before} after={row.after} format={(v) => String(v)} />
                  </s-table-cell>
                  <s-table-cell>
                    <Compare metric="lcpMs" before={row.before} after={row.after} format={formatMs} />
                  </s-table-cell>
                  <s-table-cell>
                    <Compare metric="cls" before={row.before} after={row.after} format={(v) => v.toFixed(2)} />
                  </s-table-cell>
                  <s-table-cell>
                    <Compare metric="tbtMs" before={row.before} after={row.after} format={formatMs} />
                  </s-table-cell>
                  <s-table-cell>
                    <Field test={row.after ?? row.before} />
                  </s-table-cell>
                  <s-table-cell>
                    {row.strategy === "mobile" ? (
                      <s-button
                        variant="tertiary"
                        disabled={busy || undefined}
                        onClick={() => {
                          const what = PAGE_LABEL[row.page].toLowerCase();
                          if (window.confirm(`Clear the test history of the ${what}? The next test becomes the new "before".`)) {
                            clear.submit({ intent: "clear", page: row.page }, { method: "post", encType: "application/json" });
                          }
                        }}
                      >
                        Clear
                      </s-button>
                    ) : null}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>No tests yet. Start with the home page.</s-paragraph>
        )}
        <s-text color="subdued">
          LCP: when the main content appears (good under 2.5 s). CLS: how much the layout jumps (good under 0.1). TBT: how
          long the page is too busy to respond (good under 200 ms). The biggest wins usually come from compressing images
          and removing apps you no longer use.
        </s-text>
      </s-stack>
    </s-section>
  );
}

function Compare({
  metric,
  before,
  after,
  format,
}: {
  metric: "score" | "lcpMs" | "cls" | "tbtMs";
  before: Test;
  after: Test | null;
  format: (value: number) => string;
}) {
  const show = (value: number | null) => {
    if (value == null) return <s-text color="subdued">–</s-text>;
    const rating = rate(metric, value);
    return <s-badge tone={rating ? TONE[rating] : undefined}>{format(value)}</s-badge>;
  };
  if (!after) return show(before[metric]);
  return (
    <s-stack direction="inline" gap="small-100" alignItems="center">
      {show(before[metric])}
      <s-text color="subdued">→</s-text>
      {show(after[metric])}
    </s-stack>
  );
}

function Field({ test }: { test: Test }) {
  const field = test.field;
  if (!field) return <s-text color="subdued">Not enough traffic yet</s-text>;
  const parts = [
    field.lcpMs != null ? `LCP ${formatMs(field.lcpMs)}` : null,
    field.inpMs != null ? `INP ${formatMs(field.inpMs)}` : null,
    field.cls != null ? `CLS ${field.cls.toFixed(2)}` : null,
  ].filter(Boolean);
  const label = field.category === "FAST" ? "Good" : field.category === "SLOW" ? "Poor" : "Needs work";
  const tone = field.category === "FAST" ? "success" : field.category === "SLOW" ? "critical" : "warning";
  return (
    <s-stack gap="small-100">
      {field.category ? <s-badge tone={tone}>{label}</s-badge> : null}
      <s-text color="subdued">
        {parts.join(" · ")}
        {field.origin ? " (whole site)" : ""}
      </s-text>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
