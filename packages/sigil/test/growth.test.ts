import { growthOf, growthOfAsync, now } from './growth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The measurement the linear-time checks share, asked what it was written for
 * (SIG-649): a read that is linear in its text comes out near the factor and one
 * that is quadratic near its square, and the clock it reads says something over the
 * smallest span asked of it.
 */
describe('growthOf()', () => {
  const text = (size: number): string => 'a'.repeat(size);
  const linear = (source: string): number => {
    let sum = 0;
    for (let at = 0; at < source.length; at++) {
      sum += source.charCodeAt(at);
    }
    return sum;
  };
  const quadratic = (source: string): number => {
    let sum = 0;
    for (let from = 0; from < source.length; from += 8) {
      for (let at = from; at < source.length; at++) {
        sum += source.charCodeAt(at);
      }
    }
    return sum;
  };

  it('should read a linear walk as the factor and not as its square', () => {
    expect(growthOf(linear, text(4096), text(32768), 8, 'linear')).toBeLessThan(24);
  });

  it('should read a quadratic walk as more than three times the factor', () => {
    // small enough that one read of the small side is well under a span, so the
    // span bounds the work: at 4096 a single small read already filled it on a
    // Windows runner, the large side was then 64 of them, and seven turns of that
    // timed out at ten seconds
    expect(growthOf(quadratic, text(512), text(4096), 8, 'quadratic')).toBeGreaterThan(24);
  });

  // the async form is the same measurement over a read that is awaited, which a
  // prompt opening is (SIG-657): it has to wait out what the read waits on and
  // still read the walk's growth, not the wait's
  describe('growthOfAsync()', () => {
    const settle = async (walk: (source: string) => number, source: string): Promise<number> => {
      await Promise.resolve();
      return walk(source);
    };

    it('should read an awaited linear walk as the factor and not as its square', async () => {
      expect(
        await growthOfAsync(
          (source) => settle(linear, source),
          text(4096),
          text(32768),
          8,
          'linear'
        )
      ).toBeLessThan(24);
    });

    it('should read an awaited quadratic walk as more than three times the factor', async () => {
      expect(
        await growthOfAsync(
          (source) => settle(quadratic, source),
          text(256),
          text(2048),
          8,
          'quadratic'
        )
      ).toBeGreaterThan(24);
    });

    it('should wait for a read that finishes after the call returns', async () => {
      // a read that returns at once and does its work later would time as
      // nothing, which is `the clock read nothing`, and not as slow
      const later = (source: string): Promise<void> =>
        new Promise((resolve) => {
          setImmediate(() => {
            quadratic(source);
            resolve();
          });
        });
      expect(await growthOfAsync(later, text(256), text(2048), 8, 'later')).toBeGreaterThan(24);
    });
  });

  it('should read a clock that moves in steps a span can be read over', () => {
    // a tick clock of four milliseconds reads nothing over a span of three, which
    // was `the clock read nothing over 256 reads` on three Linux jobs
    const start = now();
    const end = performance.now() + 20;
    while (performance.now() < end) {
      // spin
    }
    expect(now() - start).toBeGreaterThan(0);
  });

  describe('on a platform whose CPU clock bills in ticks', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    // each is a clock in microseconds, as `threadCpuUsage()` reports, that a span of
    // three milliseconds cannot be read over
    const CLOCKS: [string, (cpu: number) => number][] = [
      // four milliseconds a step, as the Linux CI runners keep it
      ['four milliseconds a step', (cpu) => Math.floor(cpu / 4000) * 4000],
      // the same, with one short step after each tick, as a clock that is also
      // billed at a context switch would read: the smallest step is 50
      // microseconds and the average is two milliseconds
      [
        'four milliseconds a step, and a short one between',
        (cpu) => Math.floor(cpu / 4000) * 4000 + (cpu % 4000 >= 50 ? 50 : 0),
      ],
    ];

    it.skipIf(typeof process.threadCpuUsage !== 'function').each(CLOCKS)(
      'should fall back to the wall clock rather than read nothing: %s',
      async (_name, tick) => {
        const real = process.threadCpuUsage.bind(process);
        vi.spyOn(process, 'threadCpuUsage').mockImplementation(() => {
          const { system, user } = real();
          return { system: 0, user: tick(system + user) };
        });
        vi.resetModules();
        const ticked = await import('./growth.js');
        // the wall clock moves in fractions of a millisecond; a tick clock reads
        // nothing or a whole step
        const first = ticked.now();
        let second = first;
        for (const end = performance.now() + 5; performance.now() < end && second === first;) {
          second = ticked.now();
        }
        expect(second - first).toBeLessThan(1);
        expect(second - first).toBeGreaterThan(0);
        expect(ticked.growthOf(linear, text(256), text(2048), 8, 'ticks')).toBeLessThan(24);
      }
    );
  });
});
