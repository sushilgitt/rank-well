/**
 * Shop.settings, typed. Stored as JSON; read through `readSettings`, which
 * fills in defaults so older rows never miss a newer option.
 */

export type MetaTemplates = {
  /** Liquid-like placeholders: {{title}}, {{shop}}, {{vendor}}, {{type}}, {{price}}, {{description}} */
  productTitle: string;
  productDescription: string;
  collectionTitle: string;
  collectionDescription: string;
  pageTitle: string;
  pageDescription: string;
  articleTitle: string;
  articleDescription: string;
  altText: string;
};

export type Settings = {
  storefrontPassword: string | null;
  templates: MetaTemplates;
  /** Fill in SEO fields and alt text on products created after this was turned on. */
  autoMeta: boolean;
  autoAlt: boolean;
  /** "template" fills placeholders; "ai" writes them (spends credits). */
  autoMode: "template" | "ai";
  /** Redirect new 404s to the closest match automatically. */
  autoRedirect404: boolean;
  /** Where unmatched 404s go when autoRedirect404 is on. */
  fallbackRedirect: string;
  schema: {
    organization: boolean;
    website: boolean;
    product: boolean;
    breadcrumbs: boolean;
    article: boolean;
    collection: boolean;
    faq: boolean;
    localBusiness: boolean;
    logo: string | null;
    sameAs: string[];
    business: {
      type: string;
      phone: string;
      street: string;
      city: string;
      region: string;
      postalCode: string;
      country: string;
      priceRange: string;
      openingHours: string[];
    };
  };
  llms: {
    enabled: boolean;
    summary: string;
    includeProducts: boolean;
    includeCollections: boolean;
    includePages: boolean;
    includeArticles: boolean;
    maxProducts: number;
  };
  speed: {
    prefetch: boolean;
    lazyImages: boolean;
    preconnect: boolean;
  };
  images: {
    /** light ≈ visually lossless, balanced = the usual web setting, strong = smallest files. */
    quality: "light" | "balanced" | "strong";
    /** Longest edge in px; larger originals are scaled down. 0 = keep the size. */
    maxSize: number;
    /** SEO file names, same placeholders as alt text; the extension is kept. */
    filenameTemplate: string;
  };
  /** ISO language of AI output; "auto" = the store's primary language. */
  aiLanguage: string;
  aiTone: string;
  brandKeywords: string;
};

export const DEFAULT_SETTINGS: Settings = {
  storefrontPassword: null,
  templates: {
    productTitle: "{{title}} | {{shop}}",
    productDescription: "Shop {{title}} at {{shop}}. {{description}}",
    collectionTitle: "{{title}} | {{shop}}",
    collectionDescription: "Browse our {{title}} collection at {{shop}}. {{description}}",
    pageTitle: "{{title}} | {{shop}}",
    pageDescription: "{{description}}",
    articleTitle: "{{title}} | {{shop}} Blog",
    articleDescription: "{{description}}",
    altText: "{{title}}{{variant}}",
  },
  autoMeta: false,
  autoAlt: false,
  autoMode: "template",
  autoRedirect404: false,
  fallbackRedirect: "/",
  schema: {
    organization: true,
    website: true,
    product: true,
    breadcrumbs: true,
    article: true,
    collection: true,
    faq: true,
    localBusiness: false,
    logo: null,
    sameAs: [],
    business: {
      type: "Store",
      phone: "",
      street: "",
      city: "",
      region: "",
      postalCode: "",
      country: "",
      priceRange: "",
      openingHours: [],
    },
  },
  llms: {
    enabled: true,
    summary: "",
    includeProducts: true,
    includeCollections: true,
    includePages: true,
    includeArticles: true,
    maxProducts: 200,
  },
  speed: {
    prefetch: true,
    lazyImages: true,
    preconnect: true,
  },
  images: {
    quality: "balanced",
    maxSize: 2560,
    filenameTemplate: "{{title}}{{variant}}",
  },
  aiLanguage: "auto",
  aiTone: "clear, friendly and persuasive",
  brandKeywords: "",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deep-merges stored values over defaults; unknown keys are dropped. */
function merge<T>(defaults: T, stored: unknown): T {
  if (!isObject(defaults) || !isObject(stored)) {
    if (stored === undefined || (stored === null && defaults !== null)) return defaults;
    if (isObject(defaults)) return defaults;
    if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : defaults) as T;
    if (defaults === null) return (stored ?? null) as T;
    return (typeof stored === typeof defaults ? stored : defaults) as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) out[key] = merge((defaults as Record<string, unknown>)[key], stored[key]);
  return out as T;
}

export function readSettings(stored: unknown): Settings {
  return merge(DEFAULT_SETTINGS, stored);
}

/** Applies a partial change (one settings form) on top of the stored settings. */
export function patchSettings(stored: unknown, patch: unknown): Settings {
  const current = readSettings(stored);
  return merge(current, mergeShallowDeep(current, patch));
}

function mergeShallowDeep(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = mergeShallowDeep(base[key], value);
  return out;
}
