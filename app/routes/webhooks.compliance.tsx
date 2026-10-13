import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook } from "../shopify.server";
import prisma from "../db.server";

/**
 * Mandatory compliance webhooks: /webhooks/compliance
 *
 * RankLift stores no customer data — audits, links and 404 paths are about the
 * store's pages — so customers/data_request and customers/redact have nothing
 * to return or delete. shop/redact removes everything the shop owns.
 *
 * `authenticate.webhook` verifies the HMAC; unsigned review probes get a 401.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticateWebhook(request);

  try {
    if (topic === "SHOP_REDACT") {
      await prisma.shop.deleteMany({ where: { domain: shop } });
      await prisma.session.deleteMany({ where: { shop } });
    }
    console.log(`Handled ${topic} for ${shop}`);
  } catch (error) {
    console.error(`Compliance webhook ${topic} failed for ${shop}`, error);
    return new Response("Compliance handler error", { status: 500 });
  }
  return new Response();
};

export const loader = () => new Response("Method not allowed", { status: 405 });
