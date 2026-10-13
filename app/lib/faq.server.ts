import type { Shop } from "@prisma/client";
import { askJson } from "./ai.server";
import { AI_COST } from "./plans";
import type { Resource } from "./resources.server";
import { readSettings } from "./settings";
import { assertNoUserErrors, gql, type AdminGraphql } from "./shop.server";
import { refund, spend } from "./usage.server";

/**
 * FAQs per product/page/article/collection, stored in the `ranklift.faq` JSON
 * metafield. The app embed turns them into FAQPage structured data, which AI
 * assistants and Google read; a theme block can show them on the page too.
 */

export interface Faq {
  q: string;
  a: string;
}

export function cleanFaqs(input: unknown): Faq[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => ({
      q: String((item as Faq)?.q ?? "").trim().slice(0, 300),
      a: String((item as Faq)?.a ?? "").trim().slice(0, 2000),
    }))
    .filter((item) => item.q && item.a)
    .slice(0, 20);
}

export async function readFaqs(admin: AdminGraphql, ownerId: string): Promise<Faq[]> {
  const data = await gql<{ node: { metafield: { value: string } | null } | null }>(
    admin,
    `#graphql
      query rankliftFaq($id: ID!) {
        node(id: $id) {
          ... on HasMetafields { metafield(namespace: "ranklift", key: "faq") { value } }
        }
      }`,
    { id: ownerId },
  );
  try {
    return cleanFaqs(JSON.parse(data.node?.metafield?.value ?? "[]"));
  } catch {
    return [];
  }
}

export async function saveFaqs(admin: AdminGraphql, ownerId: string, faqs: Faq[]) {
  const clean = cleanFaqs(faqs);
  if (!clean.length) {
    await gql(
      admin,
      `#graphql
        mutation rankliftFaqDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) { userErrors { field message } }
        }`,
      { metafields: [{ ownerId, namespace: "ranklift", key: "faq" }] },
    );
    return clean;
  }
  const data = await gql<{ metafieldsSet: { userErrors: { message: string }[] } }>(
    admin,
    `#graphql
      mutation rankliftFaqSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    { metafields: [{ ownerId, namespace: "ranklift", key: "faq", type: "json", value: JSON.stringify(clean) }] },
  );
  assertNoUserErrors(data.metafieldsSet.userErrors, "FAQ");
  return clean;
}

export async function generateFaqs(shop: Shop, resource: Resource): Promise<Faq[]> {
  const settings = readSettings(shop.settings);
  await spend(shop, "ai", AI_COST.faq, "faq");
  try {
    const answer = await askJson<{ faqs: Faq[] }>({
      system: [
        `You write FAQ sections for the online store "${shop.name ?? shop.domain}".`,
        "Write 5 questions shoppers really search for or ask AI assistants about this item, with short, direct answers (1–3 sentences).",
        "Only state facts found in the details given. If a detail (sizing, shipping, care) isn't given, ask a question you can answer from the text instead.",
        settings.aiLanguage === "auto" ? "Write in the language of the item's text." : `Write in: ${settings.aiLanguage}.`,
        'Answer with JSON only: {"faqs":[{"q":"…","a":"…"}]}',
      ].join("\n"),
      user: JSON.stringify({ type: resource.type, name: resource.title, details: resource.extra ?? {}, text: resource.text.slice(0, 3000) }),
      maxTokens: 1500,
    });
    return cleanFaqs(answer.faqs);
  } catch (error) {
    await refund(shop, "ai", AI_COST.faq);
    throw error;
  }
}
