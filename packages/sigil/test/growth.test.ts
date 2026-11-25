import { growthOf, growthOfAsync, now, SPAN } from './growth.js';
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

  // `]` and `(` repeated read 25.07 against 24 on an Ubuntu job (SIG-681) that took
  // 11.9 s over a file that takes 0.7 s idle: the wall clock was what that runner
  // had, and a long read is cut by the scheduler where a short one is not. The
  // stall is made here by hand and not waited for: the first read of the large side
  // in each of the first seven runs waits thirty milliseconds, which is what being
  // descheduled costs a sample that long, and the runs after those are clean. It
  // waits on the clock being measured, so that it is time on it whatever the
  // machine is doing
  describe('on a runner that stalls the large side in every one of seven runs', () => {
    const STALL = 30;
    const stalling = (small: string): ((source: string) => number) => {
      let turns = 0;
      let last = '';
      return (source) => {
        const side = source === small ? 'small' : 'large';
        if (side === 'large' && last !== 'large' && ++turns <= 7) {
          for (const end = now() + STALL; now() < end;) {
            // spin
          }
        }
        last = side;
        return linear(source);
      };
    };

    it('should read the stall as growth when it has seven runs to say so with', () => {
      // the control: without it, the next test passes for want of a stall
      const small = text(4096);
      expect(growthOf(stalling(small), small, text(32768), 8, 'stalled')).toBeGreaterThan(24);
    }, 60_000);

    it('should read past the stall once it is asked for a ratio and not given it', () => {
      const small = text(4096);
      expect(growthOf(stalling(small), small, text(32768), 8, 'stalled', SPAN, 24)).toBeLessThan(
        24
      );
    }, 60_000);

    it('should still read a quadratic walk as growth however long it samples', () => {
      expect(growthOf(quadratic, text(512), text(4096), 8, 'quadratic', SPAN, 24)).toBeGreaterThan(
        24
      );
    }, 60_000);
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
      // nothing, which is `the clock read nothing`, and not as slow. The work is
      // repeated so that it is most of a read on both sides: one turn of the event
      // loop costs tens of microseconds on a clock that counts waiting, and a
      // quadratic walk of 256 characters is six, which pulled the ratio under 24
      const later = (source: string): Promise<void> =>
        new Promise((resolve) => {
          setImmediate(() => {
            for (let again = 0; again < 100; again++) {
              quadratic(source);
            }
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
