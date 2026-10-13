import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext, jsonBody } from "../lib/context.server";
import { AiError } from "../lib/ai.server";
import { listProductImages, saveAlt, suggestAlt, templateAlt, type BulkAltPayload } from "../lib/alt.server";
import { activeJob, enqueue, jobView } from "../lib/jobs.server";
import { LimitError } from "../lib/usage.server";
import { JobProgress } from "../components/JobProgress";

const SHOWN = 200;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  const filter = new URL(request.url).searchParams.get("filter") === "all" ? "all" : "missing";
  const images = await listProductImages(admin, { limit: 250 });
  const shopName = shop.name ?? shop.domain;
  const missing = images.filter((i) => !i.alt?.trim()).length;
  const shown = (filter === "missing" ? images.filter((i) => !i.alt?.trim()) : images).slice(0, SHOWN);
  return {
    filter,
    total: images.length,
    missing,
    job: jobView(await activeJob(shop.id, "alt.bulk")),
    images: shown.map((i) => ({
      mediaId: i.mediaId,
      productId: i.productId,
      productTitle: i.productTitle,
      url: i.url,
      alt: i.alt ?? "",
      template: templateAlt(i, settings, shopName),
    })),
  };
};

type Body =
  | { intent: "save"; mediaId: string; alt: string }
  | { intent: "suggest"; mediaId: string; productId: string }
  | ({ intent: "bulk" } & BulkAltPayload);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const body = await jsonBody<Body>(request);
  if (body.intent === "save") {
    try {
      await saveAlt(admin, [{ mediaId: body.mediaId, alt: body.alt }]);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }
  if (body.intent === "suggest") {
    const images = await listProductImages(admin, { productIds: [body.productId] });
    const image = images.find((i) => i.mediaId === body.mediaId);
    if (!image) return { ok: false, message: "Image not found." };
    try {
      return { ok: true, mediaId: body.mediaId, alt: await suggestAlt(shop, image) };
    } catch (error) {
      if (error instanceof LimitError || error instanceof AiError) return { ok: false, message: error.message };
      throw error;
    }
  }
  if (body.intent === "bulk") {
    if (await activeJob(shop.id, "alt.bulk")) return { ok: false, message: "An alt text update is already running." };
    const job = await enqueue(shop.id, "alt.bulk", {
      mode: body.mode === "ai" ? "ai" : "template",
      overwrite: Boolean(body.overwrite),
      productIds: Array.isArray(body.productIds) ? body.productIds.slice(0, 1000) : [],
    } satisfies BulkAltPayload);
    return { ok: true, job: jobView(job) };
  }
  return { ok: false, message: "Unknown action" };
};

export default function Images() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const bulk = useFetcher<typeof action>();
  const job = (bulk.data && "job" in bulk.data ? bulk.data.job : null) ?? d.job;

  const run = (mode: "template" | "ai", overwrite: boolean) =>
    bulk.submit({ intent: "bulk", mode, overwrite, productIds: [] }, { method: "post", encType: "application/json" });

  return (
    <s-page heading="Image alt text">
      <s-section>
        <s-stack gap="small-200">
          <s-paragraph>
            Alt text describes an image to screen readers and to Google Images. {d.missing} of {d.total} product images
            {d.total >= 250 ? " (first 250 products)" : ""} have none.
          </s-paragraph>
          <s-stack direction="inline" gap="small-200">
            <s-button variant="primary" onClick={() => run("ai", false)}>
              Write missing alt text with AI
            </s-button>
            <s-button onClick={() => run("template", false)}>Fill missing from template</s-button>
            <s-button variant="tertiary" onClick={() => run("ai", true)}>
              Rewrite all with AI
            </s-button>
          </s-stack>
          <s-text color="subdued">AI looks at each picture: 1 credit per image. The template is free and editable in Settings.</s-text>
        </s-stack>
      </s-section>

      <JobProgress job={job} label="Alt text update" />
      {bulk.data && !bulk.data.ok && "message" in bulk.data ? <s-banner tone="warning">{bulk.data.message}</s-banner> : null}
      {job?.status === "DONE" && job.result ? (
        <s-banner tone="success" dismissible>
          Alt text saved on {(job.result as { saved?: number }).saved ?? 0} images.
        </s-banner>
      ) : null}

      <s-section>
        <s-stack direction="inline" gap="small-200">
          {(["missing", "all"] as const).map((f) => (
            <s-button
              key={f}
              variant={d.filter === f ? "primary" : "secondary"}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("filter", f);
                setParams(next);
              }}
            >
              {f === "missing" ? `Missing (${d.missing})` : "All images"}
            </s-button>
          ))}
        </s-stack>
      </s-section>

      <s-grid gridTemplateColumns="repeat(auto-fill, minmax(240px, 1fr))" gap="base">
        {d.images.map((image) => (
          <ImageCard key={image.mediaId} image={image} />
        ))}
      </s-grid>
      {d.images.length === 0 ? (
        <s-section>
          <s-paragraph>Every image here has alt text.</s-paragraph>
        </s-section>
      ) : null}
    </s-page>
  );
}

function ImageCard({ image }: { image: ReturnType<typeof useLoaderData<typeof loader>>["images"][number] }) {
  const [alt, setAlt] = useState(image.alt);
  const save = useFetcher<typeof action>();
  const suggest = useFetcher<typeof action>();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing a fetcher result into the form
    if (suggest.data && "alt" in suggest.data && suggest.data.alt) setAlt(suggest.data.alt);
  }, [suggest.data]);
  useEffect(() => {
    if (save.data?.ok) window.shopify?.toast.show("Alt text saved");
  }, [save.data]);
  const thumb = `${image.url}${image.url.includes("?") ? "&" : "?"}width=360`;

  return (
    <s-section>
      <s-stack gap="small-200">
        <img src={thumb} alt={alt || ""} style={{ width: "100%", aspectRatio: "1", objectFit: "contain", background: "#f6f6f7", borderRadius: 8 }} />
        <s-text color="subdued">{image.productTitle}</s-text>
        <textarea
          aria-label="Alt text"
          value={alt}
          rows={2}
          maxLength={512}
          placeholder={image.template}
          onChange={(e) => setAlt(e.currentTarget.value)}
          style={{ width: "100%", font: "inherit", padding: 6, borderRadius: 8, border: "1px solid #8a8a8a", boxSizing: "border-box" }}
        />
        {suggest.data && !suggest.data.ok && "message" in suggest.data ? <s-text tone="critical">{suggest.data.message}</s-text> : null}
        <s-stack direction="inline" gap="small-100">
          <s-button
            variant="primary"
            disabled={alt === image.alt || undefined}
            loading={save.state !== "idle" || undefined}
            onClick={() => save.submit({ intent: "save", mediaId: image.mediaId, alt }, { method: "post", encType: "application/json" })}
          >
            Save
          </s-button>
          <s-button
            loading={suggest.state !== "idle" || undefined}
            onClick={() =>
              suggest.submit({ intent: "suggest", mediaId: image.mediaId, productId: image.productId }, { method: "post", encType: "application/json" })
            }
          >
            AI
          </s-button>
          <s-button variant="tertiary" onClick={() => setAlt(image.template)}>
            Template
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
