/**
 * The longest a timer can be asked to wait, in milliseconds: 2^31 - 1.
 *
 * `setTimeout()` holds its delay in a signed 32-bit integer, and a delay past it
 * is one the platform fires at once rather than late -- so a toast told to stay
 * a month would vanish immediately, and a countdown longer than about 24.8 days
 * has to be waited for in pieces. `showToast()` refuses a timeout past it and a
 * timer waits in pieces no longer than it, which is one fact about the platform
 * that both had written down (SIG-366). A leaf, so that neither loads the other
 * for it; it is published from `@ttylabs/sigil/components/clock`.
 */
export const MAX_TIMER_DELAY: number = 2 ** 31 - 1;
