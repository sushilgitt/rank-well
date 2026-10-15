import type { Settings } from "./settings";

/**
 * Pure helpers for the image optimizer: file names, quality presets, savings.
 * Shopify ties a file's MIME type to its extension, so a compressed or renamed
 * image always keeps its original extension and format.
 */

export const QUALITY: Record<Settings["images"]["quality"], number> = { light: 90, balanced: 80, strong: 68 };

/** A compression that saves less than this is not worth replacing the original. */
export const MIN_SAVING = 0.05;

/** Formats sharp can re-encode in the same format. GIF (often animated) and SVG are left alone. */
export const COMPRESSIBLE = ["image/jpeg", "image/png", "image/webp"];

/** "https://cdn.shopify.com/s/files/1/…/files/Blue%20Tee.jpg?v=12" → "Blue Tee.jpg" */
export function filenameOf(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** ASCII, lowercase, hyphenated, cut at the last whole word within `max`. */
export function slugify(text: string, max = 70): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1);
  const hyphen = cut.lastIndexOf("-");
  return (hyphen > 0 ? cut.slice(0, hyphen) : slug.slice(0, max)).replace(/-+$/, "");
}

/**
 * The SEO file name for an image: the rendered template as a slug, with the
 * current extension. Null when the template gives nothing usable (e.g. a
 * product title in a non-Latin script) or the file has no extension.
 */
export function seoFilename(rendered: string, current: string): string | null {
  const ext = extensionOf(current);
  const slug = slugify(rendered);
  if (!ext || !slug) return null;
  return `${slug}.${ext}`;
}

/** Makes a file name unique by appending a short suffix before the extension. */
export function withSuffix(filename: string, suffix: string): string {
  const ext = extensionOf(filename);
  const base = ext ? filename.slice(0, -(ext.length + 1)) : filename;
  return ext ? `${base}-${suffix}.${ext}` : `${base}-${suffix}`;
}

export function savedRatio(before: number, after: number): number {
  return before > 0 ? Math.max(0, (before - after) / before) : 0;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
