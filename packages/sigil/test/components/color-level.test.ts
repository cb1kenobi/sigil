import { createAnsi } from '../../src/ansi/index.js';
import { colorLevelOf } from '../../src/components/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `colorLevelOf()`: the one place a component's colour level is decided.
 *
 * The level is the terminal's, so a fixture built at one does not have to be told
 * it a second time, but a caller who names a level or hands over an `ansi` has
 * decided and is not overruled by a terminal that merely has an opinion.
 */

/** Built rather than written, so no raw control character sits in source. */
const ESC = String.fromCharCode(0x1b);
/** `ESC [ params m`: SGR, of which the two resets are not colour. */
const SGR = new RegExp(`${ESC}\\[[\\d;:]*m`, 'g');
const RESETS = new Set([`${ESC}[0m`, `${ESC}[m`]);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('colorLevelOf()', () => {
  const ansi = createAnsi({ level: 2 });
  const fallback = createAnsi({ level: 1 });

  it('should take a colorLevel the caller named over everything', () => {
    expect(colorLevelOf({ ansi, colorLevel: 3 }, { colorLevel: 0 }, fallback)).toBe(3);
    // zero is a level, not an absence
    expect(colorLevelOf({ ansi, colorLevel: 0 }, { colorLevel: 3 }, fallback)).toBe(0);
  });

  it('should take the ansi the caller handed over over the terminal', () => {
    expect(colorLevelOf({ ansi }, { colorLevel: 0 }, fallback)).toBe(2);
  });

  it('should take the terminal over the environment', () => {
    expect(colorLevelOf({}, { colorLevel: 0 }, fallback)).toBe(0);
    expect(colorLevelOf({}, { colorLevel: 3 }, fallback)).toBe(3);
  });

  it('should ask the environment when nobody said, as it always did', () => {
    expect(colorLevelOf({}, {}, fallback)).toBe(1);
    expect(colorLevelOf({}, undefined, fallback)).toBe(1);
  });
});

describe('a built-in component handed only a test terminal', () => {
  it('should write no colour at level 0 whatever the environment says', async () => {
    // the README's own `select()` example: `terminal: ui.terminal` and no `ansi`.
    // The component asked the environment, so a CI runner that sets
    // `FORCE_COLOR` put escapes into a screen a test reads for text. The modules
    // are imported after the variable is set because the default styler reads
    // its level once, on first use
    vi.stubEnv('FORCE_COLOR', '3');
    vi.resetModules();
    const { select } = await import('../../src/components/prompt.js');
    const { createTestTerminal, KEYS } = await import('../../src/testing/index.js');

    const ui = createTestTerminal({ columns: 40, rows: 8 });
    const pick = select({ choices: ['one', 'two'], message: 'Pick', terminal: ui.terminal });
    await ui.press(KEYS.down);

    // SGR is `ESC [ params m`; the reset forms are not colour
    const sgr = (ui.output.match(SGR) ?? []).filter((it) => !RESETS.has(it));
    expect(sgr).toEqual([]);

    await ui.press(KEYS.enter);
    await pick;
  });

  it('should still write colour at the level the terminal was built with', async () => {
    // the other half, or the test above would pass for a component that never
    // coloured anything
    vi.stubEnv('FORCE_COLOR', '0');
    vi.resetModules();
    const { select } = await import('../../src/components/prompt.js');
    const { createTestTerminal, KEYS } = await import('../../src/testing/index.js');

    const ui = createTestTerminal({ colorLevel: 3, columns: 40, rows: 8 });
    const pick = select({ choices: ['one', 'two'], message: 'Pick', terminal: ui.terminal });
    await ui.press(KEYS.down);

    expect((ui.output.match(SGR) ?? []).filter((it) => !RESETS.has(it))).not.toEqual([]);

    await ui.press(KEYS.enter);
    await pick;
  });
});
