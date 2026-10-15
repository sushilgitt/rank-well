import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext, jsonBody, saveSettings } from "../lib/context.server";
import { listProductImages } from "../lib/alt.server";
import { COMPRESSIBLE, filenameOf, formatBytes, savedRatio } from "../lib/images";
import {
  IMAGE_JOBS,
  compressWithCredit,
  latestBackups,
  renameOne,
  restoreOne,
  targetFilename,
  type CompressPayload,
} from "../lib/images.server";
import { activeJob, enqueue, jobView, PermanentError, type JobView } from "../lib/jobs.server";
import type { Settings } from "../lib/settings";
import { LimitError, usageFor } from "../lib/usage.server";
import { JobProgress } from "../components/JobProgress";
import { Select, TextField } from "../components/fields";

const SHOWN = 100;
type Show = "all" | "todo" | "compressed";

async function runningImageJob(shopId: string) {
  for (const type of IMAGE_JOBS) {
    const job = await activeJob(shopId, type);
    if (job) return job;
  }
  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  const show = (new URL(request.url).searchParams.get("show") ?? "all") as Show;
  const shopName = shop.name ?? shop.domain;
  const [images, latest, usage, job] = await Promise.all([
    listProductImages(admin, { limit: 250 }),
    latestBackups(shop.id),
    usageFor(shop),
    runningImageJob(shop.id),
  ]);

  const rows = images.map((image) => {
    const last = latest.get(image.mediaId);
    const compressible = Boolean(image.mimeType && COMPRESSIBLE.includes(image.mimeType));
    const status = !compressible ? "unsupported" : last?.status === "compressed" ? "compressed" : last?.status === "skipped" && last.bytesBefore === image.fileSize ? "optimized" : "original";
    return {
      mediaId: image.mediaId,
      productId: image.productId,
      productTitle: image.productTitle,
      url: image.url,
      filename: filenameOf(image.url),
      target: targetFilename(image, settings, shopName),
      size: image.fileSize,
      before: last?.status === "compressed" ? last.bytesBefore : null,
      status,
    };
  });

  let saved = 0;
  for (const row of latest.values()) if (row.status === "compressed") saved += row.bytesBefore - (row.bytesAfter ?? row.bytesBefore);

  const filtered = rows.filter((r) => (show === "todo" ? r.status === "original" : show === "compressed" ? r.status === "compressed" : true));
  return {
    show,
    settings: settings.images,
    total: rows.length,
    capped: images.length > 0 && rows.length >= 250,
    todo: rows.filter((r) => r.status === "original").length,
    compressed: rows.filter((r) => r.status === "compressed").length,
    renamable: rows.filter((r) => r.target && r.target !== r.filename).length,
    saved,
    creditsLeft: usage.left("images"),
    creditsLimit: usage.limits.images,
    job: jobView(job),
    rows: filtered.slice(0, SHOWN),
  };
};

type Body =
  | { intent: "settings"; images: Settings["images"] }
  | { intent: "compress-all" }
  | { intent: "restore-all" }
  | { intent: "rename-all" }
  | { intent: "compress" | "rename"; mediaId: string; productId: string }
  | { intent: "restore"; mediaId: string };

const fail = (message: string) => ({ ok: false as const, message });

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  const body = await jsonBody<Body>(request);

  if (body.intent === "settings") {
    const quality = ["light", "balanced", "strong"].includes(body.images?.quality) ? body.images.quality : "balanced";
    const maxSize = [0, 2048, 2560, 3000, 4096].includes(Number(body.images?.maxSize)) ? Number(body.images.maxSize) : 2560;
    const filenameTemplate = String(body.images?.filenameTemplate ?? "").trim().slice(0, 200) || "{{title}}{{variant}}";
    await saveSettings(admin, shop, { images: { quality, maxSize, filenameTemplate } });
    return { ok: true as const, saved: "settings" };
  }

  if (await runningImageJob(shop.id)) return fail("Another image task is running. Wait for it to finish.");

  if (body.intent === "compress-all" || body.intent === "restore-all" || body.intent === "rename-all") {
    const type = { "compress-all": "images.compress", "restore-all": "images.restore", "rename-all": "images.rename" }[body.intent];
    const job = await enqueue(shop.id, type, type === "images.compress" ? ({ mediaIds: [] } satisfies CompressPayload) : {});
    return { ok: true as const, job: jobView(job) };
  }

  try {
    if (body.intent === "restore") {
      const row = (await latestBackups(shop.id, [body.mediaId])).get(body.mediaId);
      if (!row) return fail("This image has no backup.");
      await restoreOne(admin, row);
      return { ok: true as const, message: "Original restored. Shopify may take a minute to show it." };
    }
    const image = (await listProductImages(admin, { productIds: [body.productId] })).find((i) => i.mediaId === body.mediaId);
    if (!image) return fail("Image not found.");
    if (body.intent === "compress") {
      const outcome = await compressWithCredit(admin, shop, image, settings);
      return outcome.status === "compressed"
        ? { ok: true as const, message: `Compressed: ${formatBytes(outcome.before)} → ${formatBytes(outcome.after)}` }
        : { ok: true as const, message: outcome.reason };
    }
    if (body.intent === "rename") {
      const outcome = await renameOne(admin, image, settings, shop.name ?? shop.domain);
      return { ok: true as const, message: outcome.status === "renamed" ? `Renamed to ${outcome.filename}` : outcome.reason };
    }
  } catch (error) {
    if (error instanceof LimitError || error instanceof PermanentError) return fail(error.message);
    console.error("Image action failed", error);
    return fail((error as Error).message || "Something went wrong.");
  }
  return fail("Unknown action");
};

