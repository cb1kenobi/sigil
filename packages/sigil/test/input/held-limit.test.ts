import * as keysModule from '../../src/components/keys.js';
import { box } from '../../src/element/index.js';
import { createInput, ESCAPE_TIMEOUT, HELD_LIMIT } from '../../src/input/index.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An unfinished key sequence that never finishes (SIG-439).
 *
 * `createInput()` holds a read that ends mid-sequence and joins it to the next,
 * and every read measured the whole of the join again from its start. So what is
 * counted here is the work rather than the clock: how many characters
 * `pendingLength()` was asked to read, summed over every read. A wall-clock
 * threshold flakes under the load this suite runs in, and a count does not.
 */

// a spy over the one function the router measures with, which still answers as
// the real one does. Hoisted by vitest above the imports it replaces
const work = vi.hoisted(() => ({ examined: 0 }));

vi.mock('../../src/components/keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/keys.js')>();
  return {
    ...actual,
    pendingLength: (input: string, opts?: Parameters<typeof actual.pendingLength>[1]): number => {
      work.examined += input.length;
      return actual.pendingLength(input, opts);
    },
  };
});

const ESC = '\u001b';
const READ = 1024;

/** A router over a focused nothing, recording every key as its name and sequence. */
function recording(): {
  feed: (chunk: string) => void;
  keys: { name: string; sequence: string }[];
  stop: () => void;
} {
  const { terminal } = createTestTerminal();
  const input = createInput({ root: box({}), terminal });
  const keys: { name: string; sequence: string }[] = [];
  input.bind((event) => {
    keys.push({ name: event.key.name, sequence: event.key.sequence });
  });
  return { feed: (chunk) => input.feed(chunk), keys, stop: () => input.stop() };
}

/** Feeds `run` in reads of `READ` and answers what was examined doing it. */
function feedRun(feed: (chunk: string) => void, run: string): number {
  work.examined = 0;
  for (let at = 0; at < run.length; at += READ) {
    feed(run.slice(at, at + READ));
  }
  return work.examined;
}

describe('a held key sequence that keeps growing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should be read in work linear in its length, for a run of ESC', () => {
    const { feed, stop } = recording();
    const total = HELD_LIMIT * 64;
    const examined = feedRun(feed, ESC.repeat(total));
    stop();

    // every read measures what is held plus what it brought, and what is held
    // is cut at the limit, so no read costs more than that. Quadratic is
    // total / READ / 2 times total, which is thirty-two times this
    const reads = total / READ;
    expect(examined).toBeLessThanOrEqual(reads * (HELD_LIMIT + READ));
    expect(examined).toBeLessThan((total * total) / READ / 8);
  });

  it('should be read in work linear in its length, for a CSI parameter run', () => {
    const { feed, stop } = recording();
    const total = HELD_LIMIT * 64;
    const examined = feedRun(feed, `${ESC}[${'1'.repeat(total)}`);
    stop();

    const reads = Math.ceil((total + 2) / READ);
    expect(examined).toBeLessThanOrEqual(reads * (HELD_LIMIT + READ));
    expect(examined).toBeLessThan((total * total) / READ / 8);
  });

  it('should cost twice the work for twice the run, not four times', () => {
    const scale = (run: (n: number) => string): number[] =>
      [HELD_LIMIT * 16, HELD_LIMIT * 32].map((n) => {
        const { feed, stop } = recording();
        const examined = feedRun(feed, run(n));
        stop();
        return examined;
      });

    for (const run of [(n: number) => ESC.repeat(n), (n: number) => `${ESC}[${'1'.repeat(n)}`]) {
      const [one, two] = scale(run) as [number, number];
      expect(two / one).toBeLessThan(2.2);
    }
  });

  it('should leave a sequence at the limit as one key, exactly as it was', () => {
    // the bound must not change what anything under it decodes to: a run of
    // exactly `HELD_LIMIT` ESC bytes and an `a` is the one Alt-a it always was
    const { feed, keys, stop } = recording();
    feedRun(feed, ESC.repeat(HELD_LIMIT));
    expect(keys).toEqual([]);
    feed('a');
    expect(keys).toEqual([{ name: 'a', sequence: `${ESC.repeat(HELD_LIMIT)}a` }]);
    stop();
  });

  it('should release a run of ESC past the limit as the key it decodes to, and read on', () => {
    const { feed, keys, stop } = recording();
    feedRun(feed, ESC.repeat(HELD_LIMIT + 1));

    // released by the read that crossed it rather than held for the timer
    expect(keys.map((key) => key.sequence.length)).toEqual([HELD_LIMIT + 1]);
    expect(keys[0]?.name).toBe('escape');

    // and what follows is read afresh: an `a` is a plain `a`, not Alt-a
    feed('a');
    expect(keys.map((key) => key.sequence.length)).toEqual([HELD_LIMIT + 1, 1]);
    expect(keys[1]).toEqual({ name: 'a', sequence: 'a' });
    stop();
  });

  it('should release a CSI parameter run past the limit as one unknown key', () => {
    const { feed, keys, stop } = recording();
    const run = `${ESC}[${'1'.repeat(HELD_LIMIT)}`;
    feedRun(feed, run);

    expect(keys).toEqual([{ name: 'unknown', sequence: run }]);

    // the rest of the run is not a sequence any more, and no longer held either
    feed('1');
    expect(keys.map((key) => key.sequence.length)).toEqual([run.length, 1]);
    vi.advanceTimersByTime(ESCAPE_TIMEOUT);
    expect(keys).toHaveLength(2);
    stop();
  });

  it('should still read a held sequence under the limit when the rest arrives', () => {
    // a real split, which is what holding is for
    const { feed, keys, stop } = recording();
    feed(`${ESC}[`);
    expect(keys).toEqual([]);
    feed('A');
    expect(keys.map((key) => key.name)).toEqual(['up']);
    stop();
  });

  it('should not let the spy replace the decoder', () => {
    // the counting above is only evidence if the mock still reads like the real thing
    expect(keysModule.pendingLength(`${ESC}[`)).toBe(2);
  });
});
