import type { Shop } from "@prisma/client";
import { AiError, askJson } from "./ai.server";
import { PermanentError, registerJob } from "./jobs.server";
import { AI_COST } from "./plans";
import { listResources, type Resource, type ResourceType } from "./resources.server";
import { readSettings, type Settings } from "./settings";
import { assertNoUserErrors, gql, type AdminGraphql } from "./shop.server";
import { LIMITS, excerpt, renderTemplate, truncate } from "./templates";
import { refund, spend } from "./usage.server";

/** SEO title/description: reading, templating, AI writing and saving. */

export interface MetaChange {
  id: string;
  type: ResourceType;
  title?: string | null;
  description?: string | null;
}

export async function saveMeta(admin: AdminGraphql, change: MetaChange) {
  const title = change.title === undefined ? undefined : truncate((change.title ?? "").trim(), 70);
  const description = change.description === undefined ? undefined : truncate((change.description ?? "").trim(), 320);
  const seo = { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}) };

  if (change.type === "product") {
    const data = await gql<{ productUpdate: { userErrors: { message: string }[] } }>(
      admin,
      `#graphql
        mutation rankliftProductSeo($product: ProductUpdateInput!) {
          productUpdate(product: $product) { userErrors { field message } }
        }`,
      { product: { id: change.id, seo } },
    );
    assertNoUserErrors(data.productUpdate.userErrors, "Product SEO");
    return;
  }
  if (change.type === "collection") {
    const data = await gql<{ collectionUpdate: { userErrors: { message: string }[] } }>(
      admin,
      `#graphql
        mutation rankliftCollectionSeo($input: CollectionInput!) {
          collectionUpdate(input: $input) { userErrors { field message } }
        }`,
      { input: { id: change.id, seo } },
    );
    assertNoUserErrors(data.collectionUpdate.userErrors, "Collection SEO");
    return;
  }

  // Pages and articles keep their SEO fields in the global title_tag /
  // description_tag metafields, which is what the theme's {{ page_title }} reads.
  const metafields = [
    ...(title !== undefined ? [{ key: "title_tag", value: title }] : []),
    ...(description !== undefined ? [{ key: "description_tag", value: description }] : []),
  ];
  const empty = metafields.filter((m) => !m.value);
  const filled = metafields.filter((m) => m.value);
  if (filled.length) {
    const data = await gql<{ metafieldsSet: { userErrors: { message: string }[] } }>(
      admin,
      `#graphql
        mutation rankliftSeoMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
      {
        metafields: filled.map((m) => ({
          ownerId: change.id,
          namespace: "global",
          key: m.key,
          type: m.key === "title_tag" ? "single_line_text_field" : "multi_line_text_field",
          value: m.value,
        })),
      },
    );
    assertNoUserErrors(data.metafieldsSet.userErrors, "SEO fields");
  }
  if (empty.length) {
    await gql(
      admin,
      `#graphql
        mutation rankliftSeoMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) { userErrors { field message } }
        }`,
      { metafields: empty.map((m) => ({ ownerId: change.id, namespace: "global", key: m.key })) },
    );
  }
}

const TEMPLATE_KEYS: Record<ResourceType, { title: keyof Settings["templates"]; description: keyof Settings["templates"] }> = {
  product: { title: "productTitle", description: "productDescription" },
  collection: { title: "collectionTitle", description: "collectionDescription" },
  page: { title: "pageTitle", description: "pageDescription" },
  article: { title: "articleTitle", description: "articleDescription" },
};

export function templateMeta(resource: Resource, settings: Settings, shopName: string) {
  const keys = TEMPLATE_KEYS[resource.type];
  const extra = resource.extra ?? {};
  const vars = {
    title: resource.title,
    shop: shopName,
    vendor: String(extra.vendor ?? ""),
    type: String(extra.productType ?? ""),
    blog: String(extra.blog ?? ""),
    description: excerpt(resource.text, 120),
  };
  return {
    title: renderTemplate(settings.templates[keys.title], vars, LIMITS.title),
    description: renderTemplate(settings.templates[keys.description], vars, LIMITS.description),
  };
}

function languageLine(settings: Settings) {
  return settings.aiLanguage === "auto"
    ? "Write in the same language as the item's own title and description."
    : `Write in this language: ${settings.aiLanguage}.`;
}

/** AI-written titles and descriptions for up to 20 resources in one call. */
export async function aiMeta(resources: Resource[], settings: Settings, shopName: string) {
  const items = resources.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.title,
    details: [r.extra?.vendor, r.extra?.productType, (r.extra?.tags as string[] | undefined)?.join(", ")].filter(Boolean).join(" · "),
    text: r.text.slice(0, 1200),
  }));
  const answer = await askJson<{ items: { id: string; title: string; description: string }[] }>({
    system: [
      `You are an e-commerce SEO copywriter for the store "${shopName}".`,
      "For each item, write an SEO title (50–60 characters) and a meta description (130–155 characters).",
      "Put the main search phrase near the start of the title. Make the description specific and end it with a reason to click.",
      "Never invent facts (materials, prices, shipping, discounts) that aren't in the details. No quotes, no emoji, no ALL CAPS.",
      `Tone: ${settings.aiTone}.`,
      settings.brandKeywords ? `Work in these keywords where natural: ${settings.brandKeywords}.` : "",
      languageLine(settings),
      'Answer with JSON only: {"items":[{"id":"…","title":"…","description":"…"}]} — same ids, same order.',
    ]
      .filter(Boolean)
      .join("\n"),
    user: JSON.stringify(items),
    maxTokens: 4000,
  });
  const byId = new Map((answer.items ?? []).map((item) => [item.id, item]));
  return resources.map((r) => {
    const item = byId.get(r.id);
    return {
      id: r.id,
      title: item?.title ? truncate(item.title, 70) : null,
      description: item?.description ? truncate(item.description, 165) : null,
    };
  });
}

export interface BulkMetaPayload {
  type: ResourceType;
  /** Resource ids; empty = every resource of the type. */
  ids: string[];
  mode: "template" | "ai";
  fields: ("title" | "description")[];
  /** false = only fill empty fields. */
  overwrite: boolean;
}

const AI_BATCH = 10;

registerJob("meta.bulk", async (ctx) => {
  const payload = ctx.job.payload as unknown as BulkMetaPayload;
  const settings = readSettings(ctx.shop.settings);
  const shopName = ctx.shop.name ?? ctx.shop.domain;
  const all = await listResources(ctx.admin, payload.type);
  const wanted = payload.ids.length ? all.filter((r) => payload.ids.includes(r.id)) : all;
  const todo = payload.overwrite
    ? wanted
    : wanted.filter((r) => payload.fields.some((f) => !(f === "title" ? r.seoTitle : r.seoDescription)));

  await ctx.progress(0, todo.length);
  let done = 0;
  let saved = 0;
  const failed: string[] = [];

  for (let i = 0; i < todo.length; i += AI_BATCH) {
    if (await ctx.cancelled()) break;
    const batch = todo.slice(i, i + AI_BATCH);
    let generated: { id: string; title: string | null; description: string | null }[];
    if (payload.mode === "ai") {
      const cost = batch.length * AI_COST.meta;
      try {
        await spend(ctx.shop, "ai", cost, "meta.bulk");
      } catch (error) {
        throw new PermanentError((error as Error).message + ` ${saved} items were updated before the limit.`);
      }
      try {
        generated = await aiMeta(batch, settings, shopName);
      } catch (error) {
        await refund(ctx.shop, "ai", cost);
        if (error instanceof AiError) throw new PermanentError(error.message);
        throw error;
      }
    } else {
      generated = batch.map((r) => ({ id: r.id, ...templateMeta(r, settings, shopName) }));
    }

    for (const resource of batch) {
      const next = generated.find((g) => g.id === resource.id);
      const change: MetaChange = { id: resource.id, type: resource.type };
      if (payload.fields.includes("title") && next?.title && (payload.overwrite || !resource.seoTitle)) change.title = next.title;
      if (payload.fields.includes("description") && next?.description && (payload.overwrite || !resource.seoDescription)) {
        change.description = next.description;
      }
      try {
        if (change.title !== undefined || change.description !== undefined) {
          await saveMeta(ctx.admin, change);
          saved++;
        }
      } catch (error) {
        console.error("Meta save failed", resource.id, error);
        failed.push(resource.title);
      }
      done++;
    }
    await ctx.progress(done);
  }
  return { saved, failed: failed.slice(0, 20), failedCount: failed.length };
});

/** For one item in the editor: an AI suggestion, charged one credit. */
export async function suggestMeta(shop: Shop, resource: Resource) {
  await spend(shop, "ai", AI_COST.meta, "meta.suggest");
  try {
    const [result] = await aiMeta([resource], readSettings(shop.settings), shop.name ?? shop.domain);
    return result;
  } catch (error) {
    await refund(shop, "ai", AI_COST.meta);
    throw error;
  }
}
