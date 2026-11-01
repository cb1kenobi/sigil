/**
 * The spinner frame sets, one after another, and the ASCII fallback.
 *
 *   node demos/components/38-spinners.js
 *   node demos/components/38-spinners.js | cat     <- one line per set, no frames
 *
 * Seven sets ship in `@ttylabs/sigil/components`, each with its own interval:
 * `DOTS` (the default), `LINE`, `ARC`, `CIRCLE`, `GROW`, `ARROW` and
 * `BOUNCING_BAR`. Every frame of a set is the same width and every set that is
 * not ASCII is one cell, so the label never moves -- which is why there is no
 * moon: an emoji is two columns on one terminal and one on the next.
 *
 * `LINE` is also what a spinner draws by default where `unicodeSupported()` says
 * the terminal cannot be trusted with braille -- a Linux console, `TERM=dumb`,
 * an older Windows console. `ascii: true` asks for it outright, which is the
 * last spinner here.
 *
 * The long tail -- more dots, a star, a triangle, sand -- is not in the package
 * at all. `sigil add spinner-frames` copies it into the app as data.
 */
import {
  ARC,
  ARROW,
  BOUNCING_BAR,
  CIRCLE,
  createSpinner,
  DOTS,
  GROW,
  LINE,
  mountLevel,
  unicodeSupported,
} from '@ttylabs/sigil/components';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// long enough to see a set go round where it animates, and no wait at all where
// nothing does: piped, a spinner draws no frames, so there is nothing to watch
const pause = mountLevel() === 'live' ? 1200 : 0;

const sets = [
  ['DOTS', DOTS],
  ['LINE', LINE],
  ['ARC', ARC],
  ['CIRCLE', CIRCLE],
  ['GROW', GROW],
  ['ARROW', ARROW],
  ['BOUNCING_BAR', BOUNCING_BAR],
];

for (const [name, frames] of sets) {
  const spin = createSpinner({ frames, text: `${name}, every ${frames.interval}ms` }).start();
  await sleep(pause);
  spin.succeed(name);
}

const spin = createSpinner({ ascii: true, text: 'ascii: true' }).start();
await sleep(pause);
spin.succeed(
  `ascii: true, and this terminal ${unicodeSupported() ? 'can' : 'cannot'} draw braille`
);
