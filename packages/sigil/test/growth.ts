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
 *   is not part of. Where it is billed in scheduler ticks -- Windows and the Linux
 *   CI runners, a few milliseconds a step -- it is too coarse to tell sixty-four
 *   from eight on the smallest shapes, so those keep the wall clock, found out by
 *   asking the clock rather than the platform.
 * - **A span rather than a floor** (SIG-640). The small side is read, over and
 *   over, until it fills {@link SPAN} of the clock, and the large side as often as
 *   makes the same work, so what is compared is the cost of one read of each. A
 *   floor of two milliseconds on both sides stood in for a small read under about
 *   0.75 ms, and a large one that grew by up to twice the allowed ratio passed.
 * - **Best of seven, the sides taking turns**, so that a collection or a busy
 *   core costs one sample of one side rather than every sample of it.
 */

/** Milliseconds this thread has spent running, in the units the CPU clock keeps. */
const cpu = (): number => {
  const { system, user } = process.threadCpuUsage();
  return (system + user) / 1000;
};

/**
 * The average step the CPU clock takes, in milliseconds, found by spinning on it
 * until it has moved fifty times or forty milliseconds have gone, and dividing what
 * it advanced by how often it moved. A clock that never moved has no step to speak
 * of. Asked of the clock rather than of the platform (SIG-649):
 * `process.threadCpuUsage()` is microseconds on macOS and bills in scheduler ticks
 * on the Linux CI runners, which is four milliseconds a step, so that a small read
 * of 256 repeats came back as nothing at all -- `the clock read nothing over 256
 * reads` on three Ubuntu jobs of one run -- and a span of three milliseconds is less
 * than one step of it. Windows is the same story in a coarser tick, which is why it
 * used to be named here; asking covers it and whatever comes after it.
 *
 * An average and not the smallest step, because a clock that also moves a little
 * between its ticks -- a context switch bills the thread the moment it happens --
 * has one short step, and reading that as the clock's grain would pick a clock that
 * reads zero over most spans. What the average says is how far the clock gets in
 * the time it takes to move, which is what a span has to be more than.
 */
function cpuStep(): number {
  const first = cpu();
  let last = first;
  let moves = 0;
  for (const end = performance.now() + 40; moves < 50 && performance.now() < end;) {
    const at = cpu();
    if (at !== last) {
      last = at;
      moves++;
    }
  }
  return moves === 0 ? Infinity : (last - first) / moves;
}

/**
 * The finest step a clock may take and still be read over a span: a tenth of a
 * millisecond, ten times under the smallest span asked for here.
 */
const FINEST = 0.1;

/**
 * Milliseconds this thread has spent running where the platform can say it finely
 * enough, or on the wall clock where it cannot. The wall clock is what SIG-627
 * replaced, and it is what a tick clock has to go back to: a best of seven over
 * a span is still better than a step of four milliseconds, and the load that
 * moves it is the thing the CPU clock was for.
 */
export const now: () => number =
  typeof process.threadCpuUsage === 'function' && cpuStep() <= FINEST
    ? cpu
    : () => performance.now();

/**
 * The shortest span a measurement is taken over, in milliseconds. A read of one
 * short line is a few hundredths of one, which is under what a clock can tell
 * from none. A cap on the count keeps a clock that reads zero from asking for
 * ever.
 */
export const SPAN = 3;
export const MOST_READS = 4096;

/**
 * What one measurement is, whichever way it reads: how many reads of the small
 * side fill the span and how many of the large side make the same work. One
 * definition, so that {@link growthOf} and {@link growthOfAsync} cannot come to
 * disagree about either (SIG-657).
 */
const largeReadsFor = (smallReads: number, factor: number): number =>
  Math.max(1, Math.round(smallReads / factor));

/** The ratio of the two best reads, or the error that says the clock read nothing. */
function ratioOf(bestSmall: number, bestLarge: number, reads: number, label: string): number {
  if (!(bestSmall > 0)) {
    throw new Error(`${label}: the clock read nothing over ${reads} reads`);
  }
  return bestLarge / bestSmall;
}

/**
 * How much more `large` costs `read` than `small` does, where `large` is `factor`
 * times the size: linear is `factor` and quadratic its square. `label` names the
 * shape if the clock reads nothing, which is said aloud because a ratio of zero
 * would pass for ever. `span` is how much of the clock the small side is read to
 * fill: the shapes whose small read is already a millisecond of it can ask for
 * less, and the work grows with it on both sides, seven times over.
 *
 * What is read is whatever the two sides are -- a text, a count, a prepared
 * fixture -- and the function only hands it back.
 */
export function growthOf<Input = string>(
  read: (input: Input) => unknown,
  small: Input,
  large: Input,
  factor: number,
  label = '',
  span: number = SPAN
): number {
  const time = (input: Input, reads: number): number => {
    const start = now();
    for (let at = 0; at < reads; at++) {
      read(input);
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
  const largeReads = largeReadsFor(smallReads, factor);
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let run = 0; run < 7; run++) {
    bestSmall = Math.min(bestSmall, time(small, smallReads) / smallReads);
    bestLarge = Math.min(bestLarge, time(large, largeReads) / largeReads);
  }
  return ratioOf(bestSmall, bestLarge, smallReads, label);
}

/**
 * {@link growthOf} for a read that is asynchronous, which a prompt opening is
 * (SIG-657): `choice-window.test.ts` timed a `groupMultiselect()` call with
 * `performance.now()`, a floor of two milliseconds on each side and a best of
 * five -- the shape SIG-640 took out of the highlighter. Each read is awaited, so
 * what is timed is the whole of it, the work after its first `await` as well as
 * before, and a read that has to clean up after itself does so inside the read.
 *
 * It is the same measurement with the same clock, span and best of seven, taking
 * turns. What differs is what a wait is: on the CPU clock a read that is parked
 * on a timer or a stream costs nothing while it waits, which is the point of that
 * clock, but on the wall clock -- Windows and the Linux CI runners -- every
 * `setImmediate` a read yields to is time on **both** sides. A read should
 * therefore yield as little as it can, and a ratio of two sizes that each wait
 * the same is pulled towards one, which can hide growth and cannot invent it.
 */
export async function growthOfAsync<Input = string>(
  read: (input: Input) => unknown,
  small: Input,
  large: Input,
  factor: number,
  label = '',
  span: number = SPAN
): Promise<number> {
  const time = async (input: Input, reads: number): Promise<number> => {
    const start = now();
    for (let at = 0; at < reads; at++) {
      await read(input);
    }
    return now() - start;
  };
  let smallReads = 1;
  while ((await time(small, smallReads)) < span && smallReads < MOST_READS) {
    smallReads *= 2;
  }
  const largeReads = largeReadsFor(smallReads, factor);
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let run = 0; run < 7; run++) {
    bestSmall = Math.min(bestSmall, (await time(small, smallReads)) / smallReads);
    bestLarge = Math.min(bestLarge, (await time(large, largeReads)) / largeReads);
  }
  return ratioOf(bestSmall, bestLarge, smallReads, label);
}
