/**
 * A `raw` element whose paint and measure are reactive reads (SIG-477, SIG-486).
 *
 * A `raw` paints and measures during the frame, and the frame runs untracked --
 * so a signal either one reads is one nothing is listening to, and a change to it
 * repaints or relays out nothing unless something else on screen happened to
 * change in the same frame. Every `raw` that drew from state used to pair its
 * paint with a hand-written effect reading the same signals again and calling
 * `invalidatePaint()`, and every one whose size followed state did the same with
 * `invalidateMeasure()` -- a second list of the inputs, kept by hand beside the
 * function that already reads them.
 *
 * This is that pairing done once, for both. Each paint and each measure runs
 * inside a `Computed`, so what it read is recorded by the graph rather than
 * restated; a `Watcher` per kind hears when any of it moves and marks the element
 * for paint or for layout; and the owner the element was built under releases
 * all of it. `src/renderer/AGENTS.md` records why this is a helper here rather
 * than something every `raw` does.
 */

import { type Element, type ElementProps, raw, type RawOptions } from '../element/index.js';
import type { Measurement } from '../layout/index.js';
import {
  Computed,
  currentComputed,
  hasSources,
  introspectSources,
  untrack,
  Watcher,
} from '../signals/index.js';
import { raise } from '../signals/raise.js';
import { onCleanup } from './owner.js';

/**
 * Builds a `raw` element that repaints whenever a signal its paint read changes,
 * and is measured again whenever a signal its measure read changes.
 *
 * Takes what `raw()` takes and returns what it returns. The difference is that
 * the paint and the measure are tracked: whatever they read through `get()` -- a
 * `State`, a `Computed`, a function that reads either -- is what the element is
 * repainted or relaid out for. What the **last** paint read is the whole list for
 * paint, so a branch that stops reading something stops being repainted for it.
 * A measure is asked at more than one width in a layout, so what the last measure
 * at **each width** read is the list for layout, until any of it moves; the
 * measures after that start the list again. Nothing has to be named twice, and no
 * effect is needed beside it. A read wrapped in `untrack()` is not followed,
 * which is the way to say a paint or a measure does not care.
 *
 * The listening is released with the owner the element was built under, which is
 * what a `Show` closing or a `For` row leaving already disposes. Built under no
 * owner it is never released, the rule `createEffect()` follows; built under an
 * owner that is already gone it paints and measures untracked from the start. An
 * element taken out of the tree by hand while its owner lives is told once more,
 * as a mark that lands on an element no tree records, and then not again until
 * something paints or measures it -- but what it last read keeps it as a sink
 * until the owner goes, which is what an effect beside a plain `raw` did too.
 *
 * Whatever calls the paint or the measure is not made to depend on the computed
 * it ran in. A caller tracking its own reads -- `renderToString()` inside an
 * effect or a `Computed` -- is handed the reads instead, the signals a plain
 * `raw` would have left it reading, so it runs again when they move and the
 * element's own listening is not spent on the caller's behalf.
 *
 * A tracked paint or measure is a derivation of what it reads, so it may not
 * write a signal: one that does throws `A Computed may not write to a signal`,
 * which is what it is. A paint that wrote what it read would repaint itself on
 * every frame for as long as the app ran, and a measure would relay out.
 *
 * @param options - How it measures and how it paints, as `raw()` takes them.
 * @param props - Style props, plus `class`, `id` and `key`.
 * @returns The element.
 */
