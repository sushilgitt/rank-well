import { describe, expect, it, vi } from "vitest";

// redirects.server imports the database and Shopify client; the pure helpers don't need them.
vi.mock("../db.server", () => ({ default: {} }));
vi.mock("./resources.server", () => ({}));
vi.mock("./shop.server", () => ({}));

const { bestMatch, toPath, tokens } = await import("./redirects.server");

const live = [
  { type: "product" as const, handle: "organic-cotton-tee", title: "Organic Cotton Tee", url: "https://acme.com/products/organic-cotton-tee" },
  { type: "product" as const, handle: "wool-socks", title: "Wool Socks", url: "https://acme.com/products/wool-socks" },
  { type: "collection" as const, handle: "tees", title: "Tees", url: "/collections/tees" },
];

describe("redirect matching", () => {
  it("normalises full URLs and bare paths", () => {
    expect(toPath("https://acme.com/products/x?y=1")).toBe("/products/x?y=1");
    expect(toPath("products/x")).toBe("/products/x");
    expect(toPath("  ")).toBe("");
  });

  it("drops section words and file extensions from tokens", () => {
    expect(tokens("/products/Organic-Cotton-Tee.html")).toEqual(["organic", "cotton", "tee"]);
  });

  it("sends a dead product URL to the closest live product", () => {
    expect(bestMatch("/products/organic-cotton-tee-2023", live)).toBe("/products/organic-cotton-tee");
    expect(bestMatch("/fr/products/wool-socks-old", live)).toBe("/products/wool-socks");
  });

  it("returns nothing when no page is a reasonable match", () => {
    expect(bestMatch("/products/leather-wallet", live)).toBeNull();
  });
});