const JOB_LABEL: Record<string, string> = {
  "images.compress": "Compression",
  "images.restore": "Restore",
  "images.rename": "Renaming",
};

function summary(job: JobView) {
  const r = (job.result ?? {}) as { compressed?: number; skipped?: number; saved?: number; restored?: number; renamed?: number; failed?: number; errors?: string[] };
  const failed = r.failed ? ` ${r.failed} failed${r.errors?.length ? `: ${r.errors.join("; ")}` : "."}` : "";
  if (job.type === "images.compress") {
    return `${r.compressed ?? 0} images compressed, ${formatBytes(r.saved ?? 0)} saved. ${r.skipped ?? 0} were already optimized.${failed}`;
  }
  if (job.type === "images.restore") return `${r.restored ?? 0} originals restored.${failed}`;
  return `${r.renamed ?? 0} files renamed.${failed}`;
}

export default function Optimize() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const bulk = useFetcher<typeof action>();
  const save = useFetcher<typeof action>();
  const [settings, setSettings] = useState(d.settings);
  const [finished, setFinished] = useState<JobView | null>(null);
  const job = (bulk.data && "job" in bulk.data ? bulk.data.job : null) ?? d.job;
  const busy = Boolean(job && (job.status === "QUEUED" || job.status === "RUNNING"));
  const onDone = useCallback((j: JobView) => setFinished(j), []);

  useEffect(() => {
    if (save.data?.ok) window.shopify?.toast.show("Image settings saved");
  }, [save.data]);

  const submit = (intent: "compress-all" | "restore-all" | "rename-all") => {
    if (intent === "restore-all" && !window.confirm("Put back the original of every compressed image?")) return;
    setFinished(null);
    bulk.submit({ intent }, { method: "post", encType: "application/json" });
  };

  return (
    <s-page heading="Image optimizer">
      <s-section>
        <s-stack gap="small-200">
          <s-paragraph>
            {d.compressed} of {d.total} product images compressed{d.capped ? " (first 250 products)" : ""}, saving {formatBytes(d.saved)}.{" "}
            {d.todo} can still be compressed.
          </s-paragraph>
          <s-stack direction="inline" gap="small-200">
            <s-button variant="primary" disabled={busy || !d.todo || undefined} onClick={() => submit("compress-all")}>
              Compress {d.todo} images
            </s-button>
            <s-button disabled={busy || !d.renamable || undefined} onClick={() => submit("rename-all")}>
              Rename {d.renamable} files for SEO
            </s-button>
            <s-button variant="tertiary" tone="critical" disabled={busy || !d.compressed || undefined} onClick={() => submit("restore-all")}>
              Restore all originals
            </s-button>
          </s-stack>
          <s-text color="subdued">
            {Number.isFinite(d.creditsLimit) ? `${d.creditsLeft} of ${d.creditsLimit} image compressions left this period. ` : ""}
            Images that are already optimized don't use a compression.
          </s-text>
        </s-stack>
      </s-section>

      <JobProgress job={job} label={JOB_LABEL[job?.type ?? ""] ?? "Image task"} onDone={onDone} />
      {bulk.data && !bulk.data.ok ? <s-banner tone="warning">{bulk.data.message}</s-banner> : null}
      {finished?.status === "DONE" ? (
        <s-banner tone="success" dismissible>
          {summary(finished)}
        </s-banner>
      ) : null}

      <s-section heading="How it works">
        <s-stack gap="small-200">
          <s-paragraph>
            Each image is re-encoded in its own format and scaled down if it is larger than needed. It keeps its place on the
            product, its alt text and its variants.
          </s-paragraph>
          <s-paragraph>
            Before an image is replaced, the original is saved in Content → Files as <s-text type="strong">rankwell-original-…</s-text>.
            Restore puts it back. Delete those files only if you're sure you won't need the originals.
          </s-paragraph>
          <s-paragraph color="subdued">
            Images keep their file format: Shopify's CDN already sends WebP or AVIF to browsers that support them.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Settings">
        <s-stack gap="base">
          <Select
            label="Compression"
            value={settings.quality}
            onChange={(v) => setSettings({ ...settings, quality: v as Settings["images"]["quality"] })}
            options={[
              { value: "light", label: "Light: no visible change, smaller savings" },
              { value: "balanced", label: "Balanced (recommended)" },
              { value: "strong", label: "Strong: smallest files, some visible softening" },
            ]}
          />
          <Select
            label="Scale down images larger than"
            value={String(settings.maxSize)}
            onChange={(v) => setSettings({ ...settings, maxSize: Number(v) })}
            options={[
              { value: "0", label: "Keep the original size" },
              { value: "2048", label: "2048 px" },
              { value: "2560", label: "2560 px (recommended, sharp on large screens and zoom)" },
              { value: "3000", label: "3000 px" },
              { value: "4096", label: "4096 px" },
            ]}
          />
          <TextField
            label="SEO file name template"
            value={settings.filenameTemplate}
            onChange={(v) => setSettings({ ...settings, filenameTemplate: v })}
            details="Placeholders: {{title}}, {{vendor}}, {{type}}, {{shop}}, {{variant}}. Becomes e.g. blue-cotton-tee-red.jpg; the extension never changes."
          />
          <s-stack direction="inline">
            <s-button
              loading={save.state !== "idle" || undefined}
              onClick={() => save.submit({ intent: "settings", images: settings }, { method: "post", encType: "application/json" })}
            >
              Save settings
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200">
            {(
              [
                ["all", `All (${d.total})`],
                ["todo", `Not compressed (${d.todo})`],
                ["compressed", `Compressed (${d.compressed})`],
              ] as [Show, string][]
            ).map(([value, label]) => (
              <s-button
                key={value}
                variant={d.show === value ? "primary" : "secondary"}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("show", value);
                  setParams(next);
                }}
              >
                {label}
              </s-button>
            ))}
          </s-stack>
          {d.rows.length ? (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Image</s-table-header>
                <s-table-header>File name</s-table-header>
                <s-table-header>Size</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {d.rows.map((row) => (
                  <Row key={row.mediaId} row={row} busy={busy} />
                ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-paragraph>No images here.</s-paragraph>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

type RowData = ReturnType<typeof useLoaderData<typeof loader>>["rows"][number];

function Row({ row, busy }: { row: RowData; busy: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const working = fetcher.state !== "idle";
  const result = fetcher.data && "message" in fetcher.data ? fetcher.data : null;
  const run = (intent: "compress" | "rename" | "restore") =>
    fetcher.submit({ intent, mediaId: row.mediaId, productId: row.productId }, { method: "post", encType: "application/json" });
  const thumb = `${row.url}${row.url.includes("?") ? "&" : "?"}width=96`;
  const pct = row.before && row.size ? Math.round(savedRatio(row.before, row.size) * 100) : 0;

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <img src={thumb} alt="" width={48} height={48} style={{ objectFit: "contain", background: "#f6f6f7", borderRadius: 6 }} />
          <s-text>{row.productTitle}</s-text>
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack gap="small-100">
          <s-text>{row.filename}</s-text>
          {row.target && row.target !== row.filename ? <s-text color="subdued">→ {row.target}</s-text> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {row.before ? `${formatBytes(row.before)} → ${formatBytes(row.size)} (−${pct}%)` : formatBytes(row.size)}
      </s-table-cell>
      <s-table-cell>
        <s-stack gap="small-100">
          {row.status === "compressed" ? (
            <s-badge tone="success">Compressed</s-badge>
          ) : row.status === "optimized" ? (
            <s-badge tone="info">Already optimized</s-badge>
          ) : row.status === "unsupported" ? (
            <s-badge>Format kept</s-badge>
          ) : (
            <s-badge tone="warning">Original</s-badge>
          )}
          {result ? <s-text tone={result.ok ? "success" : "critical"}>{result.message}</s-text> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-100">
          {row.status === "original" ? (
            <s-button disabled={busy || undefined} loading={working || undefined} onClick={() => run("compress")}>
              Compress
            </s-button>
          ) : null}
          {row.status === "compressed" ? (
            <s-button variant="tertiary" disabled={busy || undefined} loading={working || undefined} onClick={() => run("restore")}>
              Restore
            </s-button>
          ) : null}
          {row.target && row.target !== row.filename ? (
            <s-button variant="tertiary" disabled={busy || undefined} loading={working || undefined} onClick={() => run("rename")}>
              Rename
            </s-button>
          ) : null}
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
