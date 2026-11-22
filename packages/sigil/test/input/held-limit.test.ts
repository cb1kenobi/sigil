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
 * `pendingTail()` was asked to read, and how many `hasStringEnd()` was asked to
 * look through, summed over every read. A wall-clock
 * threshold flakes under the load this suite runs in, and a count does not.
 */

// a spy over the one function the router measures with, which still answers as
// the real one does. Hoisted by vitest above the imports it replaces
const work = vi.hoisted(() => ({ examined: 0, resumed: 0 }));

vi.mock('../../src/components/keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/keys.js')>();
  return {
    ...actual,
    // the resumed search counts what it was asked to read, which is the part of
    // the string past where the last read stopped
    hasStringEnd: (input: string, from: number): boolean => {
      work.examined += input.length - from;
      work.resumed++;
      return actual.hasStringEnd(input, from);
    },
    pendingTail: (input: string, opts?: Parameters<typeof actual.pendingTail>[1]) => {
      work.examined += input.length;
      return actual.pendingTail(input, opts);
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

  it('should not cut a long reply to a query, which is a control string and not a key', async () => {
    // an OSC 52 clipboard read is as long as the clipboard. Cut at the limit it
    // resolved with nothing and typed its payload into whatever was focused
    const { terminal } = createTestTerminal();
    const input = createInput({ root: box({}), terminal });
    const keys: string[] = [];
    input.bind((event) => {
      keys.push(event.key.name);
    });
    const reply = `${ESC}]52;c;${'QUJD'.repeat(HELD_LIMIT)}\u0007`;
    const replies = input.query({
      timeout: 5000,
      until: () => true,
      write: `${ESC}]52;c;?\u0007`,
    });
    work.resumed = 0;
    for (let at = 0; at < reply.length; at += READ) {
      input.feed(reply.slice(at, at + READ));
    }
    const answers = await replies;
    expect(keys).toEqual([]);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.sequence).toBe(reply);
    // and it was held by resuming the search for its end, so this is the path a
    // reply this long takes rather than a walk from its start on every read
    expect(work.resumed).toBeGreaterThan(reply.length / READ / 2);
    input.stop();
  });

  describe('an unterminated control string', () => {
    // every introducer `STRINGS` claims, with a payload the default reading
    // claims too, so it is held whether or not a query is outstanding
    const introducers: [string, string][] = [
      ['OSC', `${ESC}]52;c;`],
      ['DCS', `${ESC}P1$r`],
      ['DCS XTVersion', `${ESC}P>|`],
      ['OSC under Alt', `${ESC}${ESC}]52;c;`],
      ['OSC under a run of ESC', `${ESC.repeat(5000)}]52;c;`],
    ];

    it.each(introducers)('should be searched in work linear in its length, for a %s', (_, open) => {
      const { feed, stop } = recording();
      const total = 1_000_000;
      const examined = feedRun(feed, open + 'A'.repeat(total));
      stop();

      // each read looks through what it brought and one byte of what was held.
      // Quadratic is total / READ / 2 times total, which is five hundred times this
      const reads = Math.ceil((total + open.length) / READ);
      expect(examined).toBeLessThanOrEqual(reads * (READ + 1) + open.length * 4);
      expect(examined).toBeLessThan(total * 2);
    });

    // what the resumed search must not change: the same keys and the same replies
    // as the whole stream fed at once, for every place the reads could split --
    // including inside an `ESC \`, which is the one terminator two reads share
    const streams: [string, string][] = [
      ['an OSC ended by BEL', `${ESC}]52;c;QUJD\u0007a`],
      ['an OSC ended by ST', `${ESC}]52;c;QUJD${ESC}\\a`],
      ['an OSC ended by C1 ST', `${ESC}]52;c;QUJD\u009ca`],
      ['a DCS ended by ST', `${ESC}P>|name${ESC}\\a`],
      ['an OSC with an ESC in its payload', `${ESC}]52;c;QU${ESC}JD${ESC}\\a`],
      ['an OSC under Alt', `${ESC}${ESC}]52;c;QUJD\u0007a`],
      ['two strings in a row', `${ESC}]11;rgb:1/2/3\u0007${ESC}P>|v${ESC}\\a`],
      ['an OSC followed by a split arrow key', `${ESC}]52;c;QUJD\u0007${ESC}[A`],
      ['an OSC that never ends', `${ESC}]52;c;QUJD`],
    ];

    /** Feeds `chunks` with a query outstanding and answers what the router made of them. */
    async function read(chunks: string[]): Promise<{ keys: string[]; replies: string[] }> {
      const { terminal } = createTestTerminal();
      const input = createInput({ root: box({}), terminal });
      const keys: string[] = [];
      input.bind((event) => {
        keys.push(event.key.sequence);
      });
      const asked = input.query({ timeout: 5000, until: () => false, write: `${ESC}[c` });
      for (const chunk of chunks) {
        input.feed(chunk);
      }
      await vi.advanceTimersByTimeAsync(5000 + ESCAPE_TIMEOUT);
      const replies = (await asked).map((reply) => reply.sequence);
      input.stop();
      return { keys, replies };
    }

    it.each(streams)('should read %s the same at every split', async (_, stream) => {
      const whole = await read([stream]);
      for (let a = 1; a < stream.length; a++) {
        expect(await read([stream.slice(0, a), stream.slice(a)])).toEqual(whole);
        for (let b = a + 1; b < stream.length; b++) {
          expect(await read([stream.slice(0, a), stream.slice(a, b), stream.slice(b)])).toEqual(
            whole
          );
        }
      }
    });

    it('should read a string whose terminator splits across the resumed search', async () => {
      // the held tail ends in the ESC of an ST, and the next read brings the
      // backslash: the search resumes one byte back so that the pair is seen
      const { terminal } = createTestTerminal();
      const input = createInput({ root: box({}), terminal });
      const keys: string[] = [];
      input.bind((event) => keys.push(event.key.name));
      const asked = input.query({ timeout: 5000, until: () => true, write: `${ESC}[c` });
      input.feed(`${ESC}]52;c;${'A'.repeat(READ)}`);
      input.feed(`${'A'.repeat(READ)}${ESC}`);
      input.feed('\\');
      expect(await asked).toHaveLength(1);
      expect(keys).toEqual([]);
      input.stop();
    });

    it('should read a held string afresh when the query that wanted it is gone', () => {
      // `ESC ] ;` is claimed as a string only while a query is outstanding. Held
      // under that reading, it is not the same tail once the query has settled, so
      // the next read is measured from its start rather than resumed -- and with
      // nothing claiming it, `ESC ]` is Alt-] and the rest are keys, at once
      const { terminal } = createTestTerminal();
      const input = createInput({ root: box({}), terminal });
      const keys: string[] = [];
      input.bind((event) => {
        keys.push(event.key.sequence);
      });
      void input.query({ timeout: 100, until: () => false, write: `${ESC}[c` });
      input.feed(`${ESC}];x`);
      expect(keys).toEqual([]);
      vi.advanceTimersByTime(100);
      input.feed('y');
      expect(keys).toEqual([`${ESC}]`, ';', 'x', 'y']);
      input.stop();
    });

    it('should not carry a finished string into the next key held after it', () => {
      // what was known of the string must go with it: a stale record read an
      // `ESC [` held afterwards as more of it, and Up never came
      const { feed, keys, stop } = recording();
      feed(`${ESC}]52;c;x`);
      feed('\u0007');
      feed(`${ESC}[`);
      feed('A');
      expect(keys.map((key) => key.name)).toEqual(['up']);
      stop();
    });

    it('should not resume a string the key timer has already flushed', () => {
      // `expire()` clears what is held and nothing else, so what follows is not
      // the continuation of anything
      const { feed, keys, stop } = recording();
      feed(`${ESC}]52;c;x`);
      vi.advanceTimersByTime(ESCAPE_TIMEOUT + 10);
      feed('abc');
      expect(keys.map((key) => key.sequence).slice(-3)).toEqual(['a', 'b', 'c']);
      stop();
    });

    it('should not find a paste start from the edge of a tail that was flushed', () => {
      const { terminal } = createTestTerminal();
      const input = createInput({ root: box({}), terminal });
      const seen: string[] = [];
      input.onPaste((event) => {
        seen.push(`paste:${event.text}`);
        event.stop();
      });
      input.bind((event) => {
        seen.push(event.key.name);
      });
      input.feed(`${ESC}[200`);
      vi.advanceTimersByTime(ESCAPE_TIMEOUT + 10);
      input.feed('~x');
      expect(seen.some((entry) => entry.startsWith('paste:'))).toBe(false);
      expect(seen.slice(-2)).toEqual(['~', 'x']);
      input.stop();
    });

    it('should look for a paste start in work linear in the string held', () => {
      // a terminal that is bracketing a paste is asked for the start marker on
      // every read, and it was asked of the whole held tail, flattening it first
      const marker = `${ESC}[200~`;
      let searched = 0;
      const indexOf = String.prototype.indexOf;
      const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
        this: string,
        search: string,
        from?: number
      ): number {
        if (search === marker) {
          searched += this.length;
        }
        return indexOf.call(this, search, from);
      });
      try {
        const { feed, stop } = recording();
        const total = 1_000_000;
        feedRun(feed, `${ESC}]52;c;${'A'.repeat(total)}`);
        stop();
        // the end of what was held and the read, which is the read and five bytes
        expect(searched).toBeLessThanOrEqual((total / READ + 1) * (READ + 8) + 64);
      } finally {
        spy.mockRestore();
      }
    });

    it('should find a paste marker that straddles the join with a held string, as it did', () => {
      // the marker is looked for in the end of what is held and the new read, not
      // all of both, so a split inside it is the case that has to still be found
      const marker = `${ESC}[200~`;
      for (let at = 1; at < marker.length; at++) {
        const { terminal } = createTestTerminal();
        const input = createInput({ root: box({}), terminal });
        const order: string[] = [];
        input.onPaste((event) => {
          order.push(`paste:${event.text}`);
          event.stop();
        });
        input.bind((event) => {
          order.push(event.key.name);
        });
        input.feed(`${ESC}]52;c;${'A'.repeat(READ)}`);
        input.feed(`${'A'.repeat(READ)}${marker.slice(0, at)}`);
        input.feed(`${marker.slice(at)}hi${ESC}[201~`);
        // the string was held up to the marker and then released as the key it
        // decodes to, and the paste came through whole
        expect(order).toEqual(['unknown', 'paste:hi']);
        input.stop();
      }
    });

    it('should cost twice the work for twice the payload, with a query outstanding', () => {
      const scale = [HELD_LIMIT * 16, HELD_LIMIT * 32].map((n) => {
        const { terminal } = createTestTerminal();
        const input = createInput({ root: box({}), terminal });
        void input.query({ timeout: 5000, until: () => false, write: `${ESC}]52;c;?\u0007` });
        const examined = feedRun((chunk) => input.feed(chunk), `${ESC}]${'A'.repeat(n)}`);
        input.stop();
        return examined;
      });
      expect(scale[1]! / scale[0]!).toBeLessThan(2.2);
    });
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
