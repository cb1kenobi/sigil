/**
 * A frame, as an image: the same canvas written out as SVG and as PNG.
 *
 *   node demos/canvas/07-screenshot.js           <- what each format came to
 *   node demos/canvas/07-screenshot.js ./shots   <- and the files, to open
 *
 * `canvas.snapshot()` is the frame that is on screen, and it knows what its
 * styles are, so `@ttylabs/screenshot` needs nothing else to draw it. The two
 * formats share one geometry: the SVG is text the viewer sets over rectangles,
 * the PNG is the bundled JetBrains Mono rasterized -- and the box, the blocks and
 * the braille are drawn as shapes in both, so they meet whatever the font.
 *
 * The ticks are `✔`, the one sigil's own components use, and JetBrains Mono
 * does not have it. A terminal would borrow it from a system font; a screenshot
 * reads none, so that one frame is one image everywhere, and borrows it from the
 * symbol font it bundles instead -- DejaVu Sans, behind the four faces.
 *
 * The canvas here is never written to the terminal. A snapshot is of what was
 * *presented*, and `present()` is what makes a frame the presented one; where
 * its output goes is the backend's business, so a canvas built just to be
 * photographed presents and throws the bytes away.
 */
import { screenshot } from '@ttylabs/screenshot';
import { ATTR, createCanvas, palette, rgb } from '@ttylabs/sigil/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const canvas = createCanvas({ height: 9, width: 44 });

canvas.paint((p) => {
  const border = { fg: palette(6) };
  p.text(0, 0, `╭${'─'.repeat(42)}╮`, border);
  for (let y = 1; y < 8; y++) {
    p.text(0, y, '│', border);
    p.text(43, y, '│', border);
  }
  p.text(0, 8, `╰${'─'.repeat(42)}╯`, border);

  p.text(2, 1, 'sigil', { attrs: ATTR.bold, fg: palette(5) });
  p.text(8, 1, 'build', { fg: palette(8) });
  p.text(2, 3, '✔', { fg: palette(2) });
  p.text(4, 3, 'compiled 12 modules');
  p.text(2, 4, '✔', { fg: palette(2) });
  p.text(4, 4, 'type-checked', { attrs: ATTR.italic });

  // a bar of half blocks, two colours a cell, which is what `Pixels` draws with
  for (let x = 0; x < 40; x++) {
    const t = x / 39;
    p.text(2 + x, 6, '▀', {
      bg: rgb(Math.round(40 + 60 * t), 20, Math.round(120 - 60 * t)),
      fg: rgb(Math.round(255 * t), Math.round(120 + 60 * t), Math.round(255 - 200 * t)),
    });
  }
  p.text(2, 7, 'docs', {
    attrs: ATTR.underline,
    fg: palette(4),
    link: 'https://github.com/cb1kenobi/sigil',
  });
  p.text(7, 7, '⣀⣤⣶⣿⣶⣤⣀', { fg: palette(3) });
});
canvas.present();

const frame = canvas.snapshot();
// `env: {}` keeps the colours the built-in dark palette wherever this runs; a
// real screenshot would pass what `view.detect()` reported as `terminal`
const svg = screenshot(frame, { env: {}, padding: 12 });
const png = screenshot(frame, { env: {}, format: 'png', padding: 12, scale: 2 });

console.log(`svg  ${svg.length.toLocaleString('en-US')} characters`);
console.log(`png  ${png.length.toLocaleString('en-US')} bytes at 2x`);

const out = process.argv[2];
if (out === undefined) {
  console.log('pass a directory to write them: node demos/canvas/07-screenshot.js ./shots');
} else {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'screenshot.svg'), svg);
  writeFileSync(join(out, 'screenshot.png'), png);
  console.log(`wrote ${join(out, 'screenshot.svg')} and ${join(out, 'screenshot.png')}`);
}
