import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { ACCEPTED_IMAGE_MEDIA_TYPES, LIMITS, STORED_IMAGE_QUALITY } from '@inlet/shared';
import { apiError } from './errors.js';

/**
 * Screenshot validation and re-encoding (FR-099, section 9.3).
 *
 * Every check runs against the decoded image rather than the declared filename or
 * Content-Type, which is what section 12.1 requires. Re-encoding to WebP is also the
 * file-safety control for Release 1: the stored bytes are produced by our own
 * encoder, so a payload smuggled inside the source image does not survive, and the
 * conversion drops EXIF and other original metadata (section 12.2).
 */

export type ProcessedImage = {
  data: Buffer;
  originalMediaType: string;
  storedMediaType: string;
  width: number;
  height: number;
  originalBytes: number;
  storedBytes: number;
};

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.floor(mb)} MB` : `${Math.floor(bytes / 1024)} KB`;
}

const FORMAT_TO_MEDIA_TYPE: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** What differs between an uploaded screenshot and an uploaded logo. */
export type ImageLimits = {
  maxSourceBytes: number;
  maxPixels: number;
  /** Names the thing in an error message, so a respondent reads about a screenshot. */
  noun?: string;
};

export function processScreenshot(source: Buffer): Promise<ProcessedImage> {
  return processImage(source, {
    maxSourceBytes: LIMITS.attachmentMaxSourceBytes,
    maxPixels: LIMITS.attachmentMaxPixels,
    noun: 'screenshot',
  });
}

/**
 * The one image pipeline. A logo and a screenshot differ only in their limits, so
 * they share every check: format by content, animation by container, decoded size,
 * and re-encoding to WebP.
 */
export async function processImage(
  source: Buffer,
  limits: ImageLimits,
): Promise<ProcessedImage> {
  const noun = limits.noun ?? 'image';

  if (source.length === 0) {
    throw apiError('upload_failed', 'The uploaded file is empty.');
  }
  if (source.length > limits.maxSourceBytes) {
    throw apiError(
      'file_too_large',
      `A ${noun} may be at most ${formatMegabytes(limits.maxSourceBytes)}.`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(source, { failOn: 'error' }).metadata();
  } catch {
    throw apiError('unsupported_image_format', 'That file is not a readable image.');
  }

  const mediaType = metadata.format ? FORMAT_TO_MEDIA_TYPE[metadata.format] : undefined;
  if (!mediaType || !ACCEPTED_IMAGE_MEDIA_TYPES.includes(mediaType as never)) {
    throw apiError(
      'unsupported_image_format',
      `A ${noun} must be JPEG, PNG, or WebP.`,
    );
  }

  // Section 9.3 rejects animated images. The decoder's page count catches animated
  // WebP, but not an animated PNG: libvips reports an APNG as a single page and
  // silently decodes only its first frame. So the container is inspected directly
  // as well, which is the only check that covers every accepted format.
  if ((metadata.pages ?? 1) > 1 || isAnimatedContainer(source, metadata.format)) {
    throw apiError('animated_image_rejected', 'Animated images are not accepted.');
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw apiError('unsupported_image_format', 'That image has no readable dimensions.');
  }
  if (width * height > limits.maxPixels) {
    throw apiError(
      'image_too_many_pixels',
      `A ${noun} may be at most ${limits.maxPixels / 1_000_000} megapixels.`,
    );
  }

  let encoded: { data: Buffer; info: OutputInfo };
  try {
    // .rotate() applies the EXIF orientation before the tag is dropped, so a photo
    // taken sideways is stored the way the respondent saw it.
    encoded = await sharp(source, { failOn: 'error' })
      .rotate()
      .webp({ quality: STORED_IMAGE_QUALITY })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw apiError('upload_failed', `That ${noun} could not be converted for storage.`);
  }

  return {
    data: encoded.data,
    originalMediaType: mediaType,
    storedMediaType: 'image/webp',
    width: encoded.info.width,
    height: encoded.info.height,
    originalBytes: source.length,
    storedBytes: encoded.data.length,
  };
}

/**
 * Container-level animation detection, independent of the decoder.
 *
 * An animated WebP carries an `ANIM` chunk in its RIFF container; an animated PNG
 * carries an `acTL` chunk before its first `IDAT`. Both are cheap to spot and neither
 * depends on how libvips was built.
 */
export function isAnimatedContainer(source: Buffer, format: string | undefined): boolean {
  if (format === 'webp') return hasRiffChunk(source, 'ANIM');
  if (format === 'png') return hasPngChunkBeforeIdat(source, 'acTL');
  return false;
}

function hasRiffChunk(source: Buffer, fourcc: string): boolean {
  if (source.length < 16 || source.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (source.toString('ascii', 8, 12) !== 'WEBP') return false;

  let offset = 12;
  while (offset + 8 <= source.length) {
    const type = source.toString('ascii', offset, offset + 4);
    if (type === fourcc) return true;
    const length = source.readUInt32LE(offset + 4);
    if (length < 0 || length > source.length) return false;
    // RIFF chunks are padded to an even length.
    offset += 8 + length + (length % 2);
  }
  return false;
}

function hasPngChunkBeforeIdat(source: Buffer, type: string): boolean {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (source.length < 16 || !source.subarray(0, 8).equals(signature)) return false;

  let offset = 8;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const name = source.toString('ascii', offset + 4, offset + 8);
    if (name === type) return true;
    // Any animation control chunk has to precede the first image data chunk.
    if (name === 'IDAT' || name === 'IEND') return false;
    if (length < 0 || length > source.length) return false;
    offset += 12 + length;
  }
  return false;
}
