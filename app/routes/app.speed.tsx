import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext, jsonBody, saveSettings } from "../lib/context.server";
import { PLANS } from "../lib/plans";
import { embedLink, embedStatus } from "../lib/publish.server";
import type { Settings } from "../lib/settings";
import { Checkbox } from "../components/fields";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop, settings } = await adminContext(request);
  return {
    speed: settings.speed,
    level: PLANS[shop.plan].features.speed,
    embedOn: (await embedStatus(admin)).seo,
    embedUrl: embedLink(shop.domain),
    psiUrl: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(shop.primaryUrl || `https://${shop.domain}`)}`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const body = await jsonBody<{ speed: Settings["speed"] }>(request);
  await saveSettings(admin, shop, { speed: body.speed });
  return { ok: true };
};

const LEVELS = {
  basic: "Basic: pages start loading the moment a shopper taps a link.",
  rocket: "Rocket: pages start loading when a shopper hovers over a link, so most clicks feel instant.",
  turbo: "Turbo: the browser fully prerenders the likely next page (Speculation Rules), for near-zero load time on click.",
};

export default function Speed() {
  const d = useLoaderData<typeof loader>();
  const [speed, setSpeed] = useState(d.speed);
  const fetcher = useFetcher<typeof action>();
  useEffect(() => {
    if (fetcher.data?.ok) window.shopify?.toast.show("Speed settings saved");
  }, [fetcher.data]);
  const set = (key: keyof Settings["speed"], value: boolean) => setSpeed({ ...speed, [key]: value });

  return (
    <s-page heading="Speed">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={fetcher.state !== "idle" || undefined}
        onClick={() => fetcher.submit({ speed }, { method: "post", encType: "application/json" })}
      >
        Save
      </s-button>
      {!d.embedOn ? (
        <s-banner tone="warning" heading="The RankLift embed is off">
          <s-button href={d.embedUrl} target="_blank">
            Turn it on in the theme editor
          </s-button>
        </s-banner>
      ) : null}

      <s-section heading={`Your speed level: ${d.level[0].toUpperCase()}${d.level.slice(1)}`}>
        <s-stack gap="small-200">
          <s-paragraph>{LEVELS[d.level]}</s-paragraph>
          {d.level !== "turbo" ? <s-link href="/app/plans">Upgrade for {d.level === "basic" ? "Rocket or Turbo" : "Turbo"}</s-link> : null}
        </s-stack>
      </s-section>

      <s-section heading="Optimizations">
        <s-stack gap="base">
          <Checkbox label="Instant page loads (prefetch)" details="Loads the next page early, as described above." checked={speed.prefetch} onChange={(v) => set("prefetch", v)} />
          <Checkbox
            label="Lazy-load images below the fold"
            details="Images further down the page load only when shoppers scroll to them."
            checked={speed.lazyImages}
            onChange={(v) => set("lazyImages", v)}
          />
          <Checkbox label="Preconnect to Shopify's CDN" details="Opens the connection for images and scripts sooner." checked={speed.preconnect} onChange={(v) => set("preconnect", v)} />
        </s-stack>
      </s-section>

      <s-section heading="Measure">
        <s-stack gap="small-200">
          <s-paragraph color="subdued">
            Check Core Web Vitals before and after. Big wins usually come from compressing images and removing apps you
            no longer use.
          </s-paragraph>
          <s-button href={d.psiUrl} target="_blank">
            Open PageSpeed Insights
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
