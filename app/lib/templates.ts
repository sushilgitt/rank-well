/**
 * Meta-tag templates: `{{title}} | {{shop}}`. Unknown placeholders render
 * empty; whitespace and dangling separators left by empty ones are tidied.
 */

export interface TemplateVars {
  title?: string;
  shop?: string;
  vendor?: string;
  type?: string;
  price?: string;
  description?: string;
  variant?: string;
  blog?: string;
  [key: string]: string | undefined;
}

export const PLACEHOLDERS = ["title", "shop", "vendor", "type", "price", "description", "variant", "blog"];

export function renderTemplate(template: string, vars: TemplateVars, maxLength?: number): string {
  const filled = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => (vars[key] ?? "").trim());
  // Split on separators — "|", "·", dashes with spaces around them (a hyphen
  // inside "T-shirt" is not one) — then drop the empty pieces an empty
  // placeholder leaves: "Shoes |  | Shop" → "Shoes | Shop", "- Tee" → "Tee".
  const pieces = ` ${filled} `.split(/(\s*\|\s*|\s*·\s*|\s+[-–—]\s+)/);
  const kept: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const text = pieces[i].replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (kept.length) kept.push(pieces[i - 1].trim() === "" ? " " : ` ${pieces[i - 1].trim()} `);
    kept.push(text);
  }
  const out = kept.join("");
  return maxLength ? truncate(out, maxLength) : out;
}

/** Cuts at a word boundary and never mid-word; no ellipsis (search engines add their own). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,.;:|\-–—]+$/, "");
}

/** First sentence(s) of a description, up to `max` characters. */
export function excerpt(text: string, max = 150): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).length > max) break;
    out += sentence;
  }
  return (out.trim() || truncate(clean, max)).trim();
}

export const LIMITS = { title: 60, description: 155, alt: 125 };
