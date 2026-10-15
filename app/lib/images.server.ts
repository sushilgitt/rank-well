import type { ImageBackup, Shop } from "@prisma/client";
import prisma from "../db.server";
import { imageVars, listProductImages, type ProductImage } from "./alt.server";
import { compressImage } from "./compress.server";
import { COMPRESSIBLE, MIN_SAVING, QUALITY, filenameOf, savedRatio, seoFilename, withSuffix } from "./images";
import { PermanentError, registerJob } from "./jobs.server";
import { readSettings, type Settings } from "./settings";
import { assertNoUserErrors, gql, type AdminGraphql } from "./shop.server";
import { renderTemplate } from "./templates";
import { LimitError, refund, spend } from "./usage.server";

/**
 * Image optimizer: compression with backup + restore, and SEO file names.
 *
 * Compressing replaces the file behind the product's MediaImage in place
 * (fileUpdate originalSource), so the media ID, position, alt text and variant
 * links all stay. Before that, the untouched original is uploaded to the
 * merchant's Files as "rankwell-original-…", which is what restore puts back.
 */

const MAX_DOWNLOAD = 30 * 1024 * 1024;
const BACKUP_PREFIX = "rankwell-original-";

/** The image operations change the same files, so only one runs at a time. */
export const IMAGE_JOBS = ["images.compress", "images.restore", "images.rename"] as const;

interface MediaState {
  id: string;
  fileStatus: "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
  mimeType: string | null;
  image: { url: string } | null;
  originalSource: { url: string | null; fileSize: number | null } | null;
  fileErrors: { code: string; message: string }[];
}

async function mediaState(admin: AdminGraphql, id: string): Promise<MediaState | null> {
  const data = await gql<{ node: MediaState | null }>(
    admin,
    `#graphql
      query rankliftMediaImage($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            id fileStatus mimeType alt
            image { url }
            originalSource { url fileSize }
            fileErrors { code message }
          }
        }
      }`,
    { id },
  );
  return data.node?.id ? data.node : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shopify locks a file while it processes; updates need it READY. */
async function waitReady(admin: AdminGraphql, id: string, timeoutMs: number): Promise<MediaState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await mediaState(admin, id);
    if (!state) throw new PermanentError("The image no longer exists.");
    if (state.fileStatus === "READY") return state;
    if (state.fileStatus === "FAILED") {
      throw new Error(`Shopify couldn't process the image: ${state.fileErrors.map((e) => e.message).join("; ") || "unknown error"}`);
    }
    if (Date.now() > deadline) throw new Error("Shopify is still processing this image. Try again in a minute.");
    await sleep(1500);
  }
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Downloading the image failed (HTTP ${response.status}).`);
  if (Number(response.headers.get("content-length") || 0) > MAX_DOWNLOAD) {
    throw new PermanentError("The image is larger than 30 MB.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD) throw new PermanentError("The image is larger than 30 MB.");
  return bytes;
}

/** Uploads bytes to Shopify's staging bucket; returns the resourceUrl to hand to fileCreate/fileUpdate. */
async function stagedUpload(admin: AdminGraphql, bytes: Buffer, filename: string, mimeType: string): Promise<string> {
  const data = await gql<{
    stagedUploadsCreate: {
      stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[];
      userErrors: { message: string }[];
    };
  }>(
    admin,
    `#graphql
      mutation rankliftStagedUpload($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`,
    { input: [{ resource: "IMAGE", filename, mimeType, httpMethod: "POST", fileSize: String(bytes.length) }] },
  );
  assertNoUserErrors(data.stagedUploadsCreate.userErrors, "Upload");
  const target = data.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
  const response = await fetch(target.url, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Uploading to Shopify failed (HTTP ${response.status}).`);
  return target.resourceUrl;
}

async function fileUpdate(admin: AdminGraphql, input: { id: string; originalSource?: string; filename?: string }) {
  const data = await gql<{ fileUpdate: { userErrors: { message: string; code: string | null }[] } }>(
    admin,
    `#graphql
      mutation rankliftFileUpdate($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          files { id fileStatus }
          userErrors { field message code }
        }
      }`,
    { files: [input] },
  );
  return data.fileUpdate.userErrors;
}

