import { ansi } from '@ttylabs/sigil/ansi';
import { image, imageView } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
/**
 * An image: a photograph fitted to its box and drawn in half blocks.
 *
 *   node demos/components/55-image.js
 *   FORCE_COLOR=2 node demos/components/55-image.js   <- the same picture at 256 colours
 *   FORCE_COLOR=1 node demos/components/55-image.js   <- and at the basic sixteen
 *   node demos/components/55-image.js | cat           <- piped: no colour, so no picture
 *
 * A cell is one character over one background, and an upper half block spends
 * that on two pixels: the foreground is the top one and the background the
 * bottom. So a row of cells is two rows of picture, and a cell about twice as
 * tall as it is wide makes each pixel about square -- which is why a 240-pixel
 * photograph asks for 240 columns and 161 rows rather than 321.
 *
 * `images/macaw.png` is a public-domain photograph by Adrian Pingstone, from
 * Wikimedia Commons, scaled to 240x321. It goes in as the bytes of the file:
 * `imageView()` decodes a PNG with `@ttylabs/sigil/png`, and takes the RGBA of
 * any other decoder as it stands.
 *
 * It reads no keys, so there is nothing here that needs a terminal on both sides.
 * Piped there is no colour, and a picture with its colour taken away is not a
 * picture: each one prints as nothing, and only the captions are left.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const photo = readFileSync(join(import.meta.dirname, 'images', 'macaw.png'));

// the whole photograph at forty columns: the height follows from its proportions,
// and each half of every cell is the box-filtered average of the six by six or so
// source pixels under it
console.log('  the photograph, 40 columns wide');
console.log(image(photo, { width: 40 }));

// one box, three ways of filling it with a picture that is not its shape
console.log('\n  contain, cover and fill, each in 24 x 8');
const fits = ['contain', 'cover', 'fill'].map((fit) =>
  box(
    { 'flex-direction': 'column', 'margin-right': 2, width: 24 },
    text(fit, { 'text-align': 'center' }),
    imageView(photo, { fit, height: 8, width: 24 }).element
  )
);
// a tree drawn as a string is resolved at the depth it is asked for, and the
// picture inside it is drawn at that depth too
const level = ansi.level;
console.log(
  renderToString(box({ 'flex-direction': 'row' }, ...fits), { colorLevel: level, width: 80 })
);

// raw RGBA, the way in for any format that is not a PNG: a disc whose edge fades
// out, generated here. Over a coloured box its soft edge is mixed with the box --
// alpha is composed against whatever is already in the cell -- and over the
// terminal's own background, which nothing here knows the colour of, a pixel
// more than half there is drawn and one less is left out
const size = 32;
const disc = new Uint8Array(size * size * 4);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
    const at = (y * size + x) * 4;
    disc.set([250, 200, 40, Math.round(255 * Math.min(1, Math.max(0, (1 - d) * 3)))], at);
  }
}
const sun = { data: disc, height: size, width: size };

console.log('\n  raw RGBA with a soft edge: over a blue box, over a red one, and over nothing');
const panes = ['#1d3b8a', '#7a1f2b', undefined].map((background) =>
  box(
    { 'margin-right': 2, padding: 1, ...(background ? { 'background-color': background } : {}) },
    imageView(sun, { width: 16 }).element
  )
);
console.log(
  renderToString(box({ 'flex-direction': 'row' }, ...panes), { colorLevel: level, width: 80 })
);

console.log(
  `\n  drawn at colour level ${level}${level === 0 ? ', which draws no picture at all' : ''}`
);
