import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext, jsonBody } from "../lib/context.server";
import { AiError } from "../lib/ai.server";
import { activeJob, enqueue, jobView } from "../lib/jobs.server";
import { saveMeta, suggestMeta, templateMeta, type BulkMetaPayload } from "../lib/meta.server";
import { hasFeature } from "../lib/plans";
import { listArticles, listCollections, listPages, listProducts, type ResourceType } from "../lib/resources.server";
import { LIMITS } from "../lib/templates";
import { LimitError } from "../lib/usage.server";
import { TextArea, TextField } from "../components/fields";
import { JobProgress } from "../components/JobProgress";

const TYPES: { id: ResourceType; label: string }[] = [
  { id: "product", label: "Products" },
  { id: "collection", label: "Collections" },
  { id: "page", label: "Pages" },
  { id: "article", label: "Blog posts" },
];

function typeFrom(value: string | null): ResourceType {
  return TYPES.some((t) => t.id === value) ? (value as ResourceType) : "product";
}

async function list(admin: Parameters<typeof listProducts>[0], type: ResourceType, q: string) {
  const limit = 250;
  if (type === "product") return listProducts(admin, limit, q ? `title:*${q.replace(/["\\]/g, "")}*` : undefined);
  const all = await (type === "collection" ? listCollections(admin, 1000) : type === "page" ? listPages(admin, 1000) : listArticles(admin, 1000));
  const needle = q.toLowerCase();
  return (needle ? all.filter((r) => r.title.toLowerCase().includes(needle)) : all).slice(0, limit);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  const url = new URL(request.url);
  const type = typeFrom(url.searchParams.get("type"));
  const q = url.searchParams.get("q")?.trim() ?? "";
  const resources = await list(admin, type, q);
  const shopName = shop.name ?? shop.domain;
  const job = await activeJob(shop.id, "meta.bulk");
  return {
    type,
    q,
    host: new URL(shop.primaryUrl || `https://${shop.domain}`).host,
    bulk: hasFeature(shop.plan, "bulkMeta"),
    job: jobView(job),
    items: resources.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      seoTitle: r.seoTitle ?? "",
      seoDescription: r.seoDescription ?? "",
      template: templateMeta(r, settings, shopName),
    })),
  };
};

