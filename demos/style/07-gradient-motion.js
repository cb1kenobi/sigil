/**
 * A gradient that moves: text whose colours flow, and two borders that cycle.
 *
 *   node demos/style/07-gradient-motion.js          <- ctrl+c stops it early
 *   node demos/style/07-gradient-motion.js | cat     <- one still frame
 *   SIGIL_REDUCED_MOTION=1 node demos/style/07-gradient-motion.js
 *
 * There is no animated gradient in the library, and there does not need to be
 * one. `gradient()` spaces its stops evenly, so handing it exactly one stop per
 * column puts every column on a stop of its own -- which makes the stop list a
 * picture of the line. Sliding a window along a looped ramp by one cell per tick
 * is then the whole animation, and `06-gradient.js`'s colour model (Oklab mix,
 * the cascade's degradation) still does all of the colour work.
 *
 * The three pieces:
 *
 * - a banner whose colours flow left to right through `gradient()`;
 * - `gradientBox()` with the same window, which moves the top and bottom edges
 *   only, since that helper ramps by column and holds each side edge to one
 *   colour;
 * - a border that runs **round** the box, painted here from `gradientColors()`.
 *   The library leaves the perimeter ramp out because a still one has a seam
 *   where the end meets the start. A looped ramp has no end, so in motion the
 *   seam is not there.
 *
 * Motion is `resolveOutput()`'s call. A pipe, a CI log and
 * `SIGIL_REDUCED_MOTION=1` all get one still frame. On a 16-colour terminal a
 * gradient is a single colour, so nothing visibly moves there, which is by
 * design (see `06-gradient.js`).
 */
import { gradient, gradientBox, gradientColors, resolveOutput } from '@ttylabs/sigil/style';
import { createLiveRegion } from '@ttylabs/sigil/terminal';

const stops = ['#ff5f6d', '#ffc371', '#47e1c8', '#7c5cff'];
const banner = '  sigil  ·  command line apps, in colour  ';
const message = ['Deploying to production', 'step 3 of 5: uploading assets'];

/**
 * The stops as a loop of `period` colours, with no seam.
 *
 * The first stop goes on the end so the ramp comes back to where it started,
 * and that last colour is then dropped, since it is the first one again. The
 * level is 3 on purpose. These are not what gets written. They are the stops
 * handed back to `gradient()`, which degrades to the real depth itself and wants
 * 24-bit stops at every level. Asking for the detected level here would hand it
 * palette colours on a 16-colour terminal and get a refusal back.
 */
const loop = (period) =>
  gradientColors([...stops, stops[0]], period + 1, { level: 3 }).slice(0, period);

/** `count` consecutive colours of a loop, starting `offset` cells in. */
const run = (cycle, offset, count) =>
  Array.from(
    { length: count },
    (_, i) => cycle[(((i + offset) % cycle.length) + cycle.length) % cycle.length]
  );

// ---- the banner and the column-ramped box ----------------------------------

const bannerCycle = loop(banner.length * 2);

// gradientBox() is as wide as its widest line, plus a padding of 1 a side and
// the two border columns
const boxWidth = Math.max(...message.map((line) => line.length)) + 4;
const boxCycle = loop(boxWidth * 2);

// ---- the perimeter box, painted by hand ------------------------------------

const ringText = ['A border that runs round the box,', 'from one looped ramp.'];
// a column of space each side of the text, as gradientBox() pads by default
const ringInner = Math.max(...ringText.map((line) => line.length)) + 2;
const ringWidth = ringInner + 2;
// every border cell, clockwise from the top-left corner: the top edge, the right
// edge down, the bottom edge back, the left edge up
const perimeter = 2 * ringWidth + 2 * ringText.length;
const ringCycle = loop(perimeter);

/**
 * A box whose border is coloured by how far round it each cell is.
 *
 * Each glyph is coloured with a one-stop `gradient()`, which the helper
 * documents as a solid colour. That keeps this file off the SGR encoding and on
 * the same degradation as everything else.
 */
function ringBox(offset) {
  const at = (k) => ringCycle[(((k - offset) % perimeter) + perimeter) % perimeter];
  const paint = (glyph, k) => gradient(glyph, [at(k)]);

  let top = '';
  for (let x = 0; x < ringWidth; x++) {
    top += paint(x === 0 ? '╭' : x === ringWidth - 1 ? '╮' : '─', x);
  }

  // the bottom edge runs right to left, so its cell k counts from the far corner
  const bottomStart = ringWidth + ringText.length;
  let bottom = '';
  for (let x = 0; x < ringWidth; x++) {
    const glyph = x === 0 ? '╰' : x === ringWidth - 1 ? '╯' : '─';
    bottom += paint(glyph, bottomStart + (ringWidth - 1 - x));
  }

  const rows = [];
  for (let y = 0; y < ringText.length; y++) {
    const text = ringText[y].padEnd(ringInner - 2);
    const right = paint('│', ringWidth + y);
    const left = paint('│', perimeter - 1 - y);
    rows.push(`${left} ${text} ${right}`);
  }

  return [top, ...rows, bottom].join('\n');
}

// ---- one frame --------------------------------------------------------------

function frame(tick) {
  return [
    gradient(banner, run(bannerCycle, -tick, banner.length)),
    '',
    gradientBox(message.join('\n'), run(boxCycle, -tick, boxWidth), { border: 'round' }),
    '',
    ringBox(tick),
  ].join('\n');
}

const output = resolveOutput({ live: process.stdout.isTTY === true });

if (output !== 'live') {
  // no frames to repaint, so one is drawn and left. A pipe is colour level 0,
  // so that frame is the plain text. `FORCE_COLOR=3` puts the colour back
  console.log(frame(0));
} else {
  const region = createLiveRegion();
  const seconds = 10;
  const fps = 30;
  let tick = 0;

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      region.render(frame(tick++));
      if (tick >= seconds * fps) {
        clearInterval(timer);
        resolve();
      }
    }, 1000 / fps);
  });

  region.done();
}
