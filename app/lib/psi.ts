/**
 * PageSpeed Insights v5 responses → the numbers Rank Well stores, and Google's
 * Core Web Vitals thresholds for colouring them.
 */

export type Strategy = "mobile" | "desktop";
export type SpeedPage = "home" | "product" | "collection";

export interface FieldData {
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  /** FAST | AVERAGE | SLOW, Chrome's verdict on real visits. */
  category: string | null;
  /** True when Chrome had too little traffic for this URL and reports the whole site. */
  origin: boolean;
}

export interface PsiResult {
  finalUrl: string | null;
  score: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  siMs: number | null;
  field: FieldData | null;
}

type Audit = { numericValue?: number };
type Metric = { percentile?: number };
interface PsiResponse {
  lighthouseResult?: {
    finalDisplayedUrl?: string;
    finalUrl?: string;
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, Audit | undefined>;
  };
  loadingExperience?: {
    overall_category?: string;
    origin_fallback?: boolean;
    metrics?: Record<string, Metric | undefined>;
  };
}

const round = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);

export function parsePsi(body: unknown): PsiResult {
  const data = (body ?? {}) as PsiResponse;
  const lh = data.lighthouseResult ?? {};
  const audits = lh.audits ?? {};
  const score = lh.categories?.performance?.score;
  const clsLab = audits["cumulative-layout-shift"]?.numericValue;

  const metrics = data.loadingExperience?.metrics ?? {};
  const lcpField = metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile;
  const inpField = metrics.INTERACTION_TO_NEXT_PAINT?.percentile;
  // CrUX reports CLS ×100 as an integer.
  const clsField = metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile;
  const hasField = [lcpField, inpField, clsField].some((v) => typeof v === "number");

  return {
    finalUrl: lh.finalDisplayedUrl ?? lh.finalUrl ?? null,
    score: typeof score === "number" ? Math.round(score * 100) : null,
    lcpMs: round(audits["largest-contentful-paint"]?.numericValue),
    cls: typeof clsLab === "number" ? Math.round(clsLab * 1000) / 1000 : null,
    tbtMs: round(audits["total-blocking-time"]?.numericValue),
    fcpMs: round(audits["first-contentful-paint"]?.numericValue),
    siMs: round(audits["speed-index"]?.numericValue),
    field: hasField
      ? {
          lcpMs: round(lcpField),
          inpMs: round(inpField),
          cls: typeof clsField === "number" ? clsField / 100 : null,
          category: data.loadingExperience?.overall_category ?? null,
          origin: Boolean(data.loadingExperience?.origin_fallback),
        }
      : null,
  };
}

/** Google's good / needs-improvement limits. */
export const THRESHOLDS = {
  score: [90, 50],
  lcpMs: [2500, 4000],
  inpMs: [200, 500],
  cls: [0.1, 0.25],
  tbtMs: [200, 600],
  fcpMs: [1800, 3000],
  siMs: [3400, 5800],
} as const;

export type Rating = "good" | "average" | "poor";

export function rate(metric: keyof typeof THRESHOLDS, value: number | null | undefined): Rating | null {
  if (value == null) return null;
  const [good, poor] = THRESHOLDS[metric];
  // The score is the only one where higher is better.
  if (metric === "score") return value >= good ? "good" : value >= poor ? "average" : "poor";
  return value <= good ? "good" : value <= poor ? "average" : "poor";
}

/** A password-protected storefront redirects every page to /password. */
export function isPasswordRedirect(finalUrl: string | null): boolean {
  if (!finalUrl) return false;
  try {
    return new URL(finalUrl).pathname.replace(/\/$/, "") === "/password";
  } catch {
    return false;
  }
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "–";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