type ActionBody =
  | { intent: "save"; id: string; type: ResourceType; title: string; description: string }
  | { intent: "suggest"; id: string; type: ResourceType }
  | ({ intent: "bulk" } & BulkMetaPayload);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const body = await jsonBody<ActionBody>(request);

  if (body.intent === "save") {
    try {
      await saveMeta(admin, { id: body.id, type: body.type, title: body.title, description: body.description });
      return { ok: true, message: "Saved" };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  if (body.intent === "suggest") {
    const [resource] = (await list(admin, body.type, "")).filter((r) => r.id === body.id);
    const target = resource ?? (body.type === "product" ? (await listProducts(admin, 1, `id:${body.id.split("/").pop()}`))[0] : null);
    if (!target) return { ok: false, message: "Item not found." };
    try {
      const suggestion = await suggestMeta(shop, target);
      return { ok: true, suggestion };
    } catch (error) {
      if (error instanceof LimitError || error instanceof AiError) return { ok: false, message: error.message };
      throw error;
    }
  }

  if (body.intent === "bulk") {
    if (!hasFeature(shop.plan, "bulkMeta")) return { ok: false, message: "Bulk editing is on the Pro plan and up." };
    if (await activeJob(shop.id, "meta.bulk")) return { ok: false, message: "A bulk update is already running." };
    const payload: BulkMetaPayload = {
      type: typeFrom(body.type),
      ids: Array.isArray(body.ids) ? body.ids.slice(0, 5000) : [],
      mode: body.mode === "ai" ? "ai" : "template",
      fields: (body.fields ?? []).filter((f) => f === "title" || f === "description"),
      overwrite: Boolean(body.overwrite),
    };
    if (!payload.fields.length) return { ok: false, message: "Choose title, description or both." };
    const job = await enqueue(shop.id, "meta.bulk", payload);
    return { ok: true, job: jobView(job) };
  }
  return { ok: false, message: "Unknown action" };
};

type Item = ReturnType<typeof useLoaderData<typeof loader>>["items"][number];

export default function MetaTags() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [search, setSearch] = useState(d.q);
  const bulk = useFetcher<typeof action>();
  const job = (bulk.data && "job" in bulk.data ? bulk.data.job : null) ?? d.job;

  // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing a fetcher result into the form
  useEffect(() => setSelected(new Set()), [d.type]);

  const setType = (type: string) => {
    const next = new URLSearchParams(params);
    next.set("type", type);
    next.delete("q");
    setSearch("");
    setParams(next);
  };

  const runBulk = (mode: "template" | "ai", overwrite: boolean) => {
    bulk.submit(
      { intent: "bulk", type: d.type, ids: [...selected], mode, fields: ["title", "description"], overwrite },
      { method: "post", encType: "application/json" },
    );
  };
  const scope = selected.size ? `${selected.size} selected` : `all ${TYPES.find((t) => t.id === d.type)?.label.toLowerCase()}`;
  const missing = d.items.filter((i) => !i.seoTitle || !i.seoDescription).length;

  return (
    <s-page heading="Meta tags">
      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200">
            {TYPES.map((t) => (
              <s-button key={t.id} variant={t.id === d.type ? "primary" : "secondary"} onClick={() => setType(t.id)}>
                {t.label}
              </s-button>
            ))}
          </s-stack>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const next = new URLSearchParams(params);
              if (search) next.set("q", search);
              else next.delete("q");
              setParams(next);
            }}
          >
            <s-stack direction="inline" gap="small-200" alignItems="end">
              <TextField label="Search" value={search} onChange={setSearch} placeholder="Name contains…" />
              <s-button type="submit">Search</s-button>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <JobProgress job={job} label="Bulk meta update" />
      {bulk.data && !bulk.data.ok && "message" in bulk.data ? <s-banner tone="warning">{bulk.data.message}</s-banner> : null}
      {job?.status === "DONE" && job.result ? (
        <s-banner tone="success" dismissible>
          Updated {(job.result as { saved?: number }).saved ?? 0} items.
        </s-banner>
      ) : null}

      <s-section heading="Bulk actions">
        {d.bulk ? (
          <s-stack gap="small-200">
            <s-text color="subdued">
              Applies to {scope}. {missing} of {d.items.length} shown are missing a title or description.
            </s-text>
            <s-stack direction="inline" gap="small-200">
              <s-button onClick={() => runBulk("template", false)}>Fill empty fields from template</s-button>
              <s-button onClick={() => runBulk("ai", false)}>Fill empty fields with AI</s-button>
              <s-button onClick={() => runBulk("ai", true)}>Rewrite with AI</s-button>
              <s-button variant="tertiary" onClick={() => runBulk("template", true)}>
                Overwrite with template
              </s-button>
            </s-stack>
            <s-text color="subdued">AI costs 1 credit per item. Templates are free; edit them in Settings.</s-text>
          </s-stack>
        ) : (
          <s-stack gap="small-200">
            <s-paragraph>Edit items one by one below, or upgrade to Pro to fill every product in one go.</s-paragraph>
            <s-button href="/app/plans">See plans</s-button>
          </s-stack>
        )}
      </s-section>

      <s-section padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={selected.size > 0 && selected.size === d.items.length}
                onChange={(e) => setSelected(e.currentTarget.checked ? new Set(d.items.map((i) => i.id)) : new Set())}
              />
            </s-table-header>
            <s-table-header listSlot="primary">Name</s-table-header>
            <s-table-header>SEO title</s-table-header>
            <s-table-header>Meta description</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {d.items.map((item) => (
              <s-table-row key={item.id}>
                <s-table-cell>
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.title}`}
                    checked={selected.has(item.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.currentTarget.checked) next.add(item.id);
                      else next.delete(item.id);
                      setSelected(next);
                    }}
                  />
                </s-table-cell>
                <s-table-cell>{item.title}</s-table-cell>
                <s-table-cell>
                  <Length value={item.seoTitle} max={LIMITS.title} min={30} />
                </s-table-cell>
                <s-table-cell>
                  <Length value={item.seoDescription} max={LIMITS.description + 5} min={70} />
                </s-table-cell>
                <s-table-cell>
                  <s-button variant="tertiary" onClick={() => setEditing(editing === item.id ? null : item.id)}>
                    {editing === item.id ? "Close" : "Edit"}
                  </s-button>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {d.items.length === 0 ? (
          <s-box padding="base">
            <s-text color="subdued">Nothing here yet.</s-text>
          </s-box>
        ) : null}
      </s-section>

      {editing ? (
        <Editor key={editing} item={d.items.find((i) => i.id === editing)!} type={d.type} host={d.host} onClose={() => setEditing(null)} />
      ) : null}
    </s-page>
  );
}

function Length({ value, max, min }: { value: string; max: number; min: number }) {
  if (!value) return <s-badge tone="critical">Missing</s-badge>;
  const tone = value.length > max || value.length < min ? "warning" : "success";
  return (
    <s-stack gap="small-100">
      <s-text>{value.length > 90 ? `${value.slice(0, 90)}…` : value}</s-text>
      <s-badge tone={tone}>{value.length} chars</s-badge>
    </s-stack>
  );
}

function Editor({ item, type, host, onClose }: { item: Item; type: ResourceType; host: string; onClose: () => void }) {
  const [title, setTitle] = useState(item.seoTitle);
  const [description, setDescription] = useState(item.seoDescription);
  const save = useFetcher<typeof action>();
  const suggest = useFetcher<typeof action>();

  useEffect(() => {
    const data = suggest.data;
    if (data && "suggestion" in data && data.suggestion) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing a fetcher result into the form
      if (data.suggestion.title) setTitle(data.suggestion.title);
      if (data.suggestion.description) setDescription(data.suggestion.description);
    }
  }, [suggest.data]);

  useEffect(() => {
    if (save.data?.ok) window.shopify?.toast.show("Saved");
  }, [save.data]);

  const path = item.url ? new URL(item.url, "https://x").pathname : "";

  return (
    <s-section heading={`Edit: ${item.title}`}>
      <s-stack gap="base">
        <TextField
          label={`SEO title (${title.length}/${LIMITS.title})`}
          value={title}
          onChange={setTitle}
          error={title.length > 70 ? "Search engines cut titles past ~60 characters." : undefined}
        />
        <TextArea label={`Meta description (${description.length}/${LIMITS.description})`} value={description} onChange={setDescription} rows={3} />

        <s-box padding="base" borderRadius="base" background="subdued">
          <s-stack gap="small-100">
            <s-text color="subdued">Search preview</s-text>
            <span style={{ color: "#1a0dab", fontSize: 18 }}>{(title || item.title).slice(0, 60)}</span>
            <span style={{ color: "#006621", fontSize: 13 }}>
              {host}
              {path}
            </span>
            <span style={{ color: "#4d5156", fontSize: 13 }}>{(description || "No description: Google picks text from the page.").slice(0, 160)}</span>
          </s-stack>
        </s-box>

        {suggest.data && !suggest.data.ok && "message" in suggest.data ? <s-banner tone="warning">{suggest.data.message}</s-banner> : null}
        {save.data && !save.data.ok && "message" in save.data ? <s-banner tone="critical">{save.data.message}</s-banner> : null}

        <s-stack direction="inline" gap="small-200">
          <s-button
            variant="primary"
            loading={save.state !== "idle" || undefined}
            onClick={() =>
              save.submit({ intent: "save", id: item.id, type, title, description }, { method: "post", encType: "application/json" })
            }
          >
            Save
          </s-button>
          <s-button
            loading={suggest.state !== "idle" || undefined}
            onClick={() => suggest.submit({ intent: "suggest", id: item.id, type }, { method: "post", encType: "application/json" })}
          >
            Write with AI (1 credit)
          </s-button>
          <s-button
            variant="tertiary"
            onClick={() => {
              setTitle(item.template.title);
              setDescription(item.template.description);
            }}
          >
            Use template
          </s-button>
          <s-button variant="tertiary" onClick={onClose}>
            Close
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
