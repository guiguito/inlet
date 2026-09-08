import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { LIMITS } from '@inlet/shared';
import { processScreenshot } from '../../src/lib/images.js';
import { ApiError } from '../../src/lib/errors.js';
import * as fixtures from '../setup/images.js';

/** FR-099, section 9.3: validation by content, then re-encoding to WebP. */
async function codeFor(input: Buffer): Promise<string> {
  try {
    await processScreenshot(input);
    return 'accepted';
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
}

describe('processScreenshot', () => {
  it('re-encodes PNG, JPEG and WebP to WebP and keeps the dimensions', async () => {
    for (const make of [fixtures.png, fixtures.jpeg, fixtures.webp]) {
      const result = await processScreenshot(await make(640, 360));
      expect(result.storedMediaType).toBe('image/webp');
      expect(result.width).toBe(640);
      expect(result.height).toBe(360);
      expect(result.data.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(result.storedBytes).toBe(result.data.length);
    }
  });

  it('records the validated source media type, not the claimed one', async () => {
    expect((await processScreenshot(await fixtures.jpeg())).originalMediaType).toBe('image/jpeg');
    expect((await processScreenshot(await fixtures.png())).originalMediaType).toBe('image/png');
  });

  it('rejects a file that is not an image', async () => {
    expect(await codeFor(fixtures.notAnImage())).toBe('unsupported_image_format');
  });

  it('rejects an empty file', async () => {
    expect(await codeFor(Buffer.alloc(0))).toBe('upload_failed');
  });

  it('rejects an unsupported format such as GIF', async () => {
    expect(await codeFor(await fixtures.animatedGif())).toBe('unsupported_image_format');
  });

  it('rejects an animated WebP', async () => {
    expect(await codeFor(await fixtures.animatedWebp())).toBe('animated_image_rejected');
  });

  it('rejects an animated PNG, which the decoder reports as a single page', async () => {
    const apng = fixtures.animatedPng();
    // The gap this closes: libvips sees one page and would happily store frame one.
    expect((await sharp(apng).metadata()).pages ?? 1).toBe(1);
    expect(await codeFor(apng)).toBe('animated_image_rejected');
  });

  it('accepts a still image of the same formats', async () => {
    expect(await codeFor(await fixtures.png())).toBe('accepted');
    expect(await codeFor(await fixtures.webp())).toBe('accepted');
  });

  it('rejects an image above the decoded pixel limit', async () => {
    expect(await codeFor(await fixtures.oversizedPixels())).toBe('image_too_many_pixels');
  });

  it('rejects a source file above the per-file size limit', async () => {
    const big = await fixtures.oversizedBytes();
    expect(big.length).toBeGreaterThan(LIMITS.attachmentMaxSourceBytes);
    expect(await codeFor(big)).toBe('file_too_large');
  });

  it('drops the source metadata, so EXIF does not survive (section 12.2)', async () => {
    const withExif = await fixtures.jpeg(200, 100);
    const result = await processScreenshot(withExif);
    // WebP output from a fresh encode carries no EXIF or XMP chunk.
    expect(result.data.includes(Buffer.from('Exif'))).toBe(false);
  });
});
