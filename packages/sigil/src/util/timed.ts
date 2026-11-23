/**
 * Where a stream takes a throw from a timer, if it has somewhere to put one.
 *
 * A registry symbol rather than an import, because the one thing that sets it is
 * `createTestTerminal()` and the testing entry loads nothing of the router's.
 */
export const TIMER_ERROR: unique symbol = Symbol.for('@ttylabs/sigil/input/timer-error');

/**
 * Wraps a callback a timer will run, so a throw that nothing is awaiting has
 * somewhere to go where the stream has one (SIG-631, SIG-642).
 *
 * Where the stream has no hook the throw goes on as it always did, which is an
 * uncaught exception -- the deliberate answer for an app, and what SIG-524 has
 * `runApp()` end on. The hook is read **where the throw happens**, so a handler a
 * test registered after the timer was armed is the one asked.
 *
 * Shared by the input router and the components whose timers call a function the
 * app supplied, which is what keeps them one mechanism: `createTestTerminal()`
 * puts the hook on the stream its terminal reads, and every one of them finds it
 * there by way of `terminal.stdin`.
 *
 * @param on - The stream the hook would be on. `undefined` where there is none.
 * @param run - What the timer does.
 * @returns The callback to arm.
 */
export function timed(on: object | undefined, run: () => void): () => void {
  return (): void => {
    try {
      run();
    } catch (error) {
      const hook = on === undefined ? undefined : (on as Record<symbol, unknown>)[TIMER_ERROR];
      if (typeof hook !== 'function') {
        throw error;
      }
      hook(error);
    }
  };
}
