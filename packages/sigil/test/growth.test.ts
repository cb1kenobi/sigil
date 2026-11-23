import { growthOf, now } from './growth.js';
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
    expect(growthOf(quadratic, text(4096), text(32768), 8, 'quadratic')).toBeGreaterThan(24);
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

    it('should fall back to the wall clock rather than read nothing', async () => {
      // four milliseconds a step, as the Linux CI runners keep it
      const real = process.threadCpuUsage.bind(process);
      vi.spyOn(process, 'threadCpuUsage').mockImplementation(() => {
        const { system, user } = real();
        return { system: 0, user: Math.floor((system + user) / 4000) * 4000 };
      });
      vi.resetModules();
      const ticked = await import('./growth.js');
      // under a tick clock `a` shape read for three milliseconds reads 0 or 4
      const first = ticked.now();
      let second = first;
      for (const end = performance.now() + 5; performance.now() < end && second === first;) {
        second = ticked.now();
      }
      expect(second - first).toBeLessThan(4);
      expect(second - first).toBeGreaterThan(0);
      expect(ticked.growthOf(linear, text(256), text(2048), 8, 'ticks')).toBeLessThan(24);
    });
  });
});
