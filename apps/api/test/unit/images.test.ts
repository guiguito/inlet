import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { LIMITS, STORED_IMAGE_MIN_WIDTH } from '@inlet/shared';
import { processImage, processScreenshot } from '../../src/lib/images.js';
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
    expect(big.length).toBeGreaterThan(LIMITS.imageMaxSourceBytes);
    expect(await codeFor(big)).toBe('file_too_large');
  });

  it('accepts a large upload and re-encodes it inside the stored budget', async () => {
    const source = await fixtures.overStoredBudget();
    // The point of the fixture: allowed in, too big to keep as it is.
    expect(source.length).toBeGreaterThan(LIMITS.imageMaxStoredBytes);
    expect(source.length).toBeLessThan(LIMITS.imageMaxSourceBytes);

    const result = await processScreenshot(source);
    expect(result.storedMediaType).toBe('image/webp');
    expect(result.storedBytes).toBeLessThanOrEqual(LIMITS.imageMaxStoredBytes);
    expect(result.storedBytes).toBe(result.data.length);
    // Quality alone could not do it, so it was narrowed, and the reported dimensions
    // are the stored ones rather than the source's.
    expect(result.width).toBeLessThan(3000);
    expect(result.width).toBeGreaterThanOrEqual(STORED_IMAGE_MIN_WIDTH);
    const stored = await sharp(result.data).metadata();
    expect(stored.width).toBe(result.width);
    expect(stored.height).toBe(result.height);
  });

  it('leaves an image that already fits at full size and full quality', async () => {
    const source = await fixtures.png(1200, 800);
    const result = await processScreenshot(source);
    expect(result.storedBytes).toBeLessThanOrEqual(LIMITS.imageMaxStoredBytes);
    // Untouched dimensions: nothing is downscaled that does not need to be.
    expect(result.width).toBe(1200);
    expect(result.height).toBe(800);
  });

  it('spends quality before pixels', async () => {
    const source = await fixtures.overStoredBudget();
    // A budget this image clears at the floor quality alone, so it must not be resized.
    const generous = await processImage(source, {
      maxSourceBytes: LIMITS.imageMaxSourceBytes,
      maxPixels: LIMITS.attachmentMaxPixels,
      maxStoredBytes: 3 * 1024 * 1024,
      noun: 'screenshot',
    });
    expect(generous.storedBytes).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(generous.width).toBe(3000);
  });

  it('stops narrowing at the floor width rather than looping forever', async () => {
    const source = await fixtures.overStoredBudget();
    // A budget no re-encode of this image can meet.
    const impossible = await processImage(source, {
      maxSourceBytes: LIMITS.imageMaxSourceBytes,
      maxPixels: LIMITS.attachmentMaxPixels,
      maxStoredBytes: 1024,
      noun: 'screenshot',
    });
    // It comes back at the floor rather than failing an upload already accepted.
    expect(impossible.width).toBe(STORED_IMAGE_MIN_WIDTH);
    expect(impossible.storedBytes).toBeGreaterThan(0);
  });

  it('drops the source metadata, so EXIF does not survive (section 12.2)', async () => {
    const withExif = await fixtures.jpeg(200, 100);
    const result = await processScreenshot(withExif);
    // WebP output from a fresh encode carries no EXIF or XMP chunk.
    expect(result.data.includes(Buffer.from('Exif'))).toBe(false);
  });
});

/** FR-140: a hosted form's logo goes through the same pipeline, with tighter limits. */
describe('processImage for a logo', () => {
  const LOGO = {
    maxSourceBytes: LIMITS.imageMaxSourceBytes,
    maxPixels: 4_000_000,
    maxStoredBytes: LIMITS.imageMaxStoredBytes,
    noun: 'logo',
  };

  it('keeps transparency, which a logo on a dark form depends on', async () => {
    const transparent = await sharp({
      create: {
        width: 120,
        height: 40,
        channels: 4,
        background: { r: 250, g: 204, b: 20, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const result = await processImage(transparent, LOGO);
    const metadata = await sharp(result.data).metadata();
    expect(result.storedMediaType).toBe('image/webp');
    expect(metadata.hasAlpha).toBe(true);
  });

  it('applies the logo ceilings rather than the screenshot ceilings', async () => {
    // Comfortably under the screenshot limits, over the logo's.
    const wide = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: '#C2410C' },
    })
      .png()
      .toBuffer();

    await expect(processImage(wide, LOGO)).rejects.toMatchObject({
      code: 'image_too_many_pixels',
    });
    // The same image is an acceptable screenshot.
    await expect(processScreenshot(wide)).resolves.toMatchObject({
      storedMediaType: 'image/webp',
    });
  });

  it('names the logo in its messages, so an operator is not told about screenshots', async () => {
    const oversize = Buffer.alloc(LIMITS.imageMaxSourceBytes + 1, 1);
    await expect(processImage(oversize, LOGO)).rejects.toMatchObject({
      message: expect.stringContaining('logo'),
    });
  });
});
