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
 * So the router moves the focus through `moveFocus()`, and the queue is drained
 * when the outermost move lets go. A handler that moves the focus again does not
 * nest: its move commits at once and its own announcements join the end of the
 * queue this drain is already walking. Each element is told the state it has
 * **when its turn comes**, and nothing if that is what it was last told, so an
 * element a later move has already taken the focus back from is not told it has
 * it -- in a drain that settles, the last word every handler hears is the state
 * its element ends in.
 *
 * While a move is committing or being announced, the router is the only writer of
 * the `focus` state: a `setState('focus')` from anywhere else -- a handler, an
 * `onScroll` the scroll into view woke -- throws, naming `focus()`. Taken, that
 * write turned `:focus` on for an element the router's `current` did not name, and
 * its handler painted the role on a second control. Outside a move a direct write
 * is still allowed and still tells its element at once, which is all an element
 * with no router has.
 *
 * The queue is one per process, not one per router, because an element does not
 * know which router owns it -- the signals layer's batch is global for the same
 * reason. So a `focus()` on one router made from inside another's handler commits
 * at once and returns before its own handlers run: they are told when the
 * outermost move in the process lets go, and what they throw is raised from that
 * outermost call.
 *
 * It imports nothing but types, for the reason `hit.ts` does: the input router
 * imports it.
 */

import type { Element } from './index.js';

/**
 * How many times one drain will tell one element before it gives up.
 *
 * A handler may move the focus, so a drain can announce more than the move that
 * started it. Counted per element rather than in total, because a chain that only
 * moves on -- each control passing the focus to the next -- tells each element
 * twice however long it is, while handlers that keep moving the focus round a
 * cycle tell the same element again and again, which is the case this exists for:
 * where telling them inline overflowed the stack, a queue would spin for ever.
 * `MAX_PASSES` in `src/signals/effect.ts` is the same bound for the same reason.
 */
const MAX_TELLS = 100;

/** Elements waiting to be told, in the order their states changed. */
const queue: Element[] = [];

/**
 * What each element's handler was last told: absent is `false`, and `null` is not
 * known -- an element a drain gave up on, or whose state could not be read, is
 * told at its next change whichever way that goes.
 */
const told = new WeakMap<Element, boolean | null>();

/** Moves open right now; the queue drains when the outermost one closes. */
let holds = 0;

/** Whether a drain is walking the queue, so a nested one joins it instead. */
let draining = false;

/** Whether `moveFocus()` itself is writing the two states, the one allowed writer. */
let moving = false;

/**
 * Refuses a write of the `focus` state from anywhere but the router while a move is
 * committing or being announced. Called by `setState()` before it commits.
 */
export function checkFocusWrite(): void {
  if ((holds > 0 || draining) && !moving) {
    throw new Error(
      "Cannot setState('focus') while the focus is moving or being announced; move it with the input router's focus.focus() instead"
    );
  }
}

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
 * Moves the focus, with every announcement held until the move has committed.
 *
 * The router's `focus()` comes through here: the two states are written by this
 * function, which is what lets `checkFocusWrite()` tell the router's writes from
 * anybody else's, and `then` commits the rest -- `current`, and the scroll into
 * view. No handler can see one written without the others. A throw from `then`
 * does not stop the handlers being told about what did commit.
 *
 * @param from - The element losing the focus.
 * @param to - The element gaining it.
 * @param then - The rest of the commit.
 */
export function moveFocus(
  from: Element | undefined,
  to: Element | undefined,
  then: () => void
): void {
  const errors: unknown[] = [];
  holds++;
  // caught rather than left to unwind, or a throwing commit -- an `onScroll` the
  // scroll into view woke -- would leave `holds` up and every later handler
  // untold, and would skip telling these
  try {
    moving = true;
    try {
      from?.setState('focus', false);
      to?.setState('focus', true);
    } finally {
      moving = false;
    }
    then();
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
 * @returns What was thrown, in the order it was thrown.
 */
function drain(): unknown[] {
  const errors: unknown[] = [];
  const tells = new Map<Element, number>();
  draining = true;
  // released in a `finally`, because a latched drain is silent rather than loud:
  // every later focus change in the process would commit and tell nobody
  try {
    while (queue.length > 0) {
      const element = queue.shift() as Element;
      let focused: boolean;
      try {
        focused = element.states.includes('focus');
      } catch (err) {
        // what it was last told is no longer known to be right
        told.set(element, null);
        errors.push(err);
        continue;
      }
      if (told.has(element) ? focused === told.get(element) : !focused) {
        continue;
      }
      const count = tells.get(element) ?? 0;
      if (count === MAX_TELLS) {
        // given up on, so what this element and every one still queued were last
        // told is not their state -- forgotten, so each is told at its next change
        // rather than skipped as though it had heard it
        told.set(element, null);
        for (const waiting of queue) {
          told.set(waiting, null);
        }
        queue.length = 0;
        errors.push(
          new Error(
            `Focus did not settle: one element was told ${MAX_TELLS} times in one move, which usually means onFocusChange handlers keep moving the focus round a cycle`
          )
        );
        break;
      }
      tells.set(element, count + 1);
      // recorded whether or not the handler returns: the state is committed either
      // way, and telling it again on the next move would be a second announcement
      // of a change it already heard about
      told.set(element, focused);
      try {
        element.onFocusChange?.(element, focused);
      } catch (err) {
        errors.push(err);
      }
    }
  } finally {
    draining = false;
  }
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
