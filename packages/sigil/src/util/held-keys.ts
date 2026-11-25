/**
 * Where a stream keeps the questions a test may ask of the routers reading it:
 * does this one still hold a key it has not decided what to call (SIG-695).
 *
 * A registry symbol, for the reason `TIMER_ERROR` is one: `createTestTerminal()`
 * puts a `Set` here and the router adds itself to it, and the testing entry
 * imports nothing of the router's. The `Set` exists only on a test terminal, so
 * a router over a real stream finds nothing and does nothing.
 */
export const HELD_KEYS: unique symbol = Symbol.for('@ttylabs/sigil/input/held-keys');

/** What a router puts in the set: whether it holds a key it is still waiting on. */
export type HeldKeysProbe = () => boolean;
