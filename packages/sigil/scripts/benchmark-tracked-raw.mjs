/**
 * What a tracked paint costs a frame, over a tree of many `raw` elements.
 *
 *   pnpm build && node packages/sigil/scripts/benchmark-tracked-raw.mjs
 *   pnpm build && node packages/sigil/scripts/benchmark-tracked-raw.mjs 2000
 *
 * Run by hand and committed for the reason `benchmark-paint-cull.mjs` gives: a
 * figure in a pull request is a claim, and a script is a way to check it. It
 * imports `dist/`, because what ships is what should be measured.
 *
 * Three trees of the same shape, each a column of N one-row `raw` elements whose
 * paint reads one signal and writes it into the row:
 *
 * - `raw`     -- `raw()`, which is what every `raw` in the library is and what a
 *                frame costs today. A tracked paint changes nothing about it.
 * - `effect`  -- `raw()` beside an effect that reads the same signal and calls
 *                `invalidatePaint()`, the hand-written pairing `trackedRaw()`
 *                replaces. Its paint costs what `raw` does; what it adds is the
 *                effect, which runs on a write rather than on a frame.
 * - `tracked` -- `trackedRaw()`: a `Computed` built per paint, watched, read,
 *                and the previous one let go.
 *
 * Two figures for each. `paint` is the paint walk alone, which is the frame's hot
 * path and the cost a tracked paint adds to every frame that paints. `write` is
 * one signal written and the next paint, which is the whole round trip a change
 * costs -- for `effect` that includes the scope's flush.
 *
 * Interleaved rather than batched, for the reason `src/layout/AGENTS.md` records:
 * batches minutes apart disagree with each other.
 */
import { CellBuffer, Painter, StyleTable } from '../dist/canvas.mjs';
import { arrange, box, paint, raw, resolveStyles } from '../dist/element.mjs';
import { createEffect, createRoot, trackedRaw } from '../dist/renderer.mjs';
import { createEffects, State } from '../dist/signals.mjs';

const COUNT = Number(process.argv[2] ?? 500);
const WIDTH = 40;
const ROUNDS = 7;
const ITERATIONS = 40;

/**
 * One tree of `COUNT` raws, built under an owner of its own.
 *
 * @param {'effect' | 'raw' | 'tracked'} side
 */
function build(side) {
  const effects = createEffects();
  // flushed by hand, so that `write` below measures the flush rather than a microtask
  effects.setScheduler(() => {});
  const words = Array.from({ length: COUNT }, (_, i) => new State(`row ${i}`));
  /** @type {import('../dist/element.mjs').Element[]} */
  const rows = [];
  const dispose = createRoot((done) => {
    for (const word of words) {
      const options = {
        measure: () => ({ height: 1, width: WIDTH }),
        /** @type {import('../dist/element.mjs').RawPaint} */
        paint: (painter, at) => painter.text(at.x, at.y, word.get()),
      };
      const props = { height: 1, width: WIDTH };
      if (side === 'tracked') {
        rows.push(trackedRaw(options, props));
      } else {
        const element = raw(options, props);
        if (side === 'effect') {
          createEffect(() => {
            word.get();
            element.invalidatePaint();
          });
        }
        rows.push(element);
      }
    }
    return done;
  }, effects.effect);
  const root = box({ 'flex-direction': 'column' }, ...rows);
  resolveStyles(root);
  arrange(root, { height: COUNT, width: WIDTH });
  return { dispose, effects, root, words };
}

/** @param {import('../dist/element.mjs').Element} root */
function paintOnce(root) {
  const buffer = new CellBuffer(WIDTH, COUNT);
  paint(root, new Painter(buffer, new StyleTable()));
  return buffer;
}

const trees = {
  effect: build('effect'),
  raw: build('raw'),
  tracked: build('tracked'),
};

// the three paint the same cells, or the comparison is not one
const pictures = Object.values(trees).map((t) => paintOnce(t.root).toString());
if (new Set(pictures).size !== 1) {
  console.error('the three trees painted different things; not timing a wrong answer');
  process.exitCode = 1;
} else {
  console.log(`${COUNT} raw elements, ${WIDTH}x${COUNT}, node ${process.version}`);

  /** @type {Record<string, { paint: number[], write: number[] }>} */
  const times = {
    effect: { paint: [], write: [] },
    raw: { paint: [], write: [] },
    tracked: { paint: [], write: [] },
  };

  for (let round = 0; round < ROUNDS; round++) {
    for (const side of /** @type {const} */ (['raw', 'effect', 'tracked'])) {
      const tree = trees[side];

      let t = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i++) {
        paintOnce(tree.root);
      }
      times[side].paint.push(Number(process.hrtime.bigint() - t) / 1e6 / ITERATIONS);

      t = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i++) {
        tree.words[i % COUNT].set(`row ${round}:${i}`);
        tree.effects.flush();
        paintOnce(tree.root);
      }
      times[side].write.push(Number(process.hrtime.bigint() - t) / 1e6 / ITERATIONS);
    }
  }

  /** @param {number[]} xs */
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const side of /** @type {const} */ (['raw', 'effect', 'tracked'])) {
    const paintMs = median(times[side].paint);
    const writeMs = median(times[side].write);
    console.log(
      `${side.padEnd(7)}  paint ${paintMs.toFixed(3)}ms (${((paintMs * 1000) / COUNT).toFixed(2)}us a raw)` +
        `  write+paint ${writeMs.toFixed(3)}ms`
    );
  }
  const ratio = median(times.tracked.paint) / median(times.raw.paint);
  console.log(`tracked paint / raw paint: ${ratio.toFixed(2)}x median`);
}

for (const tree of Object.values(trees)) {
  tree.dispose();
}
