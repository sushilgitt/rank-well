import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext, jsonBody, saveSettings } from "../lib/context.server";
import { aiSettings } from "../lib/ai.server";
import type { Settings } from "../lib/settings";
import { PLACEHOLDERS } from "../lib/templates";
import { Checkbox, Grid, Select, TextField } from "../components/fields";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { settings } = await adminContext(request);
  return {
    settings: { ...settings, storefrontPassword: settings.storefrontPassword ? "••••••••" : "" },
    hasPassword: Boolean(settings.storefrontPassword),
    aiReady: Boolean(aiSettings()),
  };
};

type Body = { settings: Partial<Settings>; keepPassword: boolean; password: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await adminContext(request);
  const body = await jsonBody<Body>(request);
  const s = body.settings ?? {};
  const patch: Partial<Settings> = {
    templates: s.templates,
    autoMeta: Boolean(s.autoMeta),
    autoAlt: Boolean(s.autoAlt),
    autoMode: s.autoMode === "ai" ? "ai" : "template",
    aiLanguage: String(s.aiLanguage ?? "auto").slice(0, 40),
    aiTone: String(s.aiTone ?? "").slice(0, 200),
    brandKeywords: String(s.brandKeywords ?? "").slice(0, 500),
  };
  // keepPassword: the masked value came back unchanged; "" = remove.
  if (!body.keepPassword) patch.storefrontPassword = body.password ? String(body.password).slice(0, 200) : null;
  await saveSettings(admin, shop, patch);
  return { ok: true };
};

const TEMPLATE_FIELDS: { key: keyof Settings["templates"]; label: string }[] = [
  { key: "productTitle", label: "Product title" },
  { key: "productDescription", label: "Product description" },
  { key: "collectionTitle", label: "Collection title" },
  { key: "collectionDescription", label: "Collection description" },
  { key: "pageTitle", label: "Page title" },
  { key: "pageDescription", label: "Page description" },
  { key: "articleTitle", label: "Blog post title" },
  { key: "articleDescription", label: "Blog post description" },
  { key: "altText", label: "Image alt text" },
];

export default function SettingsPage() {
  const d = useLoaderData<typeof loader>();
  const [settings, setSettings] = useState(d.settings);
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const fetcher = useFetcher<typeof action>();
  useEffect(() => {
    if (fetcher.data?.ok) window.shopify?.toast.show("Settings saved");
  }, [fetcher.data]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings({ ...settings, [key]: value });

  return (
    <s-page heading="Settings">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={fetcher.state !== "idle" || undefined}
        onClick={() => fetcher.submit({ settings, keepPassword: password === undefined, password: password ?? "" }, { method: "post", encType: "application/json" })}
      >
        Save
      </s-button>

      <s-section heading="Meta tag templates">
        <s-stack gap="base">
          <s-text color="subdued">
            Placeholders: {PLACEHOLDERS.map((p) => `{{${p}}}`).join(" ")}. Used by "Fill from template", and by auto-fill.
          </s-text>
          <Grid>
            {TEMPLATE_FIELDS.map((field) => (
              <TextField
                key={field.key}
                label={field.label}
                value={settings.templates[field.key]}
                onChange={(v) => set("templates", { ...settings.templates, [field.key]: v })}
              />
            ))}
          </Grid>
        </s-stack>
      </s-section>

      <s-section heading="New products">
        <s-stack gap="base">
          <Checkbox label="Fill SEO title and description on new products" checked={settings.autoMeta} onChange={(v) => set("autoMeta", v)} />
          <Checkbox label="Fill image alt text on new products" checked={settings.autoAlt} onChange={(v) => set("autoAlt", v)} />
          <Select
            label="How"
            value={settings.autoMode}
            onChange={(v) => set("autoMode", v === "ai" ? "ai" : "template")}
            options={[
              { value: "template", label: "From templates (free)" },
              { value: "ai", label: "With AI (uses credits; falls back to templates when they run out)" },
            ]}
          />
          <s-text color="subdued">Fields you've already filled in are never overwritten.</s-text>
        </s-stack>
      </s-section>

      <s-section heading="AI writing">
        <s-stack gap="base">
          {!d.aiReady ? <s-banner tone="warning">AI isn't configured on this server yet (RANKLIFT_AI_KEY).</s-banner> : null}
          <Grid>
            <Select
              label="Language"
              value={settings.aiLanguage}
              onChange={(v) => set("aiLanguage", v)}
              options={[
                { value: "auto", label: "Same as the product" },
                ...["English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Swedish", "Danish", "Norwegian", "Finnish", "Czech", "Turkish", "Japanese", "Korean", "Chinese (Simplified)", "Chinese (Traditional)", "Thai", "Hindi", "Arabic"].map((l) => ({ value: l, label: l })),
              ]}
            />
            <TextField label="Tone of voice" value={settings.aiTone} onChange={(v) => set("aiTone", v)} />
          </Grid>
          <TextField
            label="Keywords to work in"
            details="Comma-separated, e.g. handmade, organic cotton, free shipping."
            value={settings.brandKeywords}
            onChange={(v) => set("brandKeywords", v)}
          />
        </s-stack>
      </s-section>

      <s-section heading="Password-protected store">
        <s-stack gap="small-200">
          <TextField
            label="Storefront password"
            details="Only needed while your store has a password page, so the audit can read it."
            value={password === undefined ? settings.storefrontPassword ?? "" : password ?? ""}
            onChange={(v) => setPassword(v)}
          />
          {d.hasPassword ? (
            <s-button variant="tertiary" onClick={() => setPassword(null)}>
              Remove password
            </s-button>
          ) : null}
        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
