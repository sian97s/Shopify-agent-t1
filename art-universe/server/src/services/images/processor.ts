import sharp from 'sharp';
import { computeVisualFeatures, type VisualFeatures } from './features.js';

sharp.cache(false);
sharp.concurrency(2);

export const DERIVATIVES = [
  { name: 'thumb', size: 96, quality: 62 },
  { name: 'small', size: 384, quality: 74 },
  { name: 'large', size: 1400, quality: 82 }
] as const;

export type DerivativeName = (typeof DERIVATIVES)[number]['name'];

export interface PreparedImage {
  /** Cleaned, orientation-corrected, metadata-free master (webp). */
  master: Buffer;
  width: number;
  height: number;
  derivatives: Record<DerivativeName, Buffer>;
  features: VisualFeatures;
  /** What the pipeline did, for the moderation record. Never shown to the creator. */
  adjustments: string[];
  /** Whether the original carried EXIF/GPS/XMP that we removed. */
  strippedMetadata: string[];
}

export class UnsupportedImageError extends Error {
  constructor(message = 'unsupported image') {
    super(message);
    this.name = 'UnsupportedImageError';
  }
}

const SUPPORTED = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif', 'gif', 'tiff', 'heif']);

/** Which metadata blocks were present in the original, before we drop them. */
async function metadataBlocks(input: Buffer): Promise<string[]> {
  try {
    const md = await sharp(input).metadata();
    const found: string[] = [];
    if (md.exif) found.push('exif');
    if (md.icc) found.push('icc');
    if (md.iptc) found.push('iptc');
    if (md.xmp) found.push('xmp');
    if ((md as { orientation?: number }).orientation) found.push('orientation');
    return found;
  } catch {
    return [];
  }
}

/**
 * Estimate a small skew angle from the dominant gradient orientation.
 * Photographs of physical artwork are usually a couple of degrees off; a large
 * angle means the composition is deliberate and must be left alone.
 */
async function estimateSkew(input: Buffer): Promise<number> {
  const size = 128;
  const { data } = await sharp(input)
    .resize(size, size, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = new Float32Array(180);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const gx = data[i + 1] - data[i - 1];
      const gy = data[i + size] - data[i - size];
      const mag = Math.hypot(gx, gy);
      if (mag < 24) continue;
      let deg = (Math.atan2(gy, gx) * 180) / Math.PI;
      deg = ((deg % 180) + 180) % 180;
      bins[Math.floor(deg)] += mag;
    }
  }
  // Look only near the horizontal/vertical axes; anything else is content.
  let best = 0;
  let bestScore = 0;
  for (let d = -8; d <= 8; d++) {
    const h = bins[((d % 180) + 180) % 180];
    const v = bins[((d + 90) % 180 + 180) % 180];
    const score = h + v;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  const axisScore = bins[0] + bins[90];
  // Only claim a skew if it is clearly stronger than the true axes.
  if (best === 0 || bestScore < axisScore * 1.25) return 0;
  return Math.abs(best) >= 0.5 && Math.abs(best) <= 8 ? best : 0;
}

/** Does the image sit inside a flat, uniform border (a photo of art on a wall)? */
async function hasUniformBorder(input: Buffer): Promise<boolean> {
  const size = 64;
  const { data } = await sharp(input)
    .resize(size, size, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ring: number[] = [];
  for (let x = 0; x < size; x++) {
    ring.push(data[x], data[(size - 1) * size + x]);
  }
  for (let y = 0; y < size; y++) {
    ring.push(data[y * size], data[y * size + size - 1]);
  }
  const mean = ring.reduce((a, b) => a + b, 0) / ring.length;
  const variance = ring.reduce((a, b) => a + (b - mean) ** 2, 0) / ring.length;
  const inner = data[Math.floor(size / 2) * size + Math.floor(size / 2)];
  return Math.sqrt(variance) < 10 && Math.abs(inner - mean) > 24;
}

/**
 * Gentle lighting normalisation: nudge under/over-exposed photographs toward a
 * readable range, and never move a deliberately dark or bright artwork.
 */
function lightingAdjustment(mean: number): { a: number; b: number } | null {
  const target = 0.46;
  if (mean > 0.26 && mean < 0.74) return null;
  const desired = mean < 0.26 ? Math.min(target, mean * 1.5) : Math.max(target, mean * 0.82);
  const a = Math.max(0.85, Math.min(1.18, desired / Math.max(mean, 0.02)));
  return Math.abs(a - 1) < 0.03 ? null : { a, b: 0 };
}

export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  const meta = await sharp(input).metadata().catch(() => null);
  if (!meta || !meta.format || !SUPPORTED.has(meta.format)) {
    throw new UnsupportedImageError(`format ${meta?.format ?? 'unknown'} not supported`);
  }
  if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) {
    throw new UnsupportedImageError('image too small');
  }
  if (meta.width > 20000 || meta.height > 20000) {
    throw new UnsupportedImageError('image too large');
  }

  const strippedMetadata = await metadataBlocks(input);
  const adjustments: string[] = [];

  // .rotate() with no argument applies the EXIF orientation, and sharp writes
  // no metadata unless withMetadata() is called — so the output is clean.
  let pipeline = sharp(input, { failOn: 'none' }).rotate();
  let working = await pipeline.toBuffer();
  if (strippedMetadata.includes('orientation')) adjustments.push('orientation');

  if (await hasUniformBorder(working)) {
    try {
      const trimmed = await sharp(working).trim({ threshold: 12 }).toBuffer();
      const tm = await sharp(trimmed).metadata();
      const area = (tm.width ?? 0) * (tm.height ?? 0);
      const original = (meta.width ?? 1) * (meta.height ?? 1);
      // Only accept a trim that removes a frame, not one that eats the artwork.
      if (area > original * 0.4) {
        working = trimmed;
        adjustments.push('frame-crop');
      }
    } catch {
      /* trimming is best-effort */
    }
  }

  const skew = await estimateSkew(working);
  if (skew !== 0) {
    working = await sharp(working)
      .rotate(-skew, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();
    adjustments.push(`deskew:${skew.toFixed(1)}deg`);
  }

  const stats = await sharp(working).stats();
  const meanLum =
    stats.channels.slice(0, 3).reduce((acc, c) => acc + c.mean, 0) / (3 * 255) || 0.5;
  const light = lightingAdjustment(meanLum);
  if (light) {
    working = await sharp(working).linear(light.a, light.b).toBuffer();
    adjustments.push(`lighting:${light.a.toFixed(2)}x`);
  }

  const finalMeta = await sharp(working).metadata();
  const width = finalMeta.width ?? meta.width;
  const height = finalMeta.height ?? meta.height;

  const master = await sharp(working)
    .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();

  const derivatives = {} as Record<DerivativeName, Buffer>;
  for (const d of DERIVATIVES) {
    derivatives[d.name] = await sharp(working)
      .resize(d.size, d.size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: d.quality })
      .toBuffer();
  }

  const featureSize = 64;
  const raw = await sharp(working)
    .resize(featureSize, featureSize, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const features = computeVisualFeatures(raw, featureSize, width / height);

  return { master, width, height, derivatives, features, adjustments, strippedMetadata };
}

/** Downscaled JPEG used for vision calls and for the local OCR/PII heuristics. */
export async function analysisImage(input: Buffer, size = 512): Promise<Buffer> {
  return sharp(input).resize(size, size, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
}

/** Greyscale raw pixels used by the local text-region detector. */
export async function greyscaleRaw(
  input: Buffer,
  size = 256
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input)
    .resize(size, size, { fit: 'inside' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