/** Saves the original as a file in the merchant's Files and waits until Shopify has it. */
async function createBackup(admin: AdminGraphql, image: ProductImage, original: Buffer, filename: string, mimeType: string) {
  const source = await stagedUpload(admin, original, filename, mimeType);
  const data = await gql<{
    fileCreate: { files: { id: string }[] | null; userErrors: { message: string }[] };
  }>(
    admin,
    `#graphql
      mutation rankliftFileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { id fileStatus }
          userErrors { field message code }
        }
      }`,
    {
      files: [
        {
          originalSource: source,
          contentType: "IMAGE",
          filename: `${BACKUP_PREFIX}${filename}`,
          alt: `Original of ${image.productTitle}, kept by Rank Well to restore it`,
          duplicateResolutionMode: "APPEND_UUID",
        },
      ],
    },
  );
  assertNoUserErrors(data.fileCreate.userErrors, "Backup");
  const id = data.fileCreate.files?.[0]?.id;
  if (!id) throw new Error("Backup: Shopify returned no file.");
  // The original is only replaced once its copy is safely stored.
  const ready = await waitReady(admin, id, 90_000);
  return { id, url: ready.image?.url ?? null };
}

export type CompressOutcome =
  | { status: "compressed"; before: number; after: number }
  | { status: "skipped"; reason: string };

/** The most recent optimizer row per media ID. */
export async function latestBackups(shopId: string, mediaIds?: string[]) {
  const rows = await prisma.imageBackup.findMany({
    where: { shopId, ...(mediaIds ? { mediaId: { in: mediaIds } } : {}) },
    orderBy: { createdAt: "desc" },
  });
  const latest = new Map<string, ImageBackup>();
  for (const row of rows) if (!latest.has(row.mediaId)) latest.set(row.mediaId, row);
  return latest;
}

async function compressOne(admin: AdminGraphql, shop: Shop, image: ProductImage, settings: Settings): Promise<CompressOutcome> {
  if (!image.mimeType || !COMPRESSIBLE.includes(image.mimeType)) {
    return { status: "skipped", reason: "GIF, SVG and other formats are left as they are." };
  }
  const last = (await latestBackups(shop.id, [image.mediaId])).get(image.mediaId);
  if (last?.status === "compressed") return { status: "skipped", reason: "Already compressed." };
  if (last?.status === "skipped" && last.bytesBefore === image.fileSize) {
    return { status: "skipped", reason: "Already optimized." };
  }

  const state = await waitReady(admin, image.mediaId, 30_000);
  const mimeType = state.mimeType ?? image.mimeType;
  const filename = filenameOf(state.image?.url ?? image.url);
  const original = await download(state.originalSource?.url ?? state.image?.url ?? image.url);
  const compressed = await compressImage(original, mimeType, {
    quality: QUALITY[settings.images.quality],
    maxSize: settings.images.maxSize,
  });

  if (savedRatio(original.length, compressed.length) < MIN_SAVING) {
    await prisma.imageBackup.create({
      data: { shopId: shop.id, productId: image.productId, mediaId: image.mediaId, filename, bytesBefore: original.length, status: "skipped" },
    });
    return { status: "skipped", reason: "Already optimized." };
  }

  // A restored image is byte-for-byte its backup: reuse that instead of storing another copy.
  const reuse = last?.status === "restored" && last.backupFileId && last.bytesBefore === original.length ? last : null;
  const backup = reuse ? { id: reuse.backupFileId!, url: reuse.backupUrl } : await createBackup(admin, image, original, filename, mimeType);

  const source = await stagedUpload(admin, compressed, filename, mimeType);
  assertNoUserErrors(await fileUpdate(admin, { id: image.mediaId, originalSource: source }), "Replacing the image");

  await prisma.imageBackup.create({
    data: {
      shopId: shop.id,
      productId: image.productId,
      mediaId: image.mediaId,
      backupFileId: backup.id,
      backupUrl: backup.url,
      filename,
      bytesBefore: original.length,
      bytesAfter: compressed.length,
      status: "compressed",
    },
  });
  return { status: "compressed", before: original.length, after: compressed.length };
}

/** Compresses one image for 1 image credit, refunded when nothing was replaced. */
export async function compressWithCredit(admin: AdminGraphql, shop: Shop, image: ProductImage, settings: Settings) {
  await spend(shop, "images", 1, "images.compress");
  try {
    const outcome = await compressOne(admin, shop, image, settings);
    if (outcome.status !== "compressed") await refund(shop, "images", 1);
    return outcome;
  } catch (error) {
    await refund(shop, "images", 1);
    throw error;
  }
}

/** Puts the original back. The backup file stays in Files so a later compression can reuse it. */
export async function restoreOne(admin: AdminGraphql, row: ImageBackup) {
  if (row.status !== "compressed" || !row.backupFileId) throw new PermanentError("This image has no backup to restore.");
  const backup = await mediaState(admin, row.backupFileId);
  const url = backup?.image?.url;
  if (!url) {
    throw new PermanentError(`The backup (${BACKUP_PREFIX}${row.filename}) was deleted from Files, so this image can't be restored.`);
  }
  await waitReady(admin, row.mediaId, 30_000);
  assertNoUserErrors(await fileUpdate(admin, { id: row.mediaId, originalSource: url }), "Restoring the image");
  await prisma.imageBackup.update({ where: { id: row.id }, data: { status: "restored", backupUrl: url } });
}

