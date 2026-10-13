import { aiAlt, listProductImages, saveAlt, templateAlt } from "./alt.server";
import { registerJob } from "./jobs.server";
import { aiMeta, saveMeta, templateMeta } from "./meta.server";
import { AI_COST } from "./plans";
import { listProducts } from "./resources.server";
import { readSettings } from "./settings";
import { LimitError, refund, spend } from "./usage.server";

/**
 * Auto-optimise a product that was just created (products/create webhook):
 * fill empty SEO fields and alt text, by template or by AI. Never overwrites
 * what the merchant wrote. Out of AI credits, it falls back to the template.
 */
registerJob("auto.product", async (ctx) => {
  const { productId } = ctx.job.payload as { productId: string };
  const settings = readSettings(ctx.shop.settings);
  const shopName = ctx.shop.name ?? ctx.shop.domain;
  const [product] = await listProducts(ctx.admin, 1, `id:${productId.split("/").pop()}`);
  if (!product) return { skipped: "not found" };

  const tryAi = async (cost: number) => {
    if (settings.autoMode !== "ai") return false;
    try {
      await spend(ctx.shop, "ai", cost, "auto.product");
      return true;
    } catch (error) {
      if (error instanceof LimitError) return false;
      throw error;
    }
  };

  const done: string[] = [];
  if (settings.autoMeta && (!product.seoTitle || !product.seoDescription)) {
    let next = templateMeta(product, settings, shopName);
    if (await tryAi(AI_COST.meta)) {
      try {
        const [ai] = await aiMeta([product], settings, shopName);
        next = { title: ai.title || next.title, description: ai.description || next.description };
      } catch (error) {
        await refund(ctx.shop, "ai", AI_COST.meta);
        console.error("Auto meta AI failed; used template", error);
      }
    }
    await saveMeta(ctx.admin, {
      id: product.id,
      type: "product",
      ...(product.seoTitle ? {} : { title: next.title }),
      ...(product.seoDescription ? {} : { description: next.description }),
    });
    done.push("meta");
  }

  if (settings.autoAlt) {
    const images = (await listProductImages(ctx.admin, { productIds: [product.id] })).filter((i) => !i.alt?.trim());
    const alts: { mediaId: string; alt: string }[] = [];
    for (const image of images) {
      let alt = templateAlt(image, settings, shopName);
      if (await tryAi(AI_COST.alt)) {
        try {
          alt = (await aiAlt(image, settings)) || alt;
        } catch (error) {
          await refund(ctx.shop, "ai", AI_COST.alt);
          console.error("Auto alt AI failed; used template", error);
        }
      }
      if (alt) alts.push({ mediaId: image.mediaId, alt });
    }
    await saveAlt(ctx.admin, alts);
    if (alts.length) done.push(`alt ×${alts.length}`);
  }
  return { done };
});
