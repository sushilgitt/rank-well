import type { Shop } from "@prisma/client";
import { hasFeature } from "./plans";
import { readSettings } from "./settings";
import { assertNoUserErrors, gql, type AdminGraphql } from "./shop.server";

/**
 * The storefront side reads its options from one app-data metafield
 * (`app.metafields.ranklift.config` in Liquid), so changing a setting never
 * edits the theme. The metafield belongs to the app installation and goes away
 * with it — nothing is left in the theme on uninstall.
 */

export function storefrontConfig(shop: Shop) {
  const settings = readSettings(shop.settings);
  const jsonLd = hasFeature(shop.plan, "jsonLd");
  return {
    v: 1,
    schema: {
      ...settings.schema,
      // Free stores keep the basics; the rich types are a paid feature.
      organization: settings.schema.organization,
      website: settings.schema.website,
      breadcrumbs: settings.schema.breadcrumbs,
      product: jsonLd && settings.schema.product,
      article: jsonLd && settings.schema.article,
      collection: jsonLd && settings.schema.collection,
      faq: jsonLd && settings.schema.faq,
      localBusiness: jsonLd && settings.schema.localBusiness,
    },
    speed: {
      ...settings.speed,
      level: hasFeature(shop.plan, "competitors") ? "turbo" : hasFeature(shop.plan, "jsonLd") ? "rocket" : "basic",
    },
    notFound: true,
  };
}

let installationIds = new Map<string, string>();

async function installationId(admin: AdminGraphql, domain: string) {
  const known = installationIds.get(domain);
  if (known) return known;
  const data = await gql<{ currentAppInstallation: { id: string } }>(
    admin,
    `#graphql
      query rankliftInstallation { currentAppInstallation { id } }`,
  );
  if (installationIds.size > 5000) installationIds = new Map();
  installationIds.set(domain, data.currentAppInstallation.id);
  return data.currentAppInstallation.id;
}

export async function publishConfig(admin: AdminGraphql, shop: Shop) {
  const ownerId = await installationId(admin, shop.domain);
  const data = await gql<{ metafieldsSet: { userErrors: { message: string }[] } }>(
    admin,
    `#graphql
      mutation rankliftPublish($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    {
      metafields: [
        { ownerId, namespace: "ranklift", key: "config", type: "json", value: JSON.stringify(storefrontConfig(shop)) },
      ],
    },
  );
  assertNoUserErrors(data.metafieldsSet.userErrors, "Publishing settings");
}

/** Which of our app embeds are switched on in the live theme. */
export async function embedStatus(admin: AdminGraphql): Promise<{ seo: boolean; theme: string | null }> {
  try {
    const data = await gql<{
      themes: { nodes: { name: string; files: { nodes: { body: { content?: string } | null }[] } }[] };
    }>(
      admin,
      `#graphql
        query rankliftEmbeds {
          themes(first: 1, roles: [MAIN]) {
            nodes {
              name
              files(filenames: ["config/settings_data.json"], first: 1) {
                nodes { body { ... on OnlineStoreThemeFileBodyText { content } } }
              }
            }
          }
        }`,
    );
    const theme = data.themes.nodes[0];
    const content = theme?.files.nodes[0]?.body?.content ?? "";
    // settings_data.json may start with a comment block.
    const json = JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\//, "") || "{}") as {
      current?: { blocks?: Record<string, { type?: string; disabled?: boolean }> };
    };
    const blocks = Object.values(json.current?.blocks ?? {});
    const seo = blocks.some((b) => /\/blocks\/ranklift-seo\//.test(b.type ?? "") && !b.disabled);
    return { seo, theme: theme?.name ?? null };
  } catch (error) {
    console.error("Embed status check failed", error);
    return { seo: false, theme: null };
  }
}

/** Deep link that opens the theme editor with our embed selected. */
export function embedLink(shopDomain: string) {
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  return `https://${shopDomain}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/ranklift-seo`;
}
