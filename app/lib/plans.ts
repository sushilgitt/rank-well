import type { Plan } from "@prisma/client";

/**
 * What each plan includes per 30-day period. `Infinity` means no limit.
 * The Partner-dashboard plans (managed pricing) must match these names and
 * prices; app/lib/billing.server.ts maps a subscription back onto a Plan.
 */
export type Meter = "ai" | "images" | "auditPages";

export interface PlanDef {
  name: string;
  monthly: number;
  annual: number;
  limits: Record<Meter, number>;
  features: {
    jsonLd: boolean;
    llmsTxt: boolean;
    bulkMeta: boolean;
    autoRedirect: boolean;
    speed: "basic" | "rocket" | "turbo";
    competitors: boolean;
    internalLinks: boolean;
    rankTracking: number;
  };
}

export const PLANS: Record<Plan, PlanDef> = {
  FREE: {
    name: "Free",
    monthly: 0,
    annual: 0,
    limits: { ai: 30, images: 50, auditPages: 20 },
    features: {
      jsonLd: false,
      llmsTxt: false,
      bulkMeta: false,
      autoRedirect: false,
      speed: "basic",
      competitors: false,
      internalLinks: false,
      rankTracking: 0,
    },
  },
  PRO: {
    name: "Pro",
    monthly: 29.99,
    annual: 287.9,
    limits: { ai: 200, images: 2000, auditPages: 1000 },
    features: {
      jsonLd: true,
      llmsTxt: true,
      bulkMeta: true,
      autoRedirect: true,
      speed: "rocket",
      competitors: false,
      internalLinks: false,
      rankTracking: 20,
    },
  },
  PREMIUM: {
    name: "Premium",
    monthly: 59.99,
    annual: 575.9,
    limits: { ai: 500, images: 6000, auditPages: Infinity },
    features: {
      jsonLd: true,
      llmsTxt: true,
      bulkMeta: true,
      autoRedirect: true,
      speed: "turbo",
      competitors: true,
      internalLinks: true,
      rankTracking: 100,
    },
  },
};

export type Feature = keyof PlanDef["features"];

export function hasFeature(plan: Plan, feature: Feature): boolean {
  return Boolean(PLANS[plan].features[feature]);
}

/** The cheapest plan that has a feature, for "upgrade to …" messages. */
export function planWith(feature: Feature): Plan {
  return (["FREE", "PRO", "PREMIUM"] as Plan[]).find((p) => hasFeature(p, feature)) ?? "PREMIUM";
}

/** AI credits each action costs. */
export const AI_COST = {
  meta: 1,
  alt: 1,
  outline: 2,
  article: 10,
  rewrite: 3,
  faq: 2,
  visibility: 1,
} as const;
