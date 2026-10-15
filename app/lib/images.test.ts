import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compressImage } from "./compress.server";
import { extensionOf, filenameOf, savedRatio, seoFilename, slugify, withSuffix } from "./images";
import { readSettings } from "./settings";

describe("file names", () => {
  it("reads the file name from a Shopify CDN URL", () => {
    expect(filenameOf("https://cdn.shopify.com/s/files/1/0001/files/Blue%20Tee.JPG?v=12")).toBe("Blue Tee.JPG");
    expect(filenameOf("not a url")).toBe("");
    expect(extensionOf("Blue Tee.JPG")).toBe("jpg");
    expect(extensionOf("noext")).toBe("");
  });

  it("slugs to ASCII and cuts at a hyphen", () => {
    expect(slugify("Crème Brûlée & Co. — Red / M")).toBe("creme-brulee-and-co-red-m");
    expect(slugify("one two three four five", 12)).toBe("one-two");
    expect(slugify("日本語")).toBe("");
  });

  it("keeps the current extension, since Shopify ties the MIME type to it", () => {
    expect(seoFilename("Blue Tee - view 2", "IMG_0042.JPG")).toBe("blue-tee-view-2.jpg");
    expect(seoFilename("日本語", "a.png")).toBeNull();
    expect(seoFilename("Tee", "noext")).toBeNull();
    expect(withSuffix("blue-tee.jpg", "a1b2c3")).toBe("blue-tee-a1b2c3.jpg");
  });

  it("defaults the file name template to the alt text placeholders", () => {
    expect(readSettings({}).images).toEqual({ quality: "balanced", maxSize: 2560, filenameTemplate: "{{title}}{{variant}}" });
  });
});

/** A noisy photo-like image: flat colours compress too well to be a fair test. */
async function photo(width: number, height: number, format: "jpeg" | "png" | "webp") {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i / 3) % width) * 3 + Math.floor(Math.random() * 40)) & 255;
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  if (format === "jpeg") return image.jpeg({ quality: 100 }).toBuffer();
  if (format === "png") return image.png({ compressionLevel: 0 }).toBuffer();
  return image.webp({ quality: 100 }).toBuffer();
}

describe("compression", () => {
  it.each([
    ["image/jpeg", "jpeg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ] as const)("shrinks %s and keeps the format", async (mime, format) => {
    const input = await photo(400, 300, format);
    const output = await compressImage(input, mime, { quality: 80, maxSize: 0 });
    expect((await sharp(output).metadata()).format).toBe(format);
    expect(savedRatio(input.length, output.length)).toBeGreaterThan(0.05);
  });

  it("scales the longest edge down to maxSize, never up", async () => {
    const big = await compressImage(await photo(600, 300, "jpeg"), "image/jpeg", { quality: 80, maxSize: 200 });
    expect(await sharp(big).metadata()).toMatchObject({ width: 200, height: 100 });
    const small = await compressImage(await photo(120, 80, "jpeg"), "image/jpeg", { quality: 80, maxSize: 200 });
    expect(await sharp(small).metadata()).toMatchObject({ width: 120, height: 80 });
  });

  it("refuses formats it would have to convert", async () => {
    await expect(compressImage(Buffer.from("x"), "image/gif", { quality: 80, maxSize: 0 })).rejects.toThrow();
  });
});
