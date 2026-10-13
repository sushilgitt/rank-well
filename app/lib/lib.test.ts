import { describe, expect, it } from "vitest";
import { excerpt, renderTemplate, truncate } from "./templates";
import { DEFAULT_SETTINGS, patchSettings, readSettings } from "./settings";
import { hasFeature, planWith } from "./plans";

describe("templates", () => {
  it("fills placeholders and tidies separators left by empty ones", () => {
    expect(renderTemplate("{{title}} | {{shop}}", { title: "Tee", shop: "Acme" })).toBe("Tee | Acme");
    expect(renderTemplate("{{title}} | {{vendor}} | {{shop}}", { title: "Tee", shop: "Acme" })).toBe("Tee | Acme");
    expect(renderTemplate("{{vendor}} - {{title}}", { title: "Tee" })).toBe("Tee");
  });

  it("truncates at a word boundary", () => {
    expect(truncate("The quick brown fox jumps", 15)).toBe("The quick brown");
    expect(truncate("short", 15)).toBe("short");
  });

  it("excerpts whole sentences when they fit", () => {
    expect(excerpt("First sentence. Second one is longer. Third.", 30)).toBe("First sentence.");
  });
});

describe("settings", () => {
  it("fills defaults for a missing or partial row", () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = readSettings({ autoMeta: true, schema: { faq: false }, unknown: 1 });
    expect(s.autoMeta).toBe(true);
    expect(s.schema.faq).toBe(false);
    expect(s.schema.product).toBe(true);
    expect("unknown" in s).toBe(false);
  });

  it("ignores values of the wrong type", () => {
    expect(readSettings({ autoMeta: "yes", llms: { maxProducts: "lots" } }).llms.maxProducts).toBe(200);
  });

  it("patches nested values without dropping siblings", () => {
    const s = patchSettings({ templates: { productTitle: "A" } }, { templates: { altText: "B" } });
    expect(s.templates.productTitle).toBe("A");
    expect(s.templates.altText).toBe("B");
  });
});

describe("plans", () => {
  it("gates features by plan", () => {
    expect(hasFeature("FREE", "jsonLd")).toBe(false);
    expect(hasFeature("PRO", "jsonLd")).toBe(true);
    expect(planWith("competitors")).toBe("PREMIUM");
  });
});
