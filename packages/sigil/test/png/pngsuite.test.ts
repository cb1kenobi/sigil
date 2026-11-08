import { decodePng, encodePng } from '../../src/png/index.js';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PngSuite, Willem van Schaik's test set: every colour type at every bit depth,
 * interlaced and not, each filter, odd sizes, ancillary chunks, and a set of
 * deliberately broken files whose names start with `x`.
 *
 * The valid ones are compared against `reference.json`, which is what
 * ImageMagick decodes them to (`scripts/generate-png-reference.mjs`), so the
 * decoder is checked against somebody else's reading of the format rather than
 * against its own encoder.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const suite = join(fixtures, 'pngsuite');
const reference: Record<string, { width: number; height: number; sha256: string }> = JSON.parse(
  readFileSync(join(fixtures, 'reference.json'), 'utf8')
);

const names = readdirSync(suite)
  .filter((name) => name.endsWith('.png'))
  .sort();
const valid = names.filter((name) => !name.startsWith('x'));
const malformed = names.filter((name) => name.startsWith('x'));

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('PngSuite', () => {
  it('should be the whole suite, so that a missing file is not a passing test', () => {
    // 2017-07-19 release: 162 valid images and 14 malformed ones
    expect(valid).toHaveLength(162);
    expect(malformed).toHaveLength(14);
    expect(Object.keys(reference).sort()).toEqual(valid);
  });

  it.each(valid)('should decode %s to the pixels ImageMagick reads', (name) => {
    const image = decodePng(readFileSync(join(suite, name)));
    const expected = reference[name];

    expect(image.width).toBe(expected.width);
    expect(image.height).toBe(expected.height);
    expect(image.data).toBeInstanceOf(Uint8Array);
    expect(image.data.length).toBe(image.width * image.height * 4);
    expect(sha256(image.data)).toBe(expected.sha256);
  });

  it.each(valid)('should round-trip %s through the encoder unchanged', (name) => {
    const image = decodePng(readFileSync(join(suite, name)));
    const again = decodePng(encodePng(image));

    expect(again.width).toBe(image.width);
    expect(again.height).toBe(image.height);
    expect(sha256(again.data)).toBe(sha256(image.data));
  });

  it.each(malformed)('should refuse %s with a readable Error', (name) => {
    const bytes = readFileSync(join(suite, name));
    let error: unknown;
    try {
      decodePng(bytes);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/PNG/);
    // a message a person can read: printable, one line, and saying something
    expect((error as Error).message).toMatch(/^[\x20-\x7e]{20,200}$/);
  });
});
