import sharp from "sharp";

// Each image is processed once; caching decoded images only costs memory.
sharp.cache(false);

export interface CompressOptions {
  /** 1–100, see QUALITY in images.ts. */
  quality: number;
  /** Longest edge in px; 0 keeps the size. Never enlarges. */
  maxSize: number;
}

/**
 * Re-encodes an image in its own format: JPEG with mozjpeg, PNG losslessly
 * (or palette-quantized below quality 90), WebP. EXIF orientation is applied
 * and metadata dropped; colours are converted to sRGB.
 */
export async function compressImage(input: Buffer, mimeType: string, options: CompressOptions): Promise<Buffer> {
  let image = sharp(input, { failOn: "error" }).rotate();
  if (options.maxSize > 0) {
    image = image.resize({ width: options.maxSize, height: options.maxSize, fit: "inside", withoutEnlargement: true });
  }
  switch (mimeType) {
    case "image/jpeg":
      image = image.jpeg({ quality: options.quality, mozjpeg: true, progressive: true });
      break;
    case "image/png":
      image =
        options.quality >= 90
          ? image.png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 })
          : image.png({ compressionLevel: 9, palette: true, quality: options.quality, effort: 10 });
      break;
    case "image/webp":
      image = image.webp({ quality: options.quality, effort: 6 });
      break;
    default:
      throw new Error(`Can't compress ${mimeType}`);
  }
  return image.toBuffer();
}
