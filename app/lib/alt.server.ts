import type { Shop } from "@prisma/client";
import { AiError, askJson, type AskImage } from "./ai.server";
import { PermanentError, registerJob } from "./jobs.server";
import { AI_COST } from "./plans";
import { paginate } from "./resources.server";
import { readSettings, type Settings } from "./settings";
import { assertNoUserErrors, gql, type AdminGraphql } from "./shop.server";
import { LIMITS, renderTemplate, truncate } from "./templates";
import { refund, spend } from "./usage.server";

/** Product image alt text: listing, templating, AI (vision) and saving. */

export interface ProductImage {
  mediaId: string;
  productId: string;
  productTitle: string;
  vendor: string;
  productType: string;
  url: string;
  alt: string | null;
  position: number;
  /** Variant titles that show this image, e.g. "Red / M". */
  variants: string[];
}

export async function listProductImages(admin: AdminGraphql, opts: { limit?: number; productIds?: string[] } = {}) {
  type Node = {
    id: string;
    title: string;
    vendor: string;
    productType: string;
    media: { nodes: { id: string; alt: string | null; mediaContentType: string; image: { url: string } | null }[] };
    variants: { nodes: { title: string; media: { nodes: { id: string }[] } }[] };
  };
  const query = opts.productIds?.length ? opts.productIds.map((id) => `id:${id.split("/").pop()}`).join(" OR ") : null;
  const products = await paginate<Node>(async (after) => {
    const data = await gql<{ products: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      admin,
      `#graphql
        query rankliftProductImages($after: String, $query: String) {
          products(first: 50, after: $after, query: $query) {
            nodes {
              id title vendor productType
              media(first: 50) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } }
              variants(first: 50) { nodes { title media(first: 1) { nodes { id } } } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { after, query },
    );
    return data.products;
  }, opts.limit ?? Infinity);

  const images: ProductImage[] = [];
  for (const product of products) {
    product.media.nodes.forEach((media, position) => {
      if (media.mediaContentType !== "IMAGE" || !media.image) return;
      images.push({
        mediaId: media.id,
        productId: product.id,
        productTitle: product.title,
        vendor: product.vendor,
        productType: product.productType,
        url: media.image.url,
        alt: media.alt,
        position,
        variants: product.variants.nodes
          .filter((v) => v.title !== "Default Title" && v.media.nodes.some((m) => m.id === media.id))
          .map((v) => v.title),
      });
    });
  }
  return images;
}

export async function saveAlt(admin: AdminGraphql, items: { mediaId: string; alt: string }[]) {
  if (!items.length) return;
  const data = await gql<{ fileUpdate: { userErrors: { message: string }[] } }>(
    admin,
    `#graphql
      mutation rankliftAlt($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) { userErrors { field message } }
      }`,
    { files: items.map((item) => ({ id: item.mediaId, alt: truncate(item.alt, 512) })) },
  );
  assertNoUserErrors(data.fileUpdate.userErrors, "Alt text");
}

export function templateAlt(image: ProductImage, settings: Settings, shopName: string) {
  return renderTemplate(
    settings.templates.altText,
    {
      title: image.productTitle,
      shop: shopName,
      vendor: image.vendor,
      type: image.productType,
      variant: image.variants.length ? ` - ${image.variants[0]}` : image.position ? ` - view ${image.position + 1}` : "",
    },
    LIMITS.alt,
  );
}

/** Downloads a small rendition from Shopify's CDN for the vision model. */
async function thumbnail(url: string): Promise<AskImage | null> {
  try {
    const small = new URL(url);
    small.searchParams.set("width", "512");
    const response = await fetch(small);
    if (!response.ok) return null;
    const media = response.headers.get("content-type") || "image/jpeg";
    if (!/^image\/(jpeg|png|webp|gif)$/.test(media)) return null;
    return { media, base64: Buffer.from(await response.arrayBuffer()).toString("base64") };
  } catch {
    return null;
  }
}

/** AI alt text for one image: looks at the picture, knows the product. */
export async function aiAlt(image: ProductImage, settings: Settings): Promise<string> {
  const picture = await thumbnail(image.url);
  const answer = await askJson<{ alt: string }>({
    system: [
      "You write image alt text for an online store, for screen readers and image search.",
      "Describe what is visible in one phrase of at most 125 characters: the product, its colour/material/angle, and any context.",
      "Include the product name once. Don't start with 'image of' or 'picture of'. No quotes, no emoji.",
      settings.aiLanguage === "auto" ? "Write in the language of the product name." : `Write in: ${settings.aiLanguage}.`,
      'Answer with JSON only: {"alt":"…"}',
    ].join("\n"),
    user: JSON.stringify({
      product: image.productTitle,
      vendor: image.vendor,
      type: image.productType,
      variant: image.variants[0] ?? null,
      imageNumber: image.position + 1,
    }),
    images: picture ? [picture] : undefined,
    maxTokens: 300,
    timeout: 60,
  });
  return truncate((answer.alt ?? "").replace(/^["']|["']$/g, "").trim(), LIMITS.alt);
}

export interface BulkAltPayload {
  mode: "template" | "ai";
  overwrite: boolean;
  productIds: string[];
}

registerJob("alt.bulk", async (ctx) => {
  const payload = ctx.job.payload as unknown as BulkAltPayload;
  const settings = readSettings(ctx.shop.settings);
  const shopName = ctx.shop.name ?? ctx.shop.domain;
  const images = await listProductImages(ctx.admin, { productIds: payload.productIds });
  const todo = payload.overwrite ? images : images.filter((image) => !image.alt?.trim());
  await ctx.progress(0, todo.length);

  let saved = 0;
  const pending: { mediaId: string; alt: string }[] = [];
  for (let i = 0; i < todo.length; i++) {
    if (await ctx.cancelled()) break;
    const image = todo[i];
    let alt: string;
    if (payload.mode === "ai") {
      try {
        await spend(ctx.shop, "ai", AI_COST.alt, "alt.bulk");
      } catch (error) {
        await saveAlt(ctx.admin, pending);
        throw new PermanentError(`${(error as Error).message} ${saved + pending.length} images were updated before the limit.`);
      }
      try {
        alt = await aiAlt(image, settings);
      } catch (error) {
        await refund(ctx.shop, "ai", AI_COST.alt);
        if (error instanceof AiError) throw new PermanentError(error.message);
        throw error;
      }
    } else {
      alt = templateAlt(image, settings, shopName);
    }
    if (alt) pending.push({ mediaId: image.mediaId, alt });
    if (pending.length >= 25) {
      await saveAlt(ctx.admin, pending.splice(0));
      saved += 25;
    }
    if (i % 5 === 4) await ctx.progress(i + 1);
  }
  saved += pending.length;
  await saveAlt(ctx.admin, pending);
  await ctx.progress(todo.length);
  return { saved };
});

export async function suggestAlt(shop: Shop, image: ProductImage) {
  await spend(shop, "ai", AI_COST.alt, "alt.suggest");
  try {
    return await aiAlt(image, readSettings(shop.settings));
  } catch (error) {
    await refund(shop, "ai", AI_COST.alt);
    throw error;
  }
}
