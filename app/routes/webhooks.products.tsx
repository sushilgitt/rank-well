import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticateWebhook } from "../shopify.server";
import { enqueue } from "../lib/jobs.server";
import { readSettings } from "../lib/settings";

/**
 * products/create → queue auto-optimisation when the merchant turned it on.
 * Shopify needs a quick 200; the work happens in the job worker. Media are
 * often attached a moment after creation, hence the short delay.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: domain, payload } = await authenticateWebhook(request);
  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (!shop || shop.uninstalledAt) return new Response();

  const settings = readSettings(shop.settings);
  const id = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
  if (id && (settings.autoMeta || settings.autoAlt)) {
    await enqueue(shop.id, "auto.product", { productId: id }, new Date(Date.now() + 60_000));
  }
  return new Response();
};
