import type { Plan } from "@prisma/client";
import prisma from "../db.server";
import { gql, type AdminGraphql } from "./shop.server";

/**
 * Shopify managed pricing (App Pricing). Plans, prices, trials and annual
 * options live in the Partner dashboard; Shopify hosts the plan page and
 * invoices. RankLift only sends the merchant there and reads the active
 * subscription back. Partner-dashboard plan handles: `pro`, `premium`
 * (annual variants may be suffixed, e.g. `pro-annual`).
 */

let cachedHandle: string | null = null;

export async function appHandle(admin: AdminGraphql): Promise<string> {
  if (cachedHandle) return cachedHandle;
  try {
    const data = await gql<{ currentAppInstallation: { app: { handle: string | null } } }>(
      admin,
      `#graphql
        query rankliftAppHandle { currentAppInstallation { app { handle } } }`,
    );
    if (data.currentAppInstallation.app.handle) cachedHandle = data.currentAppInstallation.app.handle;
  } catch (error) {
    console.error("Could not read app handle", error);
  }
  return cachedHandle || process.env.SHOPIFY_APP_HANDLE || "ranklift";
}

const RANK: Record<Plan, number> = { FREE: 0, PRO: 1, PREMIUM: 2 };

export function planFor(identifier?: string | null): Plan | null {
  if (!identifier) return null;
  const key = identifier.trim().toLowerCase();
  if (key.startsWith("premium")) return "PREMIUM";
  if (key.startsWith("pro")) return "PRO";
  return null;
}

interface Subscription {
  name: string;
  status: string;
  lineItems?: { plan?: { pricingDetails?: { planHandle?: string | null } | null } | null }[];
}

/**
 * Reconciles the stored plan with the real subscription on every admin load.
 * Returns null when Shopify couldn't be reached; the stored plan is kept then.
 */
export async function syncPlanFromShopify(admin: AdminGraphql, domain: string): Promise<Plan | null> {
  let subs: Subscription[];
  try {
    const data = await gql<{ currentAppInstallation: { activeSubscriptions: Subscription[] } }>(
      admin,
      `#graphql
        query rankliftSubscriptions {
          currentAppInstallation {
            activeSubscriptions {
              name
              status
              lineItems { plan { pricingDetails { ... on AppRecurringPricing { planHandle } } } }
            }
          }
        }`,
    );
    subs = data.currentAppInstallation.activeSubscriptions ?? [];
  } catch (error) {
    console.error(`Could not read subscriptions for ${domain}`, error);
    return null;
  }
  const plan =
    subs
      .filter((s) => s.status?.toUpperCase() === "ACTIVE")
      .map((s) => planFor(s.lineItems?.map((l) => l.plan?.pricingDetails?.planHandle).find(Boolean)) ?? planFor(s.name))
      .filter((p): p is Plan => p !== null)
      .sort((a, b) => RANK[b] - RANK[a])[0] ?? "FREE";

  // A plan change resets the usage period so an upgrade is usable at once.
  await prisma.shop.updateMany({ where: { domain, NOT: { plan } }, data: { plan, periodStart: new Date() } });
  return plan;
}
