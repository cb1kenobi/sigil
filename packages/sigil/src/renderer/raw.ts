/**
 * A `raw` element whose paint is a reactive read (SIG-477).
 *
 * A `raw` paints during the frame, and the frame runs untracked -- so a signal a
 * paint reads is one nothing is listening to, and a change to it repaints
 * nothing unless something else on screen happened to change in the same frame.
 * Every `raw` that drew from state used to pair its paint with a hand-written
 * effect reading the same signals again and calling `invalidatePaint()`, which is
 * a second list of the paint's inputs kept by hand beside the paint itself.
 *
 * This is that pairing done once. The paint runs inside a `Computed`, so what it
 * read is recorded by the graph rather than restated; a `Watcher` hears when any
 * of it moves and marks the element for paint; and the owner the element was
 * built under releases both. `src/renderer/AGENTS.md` records why this is a
 * helper here rather than something every `raw` does.
 */

import { type Element, type ElementProps, raw, type RawOptions } from '../element/index.js';
import {
  Computed,
  currentComputed,
  introspectSources,
  untrack,
  Watcher,
} from '../signals/index.js';
import { onCleanup } from './owner.js';

/**
 * Builds a `raw` element that repaints whenever a signal its paint read changes.
 *
 * Takes what `raw()` takes and returns what it returns. The difference is that
 * the paint is tracked: whatever it reads through `get()` -- a `State`, a
 * `Computed`, a function that reads either -- is what the element is repainted
 * for, and what it read on its **last** paint is the whole list, so a branch
 * that stops reading something stops being repainted for it. Nothing has to be
 * named twice, and no effect is needed beside it. A read wrapped in `untrack()`
 * is not followed, which is the way to say a paint does not care.
 *
 * The listening is released with the owner the element was built under, which is
 * what a `Show` closing or a `For` row leaving already disposes. Built under no
 * owner it is never released, the rule `createEffect()` follows; built under an
 * owner that is already gone it paints untracked from the start. An element taken
 * out of the tree by hand while its owner lives is told once more, as a mark that
 * lands on an element no tree records, and then not again until something paints
 * it -- but what its last paint read keeps it as a sink until the owner goes,
 * which is what an effect beside a plain `raw` did too.
 *
 * Whatever calls the paint is not made to depend on the computed the paint ran
 * in. A caller tracking its own reads -- `renderToString()` inside an effect or a
 * `Computed` -- is handed the paint's reads instead, the signals a plain `raw`
 * would have left it reading, so it runs again when they move and the element's
 * own listening is not spent on the caller's behalf.
 *
 * A tracked paint is a derivation of what it reads, so it may not write a signal:
 * one that does throws `A Computed may not write to a signal`, which is what it
 * is. A paint that wrote what it read would repaint itself on every frame for as
 * long as the app ran. The measure is not tracked; a raw whose size follows state
 * still calls `invalidateMeasure()` from an effect.
 *
 * @param options - How it measures and how it paints, as `raw()` takes them.
 * @param props - Style props, plus `class`, `id` and `key`.
 * @returns The element.
 */
export function trackedRaw(options: RawOptions, props: ElementProps = {}): Element {
  /** What the last paint read, as the computed that read it. */
  let reads: Computed<void> | undefined;
  let released = false;

  // told *that* something the last paint read may have moved, and nothing else.
  // It fires once and stays quiet until the next paint re-arms it, so a burst of
  // writes is one mark, and a raw nothing paints any more is told at most once
  const watcher = new Watcher(() => element.invalidatePaint());

  const element = raw(
    {
      ...options,
      paint: (painter, box, self) => {
        if (released) {
          options.paint(painter, box, self);
          return;
        }
        // a computed per paint rather than one kept and forced: the paint has to
        // run on every frame that asks for it, whether or not what it read moved,
        // and a computed whose sources are clean answers from its cache. Watched
        // before it is read, so the edges it makes carry liveness; the previous
        // one let go after, so a source both read stays live throughout and its
        // `watched` callback does not fire again for a paint that read it again
        const next = new Computed<void>(() => options.paint(painter, box, self));
        const previous = reads;
        reads = next;
        watcher.watch(next);
        try {
          // untracked: read by the caller, the computed would be refreshed by the
          // caller's own settling -- a run of the old closure into the painter of
          // a paint that is over, which leaves the watcher disarmed with nothing
          // to re-arm it
          untrack(() => next.get());
        } finally {
          if (previous) {
            watcher.unwatch(previous);
            previous.dispose();
          }
          if (released) {
            // the owner went during this paint, and its cleanup let go of the
            // computed while it was still reading: what it read after that put
            // its edges back, and nothing would ever take them away again
            watcher.unwatch(next);
            next.dispose();
            reads = undefined;
          }
          if (currentComputed() !== undefined) {
            // and the caller depends on what a plain `raw` would have had it read
            for (const source of introspectSources(next)) {
              try {
                source.get();
              } catch {
                // the paint's to report, and it already has or has caught it
              }
            }
          }
        }
      },
    },
    props
  );

  onCleanup(() => {
    released = true;
    if (reads) {
      watcher.unwatch(reads);
      reads.dispose();
      reads = undefined;
    }
  });

  return element;
}
