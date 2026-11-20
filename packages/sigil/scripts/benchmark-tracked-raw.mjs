/**
 * What a tracked paint and a tracked measure cost a frame, over a tree of many
 * `raw` elements.
 *
 *   pnpm build && node packages/sigil/scripts/benchmark-tracked-raw.mjs
 *   pnpm build && node packages/sigil/scripts/benchmark-tracked-raw.mjs 2000
 *   pnpm build && node packages/sigil/scripts/benchmark-tracked-raw.mjs 500 static
 *
 * Run by hand and committed for the reason `benchmark-paint-cull.mjs` gives: a
 * figure in a pull request is a claim, and a script is a way to check it. It
 * imports `dist/`, because what ships is what should be measured.
 *
 * Three trees of the same shape, each a column of N one-row `raw` elements whose
 * paint reads one signal and writes it into the row, and whose measure reads the
 * same signal for its width (SIG-486) -- or, given `static`, reads nothing, which
 * is what the treemap's measure is:
 *
 * - `raw`     -- `raw()`, which is what every `raw` in the library is and what a
 *                frame costs today. A tracked paint or measure changes nothing
 *                about it.
 * - `effect`  -- `raw()` beside an effect that reads the same signal and calls
 *                `invalidatePaint()`, and `invalidateMeasure()` when the measure
 *                reads it, the hand-written pairing `trackedRaw()` replaces. Its
 *                paint and layout cost what `raw`'s do; what it adds is the
 *                effect, which runs on a write rather than on a frame.
 * - `tracked` -- `trackedRaw()`: a `Computed` built per paint and per measure,
 *                watched, read, and the one it replaces let go.
 *
 * Three figures for each. `paint` is the paint walk alone, which is the frame's
 * hot path and the cost a tracked paint adds to every frame that paints. `layout`
 * is `arrange()` alone, which asks every raw's measure and is what a tracked
 * measure adds to every frame that lays out. `write` is
 * one signal written, the scope flushed, the marks the tree recorded taken, and
 * the next paint -- what a change costs short of the renderer's own frame (style,
 * layout, the diff to the terminal), which is the same for all three and is
 * measured elsewhere. For `effect` the flush is where the mark is made; for
 * `tracked` it is the watcher, during the write. A tracked measure's watcher is
 * armed again only by the next measure, and a round writes each of its first
 * `ITERATIONS` rows once after the `layout` pass has measured them, which is why
 * the count is at least that many.
 *
 * Interleaved rather than batched, for the reason `src/layout/AGENTS.md` records:
 * batches minutes apart disagree with each other.
 */
import { CellBuffer, Painter, StyleTable } from '../dist/canvas.mjs';
import { arrange, box, createTree, paint, raw, resolveStyles } from '../dist/element.mjs';
import { createEffect, createRoot, trackedRaw } from '../dist/renderer.mjs';
import { createEffects, State } from '../dist/signals.mjs';

const COUNT = Number(process.argv[2] ?? 500);
/** Whether the measure reads nothing, rather than the row's signal. */
const STATIC = process.argv[3] === 'static';
const WIDTH = 40;
const ROUNDS = 7;
const ITERATIONS = 40;

if (!(COUNT >= ITERATIONS)) {
  throw new Error(`Expected at least ${ITERATIONS} raws, so that a round writes each row once`);
}

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
        // the declared width is what the row is laid out at either way, so what
        // the measure answers changes no picture and the three still agree
        measure: STATIC
          ? () => ({ height: 1, width: WIDTH })
          : () => ({ height: 1, width: Math.min(WIDTH, word.get().length) }),
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
            if (!STATIC) {
              element.invalidateMeasure();
            }
          });
        }
        rows.push(element);
      }
    }
    return done;
  }, effects.effect);
  const root = box({ 'flex-direction': 'column' }, ...rows);
  // in a tree, so that `invalidatePaint()` records a mark as it does on screen
  // rather than returning early on an element nothing holds
  const tree = createTree(root);
  resolveStyles(root);
  arrange(root, { height: COUNT, width: WIDTH });
  return { dispose, effects, root, tree, words };
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
  console.log(
    `${COUNT} raw elements, ${WIDTH}x${COUNT}, node ${process.version}, ` +
      `measure ${STATIC ? 'reads nothing' : 'reads the signal'}`
  );

  /** @type {Record<string, { layout: number[], paint: number[], write: number[] }>} */
  const times = {
    effect: { layout: [], paint: [], write: [] },
    raw: { layout: [], paint: [], write: [] },
    tracked: { layout: [], paint: [], write: [] },
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
        arrange(tree.root, { height: COUNT, width: WIDTH });
      }
      times[side].layout.push(Number(process.hrtime.bigint() - t) / 1e6 / ITERATIONS);

      tree.tree.take();
      t = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i++) {
        tree.words[i % COUNT].set(`row ${round}:${i}`);
        tree.effects.flush();
        // a plain `raw` marks nothing, which is the defect; the other two mark one,
        // and one for layout as well when the measure read the signal
        const marks = tree.tree.take();
        if (marks.paint.size !== (side === 'raw' ? 0 : 1)) {
          throw new Error(`${side}: a write marked the wrong number of raws for paint`);
        }
        if (marks.layout.size !== (side === 'raw' || STATIC ? 0 : 1)) {
          throw new Error(`${side}: a write marked the wrong number of raws for layout`);
        }
        paintOnce(tree.root);
      }
      times[side].write.push(Number(process.hrtime.bigint() - t) / 1e6 / ITERATIONS);
    }
  }

  /** @param {number[]} xs */
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const side of /** @type {const} */ (['raw', 'effect', 'tracked'])) {
    const paintMs = median(times[side].paint);
    const layoutMs = median(times[side].layout);
    const writeMs = median(times[side].write);
    console.log(
      `${side.padEnd(7)}  paint ${paintMs.toFixed(3)}ms (${((paintMs * 1000) / COUNT).toFixed(2)}us a raw)` +
        `  layout ${layoutMs.toFixed(3)}ms (${((layoutMs * 1000) / COUNT).toFixed(2)}us a raw)` +
        `  write+paint ${writeMs.toFixed(3)}ms`
    );
  }
  const ratio = median(times.tracked.paint) / median(times.raw.paint);
  console.log(`tracked paint / raw paint: ${ratio.toFixed(2)}x median`);
  const layoutRatio = median(times.tracked.layout) / median(times.raw.layout);
  console.log(`tracked layout / raw layout: ${layoutRatio.toFixed(2)}x median`);
}

for (const tree of Object.values(trees)) {
  tree.dispose();
}
