/**
 * How much more a read of a large text costs than a read of a small one, which is
 * what a linear-time check asks and a deadline cannot (SIG-429): coverage and a
 * slow runner scale both sides of a ratio alike, and no deadline separates two
 * ranges that overlap. One definition, for every parser and lexer whose tests
 * read a pathological input at two sizes (SIG-649): `highlight.test.ts` and
 * `markdown-malformed.test.ts` each had their own, and the one that had not been
 * through SIG-627 and SIG-640 timed out on a macOS runner.
 *
 * Three things make it stable, each one a failure measured on a loaded machine.
 *
 * - **CPU time rather than wall time** where the platform can say it (SIG-627). A
 *   wall-clock best of seven survives a stall that lands on some of the runs and
 *   not a machine that is oversubscribed for the whole test: a macOS runner read
 *   a linear diff at 39.3 against a bound of 24, and a laptop at a load average
 *   of 140 failed a different shape in five of eight runs of one file, each of
 *   them linear. Being descheduled costs a measurement its wait however long it
 *   was, and the small side is a tenth of a millisecond, which fits between two
 *   preemptions where a large one does not, so load inflates the larger read
 *   alone. `process.threadCpuUsage()` is this thread's time on a CPU, which a wait
 *   is not part of. Windows reports it from the scheduler's tick, which is a few
 *   milliseconds, too coarse to tell sixty-four from eight on the smallest
 *   shapes, so it keeps the wall clock there.
 * - **A span rather than a floor** (SIG-640). The small side is read, over and
 *   over, until it fills {@link SPAN} of the clock, and the large side as often as
 *   makes the same work, so what is compared is the cost of one read of each. A
 *   floor of two milliseconds on both sides stood in for a small read under about
 *   0.75 ms, and a large one that grew by up to twice the allowed ratio passed.
 * - **Best of seven, the sides taking turns**, so that a collection or a busy
 *   core costs one sample of one side rather than every sample of it.
 */

/** Milliseconds this thread has spent running, or on the wall clock where that is too coarse to read. */
export const now: () => number =
  process.platform === 'win32' || typeof process.threadCpuUsage !== 'function'
    ? () => performance.now()
    : () => {
        const { system, user } = process.threadCpuUsage();
        return (system + user) / 1000;
      };

/**
 * The shortest span a measurement is taken over, in milliseconds. A read of one
 * short line is a few hundredths of one, which is under what a clock can tell
 * from none. A cap on the count keeps a clock that reads zero from asking for
 * ever.
 */
export const SPAN = 3;
export const MOST_READS = 4096;

/**
 * How much more `large` costs `read` than `small` does, where `large` is `factor`
 * times the size: linear is `factor` and quadratic its square. `label` names the
 * shape if the clock reads nothing, which is said aloud because a ratio of zero
 * would pass for ever. `span` is how much of the clock the small side is read to
 * fill: the shapes whose small read is already a millisecond of it can ask for
 * less, and the work grows with it on both sides, seven times over.
 */
export function growthOf(
  read: (text: string) => unknown,
  small: string,
  large: string,
  factor: number,
  label = '',
  span: number = SPAN
): number {
  const time = (text: string, reads: number): number => {
    const start = now();
    for (let at = 0; at < reads; at++) {
      read(text);
    }
    return now() - start;
  };
  // The small read is repeated until it fills the span the first time it is
  // asked, while the code is cold, which is a little more than it will fill once
  // warm: the count is a way to a measurable span rather than a span itself.
  let smallReads = 1;
  while (time(small, smallReads) < span && smallReads < MOST_READS) {
    smallReads *= 2;
  }
  const largeReads = Math.max(1, Math.round(smallReads / factor));
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let run = 0; run < 7; run++) {
    bestSmall = Math.min(bestSmall, time(small, smallReads) / smallReads);
    bestLarge = Math.min(bestLarge, time(large, largeReads) / largeReads);
  }
  if (!(bestSmall > 0)) {
    throw new Error(`${label}: the clock read nothing over ${smallReads} reads`);
  }
  return bestLarge / bestSmall;
}
