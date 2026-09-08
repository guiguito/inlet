import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';

/**
 * Real image bytes for the upload tests. Generated rather than committed as binary
 * fixtures, so a test can ask for exactly the dimensions or format it needs.
 */

export async function png(width = 600, height = 400): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
}

export async function jpeg(width = 600, height = 400): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 20 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function webp(width = 600, height = 400): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 160, b: 90 } },
  })
    .webp()
    .toBuffer();
}

/** A GIF, which is both an unsupported format and animated. */
export async function animatedGif(): Promise<Buffer> {
  return sharp(
    { create: { width: 60, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } },
  )
    .gif()
    .toBuffer();
}

/**
 * A genuinely animated WebP: a supported container that must still be rejected.
 *
 * Assembled by hand from a real still frame because this libvips build will not
 * encode an animation from raw input, and a fixture that is not actually animated
 * would make the rejection test pass for the wrong reason.
 */
export async function animatedWebp(): Promise<Buffer> {
  const width = 32;
  const height = 32;
  const still = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 200, b: 90 } },
  })
    .webp({ lossless: true })
    .toBuffer();

  const bitstream = extractRiffChunk(still, ['VP8L', 'VP8 ']);
  if (!bitstream) throw new Error('no WebP bitstream in the generated still image');

  const vp8x = riffChunk(
    'VP8X',
    Buffer.concat([Buffer.from([0x02]), Buffer.alloc(3), u24(width - 1), u24(height - 1)]),
  );
  const anim = riffChunk('ANIM', Buffer.concat([Buffer.alloc(4), Buffer.from([0x00, 0x00])]));
  const frame = riffChunk(
    'ANMF',
    Buffer.concat([
      u24(0),
      u24(0),
      u24(width - 1),
      u24(height - 1),
      u24(100),
      Buffer.from([0x02]),
      riffChunk(bitstream.type, bitstream.data),
    ]),
  );

  return riffContainer([vp8x, anim, frame, frame, frame]);
}

/**
 * A genuinely animated PNG. libvips reports an APNG as a single page, so this is the
 * fixture that proves the container-level check is doing the work.
 */
export function animatedPng(): Buffer {
  const width = 8;
  const height = 8;
  const scanlines = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 200)]),
    ),
  );
  const imageData = deflateSync(scanlines);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);

  const fctl = (sequence: number): Buffer => {
    const b = Buffer.alloc(26);
    b.writeUInt32BE(sequence, 0);
    b.writeUInt32BE(width, 4);
    b.writeUInt32BE(height, 8);
    b.writeUInt16BE(10, 20);
    b.writeUInt16BE(100, 22);
    return b;
  };

  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(3, 0);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('acTL', actl),
    pngChunk('fcTL', fctl(0)),
    pngChunk('IDAT', imageData),
    pngChunk('fcTL', fctl(2)),
    pngChunk('fdAT', Buffer.concat([sequence, imageData])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function u24(value: number): Buffer {
  const b = Buffer.alloc(3);
  b.writeUIntLE(value, 0, 3);
  return b;
}

function riffChunk(fourcc: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  const parts = [header, payload];
  if (payload.length % 2) parts.push(Buffer.alloc(1));
  return Buffer.concat(parts);
}

function riffContainer(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function extractRiffChunk(
  source: Buffer,
  types: string[],
): { type: string; data: Buffer } | null {
  let offset = 12;
  while (offset + 8 <= source.length) {
    const type = source.toString('ascii', offset, offset + 4);
    const length = source.readUInt32LE(offset + 4);
    if (types.includes(type)) {
      return { type, data: source.subarray(offset + 8, offset + 8 + length) };
    }
    offset += 8 + length + (length % 2);
  }
  return null;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Exceeds the 25-megapixel decode limit while staying small on disk. */
export async function oversizedPixels(): Promise<Buffer> {
  return sharp({
    create: { width: 6000, height: 5000, channels: 3, background: { r: 1, g: 1, b: 1 } },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Larger than the 2 MB per-file limit. */
export async function oversizedBytes(): Promise<Buffer> {
  const noise = Buffer.alloc(2200 * 1100 * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) % 256;
  return sharp(noise, { raw: { width: 2200, height: 1100, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

export function notAnImage(): Buffer {
  return Buffer.from('This is a text file pretending to be a screenshot.', 'utf8');
}
