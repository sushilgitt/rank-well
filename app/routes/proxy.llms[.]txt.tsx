import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { buildLlmsTxt } from "../lib/llms.server";
import { hasFeature } from "../lib/plans";
import { readSettings } from "../lib/settings";

/** GET /apps/ranklift/llms.txt (app proxy) */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  const shop = session ? await prisma.shop.findUnique({ where: { domain: session.shop } }) : null;
  if (!admin || !shop || !hasFeature(shop.plan, "llmsTxt") || !readSettings(shop.settings).llms.enabled) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const text = await buildLlmsTxt(admin, shop);
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
