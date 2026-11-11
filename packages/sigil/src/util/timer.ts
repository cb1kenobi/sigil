/**
 * The longest a timer can be asked to wait, in milliseconds: 2^31 - 1.
 *
 * `setTimeout()` holds its delay in a signed 32-bit integer, and a delay past it
 * is one the platform fires at once rather than late -- so a toast told to stay
 * a month would vanish immediately, and a countdown longer than about 24.8 days
 * has to be waited for in pieces. `showToast()` refuses a timeout past it and a
 * timer waits in pieces no longer than it, which is one fact about the platform
 * that both had written down, as had the input router's sequence timeout, the
 * fake clock in `testing` and the config watcher's debounce (SIG-366). A leaf,
 * so that none of them loads another for it. It is published from
 * `@ttylabs/sigil/renderer`, whose frame loop is the package's own timer and
 * which the clock and the toast both import already -- so an ejected copy of
 * either loads nothing more for it. They import it from the renderer rather
 * than from here, so that a copy has one import of that subpath and not two.
 */
export const MAX_TIMER_DELAY: number = 2 ** 31 - 1;
