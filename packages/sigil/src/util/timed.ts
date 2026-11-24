/**
 * Where a stream takes a throw from a timer, if it has somewhere to put one.
 *
 * A registry symbol rather than an import, because the one thing that sets it is
 * `createTestTerminal()` and the testing entry loads nothing of the router's.
 */
export const TIMER_ERROR: unique symbol = Symbol.for('@ttylabs/sigil/input/timer-error');

/**
 * Where a root owner keeps the stream its renderer reads keys from (SIG-653).
 *
 * A registry symbol for the reason `TIMER_ERROR` is: the renderer sets it and
 * `timed()` reads it, and neither may rely on the two being one module instance.
 */
const TIMER_STREAM: unique symbol = Symbol.for('@ttylabs/sigil/renderer/timer-stream');

/**
 * Lets a timer armed under `owner` find the hook of the terminal `render()` was
 * given, without that terminal being passed to it (SIG-653).
 *
 * Called by the renderer on the root owner it builds. A toast raised on a
 * renderer, or a `decryptReveal()` called inside its tree, hands `timed()` that
 * owner or one below it, and the walk up finds this.
 *
 * @param owner - The root owner.
 * @param stream - The terminal's input stream, which is where the hook lives.
 */
export function hearTimersOn(owner: object | undefined, stream: object | undefined): void {
  if (owner !== undefined && stream !== undefined) {
    Object.defineProperty(owner, TIMER_STREAM, { configurable: true, value: stream });
  }
}

/** The hook `on` leads to: its own, its renderer's stream's, or an ancestor owner's. */
function hookFor(on: object | undefined): unknown {
  for (let at = on; at !== undefined; at = (at as { parent?: object }).parent) {
    const record = at as Record<symbol, unknown>;
    const stream = record[TIMER_STREAM];
    const held =
      typeof record[TIMER_ERROR] === 'function'
        ? record[TIMER_ERROR]
        : typeof stream === 'object' && stream !== null
          ? (stream as Record<symbol, unknown>)[TIMER_ERROR]
          : undefined;
    if (typeof held === 'function') {
      return held;
    }
  }
  return undefined;
}

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
 * @param on - The stream the hook would be on, or an owner under a renderer whose
 *   terminal has one (SIG-653). `undefined` where there is none.
 * @param run - What the timer does.
 * @returns The callback to arm.
 */
export function timed(on: object | undefined, run: () => void): () => void {
  return (): void => {
    try {
      run();
    } catch (error) {
      const hook = hookFor(on);
      if (typeof hook !== 'function') {
        throw error;
      }
      hook(error);
    }
  };
}
