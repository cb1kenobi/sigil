import { createStress } from '../stress/app.js';
import { measureFrames } from '../stress/measure.js';
import { describe, expect, it } from 'vitest';

/**
 * The full-screen budget: a 200 by 60 screen whose thousand-row table re-sorts and
 * whose four charts move on every frame, held to ceilings on what it writes and
 * what it builds.
 *
 * Every number asserted here is a count, and the same count on every machine:
 * the workload is seeded, the colour level and the glyphs are fixed, and nothing
 * here reads a clock. Each ceiling is about twice what was measured when it was
 * set -- the `dist.test.ts` rule -- so ordinary growth never touches it and a
 * change of kind does: a frame that repaints every cell, a table that formats
 * every row rather than the rows on screen, a window that stopped windowing.
 *
 * Time is deliberately not asserted. The suite runs its projects in parallel and
 * CI on nine machines slower than the one the budget was measured on, and the
 * layout fuzzer already times out only under that load; a ceiling loose enough
 * to hold there would be one a regression of 5x walks under. The times are the
 * benchmark's (`stress/benchmark.js`), and `packages/sigil/src/renderer/AGENTS.md`
 * records them under "A full-screen performance budget".
 */

/** Frames measured after five to warm up, which is enough for every count to settle. */
const FRAMES = 60;

/** What the workload measured as of SIG-290, which each ceiling is about double. */
const MEASURED = Object.freeze({
  cells: 2_114,
  elements: 1_059,
  formatted: 123,
  frameBytes: 4_142,
  mountBytes: 16_693,
  styles: 7,
});

/** The ceilings, each about twice its measurement; the last test holds them to that. */
const CEILING = Object.freeze({
  cells: 4_300,
  elements: 2_200,
  formatted: 250,
  frameBytes: 8_500,
  mountBytes: 34_000,
  styles: 14,
});

describe('the full-screen budget', () => {
  it(
    'should hold a 200x60 screen that changes every frame under its ceilings',
    async () => {
      const workload = createStress();
      /** The table's `format` calls since the step before: the frame between the two. */
      const formatted = [];
      let seen = 0;
      const { frames, mounted } = await measureFrames(
        {
          App: workload.App,
          sheets: workload.sheets,
          step: () => {
            workload.step();
            formatted.push(workload.formatted - seen);
            seen = workload.formatted;
          },
        },
        { frames: FRAMES, warmup: 5 }
      );

      expect(frames).toHaveLength(FRAMES);
      // the first frame paints every cell, so this is the whole screen's bytes
      expect(mounted.stats?.cells).toBe(200 * 60);
      expect(mounted.bytes).toBeLessThanOrEqual(CEILING.mountBytes);

      const stats = frames.map((frame) => frame.stats);
      for (const [i, frame] of frames.entries()) {
        const at = `frame ${i}`;
        // every frame has something to draw, or the ceilings below are about nothing
        expect(stats[i]?.painted, at).toBe(true);
        expect(frame.bytes, at).toBeGreaterThan(0);
        expect(frame.bytes, at).toBeLessThanOrEqual(CEILING.frameBytes);
        // a frame that repainted the screen would be 12,000
        expect(stats[i]?.cells, at).toBeLessThanOrEqual(CEILING.cells);
        // a table that stopped windowing would be a thousand rows of elements
        expect(stats[i]?.elements, at).toBeLessThanOrEqual(CEILING.elements);
      }

      // a thousand rows cost what the rows on screen cost: three formatted columns
      // a row, for the forty-odd rows the screen holds, and not for the rest
      const steady = formatted.slice(-FRAMES);
      expect(Math.min(...steady)).toBeGreaterThan(0);
      expect(Math.max(...steady)).toBeLessThanOrEqual(CEILING.formatted);

      // the style table holds what the screen wears, which a reading does not add to
      expect(stats.at(-1)?.styles).toBeLessThanOrEqual(CEILING.styles);
      expect(stats.at(-1)?.sweeps).toBe(0);
    },
    // a count is the same however slow the machine, but the frames still take
    // the time they take: about one second here, and CI under parallel load is
    // slower by more than the default five allows
    60_000
  );

  it('should measure the same frames on every run, which is what makes a count a ceiling', async () => {
    const run = async () => {
      const { frames, mounted } = await measureFrames(createStress(), { frames: 10, warmup: 0 });
      return [mounted.bytes, ...frames.map((frame) => frame.bytes)];
    };
    expect(await run()).toEqual(await run());
  }, 60_000);

  it('should have ceilings about twice what was measured', () => {
    // the rule the numbers above are set by, so that a ceiling raised to make a
    // failure go away has to change a measurement beside it to do it
    for (const [name, ceiling] of Object.entries(CEILING)) {
      const ratio = ceiling / MEASURED[/** @type {keyof typeof MEASURED} */ (name)];
      expect(ratio, name).toBeGreaterThanOrEqual(1.9);
      expect(ratio, name).toBeLessThanOrEqual(2.2);
    }
  });
});
