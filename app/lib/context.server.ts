import type { Prisma, Shop } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { patchSettings, readSettings } from "./settings";
import { publishConfig } from "./publish.server";

/** What every admin loader and action starts with. */
export async function adminContext(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  return { admin, session, shop, settings: readSettings(shop.settings) };
}

/** Saves part of the settings and republishes the storefront config. */
export async function saveSettings(
  admin: Parameters<typeof publishConfig>[0],
  shop: Shop,
  patch: unknown,
): Promise<Shop> {
  const settings = patchSettings(shop.settings, patch);
  const updated = await prisma.shop.update({
    where: { id: shop.id },
    data: { settings: settings as unknown as Prisma.InputJsonValue },
  });
  await publishConfig(admin, updated);
  return updated;
}

/** JSON body of a fetcher.submit(..., { encType: "application/json" }). */
export async function jsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}
