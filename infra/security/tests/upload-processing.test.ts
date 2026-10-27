import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../../../backend/package.json', import.meta.url))('sharp');
import { prepareImage, MAX_BYTES, MAX_PIXELS, objectKeyFor } from '../../../backend/src/lib/imageProcessing.js';

const image = (width = 24, height = 12) => sharp({ create: { width, height, channels: 3, background: '#a87' } });
describe('actual image byte validation; synthetic fixtures only', () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    it(`accepts real ${format} and normalizes to private JPEG plus public blurred WebP`, async () => {
      const result = await prepareImage(await image().toFormat(format).toBuffer());
      expect('code' in result).toBe(false);
      if ('code' in result) return;
      expect((await sharp(result.original.body).metadata()).format).toBe('jpeg');
      expect((await sharp(result.blurred.body).metadata()).format).toBe('webp');
      expect(result.original.width).toBe(24); expect(result.original.height).toBe(12);
      expect(result.blurred.width).toBe(480); expect(result.blurred.height).toBe(480);
    });
  }
  it('rejects HTML or text disguised as an image', async () => {
    for (const body of ['synthetic text named fake.jpg', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>', '<script>synthetic</script>']) {
      const result = await prepareImage(Buffer.from(body));
      expect(result).toMatchObject({ status: 415, code: 'UNSUPPORTED_IMAGE_TYPE' });
    }
  });
  it('rejects real GIF bytes', async () => {
    expect(await prepareImage(await image().gif().toBuffer())).toMatchObject({ status: 415 });
  });
  it('rejects empty files', async () => expect(await prepareImage(Buffer.alloc(0))).toMatchObject({ status: 400 }));
  it('rejects more than 10 MiB before attempting image decode', async () => {
    expect(await prepareImage(Buffer.alloc(MAX_BYTES + 1))).toMatchObject({ status: 413, code: 'IMAGE_TOO_LARGE' });
  });
  it('rejects highly compressed image over 20 million pixels even below byte limit', async () => {
    const input = await image(5000, 4001).png().toBuffer();
    expect(input.length).toBeLessThan(MAX_BYTES); expect(5000 * 4001).toBeGreaterThan(MAX_PIXELS);
    expect(await prepareImage(input)).toMatchObject({ status: 413, code: 'IMAGE_TOO_LARGE' });
  });
  it('strips EXIF and embedded metadata from both stored variants while applying orientation', async () => {
    const input = await image(24, 12).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect((await sharp(input).metadata()).exif?.length).toBeGreaterThan(0);
    const result = await prepareImage(input);
    expect('code' in result).toBe(false); if ('code' in result) return;
    expect(result.original.width).toBe(12); expect(result.original.height).toBe(24);
    for (const output of [result.original.body, result.blurred.body]) {
      const metadata = await sharp(output).metadata();
      for (const field of ['exif', 'xmp', 'iptc', 'icc'] as const) expect(metadata[field]).toBeUndefined();
    }
  });
  it('rejects truncated image payload', async () => {
    const input = await image().jpeg().toBuffer();
    expect(await prepareImage(input.subarray(0, Math.floor(input.length / 2)))).toMatchObject({ status: 415 });
  });
  it('generates distinct private and public namespaces with unpredictable keys', () => {
    const first = objectKeyFor('original', 42n, 'jpg'), second = objectKeyFor('original', 42n, 'jpg');
    expect(first).toMatch(/^originals\/42\/[a-f0-9-]+\.jpg$/); expect(first).not.toBe(second);
    expect(objectKeyFor('blurred', 42n, 'webp')).toMatch(/^profiles\/blur\/42\/[a-f0-9-]+\.webp$/);
  });
});
