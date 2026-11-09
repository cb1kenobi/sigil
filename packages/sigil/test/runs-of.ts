import {
  type Computed,
  currentComputed,
  effect,
  flush,
  introspectSources,
  State,
} from '../src/signals/index.js';

/**
 * Runs `act` inside an effect and says how many times that effect ran.
 *
 * The effect starts doing nothing and `act` is switched on afterwards, so the
 * count is a fixed two for a call that leaves the effect alone: once to see
 * that there was nothing to do, once for the pass `act` ran in. `outside` is a
 * write from outside any effect, made after that, and the count includes any
 * pass it caused -- a method that read something on the way and left its caller
 * subscribed to it shows up as a third run here, and the effect doing its work
 * again. A call that reads what it writes, tracked, does not stop at all: the
 * scheduler reports it after 100 passes and the count is 101.
 *
 * @param act - What to call from the effect.
 * @param outside - What to do to the thing from outside, once `act` has run.
 * @returns How many times the effect ran.
 */
export function runsOf(act: () => void, outside?: () => void): number {
  const on = new State(false);
  let runs = 0;
  const stop = effect(() => {
    runs++;
    if (on.get()) {
      act();
    }
  });
  try {
    on.set(true);
    flush();
    if (outside) {
      outside();
      flush();
    }
  } finally {
    stop();
  }
  return runs;
}

/**
 * Runs `act` inside an effect and says how many signals it left that effect
 * subscribed to.
 *
 * `runsOf()`'s count is what a caller *sees*, and there is a leak it cannot see:
 * an effect left subscribed to another effect -- which is what a drain that read
 * tracked left behind -- re-validates that effect on a later write, finds it
 * returned `undefined` again, and does not re-run. It still holds the edge, and
 * its own scope's flush still runs the other scope's effect for it (SIG-321).
 * So this asks the graph, after the pass `act` ran in, and the answer is exact:
 * zero for a call that leaves its caller subscribed to nothing, the switch that
 * turns `act` on not counted.
 *
 * @param act - What to call from the effect.
 * @returns How many signals the effect was left reading, beyond its own switch.
 */
export function sourcesOf(act: () => void): number {
  const on = new State(false);
  let self: Computed<unknown> | undefined;
  const stop = effect(() => {
    if (on.get()) {
      self = currentComputed();
      act();
    }
  });
  try {
    on.set(true);
    flush();
    // a zero from an effect that never got as far as `act` would pass every
    // assertion this is written for, so that is a failure rather than an answer
    if (!self) {
      throw new Error('The effect never ran `act`');
    }
    // asked after the run has finished rather than from inside it, because the
    // sweep that drops what a run stopped reading happens on the way out
    return introspectSources(self).length - 1;
  } finally {
    stop();
  }
}
