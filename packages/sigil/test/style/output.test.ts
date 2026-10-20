import { resolveMotion } from '../../src/style/motion.js';
import { quietRequested, requestQuiet, resolveOutput } from '../../src/style/output.js';
import { describe, expect, it, afterEach } from 'vitest';

afterEach(() => {
  // process-wide, so a run that set it would otherwise decide the answer for
  // every test after it in this worker
  requestQuiet(undefined);
});

describe('resolveMotion', () => {
  it('should take the app’s own preference over everything', () => {
    expect(
      resolveMotion({
        env: { SIGIL_REDUCED_MOTION: '1' },
        live: true,
        reducedMotion: 'no-preference',
      })
    ).toBe('no-preference');
    expect(resolveMotion({ env: {}, live: true, reducedMotion: 'reduce' })).toBe('reduce');
  });

  it('should take the variable over the terminal', () => {
    expect(resolveMotion({ env: { SIGIL_REDUCED_MOTION: '1' }, live: true })).toBe('reduce');
    expect(resolveMotion({ env: { SIGIL_REDUCED_MOTION: 'off' }, live: false })).toBe(
      'no-preference'
    );
  });

  it('should read a pipe as reduced, which is the last term', () => {
    expect(resolveMotion({ env: {}, live: false })).toBe('reduce');
    expect(resolveMotion({ env: {}, live: true })).toBe('no-preference');
  });
});

describe('resolveOutput', () => {
  it('should answer live for a terminal nobody has an opinion about', () => {
    expect(resolveOutput({ env: {}, live: true })).toBe('live');
  });

  it('should answer reduce for a pipe', () => {
    expect(resolveOutput({ env: {}, live: false })).toBe('reduce');
  });

  it('should answer reduce for a motion preference on a terminal', () => {
    expect(resolveOutput({ env: {}, live: true, reducedMotion: 'reduce' })).toBe('reduce');
    expect(resolveOutput({ env: { SIGIL_REDUCED_MOTION: 'yes' }, live: true })).toBe('reduce');
  });

  /**
   * The one guard in the fold that is not a chain, and the one input that makes
   * it matter: a forced `no-preference` is the only way `resolveMotion()` can
   * answer "animate" with no screen to animate on, and without the ceiling a
   * typewriter would write a line per reveal step into a log file.
   */
  it('should not raise a pipe to live, however loudly it is asked', () => {
    expect(resolveMotion({ env: {}, live: false, reducedMotion: 'no-preference' })).toBe(
      'no-preference'
    );
    expect(resolveOutput({ env: {}, live: false, reducedMotion: 'no-preference' })).toBe('reduce');
    expect(resolveOutput({ env: { SIGIL_REDUCED_MOTION: 'no' }, live: false })).toBe('reduce');
  });

  it('should answer quiet for a mount that said so, whatever the screen is', () => {
    expect(resolveOutput({ env: {}, live: true, quiet: true })).toBe('quiet');
    expect(resolveOutput({ env: {}, live: false, quiet: true })).toBe('quiet');
  });

  it('should answer quiet for the process-wide request', () => {
    requestQuiet(true);
    expect(resolveOutput({ env: {}, live: true })).toBe('quiet');
    expect(resolveOutput({ env: {}, live: false })).toBe('quiet');
  });

  /**
   * The opt-out, which is how a built-in says it is not progress at all. The
   * prompt is the one that needs it: a silenced dialogue waits forever for an
   * answer to a question nobody was shown.
   */
  it('should let a mount say it is not progress, above the request', () => {
    requestQuiet(true);
    expect(resolveOutput({ env: {}, live: true, quiet: false })).toBe('live');
    expect(resolveOutput({ env: {}, live: false, quiet: false })).toBe('reduce');
  });

  /**
   * The property `report.ts` rests on: a caller with no mount of its own asks
   * the request, and this is what says the request is the only thing that can
   * produce `quiet` for it. A fourth source added above the request would fail
   * here rather than diverging silently in the toolchain.
   */
  it('should answer quiet only where something asked', () => {
    for (const live of [true, false]) {
      for (const reducedMotion of ['no-preference', 'reduce', undefined] as const) {
        for (const env of [{}, { SIGIL_REDUCED_MOTION: '1' }, { SIGIL_REDUCED_MOTION: '0' }]) {
          expect(resolveOutput({ env, live, reducedMotion })).not.toBe('quiet');
        }
      }
    }
  });

  /**
   * Truthiness is the wrong reading in the direction that costs: `'false'` and
   * `new Boolean(false)` are both truthy, so each silenced a whole process
   * before this was strict. There is no third answer to fall back to, so it is
   * refused where it was written -- the call a non-boolean `hidden` already
   * gets.
   */
  it('should refuse a quiet statement that is not a boolean', () => {
    expect(() => resolveOutput({ live: true, quiet: 'false' as never })).toThrow(
      'Expected quiet to be a boolean'
    );
    expect(() => resolveOutput({ live: true, quiet: new Boolean(false) as never })).toThrow(
      'Expected quiet to be a boolean'
    );
    expect(() => resolveOutput({ live: true, quiet: 0 as never })).toThrow(TypeError);
    expect(() => requestQuiet('false' as never)).toThrow('Expected requestQuiet to be a boolean');
    expect(() => requestQuiet(new Boolean(true) as never)).toThrow(TypeError);
    // and a request that was refused is not a request: the slot is untouched
    expect(quietRequested()).toBeUndefined();
    expect(resolveOutput({ env: {}, live: true })).toBe('live');
  });

  it('should take a recorded request back, so a test can put it back', () => {
    requestQuiet(true);
    expect(quietRequested()).toBe(true);
    requestQuiet(undefined);
    expect(quietRequested()).toBeUndefined();
    expect(resolveOutput({ env: {}, live: true })).toBe('live');
  });

  /**
   * The two axes are separate answers to separate questions, and this is the
   * pairing that says so: a reduced-motion preference is not a quiet request,
   * and `--quiet` is not a motion preference.
   */
  it('should keep quiet and reduced motion apart', () => {
    requestQuiet(false);
    expect(resolveOutput({ env: { SIGIL_REDUCED_MOTION: '1' }, live: true })).toBe('reduce');
    requestQuiet(true);
    expect(resolveOutput({ env: {}, live: true })).toBe('quiet');
  });
});
