import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext, jsonBody, saveSettings } from "../lib/context.server";
import { AiError } from "../lib/ai.server";
import { cleanFaqs, generateFaqs, readFaqs, saveFaqs, type Faq } from "../lib/faq.server";
import { buildLlmsTxt, clearLlmsCache } from "../lib/llms.server";
import { hasFeature } from "../lib/plans";
import { createRedirect, listRedirects } from "../lib/redirects.server";
import { listProducts } from "../lib/resources.server";
import { LimitError } from "../lib/usage.server";
import type { Settings } from "../lib/settings";
import { Checkbox, NumberField, TextArea, TextField } from "../components/fields";

const LLMS_PATH = "/llms.txt";
const PROXY_PATH = "/apps/ranklift/llms.txt";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const paid = hasFeature(shop.plan, "llmsTxt");
  const [products, redirect] = await Promise.all([
    listProducts(admin, 50, q ? `title:*${q.replace(/["\\]/g, "")}*` : undefined),
    listRedirects(admin, 1, null, `path:${LLMS_PATH}`),
  ]);
  const base = shop.primaryUrl || `https://${shop.domain}`;
  return {
    paid,
    llms: settings.llms,
    rootLinked: redirect.nodes.some((r) => r.path === LLMS_PATH),
    llmsUrl: `${base}${LLMS_PATH}`,
    proxyUrl: `${base}${PROXY_PATH}`,
    preview: paid ? (await buildLlmsTxt(admin, shop)).slice(0, 6000) : null,
    q,
    products: products.map((p) => ({ id: p.id, title: p.title })),
  };
};

type Body =
  | { intent: "llms"; llms: Settings["llms"]; linkRoot: boolean }
  | { intent: "faq-load"; id: string }
  | { intent: "faq-generate"; id: string }
  | { intent: "faq-save"; id: string; faqs: Faq[] };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const body = await jsonBody<Body>(request);

  if (body.intent === "llms") {
    if (!hasFeature(shop.plan, "llmsTxt")) return { ok: false, message: "llms.txt is on the Pro plan and up." };
    const llms = body.llms;
    llms.maxProducts = Math.max(10, Math.min(1000, Number(llms.maxProducts) || 200));
    llms.summary = String(llms.summary ?? "").slice(0, 1000);
    await saveSettings(admin, shop, { llms });
    clearLlmsCache(shop.domain);
    if (body.linkRoot && llms.enabled) {
      const existing = await listRedirects(admin, 1, null, `path:${LLMS_PATH}`);
      if (!existing.nodes.some((r) => r.path === LLMS_PATH)) await createRedirect(admin, LLMS_PATH, PROXY_PATH);
    }
    return { ok: true, message: "Saved" };
  }

  if (body.intent === "faq-load") return { ok: true, id: body.id, faqs: await readFaqs(admin, body.id) };

  if (body.intent === "faq-generate") {
    const [product] = await listProducts(admin, 1, `id:${body.id.split("/").pop()}`);
    if (!product) return { ok: false, message: "Product not found." };
    try {
      return { ok: true, id: body.id, faqs: await generateFaqs(shop, product), generated: true };
    } catch (error) {
      if (error instanceof LimitError || error instanceof AiError) return { ok: false, message: error.message };
      throw error;
    }
  }

  if (body.intent === "faq-save") {
    const faqs = await saveFaqs(admin, body.id, cleanFaqs(body.faqs));
    return { ok: true, id: body.id, faqs, message: "FAQ saved" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function AiSearch() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="AI search (GEO)">
      <s-section>
        <s-paragraph>
          ChatGPT, Claude, Perplexity and Google's AI answers read your store differently from classic search. Give them a
          clean map of the store (llms.txt) and direct answers (FAQ structured data) so they can recommend you.
        </s-paragraph>
      </s-section>
      <Llms d={d} />
      <Faqs d={d} />
    </s-page>
  );
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

function Llms({ d }: { d: Data }) {
  const [llms, setLlms] = useState(d.llms);
  const [linkRoot, setLinkRoot] = useState(true);
  const fetcher = useFetcher<typeof action>();
  useEffect(() => {
    if (fetcher.data && "message" in fetcher.data && fetcher.data.message) window.shopify?.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data]);
  const set = <K extends keyof Settings["llms"]>(key: K, value: Settings["llms"][K]) => setLlms({ ...llms, [key]: value });

  if (!d.paid) {
    return (
      <s-section heading="llms.txt">
        <s-paragraph>An llms.txt file lists your collections, products, pages and policies for AI assistants. It's on the Pro plan.</s-paragraph>
        <s-button href="/app/plans">See plans</s-button>
      </s-section>
    );
  }
  return (
    <s-section heading="llms.txt">
      <s-stack gap="base">
        <Checkbox label="Publish llms.txt" checked={llms.enabled} onChange={(v) => set("enabled", v)} />
        <TextArea
          label="About your store"
          details="One or two sentences AI assistants should know: what you sell, for whom, what makes you different. Empty = your store description."
          value={llms.summary}
          onChange={(v) => set("summary", v)}
          rows={3}
        />
        <s-stack direction="inline" gap="base">
          <Checkbox label="Collections" checked={llms.includeCollections} onChange={(v) => set("includeCollections", v)} />
          <Checkbox label="Products" checked={llms.includeProducts} onChange={(v) => set("includeProducts", v)} />
          <Checkbox label="Pages" checked={llms.includePages} onChange={(v) => set("includePages", v)} />
          <Checkbox label="Blog posts" checked={llms.includeArticles} onChange={(v) => set("includeArticles", v)} />
        </s-stack>
        <NumberField label="Products to list (newest first)" value={llms.maxProducts} min={10} max={1000} onChange={(v) => set("maxProducts", v)} />
        {!d.rootLinked ? (
          <Checkbox
            label={`Also serve it at ${d.llmsUrl}`}
            details="Adds a Shopify URL redirect from /llms.txt, where AI crawlers look for it."
            checked={linkRoot}
            onChange={setLinkRoot}
          />
        ) : (
          <s-text color="subdued">
            Live at <s-link href={d.llmsUrl} target="_blank">{d.llmsUrl}</s-link>
          </s-text>
        )}
        <s-button
          variant="primary"
          loading={fetcher.state !== "idle" || undefined}
          onClick={() => fetcher.submit({ intent: "llms", llms, linkRoot }, { method: "post", encType: "application/json" })}
        >
          Save
        </s-button>
        {d.preview ? (
          <details>
            <summary>Preview</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "#f6f6f7", padding: 12, borderRadius: 8, maxHeight: 400, overflow: "auto" }}>
              {d.preview}
            </pre>
          </details>
        ) : null}
      </s-stack>
    </s-section>
  );
}