/** The SEO file name the template gives an image, or null when it can't make one. */
export function targetFilename(image: ProductImage, settings: Settings, shopName: string) {
  return seoFilename(renderTemplate(settings.images.filenameTemplate, imageVars(image, shopName)), filenameOf(image.url));
}

export type RenameOutcome = { status: "renamed"; filename: string } | { status: "skipped"; reason: string };

export async function renameOne(admin: AdminGraphql, image: ProductImage, settings: Settings, shopName: string): Promise<RenameOutcome> {
  const target = targetFilename(image, settings, shopName);
  if (!target) return { status: "skipped", reason: "The template gives no usable file name for this product." };
  if (target === filenameOf(image.url)) return { status: "skipped", reason: "Already has this name." };

  let errors = await fileUpdate(admin, { id: image.mediaId, filename: target });
  let filename = target;
  // Two products with the same title: make the second name unique.
  if (errors.length && errors.some((e) => /exist|taken|duplicate|in use/i.test(e.message))) {
    filename = withSuffix(target, image.mediaId.split("/").pop()!.slice(-6));
    errors = await fileUpdate(admin, { id: image.mediaId, filename });
  }
  assertNoUserErrors(errors, "Renaming the image");
  return { status: "renamed", filename };
}

export interface CompressPayload {
  /** Empty = every product image. */
  mediaIds: string[];
}

registerJob("images.compress", async (ctx) => {
  const { mediaIds } = ctx.job.payload as unknown as CompressPayload;
  const settings = readSettings(ctx.shop.settings);
  const images = (await listProductImages(ctx.admin)).filter(
    (image) => (!mediaIds.length || mediaIds.includes(image.mediaId)) && image.mimeType && COMPRESSIBLE.includes(image.mimeType),
  );
  const done = await latestBackups(ctx.shop.id);
  const todo = images.filter((image) => {
    const last = done.get(image.mediaId);
    return !(last?.status === "compressed" || (last?.status === "skipped" && last.bytesBefore === image.fileSize));
  });
  await ctx.progress(0, todo.length);

  let compressed = 0;
  let skipped = 0;
  let saved = 0;
  const failed: string[] = [];
  for (let i = 0; i < todo.length; i++) {
    if (await ctx.cancelled()) break;
    const image = todo[i];
    try {
      const outcome = await compressWithCredit(ctx.admin, ctx.shop, image, settings);
      if (outcome.status === "compressed") {
        compressed++;
        saved += outcome.before - outcome.after;
      } else skipped++;
    } catch (error) {
      if (error instanceof LimitError) {
        throw new PermanentError(`${error.message} ${compressed} images were compressed before the limit.`);
      }
      // One bad file shouldn't stop the rest.
      console.error(`Compressing ${image.mediaId} failed`, error);
      failed.push(`${image.productTitle}: ${(error as Error).message}`);
    }
    await ctx.progress(i + 1);
  }
  return { compressed, skipped, saved, failed: failed.length, errors: failed.slice(0, 5) };
});

registerJob("images.restore", async (ctx) => {
  const rows = [...(await latestBackups(ctx.shop.id)).values()].filter((row) => row.status === "compressed");
  await ctx.progress(0, rows.length);
  let restored = 0;
  const failed: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (await ctx.cancelled()) break;
    try {
      await restoreOne(ctx.admin, rows[i]);
      restored++;
    } catch (error) {
      console.error(`Restoring ${rows[i].mediaId} failed`, error);
      failed.push(`${rows[i].filename}: ${(error as Error).message}`);
    }
    await ctx.progress(i + 1);
  }
  return { restored, failed: failed.length, errors: failed.slice(0, 5) };
});

registerJob("images.rename", async (ctx) => {
  const settings = readSettings(ctx.shop.settings);
  const shopName = ctx.shop.name ?? ctx.shop.domain;
  const images = await listProductImages(ctx.admin);
  const todo = images.filter((image) => {
    const target = targetFilename(image, settings, shopName);
    return target && target !== filenameOf(image.url);
  });
  await ctx.progress(0, todo.length);
  let renamed = 0;
  const failed: string[] = [];
  for (let i = 0; i < todo.length; i++) {
    if (await ctx.cancelled()) break;
    try {
      if ((await renameOne(ctx.admin, todo[i], settings, shopName)).status === "renamed") renamed++;
    } catch (error) {
      failed.push(`${todo[i].productTitle}: ${(error as Error).message}`);
    }
    if (i % 5 === 4) await ctx.progress(i + 1);
  }
  await ctx.progress(todo.length);
  return { renamed, failed: failed.length, errors: failed.slice(0, 5) };
});