export function trackedRaw(options: RawOptions, props: ElementProps = {}): Element {
  /** What the last paint read, as the computed that read it. */
  let reads: Computed<void> | undefined;
  /** The computed a paint is running in, which the owner's cleanup leaves to it. */
  let painting: Computed<void> | undefined;
  /**
   * What the measures read since the last time any of it moved: the last measure
   * at each width, as the computed it ran in. Only one that read something is
   * kept, so a measure that reads no signal holds nothing at all.
   */
  const measures = new Map<number, Computed<Measurement>>();
  /** Whether something a measure read has moved, so the next measure starts the list again. */
  let moved = false;
  let released = false;

  // told *that* something the last paint read may have moved, and nothing else.
  // It fires once and stays quiet until the next paint re-arms it, so a burst of
  // writes is one mark, and a raw nothing paints any more is told at most once
  const painted = new Watcher(() => element.invalidatePaint());
  // and the same for a measure, which re-arms it; a layout mark repaints too, so
  // a signal both read is one layout rather than a layout and a paint
  const measured = new Watcher(() => {
    moved = true;
    element.invalidateMeasure();
  });

  /**
   * Lets a computed go, each step on its own: an `unwatched` callback that throws
   * must not leave the next step, or the next computed, undone.
   *
   * @param watcher - What watches it.
   * @param computed - What to let go.
   * @param errors - Where a throw goes, to be raised once everything has run.
   */
  const release = <T>(watcher: Watcher, computed: Computed<T>, errors: unknown[]): void => {
    try {
      watcher.unwatch(computed);
    } catch (error) {
      errors.push(error);
    }
    try {
      computed.dispose();
    } catch (error) {
      errors.push(error);
    }
  };

  /**
   * Has a caller that tracks its reads depend on what a plain `raw` would have
   * had it read, which is what the computed read.
   *
   * @param read - The computed's sources, taken before it could be let go.
   */
  const handOver = (read: readonly { get(): unknown }[]): void => {
    for (const source of read) {
      try {
        source.get();
      } catch {
        // the paint's or the measure's to report, and it already has or has caught it
      }
    }
  };

  const element = raw(
    {
      ...options,
      measure: (width) => {
        if (released) {
          return options.measure(width);
        }
        // a computed per measure, for the reason a paint has one: the measure
        // reads plain fields and style as well as signals, so a cached answer
        // would be wrong the moment one of those changed. Watched before it is
        // read and the one it replaces let go after, as a paint's is
        const next = new Computed<Measurement>(() => options.measure(width));
        measured.watch(next);

        const errors: unknown[] = [];
        let value: Measurement | undefined;
        try {
          // untracked, for the reason the paint's is
          value = untrack(() => next.get());
        } catch (error) {
          errors.push(error);
        }

        const read = currentComputed() === undefined ? [] : introspectSources(next);
        // what this replaces: the last measure at this width, or once something a
        // measure read has moved, every one of them -- the widths a layout asks
        // for are the ones it is about to ask again, and one no longer asked is
        // let go here rather than kept as a reason to relay out
        if (moved) {
          moved = false;
          for (const previous of measures.values()) {
            release(measured, previous, errors);
          }
          measures.clear();
        } else {
          const previous = measures.get(width);
          if (previous) {
            measures.delete(width);
            release(measured, previous, errors);
          }
        }
        if (released || !hasSources(next)) {
          // read nothing, so there is nothing to hear; or the owner went during
          // this measure and left the computed to it
          release(measured, next, errors);
        } else {
          measures.set(width, next);
        }
        handOver(read);
        raise(errors, 'Errors in a tracked measure and its release');
        return value as Measurement;
      },
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
        painted.watch(next);

        const errors: unknown[] = [];
        painting = next;
        try {
          // untracked: read by the caller, the computed would be refreshed by the
          // caller's own settling -- a run of the old closure into the painter of
          // a paint that is over, which leaves the watcher disarmed with nothing
          // to re-arm it
          untrack(() => next.get());
        } catch (error) {
          errors.push(error);
        }
        painting = undefined;

        // what the paint read, for a caller that tracks its reads, taken before
        // anything below can let the computed go and empty the list
        const read = currentComputed() === undefined ? [] : introspectSources(next);
        if (previous) {
          release(painted, previous, errors);
        }
        if (released) {
          // the owner went during this paint and left the computed to it
          release(painted, next, errors);
          reads = undefined;
        }
        // and the caller depends on what a plain `raw` would have had it read
        handOver(read);
        raise(errors, 'Errors in a tracked paint and its release');
      },
    },
    props
  );

  onCleanup(() => {
    released = true;
    const errors: unknown[] = [];
    if (reads && reads !== painting) {
      release(painted, reads, errors);
      reads = undefined;
    }
    // a measure running now is not in the map until it has read, so it is left
    // to that measure as the paint's is
    for (const computed of measures.values()) {
      release(measured, computed, errors);
    }
    measures.clear();
    raise(errors, 'Errors releasing a tracked raw');
  });

  return element;
}
