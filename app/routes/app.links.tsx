import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext, jsonBody, saveSettings } from "../lib/context.server";
import { hasFeature } from "../lib/plans";
import { bestMatch, createRedirect, deleteRedirect, listRedirects, matchCandidates, toPath } from "../lib/redirects.server";
import { Checkbox, TextField } from "../components/fields";

type Tab = "broken" | "404" | "redirects";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  const url = new URL(request.url);
  const tab = (["broken", "404", "redirects"].includes(url.searchParams.get("tab") ?? "") ? url.searchParams.get("tab") : "broken") as Tab;
  const after = url.searchParams.get("after");
  const q = url.searchParams.get("q") ?? "";

  const [broken, notFound, counts] = await Promise.all([
    tab === "broken" ? prisma.link.findMany({ where: { shopId: shop.id, fixed: false }, orderBy: { url: "asc" }, take: 500 }) : [],
    tab === "404"
      ? prisma.notFound.findMany({ where: { shopId: shop.id }, orderBy: [{ redirectTo: { sort: "desc", nulls: "first" } }, { hits: "desc" }], take: 500 })
      : [],
    Promise.all([
      prisma.link.count({ where: { shopId: shop.id, fixed: false } }),
      prisma.notFound.count({ where: { shopId: shop.id, redirectTo: null } }),
    ]),
  ]);

  // Suggested targets for dead URLs, matched against live pages.
  let suggestions: Record<string, string | null> = {};
  if (tab !== "redirects" && (broken.length || notFound.length)) {
    const candidates = await matchCandidates(shop.domain, admin);
    const paths = [...broken.map((l) => toPath(l.url)), ...notFound.filter((n) => !n.redirectTo).map((n) => n.path)];
    suggestions = Object.fromEntries(paths.map((p) => [p, bestMatch(p, candidates)]));
  }

  const redirects = tab === "redirects" ? await listRedirects(admin, 100, after, q ? `path:*${q}*` : undefined) : null;

  return {
    tab,
    q,
    counts: { broken: counts[0], notFound: counts[1] },
    autoRedirect: settings.autoRedirect404,
    fallback: settings.fallbackRedirect,
    canAuto: hasFeature(shop.plan, "autoRedirect"),
    broken: broken.map((l) => ({ id: l.id, url: l.url, path: toPath(l.url), sourceUrl: l.sourceUrl, status: l.status })),
    notFound: notFound.map((n) => ({ id: n.id, path: n.path, hits: n.hits, lastSeen: n.lastSeen.toISOString(), referrer: n.referrer, redirectTo: n.redirectTo })),
    suggestions,
    redirects,
  };
};

