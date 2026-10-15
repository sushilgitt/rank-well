import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { backfillShopProfile, ensureShop } from "../lib/shop.server";
import { syncPlanFromShopify } from "../lib/billing.server";
import { publishConfig } from "../lib/publish.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // No "installed" webhook exists, so provisioning happens on first load.
  let shop = await ensureShop(session.shop);
  if (!shop.primaryUrl) await backfillShopProfile(admin, session.shop);
  const before = shop.plan;
  await syncPlanFromShopify(admin, session.shop);
  shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  // First open, or a plan change that unlocks/locks storefront features.
  if (before !== shop.plan || shop.installedAt.getTime() > Date.now() - 60_000) {
    await publishConfig(admin, shop).catch((error) => console.error("Publish failed", error));
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/audit">SEO audit</s-link>
        <s-link href="/app/meta">Meta tags</s-link>
        <s-link href="/app/images">Alt text</s-link>
        <s-link href="/app/optimize">Image optimizer</s-link>
        <s-link href="/app/schema">Structured data</s-link>
        <s-link href="/app/links">Links &amp; redirects</s-link>
        <s-link href="/app/ai-search">AI search</s-link>
        <s-link href="/app/speed">Speed</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plans">Plans</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
