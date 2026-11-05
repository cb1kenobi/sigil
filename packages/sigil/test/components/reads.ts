/**
 * Directory reads under way, for a test that has to wait for one to land.
 *
 * A file of its own with nothing imported, because a `vi.mock()` factory is what
 * imports it: the factory for `node:fs/promises` runs while the modules under test
 * are still being loaded, so it can reach nothing but a module that loads nothing
 * -- `helpers.ts` pulls in half the package. `settleOutput()` reads the count from
 * here, so the mock and the wait share one counter without either knowing the
 * other's file.
 */

/** How many reads have started and not yet answered. */
export const reading = { count: 0 };

/**
 * `readdir`, counted while it is out.
 *
 * Counted only once past `gate`, which is how a test holds a read on purpose: a
 * held read is one the test is deliberately not waiting for, so it must not keep
 * `settleOutput()` waiting either.
 *
 * @param readdir - The real `readdir`.
 * @param gate - What to wait for before reading, if anything.
 * @returns A `readdir` that keeps {@link reading} up to date.
 */
export function counted<F extends (...args: never[]) => Promise<unknown>>(
  readdir: F,
  gate: () => unknown = () => undefined
): F {
  return (async (...args: Parameters<F>) => {
    await gate();
    reading.count++;
    try {
      return await readdir(...args);
    } finally {
      reading.count--;
    }
  }) as F;
}
