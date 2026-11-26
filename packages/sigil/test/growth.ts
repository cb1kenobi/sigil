/**
 * How much more a read of a large text costs than a read of a small one, which is
 * what a linear-time check asks and a deadline cannot (SIG-429): coverage and a
 * slow runner scale both sides of a ratio alike, and no deadline separates two
 * ranges that overlap. One definition, for every parser and lexer whose tests
 * read a pathological input at two sizes (SIG-649): `highlight.test.ts` and
 * `markdown-malformed.test.ts` each had their own, and the one that had not been
 * through SIG-627 and SIG-640 timed out on a macOS runner.
 *
 * Four things make it stable, each one a failure measured on a loaded machine.
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
 * - **More samples where the ratio is over what the caller will accept**
 *   (SIG-681), for the clock that cannot be fixed. On the wall clock a stall costs
 *   a sample its whole wait, and the two sides are not always exposed to it alike.
 *   A sample is the same work on both sides, except where a small read fills the
 *   span in fewer reads than the factor and the large side's count is rounded up
 *   to one: then a sample of the large side is a whole read of eight times the
 *   text, several milliseconds, cut by the scheduler's slice on a runner with more
 *   work than cores, against a small one of a few tenths that fits between two
 *   preemptions. `](` repeated is that case, with one read on each side. A best of
 *   seven does not help when all seven of the large side are cut, and `](`
 *   repeated read 25.07 against 24 on an Ubuntu job whose file took 11.9 s where
 *   it takes 0.7 s idle. But a stall only ever adds: noise puts time into a sample
 *   and takes none out, so the best of more samples is nearer what a read costs
 *   and never further from it. A caller that says which ratio it will take, as
 *   `limit`, therefore has the sampling go on past seven runs while the best is not
 *   under it, for {@link EXTRA_MS}. A read that really grows does not come down by
 *   being read more -- its best is its cost -- so a quadratic is still sixty-four
 *   and spends the whole budget saying so, where a linear one on a quiet machine
 *   is under the limit at seven and spends nothing.
 * - **A count sized warm, and grown again by a batch that reads nothing**
 *   (SIG-727). The count was decided once, by the first batch, which is the code's
 *   first run and so a cold one: on a Linux job one cold read of a fast shape
 *   filled the span, the count stayed at one, and a warm read of it was under what
 *   the clock can tell from none -- `the clock read nothing over 1 reads`, from
 *   the harness and not the parser. The read is made once, unmeasured, before the
 *   count is sized; and a measured batch that still reads nothing doubles the count
 *   and starts the samples again, because a best that holds a zero is zero for
 *   every run after it. A clock that never moves still ends at {@link MOST_READS}
 *   and says so.
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

/** How many times each side is read, taking turns, the best of which is kept. */
const RUNS = 7;

/**
 * How long, in milliseconds of wall clock from the first run, the sampling may go
 * on past {@link RUNS} while the ratio is not under the caller's `limit`
 * (SIG-681). It is spent only by a ratio that is over: on a quiet machine a linear
 * read is under its limit after seven runs and nothing more is read, and a
 * quadratic spends it before the test fails. Counted from the first run and not
 * from the seventh, so that a read slow enough to have used it up in seven runs
 * is not read an eighth time on top of a failure already on its way to a timeout.
 */
export const EXTRA_MS = 2000;

/**
 * Whether more samples have nothing to add: the ratio of the two best reads is
 * under `limit`, or the clock read nothing for the small side, which no sample is
 * going to change and which {@link ratioOf} says aloud.
 */
const settled = (bestSmall: number, bestLarge: number, limit: number): boolean =>
  !(bestSmall > 0) || bestLarge < limit * bestSmall;

/**
 * What one measurement is, whichever way it reads: how many reads of the small
 * side fill the span and how many of the large side make the same work. One
 * definition, so that {@link growthOf} and {@link growthOfAsync} cannot come to
 * disagree about either (SIG-657).
 */
const largeReadsFor = (smallReads: number, factor: number): number =>
  Math.max(1, Math.round(smallReads / factor));

/**
 * Whether a measured batch of the small side read nothing and the count can still
 * grow (SIG-727), in which case it is doubled and what was sampled is thrown away:
 * the best of a side is a minimum, and a zero in it is every later run's answer. One
 * definition for both forms, like {@link largeReadsFor}.
 */
const regrow = (elapsed: number, smallReads: number): boolean =>
  !(elapsed > 0) && smallReads < MOST_READS;

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
 * less, and the work grows with it on both sides, seven times over. `limit` is the
 * ratio the caller will accept, and it is what the sampling is for: while the
 * ratio is not under it the sides go on being read, up to {@link EXTRA_MS} past
 * the seven runs, because a ratio over it may be a stall and only more samples can
 * say (SIG-681). Without one, seven runs are all there are.
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
  span: number = SPAN,
  limit: number = Infinity
): number {
  const time = (input: Input, reads: number): number => {
    const start = now();
    for (let at = 0; at < reads; at++) {
      read(input);
    }
    return now() - start;
  };
  // The first read is the code's cold one, and a count sized by it is a count for
  // a cost the later reads do not have (SIG-727), so it is made and not timed.
  read(small);
  let smallReads = 1;
  while (time(small, smallReads) < span && smallReads < MOST_READS) {
    smallReads *= 2;
  }
  let largeReads = largeReadsFor(smallReads, factor);
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  // the budget is counted from the first run, so that a read whose seven runs
  // already took longer than it has no extra ones
  const until = performance.now() + EXTRA_MS;
  for (let run = 1; ; run++) {
    const elapsed = time(small, smallReads);
    if (regrow(elapsed, smallReads)) {
      smallReads *= 2;
      largeReads = largeReadsFor(smallReads, factor);
      bestSmall = Infinity;
      bestLarge = Infinity;
      run = 0;
      continue;
    }
    bestSmall = Math.min(bestSmall, elapsed / smallReads);
    bestLarge = Math.min(bestLarge, time(large, largeReads) / largeReads);
    if (run >= RUNS) {
      if (settled(bestSmall, bestLarge, limit)) {
        break;
      }
      if (performance.now() >= until) {
        break;
      }
    }
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
  span: number = SPAN,
  limit: number = Infinity
): Promise<number> {
  const time = async (input: Input, reads: number): Promise<number> => {
    const start = now();
    for (let at = 0; at < reads; at++) {
      await read(input);
    }
    return now() - start;
  };
  // made and not timed, for the reason {@link growthOf} gives (SIG-727)
  await read(small);
  let smallReads = 1;
  while ((await time(small, smallReads)) < span && smallReads < MOST_READS) {
    smallReads *= 2;
  }
  let largeReads = largeReadsFor(smallReads, factor);
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  // the budget is counted from the first run, so that a read whose seven runs
  // already took longer than it has no extra ones
  const until = performance.now() + EXTRA_MS;
  for (let run = 1; ; run++) {
    const elapsed = await time(small, smallReads);
    if (regrow(elapsed, smallReads)) {
      smallReads *= 2;
      largeReads = largeReadsFor(smallReads, factor);
      bestSmall = Infinity;
      bestLarge = Infinity;
      run = 0;
      continue;
    }
    bestSmall = Math.min(bestSmall, elapsed / smallReads);
    bestLarge = Math.min(bestLarge, (await time(large, largeReads)) / largeReads);
    if (run >= RUNS) {
      if (settled(bestSmall, bestLarge, limit)) {
        break;
      }
      if (performance.now() >= until) {
        break;
      }
    }
  }
  return ratioOf(bestSmall, bestLarge, smallReads, label);
}
