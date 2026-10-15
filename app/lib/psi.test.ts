import { describe, expect, it } from "vitest";
import { isPasswordRedirect, parsePsi, rate } from "./psi";

const response = {
  lighthouseResult: {
    finalDisplayedUrl: "https://acme.com/",
    categories: { performance: { score: 0.734 } },
    audits: {
      "largest-contentful-paint": { numericValue: 3120.6 },
      "cumulative-layout-shift": { numericValue: 0.04567 },
      "total-blocking-time": { numericValue: 412.2 },
      "first-contentful-paint": { numericValue: 1500 },
      "speed-index": { numericValue: 4200 },
    },
  },
  loadingExperience: {
    overall_category: "AVERAGE",
    origin_fallback: true,
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2400 },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180 },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 },
    },
  },
};

describe("PageSpeed Insights", () => {
  it("reads lab metrics and real-user field data", () => {
    expect(parsePsi(response)).toEqual({
      finalUrl: "https://acme.com/",
      score: 73,
      lcpMs: 3121,
      cls: 0.046,
      tbtMs: 412,
      fcpMs: 1500,
      siMs: 4200,
      field: { lcpMs: 2400, inpMs: 180, cls: 0.12, category: "AVERAGE", origin: true },
    });
  });

  it("has no field data when Chrome has too little traffic", () => {
    const parsed = parsePsi({ lighthouseResult: response.lighthouseResult, loadingExperience: { metrics: {} } });
    expect(parsed.field).toBeNull();
    expect(parsePsi(null).score).toBeNull();
  });

  it("rates against Google's thresholds", () => {
    expect(rate("lcpMs", 2500)).toBe("good");
    expect(rate("lcpMs", 3121)).toBe("average");
    expect(rate("cls", 0.3)).toBe("poor");
    expect(rate("score", 90)).toBe("good");
    expect(rate("score", 49)).toBe("poor");
    expect(rate("tbtMs", null)).toBeNull();
  });

  it("spots a password-protected storefront", () => {
    expect(isPasswordRedirect("https://acme.com/password")).toBe(true);
    expect(isPasswordRedirect("https://acme.com/products/password-safe")).toBe(false);
    expect(isPasswordRedirect(null)).toBe(false);
  });
});