function Faqs({ d }: { d: Data }) {
  const [productId, setProductId] = useState<string | null>(null);
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [search, setSearch] = useState(d.q);
  const [, setParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    const data = fetcher.data;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing a fetcher result into the form
    if (data && "faqs" in data && data.faqs && data.id === productId) setFaqs(data.faqs);
    if (data && "message" in data && data.message) window.shopify?.toast.show(data.message, { isError: !data.ok });
  }, [fetcher.data, productId]);

  const open = (id: string) => {
    setProductId(id);
    setFaqs([]);
    fetcher.submit({ intent: "faq-load", id }, { method: "post", encType: "application/json" });
  };
  const update = (index: number, field: keyof Faq, value: string) => setFaqs(faqs.map((f, i) => (i === index ? { ...f, [field]: value } : f)));

  return (
    <s-section heading="Product FAQs">
      <s-stack gap="base">
        <s-paragraph color="subdued">
          FAQs are added to the product page as FAQ structured data (Pro). Write them yourself or let AI draft them from the
          product description (2 credits).
        </s-paragraph>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setParams(search ? new URLSearchParams({ q: search }) : new URLSearchParams());
          }}
        >
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <TextField label="Find a product" value={search} onChange={setSearch} />
            <s-button type="submit">Search</s-button>
          </s-stack>
        </form>
        <s-stack direction="inline" gap="small-200">
          {d.products.slice(0, 30).map((p) => (
            <s-button key={p.id} variant={p.id === productId ? "primary" : "secondary"} onClick={() => open(p.id)}>
              {p.title}
            </s-button>
          ))}
        </s-stack>

        {productId ? (
          <s-stack gap="base">
            {faqs.map((faq, index) => (
              <s-box key={index} padding="base" borderWidth="base" borderRadius="base">
                <s-stack gap="small-200">
                  <TextField label={`Question ${index + 1}`} value={faq.q} onChange={(v) => update(index, "q", v)} />
                  <TextArea label="Answer" value={faq.a} onChange={(v) => update(index, "a", v)} rows={2} />
                  <s-button variant="tertiary" tone="critical" onClick={() => setFaqs(faqs.filter((_, i) => i !== index))}>
                    Remove
                  </s-button>
                </s-stack>
              </s-box>
            ))}
            <s-stack direction="inline" gap="small-200">
              <s-button onClick={() => setFaqs([...faqs, { q: "", a: "" }])}>Add question</s-button>
              <s-button
                loading={fetcher.state !== "idle" || undefined}
                onClick={() => fetcher.submit({ intent: "faq-generate", id: productId }, { method: "post", encType: "application/json" })}
              >
                Draft with AI
              </s-button>
              <s-button
                variant="primary"
                onClick={() => fetcher.submit({ intent: "faq-save", id: productId, faqs: faqs.map((f) => ({ q: f.q, a: f.a })) }, { method: "post", encType: "application/json" })}
              >
                Save FAQ
              </s-button>
            </s-stack>
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
