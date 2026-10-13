import prisma from "../db.server";

export interface AdminGraphql {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/** Runs an Admin GraphQL call and throws on top-level errors. */
export async function gql<T = unknown>(
  admin: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

/** Throws when a mutation answers with userErrors. */
export function assertNoUserErrors(errors: { message: string }[] | undefined | null, what: string) {
  if (errors?.length) throw new Error(`${what}: ${errors.map((e) => e.message).join("; ")}`);
}

/**
 * Shopify sends no "installed" webhook, so the shop is provisioned when a
 * session is created (afterAuth in shopify.server.ts) and again by the admin
 * loader. Safe to call concurrently: on first open, React Router runs the
 * layout and page loaders in parallel, and both may try to create the row.
 */
export async function ensureShop(domain: string) {
  let existing = await prisma.shop.findUnique({ where: { domain } });
  if (!existing) {
    try {
      return await prisma.shop.create({ data: { domain } });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      existing = await prisma.shop.findUniqueOrThrow({ where: { domain } });
    }
  }
  if (existing.uninstalledAt) {
    return prisma.shop.update({
      where: { id: existing.id },
      data: { uninstalledAt: null, installedAt: new Date() },
    });
  }
  return existing;
}

export async function backfillShopProfile(admin: AdminGraphql, domain: string) {
  try {
    const data = await gql<{
      shop: {
        name: string;
        contactEmail: string | null;
        currencyCode: string;
        ianaTimezone: string;
        primaryDomain: { url: string };
        plan: { partnerDevelopment: boolean };
      };
    }>(
      admin,
      `#graphql
        query rankliftShopProfile {
          shop {
            name
            contactEmail
            currencyCode
            ianaTimezone
            primaryDomain { url }
            plan { partnerDevelopment }
          }
        }`,
    );
    await prisma.shop.update({
      where: { domain },
      data: {
        name: data.shop.name,
        email: data.shop.contactEmail,
        currencyCode: data.shop.currencyCode,
        timezone: data.shop.ianaTimezone,
        primaryUrl: data.shop.primaryDomain.url.replace(/\/$/, ""),
        devStore: Boolean(data.shop.plan?.partnerDevelopment),
      },
    });
  } catch (error) {
    // Cosmetic; never block the admin on it.
    console.error(`Shop profile backfill failed for ${domain}`, error);
  }
}

export async function markUninstalled(domain: string) {
  await prisma.session.deleteMany({ where: { shop: domain } });
  await prisma.shop.updateMany({ where: { domain }, data: { uninstalledAt: new Date() } });
  // Queued work can't run without a token; drop it.
  await prisma.job.updateMany({
    where: { shop: { domain }, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
}

/** The storefront base URL: the primary domain once known, else myshopify. */
export function storefrontUrl(shop: { domain: string; primaryUrl: string | null }) {
  return shop.primaryUrl || `https://${shop.domain}`;
}