type Body =
  | { intent: "redirect"; path: string; target: string; linkId?: string; notFoundId?: string }
  | { intent: "ignore-link"; id: string }
  | { intent: "ignore-404"; id: string }
  | { intent: "delete-redirect"; id: string }
  | { intent: "import"; csv: string }
  | { intent: "auto"; autoRedirect404: boolean; fallbackRedirect: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const body = await jsonBody<Body>(request);

  switch (body.intent) {
    case "redirect": {
      try {
        await createRedirect(admin, body.path, body.target);
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
      if (body.linkId) await prisma.link.updateMany({ where: { id: body.linkId, shopId: shop.id }, data: { fixed: true } });
      if (body.notFoundId) {
        await prisma.notFound.updateMany({ where: { id: body.notFoundId, shopId: shop.id }, data: { redirectTo: toPath(body.target) } });
      }
      return { ok: true, message: "Redirect created" };
    }
    case "ignore-link":
      await prisma.link.updateMany({ where: { id: body.id, shopId: shop.id }, data: { fixed: true } });
      return { ok: true, message: "Ignored" };
    case "ignore-404":
      await prisma.notFound.deleteMany({ where: { id: body.id, shopId: shop.id } });
      return { ok: true, message: "Removed" };
    case "delete-redirect":
      await deleteRedirect(admin, body.id);
      return { ok: true, message: "Redirect deleted" };
    case "import": {
      // "old,new" per line; a header row and blank lines are skipped.
      const rows = String(body.csv ?? "")
        .split(/\r?\n/)
        .map((line) => line.split(/[,\t;]/).map((cell) => cell.trim().replace(/^"|"$/g, "")))
        .filter((cells) => cells.length >= 2 && cells[0] && cells[1] && !/^(path|from|old)/i.test(cells[0]))
        .slice(0, 1000);
      let created = 0;
      const errors: string[] = [];
      for (const [from, to] of rows) {
        try {
          await createRedirect(admin, from, to);
          created++;
        } catch (error) {
          errors.push(`${from}: ${(error as Error).message}`);
        }
      }
      return { ok: errors.length === 0, message: `${created} redirects created${errors.length ? `, ${errors.length} skipped` : ""}`, errors: errors.slice(0, 10) };
    }
    case "auto":
      if (!hasFeature(shop.plan, "autoRedirect") && body.autoRedirect404) {
        return { ok: false, message: "Automatic redirects are on the Pro plan and up." };
      }
      await saveSettings(admin, shop, {
        autoRedirect404: Boolean(body.autoRedirect404),
        fallbackRedirect: toPath(body.fallbackRedirect || "/") || "/",
      });
      return { ok: true, message: "Saved" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function Links() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const go = (tab: Tab) => setParams(new URLSearchParams({ tab }));

  return (
    <s-page heading="Links & redirects">
      <s-section>
        <s-stack direction="inline" gap="small-200">
          <s-button variant={d.tab === "broken" ? "primary" : "secondary"} onClick={() => go("broken")}>
            Broken links ({d.counts.broken})
          </s-button>
          <s-button variant={d.tab === "404" ? "primary" : "secondary"} onClick={() => go("404")}>
            404 monitor ({d.counts.notFound})
          </s-button>
          <s-button variant={d.tab === "redirects" ? "primary" : "secondary"} onClick={() => go("redirects")}>
            Redirects
          </s-button>
        </s-stack>
      </s-section>

      {d.tab === "broken" ? <Broken d={d} /> : null}
      {d.tab === "404" ? <NotFoundTab d={d} /> : null}
      {d.tab === "redirects" ? <Redirects d={d} params={params} setParams={setParams} /> : null}
    </s-page>
  );
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

function useToast(fetcher: ReturnType<typeof useFetcher<typeof action>>) {
  useEffect(() => {
    if (fetcher.data?.message) window.shopify?.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data]);
}

function RedirectForm({ path, suggestion, extra }: { path: string; suggestion: string | null; extra: Record<string, string> }) {
  const [target, setTarget] = useState(suggestion ?? "");
  const fetcher = useFetcher<typeof action>();
  useToast(fetcher);
  return (
    <s-stack direction="inline" gap="small-200" alignItems="end">
      <TextField label="Redirect to" value={target} onChange={setTarget} placeholder="/collections/all" />
      <s-button
        disabled={!target || undefined}
        loading={fetcher.state !== "idle" || undefined}
        onClick={() => fetcher.submit({ intent: "redirect", path, target, ...extra }, { method: "post", encType: "application/json" })}
      >
        Redirect
      </s-button>
    </s-stack>
  );
}

function Broken({ d }: { d: Data }) {
  const ignore = useFetcher<typeof action>();
  if (!d.broken.length) {
    return (
      <s-section>
        <s-paragraph>No broken internal links in the last audit. Links are checked every time you run an audit.</s-paragraph>
        <s-button href="/app/audit">Run audit</s-button>
      </s-section>
    );
  }
  return (
    <s-section heading="Broken internal links">
      <s-paragraph color="subdued">
        Redirect each dead URL to a live page so visitors and search engines land somewhere useful. Better still, fix the
        link on the page it's on.
      </s-paragraph>
      <s-stack gap="base">
        {d.broken.map((link) => (
          <s-box key={link.id} padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small-200">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-badge tone="critical">{link.status || "No answer"}</s-badge>
                <s-text>{link.path}</s-text>
              </s-stack>
              <s-text color="subdued">
                Linked from <s-link href={link.sourceUrl} target="_blank">{new URL(link.sourceUrl).pathname}</s-link>
              </s-text>
              <s-stack direction="inline" gap="base" alignItems="end">
                <RedirectForm path={link.path} suggestion={d.suggestions[link.path] ?? null} extra={{ linkId: link.id }} />
                <s-button variant="tertiary" onClick={() => ignore.submit({ intent: "ignore-link", id: link.id }, { method: "post", encType: "application/json" })}>
                  Ignore
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}

function NotFoundTab({ d }: { d: Data }) {
  const [auto, setAuto] = useState(d.autoRedirect);
  const [fallback, setFallback] = useState(d.fallback);
  const save = useFetcher<typeof action>();
  const ignore = useFetcher<typeof action>();
  useToast(save);

  return (
    <>
      <s-section heading="Automatic redirects">
        <s-stack gap="base">
          <Checkbox
            label={`Redirect new 404s automatically${d.canAuto ? "" : " (Pro)"}`}
            details="Sends visitors to the closest matching product, collection or page, and saves it as a permanent Shopify redirect."
            checked={auto}
            disabled={!d.canAuto}
            onChange={setAuto}
          />
          <TextField label="When nothing matches, redirect to" value={fallback} onChange={setFallback} />
          <s-button
            loading={save.state !== "idle" || undefined}
            onClick={() => save.submit({ intent: "auto", autoRedirect404: auto, fallbackRedirect: fallback }, { method: "post", encType: "application/json" })}
          >
            Save
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="404s visitors hit">
        {d.notFound.length === 0 ? (
          <s-paragraph color="subdued">
            None recorded yet. With the Rank Well app embed on, every visit to a missing page is logged here.
          </s-paragraph>
        ) : (
          <s-stack gap="base">
            {d.notFound.map((row) => (
              <s-box key={row.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack gap="small-200">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-badge>{row.hits} hits</s-badge>
                    <s-text>{row.path}</s-text>
                    {row.redirectTo ? <s-badge tone="success">→ {row.redirectTo}</s-badge> : null}
                  </s-stack>
                  <s-text color="subdued">
                    Last seen {new Date(row.lastSeen).toLocaleString()}
                    {row.referrer ? ` · from ${row.referrer}` : ""}
                  </s-text>
                  {!row.redirectTo ? (
                    <s-stack direction="inline" gap="base" alignItems="end">
                      <RedirectForm path={row.path} suggestion={d.suggestions[row.path] ?? null} extra={{ notFoundId: row.id }} />
                      <s-button variant="tertiary" onClick={() => ignore.submit({ intent: "ignore-404", id: row.id }, { method: "post", encType: "application/json" })}>
                        Dismiss
                      </s-button>
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </>
  );
}

function Redirects({ d, params, setParams }: { d: Data; params: URLSearchParams; setParams: (p: URLSearchParams) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [csv, setCsv] = useState("");
  const [q, setQ] = useState(d.q);
  const create = useFetcher<typeof action>();
  const remove = useFetcher<typeof action>();
  const importer = useFetcher<typeof action>();
  useToast(create);
  useToast(remove);
  useToast(importer);
  useEffect(() => {
    if (create.data?.ok) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing a fetcher result into the form
      setFrom("");
      setTo("");
    }
  }, [create.data]);

  return (
    <>
      <s-section heading="Add a redirect">
        <s-stack direction="inline" gap="small-200" alignItems="end">
          <TextField label="Old path" value={from} onChange={setFrom} placeholder="/old-page" />
          <TextField label="Redirect to" value={to} onChange={setTo} placeholder="/pages/new-page" />
          <s-button
            variant="primary"
            loading={create.state !== "idle" || undefined}
            onClick={() => create.submit({ intent: "redirect", path: from, target: to }, { method: "post", encType: "application/json" })}
          >
            Add
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Import from CSV">
        <s-stack gap="small-200">
          <textarea
            aria-label="CSV"
            rows={4}
            value={csv}
            placeholder={"/old-url,/new-url\n/another-old,/collections/sale"}
            onChange={(e) => setCsv(e.currentTarget.value)}
            style={{ width: "100%", font: "13px monospace", padding: 8, borderRadius: 8, border: "1px solid #8a8a8a", boxSizing: "border-box" }}
          />
          <s-button
            disabled={!csv.trim() || undefined}
            loading={importer.state !== "idle" || undefined}
            onClick={() => importer.submit({ intent: "import", csv }, { method: "post", encType: "application/json" })}
          >
            Import
          </s-button>
          {importer.data && "errors" in importer.data && importer.data.errors?.length ? (
            <s-banner tone="warning">
              {importer.data.errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </s-banner>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Your redirects">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setParams(new URLSearchParams({ tab: "redirects", ...(q ? { q } : {}) }));
          }}
        >
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <TextField label="Search paths" value={q} onChange={setQ} />
            <s-button type="submit">Search</s-button>
          </s-stack>
        </form>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">From</s-table-header>
            <s-table-header>To</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {(d.redirects?.nodes ?? []).map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>{r.path}</s-table-cell>
                <s-table-cell>{r.target}</s-table-cell>
                <s-table-cell>
                  <s-button variant="tertiary" tone="critical" onClick={() => remove.submit({ intent: "delete-redirect", id: r.id }, { method: "post", encType: "application/json" })}>
                    Delete
                  </s-button>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {d.redirects?.pageInfo.hasNextPage ? (
          <s-button
            variant="tertiary"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("after", d.redirects!.pageInfo.endCursor!);
              setParams(next);
            }}
          >
            Next page
          </s-button>
        ) : null}
      </s-section>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
