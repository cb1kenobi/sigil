/**
 * How far ahead of this clock a cache's stamp may be and still be fresh.
 *
 * A minute: enough for the ordinary jitter of a clock that NTP nudged back
 * between the run that wrote the cache and the one reading it, and far too
 * little for a clock that was simply wrong, which is the case a future stamp
 * has to be stale for.
 */
export const CLOCK_TOLERANCE = 60_000;

/**
 * Whether a cache stamped `ts` is still fresh at `now`.
 *
 * Fresh is a finite number, no more than {@link CLOCK_TOLERANCE} ahead of `now`
 * and no more than `maxAge` behind it. Asking only "too old" is what this
 * replaced, twice: a cache written while the clock was ahead -- a bad RTC, a
 * VM resumed from a snapshot, a cache directory restored from another machine
 * -- stayed fresh until real time caught up with it, which can be a year. And a
 * stamp that is not a number is stale, asked by type rather than left to the
 * arithmetic: a string of digits holding the current time is concatenated
 * rather than added to, and compares as a number twenty-odd digits long.
 *
 * One definition for every stamped cache sigil keeps -- the update check's and
 * `sigil package`'s runtime listings -- so the two cannot come to disagree
 * about what a stamp in the future means.
 *
 * @param ts - The stamp read back out of the cache, whatever it turned out to
 *   be.
 * @param maxAge - The oldest acceptable age in milliseconds.
 * @param now - The time to judge it at.
 * @returns `true` when the cache may be answered from without asking again.
 */
export function isFreshStamp(ts: unknown, maxAge: number, now: number = Date.now()): boolean {
  return (
    typeof ts === 'number' &&
    Number.isFinite(ts) &&
    ts <= now + CLOCK_TOLERANCE &&
    ts + maxAge >= now
  );
}
