/**
 * Telling an element its focus changed: one queue, drained once the move is done.
 *
 * `setState()` commits the `focus` state and hands the element here, and a
 * handler is told **after** the change it is about has been committed in full --
 * both ends of a move and the router's `current` -- rather than between the two
 * writes. Told in between, a handler that moved the focus itself saw a router
 * half way through a move and finished it twice: two elements were left with
 * `:focus`, and a blur handler putting the focus back was a no-op, because the
 * router still named the element it was putting it back on.
 *
 * So the router commits under `holdFocusChanges()` and the queue is drained when
 * the outermost hold lets go. A handler that moves the focus again does not nest:
 * its move commits at once and its own announcements join the end of the queue
 * this drain is already walking. Each element is told the state it has **when its
 * turn comes**, and nothing if that is what it was last told, so an element a
 * later move has already taken the focus back from is not told it has it -- the
 * last word every handler hears is the state its element ends in.
 *
 * It imports nothing but types, for the reason `hit.ts` does: the input router
 * imports it.
 */

import type { Element } from './index.js';

/**
 * How many handler calls one drain will make before it gives up.
 *
 * A handler may move the focus, so a drain can announce more than the move that
 * started it. Two handlers that each move it to the other would otherwise spin
 * forever -- where telling them inline overflowed the stack, which was at least
 * an error with a trace. `MAX_PASSES` in `src/signals/effect.ts` is the same bound
 * for the same reason.
 */
const MAX_TELLS = 100;

/** Elements waiting to be told, in the order their states changed. */
const queue: Element[] = [];

/** What each element's handler was last told, absent meaning `false`. */
const told = new WeakMap<Element, boolean>();

/** Holds open right now; the queue drains when the outermost one closes. */
let holds = 0;

/** Whether a drain is walking the queue, so a nested one joins it instead. */
let draining = false;

/**
 * Says an element's `focus` state changed, telling it now or once the move is
 * committed.
 *
 * @param element - The element whose state flipped.
 */
export function announceFocus(element: Element): void {
  // queued twice is harmless: the second turn finds it already told
  queue.push(element);
  if (holds === 0 && !draining) {
    raise(drain());
  }
}

/**
 * Runs a focus move with every announcement held until it has committed.
 *
 * The router's `focus()` writes both states and `current` in here, so no handler
 * can see one written without the other. A throw from `fn` does not stop the
 * handlers being told about what it did commit.
 *
 * @param fn - The commit.
 */
export function holdFocusChanges(fn: () => void): void {
  const errors: unknown[] = [];
  holds++;
  // caught rather than left to unwind, or a throwing commit -- an `onScroll` the
  // scroll into view woke -- would leave `holds` up and every later handler
  // untold, and would skip telling these
  try {
    fn();
  } catch (err) {
    errors.push(err);
  }
  holds--;
  if (holds === 0 && !draining) {
    errors.push(...drain());
  }
  raise(errors);
}

/**
 * Tells every queued element its state, until nothing is left to tell.
 *
 * A handler that throws does not stop the rest being told, for the reason a graph
 * walk in `src/signals/graph.ts` finishes before it raises: a handler skipped
 * because an earlier one threw is a control left drawing a focus it does not
 * have, with nothing left that will ever ask it again.
 *
 * @returns What the handlers threw, in the order they threw it.
 */
function drain(): unknown[] {
  const errors: unknown[] = [];
  let tells = 0;
  draining = true;
  while (queue.length > 0) {
    const element = queue.shift() as Element;
    const focused = element.states.includes('focus');
    if (focused === (told.get(element) ?? false)) {
      continue;
    }
    if (tells === MAX_TELLS) {
      queue.length = 0;
      errors.push(
        new Error(
          `Focus did not settle after ${MAX_TELLS} onFocusChange calls, which usually means two handlers keep moving it to each other`
        )
      );
      break;
    }
    tells++;
    // recorded whether or not the handler returns: the state is committed either
    // way, and telling it again on the next move would be a second announcement
    // of a change it already heard about
    told.set(element, focused);
    // and caught, which is also what keeps `draining` from latching on a throw
    try {
      element.onFocusChange?.(element, focused);
    } catch (err) {
      errors.push(err);
    }
  }
  draining = false;
  return errors;
}

/**
 * Rethrows what a drain collected: one error as itself, more as an aggregate.
 *
 * @param errors - What was caught.
 */
function raise(errors: unknown[]): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Errors in onFocusChange');
  }
}
