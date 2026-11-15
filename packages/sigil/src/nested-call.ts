import { saveLocale } from './i18n/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which `main()` calls are in flight, so that a call can tell it is nested and
 * the outer app's locale can be put back when it returns (SIG-395).
 *
 * **Nested means another `main()` is in flight**, whatever async context the
 * call was made from. The first version asked whether an `AsyncLocalStorage`
 * store was inherited, which is a different question and was wrong both ways: a
 * `main()` called from an event listener on a handle created before the outer
 * call -- a `process.stdin` listener, a timer made outside `main()` -- inherits
 * nothing and was taken for a top-level run while the outer app was still
 * running, and one called from a timer the outer `run()` scheduled, after the
 * outer call had returned, inherited a store that no longer named anything and
 * was taken for nested.
 *
 * The store is kept for the one thing a list cannot say for certain: **which**
 * call is the parent. A call that inherited a live one is its child, so three
 * levels unwind one at a time. Where the store names nothing live -- no store, or
 * the call it names has returned -- the parent is the **innermost** call in
 * flight, the one most recently started and still running: a level entered from
 * a listener with no context is most likely a part of what is running now, and
 * attaching it to the outermost call instead took the middle level's locale
 * away.
 *
 * The snapshot is held on the **parent** and counted: the first child to start
 * takes it and the last to finish puts it back. Two children running together
 * would otherwise each snapshot what the other had left, and whichever finished
 * last would restore a state that was never the outer app's.
 *
 * A call counts out of its parent only once it has returned **and** every call it
 * started has too, so a subtree settles together, from the leaves up -- see
 * `settle()`.
 *
 * The price is that overlapping **top-level** calls are read as nested -- a later
 * one is a child of the innermost one running -- and the later one's locale is
 * rolled back when it returns. They share one catalog slot already, so each was
 * overwriting the other. A top-level call with nothing else in flight is
 * unchanged and leaves its locale in effect. A `main()` that never settles keeps
 * every later call nested for the rest of the process.
 */
interface Call {
  /** How many of this call's children are in flight. */
  children: number;
  /** Whether the call has not yet returned. */
  live: boolean;
  /** The call this one was started from, which is who it is counted against. */
  parent?: Call;
  /** The locale state before the first of the children in flight. */
  restore?: () => void;
}

const calls = new AsyncLocalStorage<Call>();

/** The calls in flight, in the order they started. */
const inFlight: Call[] = [];

/**
 * Runs one `main()` call, and puts the parent's locale back when it returns.
 *
 * On every way out -- a return, a handled error, a rethrow -- and whatever the
 * call did to the locale, its own `setLocale()` included, and whatever the
 * parent did to it meanwhile: the restore is unconditional, because the call
 * owns the locale for as long as it runs. This is not `rewindQuiet()`'s rule,
 * which declines where somebody wrote since: a quiet statement is about the
 * process and outlives the run that made it, a locale is the app's.
 *
 * @param body - The call.
 * @returns What the call resolved with.
 */
export function inCall<T>(body: () => Promise<T>): Promise<T> {
  const call: Call = { children: 0, live: true };
  const inherited = calls.getStore();
  const parent = inherited?.live ? inherited : inFlight.at(-1);

  call.parent = parent;

  if (parent && parent.children++ === 0) {
    parent.restore = saveLocale();
  }

  inFlight.push(call);

  // `async` so that a body that threw before returning a promise would still
  // reach the `finally` below, rather than leaving the call in the list for good
  return calls
    .run(call, async () => body())
    .finally(() => {
      call.live = false;
      inFlight.splice(inFlight.indexOf(call), 1);
      settle(call);
    });
}

/**
 * Lets a call go from its parent's count, once it has returned **and** every
 * call it started has too.
 *
 * A call that started another and did not await it returns first, and the other
 * is still using the locale it left: counting the first out then puts the
 * parent's snapshot back under a call that is still running, and the one that
 * ends last puts its own parent's snapshot back over the whole of it. So a
 * subtree settles together, from the leaves up, and the parent's snapshot goes
 * back only when the last of it has gone.
 *
 * @param call - A call that has just returned or just lost its last child.
 */
function settle(call: Call): void {
  if (call.live || call.children > 0) {
    return;
  }

  const parent = call.parent;

  if (parent && --parent.children === 0) {
    parent.restore?.();
    parent.restore = undefined;
    settle(parent);
  }
}
