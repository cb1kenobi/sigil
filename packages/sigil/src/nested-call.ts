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
 * The store is kept for the one thing a count cannot say: **which** call is the
 * parent. It names the parent for a call that inherited a live one, so a call
 * inside a call inside a call unwinds one level at a time. Where it names
 * nothing live -- no store, or the call it names has returned -- the parent is
 * the outermost call in flight, which is the app the process started as.
 *
 * The snapshot is held on the **parent** and counted: the first child to start
 * takes it and the last to finish puts it back. Two children running together
 * would otherwise each snapshot what the other had left, and whichever finished
 * last would restore a state that was never the outer app's.
 *
 * The price is that two **top-level** calls that overlap are read as nested --
 * the later one is a child of the earlier -- and the later one's locale is rolled
 * back when it returns. They share one catalog slot already, so each was
 * overwriting the other, and an outer app that is still running is the one whose
 * locale is worth keeping. A top-level call with nothing else in flight is
 * unchanged and leaves its locale in effect.
 */
interface Call {
  /** How many of this call's children are in flight. */
  children: number;
  /** Whether the call has not yet returned. */
  live: boolean;
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
  const parent = inherited?.live ? inherited : inFlight[0];

  if (parent && parent.children++ === 0) {
    parent.restore = saveLocale();
  }

  inFlight.push(call);

  return calls.run(call, body).finally(() => {
    call.live = false;
    inFlight.splice(inFlight.indexOf(call), 1);

    if (parent && --parent.children === 0) {
      parent.restore?.();
      parent.restore = undefined;
    }
  });
}
