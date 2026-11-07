#!/usr/bin/env node
/**
 * Regenerates `test/png/fixtures/reference.json`: what an independent decoder
 * makes of every valid PngSuite image, as a width, a height and a SHA-256 of
 * the 8-bit RGBA.
 *
 * The decoder's corpus test compares against this rather than against itself.
 * A round trip through our own encoder proves the two halves agree with each
 * other, and two halves written by one author can agree on the same mistake --
 * so the pixels a file *should* decode to come from somebody else's code.
 * ImageMagick is that somebody, and it is a tool on the machine of whoever runs
 * this rather than a dependency of anything: the test reads the committed JSON
 * and needs nothing installed.
 *
 *     node scripts/generate-png-reference.mjs
 *
 * Run from inside `packages/sigil`, with `magick` on `PATH`, and `pnpm fmt`
 * afterwards. The malformed `x*` files are skipped: what they decode to is an
 * error, which the test asserts directly.
 *
 * `-depth 8` reduces a 16-bit sample by rounding it to the nearest 8-bit one,
 * which is the reduction `decodePng()` makes. Gamma, chromaticity and colour
 * profiles are metadata to both: ImageMagick writes the stored samples to
 * `rgba:` without applying them, and so does the decoder.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const suite = join(root, 'test', 'png', 'fixtures', 'pngsuite');
const out = join(root, 'test', 'png', 'fixtures', 'reference.json');

const reference = {};
for (const name of readdirSync(suite).sort()) {
  if (!name.endsWith('.png') || name.startsWith('x')) {
    continue;
  }
  const file = join(suite, name);
  const [width, height] = execFileSync('magick', ['identify', '-format', '%w %h', `png:${file}`])
    .toString()
    .trim()
    .split(' ')
    .map(Number);
  const rgba = execFileSync('magick', [`png:${file}`, '-depth', '8', 'rgba:-'], {
    maxBuffer: 1 << 28,
  });
  if (rgba.length !== width * height * 4) {
    throw new Error(`${name}: ImageMagick wrote ${rgba.length} bytes for ${width}x${height}`);
  }
  reference[name] = {
    height,
    sha256: createHash('sha256').update(rgba).digest('hex'),
    width,
  };
}

writeFileSync(out, `${JSON.stringify(reference, null, 2)}\n`);
console.log(`Wrote ${Object.keys(reference).length} reference images to ${out}`);
