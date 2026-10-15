import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext, jsonBody, saveSettings } from "../lib/context.server";
import { embedLink, embedStatus } from "../lib/publish.server";
import { hasFeature } from "../lib/plans";
import type { Settings } from "../lib/settings";
import { Checkbox, Grid, Select, TextArea, TextField } from "../components/fields";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  const embed = await embedStatus(admin);
  return {
    schema: settings.schema,
    paid: hasFeature(shop.plan, "jsonLd"),
    embedOn: embed.seo,
    embedUrl: embedLink(shop.domain),
    testUrl: `https://search.google.com/test/rich-results?url=${encodeURIComponent(shop.primaryUrl || `https://${shop.domain}`)}`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const body = await jsonBody<{ schema: Settings["schema"] }>(request);
  const schema = body.schema;
  if (!schema || typeof schema !== "object") return { ok: false };
  schema.sameAs = (Array.isArray(schema.sameAs) ? schema.sameAs : [])
    .map((url) => String(url).trim())
    .filter((url) => /^https?:\/\//.test(url))
    .slice(0, 20);
  await saveSettings(admin, shop, { schema });
  return { ok: true };
};

const TYPES: { key: keyof Settings["schema"]; label: string; details: string; paid?: boolean }[] = [
  { key: "organization", label: "Organization", details: "Your brand, logo and social profiles on the home page." },
  { key: "website", label: "Website + sitelinks search box", details: "Lets Google show a search box for your store." },
  { key: "breadcrumbs", label: "Breadcrumbs", details: "The page path shown under your result in Google." },
  { key: "product", label: "Product", details: "Price, availability, brand, SKU/GTIN and review stars.", paid: true },
  { key: "collection", label: "Collection", details: "The products listed on collection pages.", paid: true },
  { key: "article", label: "Blog article", details: "Headline, author, dates and image for blog posts.", paid: true },
  { key: "faq", label: "FAQ", details: "Questions and answers you add on the AI search page.", paid: true },
  { key: "localBusiness", label: "Local business", details: "Address, phone and hours for a physical store.", paid: true },
];

export default function Schema() {
  const d = useLoaderData<typeof loader>();
  const [schema, setSchema] = useState(d.schema);
  const fetcher = useFetcher<typeof action>();
  useEffect(() => {
    if (fetcher.data?.ok) window.shopify?.toast.show("Structured data saved");
  }, [fetcher.data]);
  const set = <K extends keyof Settings["schema"]>(key: K, value: Settings["schema"][K]) => setSchema({ ...schema, [key]: value });
  const setBusiness = (key: keyof Settings["schema"]["business"], value: string | string[]) =>
    setSchema({ ...schema, business: { ...schema.business, [key]: value } });

  return (
    <s-page heading="Structured data (JSON-LD)">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={fetcher.state !== "idle" || undefined}
        onClick={() => fetcher.submit({ schema }, { method: "post", encType: "application/json" })}
      >
        Save
      </s-button>

      {!d.embedOn ? (
        <s-banner tone="warning" heading="The Rank Well embed is off">
          <s-stack gap="small-200">
            <s-paragraph>Structured data is added by the Rank Well SEO app embed. Switch it on in your theme.</s-paragraph>
            <s-button href={d.embedUrl} target="_blank">
              Open theme editor
            </s-button>
          </s-stack>
        </s-banner>
      ) : (
        <s-banner tone="success">
          The embed is on. <s-link href={d.testUrl} target="_blank">Test your store in Google's Rich Results Test</s-link>.
        </s-banner>
      )}

      <s-section heading="What to add">
        <s-stack gap="base">
          {TYPES.map((type) => {
            const locked = type.paid && !d.paid;
            return (
              <Checkbox
                key={type.key}
                label={`${type.label}${locked ? " (Pro)" : ""}`}
                details={type.details}
                checked={Boolean(schema[type.key]) && !locked}
                disabled={locked}
                onChange={(value) => set(type.key, value as never)}
              />
            );
          })}
          {!d.paid ? <s-link href="/app/plans">Upgrade to add Product, Article, FAQ and Local business data</s-link> : null}
        </s-stack>
      </s-section>

      <s-section heading="Brand">
        <s-stack gap="base">
          <TextField
            label="Logo URL"
            value={schema.logo ?? ""}
            onChange={(v) => set("logo", v || null)}
            details="Leave empty to use your theme's logo. Square or wide, at least 112px."
          />
          <TextArea
            label="Social profiles (one URL per line)"
            value={schema.sameAs.join("\n")}
            onChange={(v) => set("sameAs", v.split("\n"))}
            rows={4}
          />
        </s-stack>
      </s-section>

      {schema.localBusiness && d.paid ? (
        <s-section heading="Local business">
          <Grid>
            <Select
              label="Business type"
              value={schema.business.type}
              onChange={(v) => setBusiness("type", v)}
              options={["Store", "ClothingStore", "ElectronicsStore", "FurnitureStore", "HomeGoodsStore", "JewelryStore", "ShoeStore", "SportingGoodsStore", "BookStore", "GroceryStore", "LocalBusiness"].map((v) => ({ value: v, label: v }))}
            />
            <TextField label="Phone" value={schema.business.phone} onChange={(v) => setBusiness("phone", v)} />
            <TextField label="Street address" value={schema.business.street} onChange={(v) => setBusiness("street", v)} />
            <TextField label="City" value={schema.business.city} onChange={(v) => setBusiness("city", v)} />
            <TextField label="State / region" value={schema.business.region} onChange={(v) => setBusiness("region", v)} />
            <TextField label="Postal code" value={schema.business.postalCode} onChange={(v) => setBusiness("postalCode", v)} />
            <TextField label="Country code" value={schema.business.country} onChange={(v) => setBusiness("country", v)} placeholder="US" />
            <TextField label="Price range" value={schema.business.priceRange} onChange={(v) => setBusiness("priceRange", v)} placeholder="$$" />
          </Grid>
          <TextArea
            label="Opening hours (one per line, e.g. Mo-Fr 09:00-18:00)"
            value={schema.business.openingHours.join("\n")}
            onChange={(v) => setBusiness("openingHours", v.split("\n").map((s) => s.trim()).filter(Boolean))}
            rows={3}
          />
        </s-section>
      ) : null}

      <s-section heading="Duplicate product data">
        <s-paragraph color="subdued">
          Many themes already output basic Product data. Google reads both, and Rank Well's is more complete (offers per
          variant, GTIN, review stars). If the Rich Results Test shows two Product items, remove the theme's
          "structured-data" output, or ask your theme developer.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
