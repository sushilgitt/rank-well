import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Plan } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { appHandle, syncPlanFromShopify } from "../lib/billing.server";
import { PLANS } from "../lib/plans";
import { usageFor } from "../lib/usage.server";
import { PlanButton } from "../components/PlanButton";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  await syncPlanFromShopify(admin, session.shop);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const usage = await usageFor(shop);
  return { current: shop.plan, handle: await appHandle(admin), devStore: shop.devStore, used: usage.used };
};

const ORDER: Plan[] = ["FREE", "PRO", "PREMIUM"];

function features(plan: Plan): string[] {
  const p = PLANS[plan];
  const n = (v: number) => (Number.isFinite(v) ? v.toLocaleString() : "Unlimited");
  return [
    `${n(p.limits.auditPages)} audit pages / 30 days`,
    `${n(p.limits.ai)} AI credits / 30 days`,
    `${n(p.limits.images)} image compressions / 30 days`,
    `Speed: ${p.features.speed[0].toUpperCase()}${p.features.speed.slice(1)}`,
    ...(p.features.bulkMeta ? ["Bulk & automatic meta tags"] : ["Meta tags one by one"]),
    ...(p.features.jsonLd ? ["Product, Article, FAQ & Local business JSON-LD"] : ["Organization, Website & Breadcrumb JSON-LD"]),
    ...(p.features.llmsTxt ? ["llms.txt for AI search"] : []),
    ...(p.features.autoRedirect ? ["Automatic 404 redirects"] : ["Broken link & 404 monitor"]),
    // Rank tracking, competitor analysis and internal linking are listed here
    // once they ship: App Store review rejects plans that promise unbuilt features.
  ];
}

export default function Plans() {
  const d = useLoaderData<typeof loader>();
  const [yearly, setYearly] = useState(false);
  return (
    <s-page heading="Plans">
      {d.devStore ? <s-banner tone="info">Development stores can test every plan without being charged.</s-banner> : null}
      <s-section>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-button variant={yearly ? "secondary" : "primary"} onClick={() => setYearly(false)}>
            Monthly
          </s-button>
          <s-button variant={yearly ? "primary" : "secondary"} onClick={() => setYearly(true)}>
            Yearly (save 20%)
          </s-button>
          <s-badge tone="info">7-day free trial on paid plans</s-badge>
        </s-stack>
      </s-section>
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
        {ORDER.map((id) => {
          const plan = PLANS[id];
          return (
            <s-section key={id} heading={plan.name}>
              <s-stack gap="base">
                <s-heading>
                  {!plan.monthly ? "Free" : yearly ? `$${plan.annual}/year` : `$${plan.monthly}/month`}
                </s-heading>
                <s-stack gap="small-100">
                  {features(id).map((f) => (
                    <s-text key={f}>✓ {f}</s-text>
                  ))}
                </s-stack>
                {id === d.current ? (
                  <s-badge tone="success">Current plan</s-badge>
                ) : (
                  <PlanButton handle={d.handle} variant={id === "PRO" ? "primary" : undefined}>
                    {ORDER.indexOf(id) > ORDER.indexOf(d.current) ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`}
                  </PlanButton>
                )}
              </s-stack>
            </s-section>
          );
        })}
      </s-grid>
      <s-section>
        <s-text color="subdued">
          This period: {d.used.ai} AI credits, {d.used.images} image compressions, {d.used.auditPages} audit pages used.
          Billing and invoices are handled by Shopify.
        </s-text>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
