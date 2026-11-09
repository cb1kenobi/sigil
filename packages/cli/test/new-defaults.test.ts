import {
  askLanguage,
  askLayout,
  askLinter,
  askSyntax,
  askTui,
  DEFAULTS,
} from '../src/commands/new.ts';
import { confirm, select } from '@ttylabs/sigil/components/prompt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Each question reads its default from `DEFAULTS`, which `--yes` reads too.
 *
 * The prompts are stubbed to hand back what they were given as the answer to start
 * from, so what is asserted is what `sigil new` *asked for*: a menu handed `value`
 * and a confirmation handed `default`.
 *
 * **What it proves.** `DEFAULTS` is moved here to values that are not the real
 * ones, none of them the first row of its menu, and each menu and confirmation has to
 * follow: a menu handed the literal `'oxlint'` instead of `DEFAULTS.linter` passes
 * with the real defaults, because they are the same string, and fails with these. The
 * stub returning what it was handed is circular on its own and is not the claim; the
 * claim is that what it was handed moved when the constant did, and that `--yes`
 * returns the moved values too.
 *
 * **What it cannot.** That a real menu *highlights* the entry it was handed. That is
 * `select()`'s contract -- `value` starts highlighted and beats `initial` -- and
 * `prompt-value.test.ts` in `@ttylabs/sigil` pins it on a choice that is not the first
 * row. No real default is a non-first row, so nothing end to end through a real menu
 * can tell `value` from nothing.
 */

vi.mock('@ttylabs/sigil/components/prompt', () => ({
  confirm: vi.fn(async (options: { default?: boolean }) => options.default ?? true),
  select: vi.fn(async (options: { value?: unknown }) => options.value),
  text: vi.fn(async () => ''),
}));

const REAL = { ...DEFAULTS };

/** Values that are not the real ones, and not the first row of any menu. */
const MOVED = {
  language: 'js',
  layout: 'single',
  linter: 'biome',
  syntax: 'ui',
  tui: true,
} as const;

beforeEach(() => {
  vi.mocked(select).mockClear();
  vi.mocked(confirm).mockClear();
});

afterEach(() => {
  // `DEFAULTS` is a plain object, so a test that moves it has to put it back
  Object.assign(DEFAULTS, REAL);
});

/** The options a stubbed menu was last called with. */
function menu(): { value?: unknown } {
  return vi.mocked(select).mock.calls.at(-1)?.[0] as { value?: unknown };
}

/** The options a stubbed confirmation was last called with. */
function confirmation(): { default?: boolean } {
  return vi.mocked(confirm).mock.calls.at(-1)?.[0] as { default?: boolean };
}

describe('the defaults, as the questions read them', () => {
  it('should be what the real defaults are, when nothing has moved them', async () => {
    expect(await askLayout({}, false)).toBe(REAL.layout);
    expect(await askSyntax({}, false, { at: 'root' })).toBe(REAL.syntax);
    expect(await askLinter({}, false)).toBe(REAL.linter);
    expect(await askLanguage({}, false)).toBe(REAL.language);
    expect(await askTui({}, false, 'multi', 'demo')).toBeUndefined();
  });

  describe('moved to values that are not the real ones', () => {
    beforeEach(() => {
      Object.assign(DEFAULTS, MOVED);
    });

    it('should hand the layout menu the moved default to start on', async () => {
      await askLayout({}, false);
      expect(menu().value).toBe(MOVED.layout);
    });

    it('should hand the syntax menu the moved default to start on', async () => {
      await askSyntax({}, false, { at: 'root' });
      expect(menu().value).toBe(MOVED.syntax);
    });

    it('should hand the linter menu the moved default to start on', async () => {
      await askLinter({}, false);
      expect(menu().value).toBe(MOVED.linter);
    });

    it('should hand the language confirmation the moved default', async () => {
      await askLanguage({}, false);
      expect(confirmation().default).toBe(false);
    });

    it('should hand the full-screen confirmation the moved default', async () => {
      await askTui({}, false, 'multi', 'demo');
      expect(confirmation().default).toBe(true);
    });

    it('should return the moved values under --yes, asking nothing', async () => {
      expect(await askLayout({}, true)).toBe(MOVED.layout);
      expect(await askSyntax({}, true, { at: 'root' })).toBe(MOVED.syntax);
      expect(await askLinter({}, true)).toBe(MOVED.linter);
      expect(await askLanguage({}, true)).toBe(MOVED.language);
      // the default is to include one, so it is the app itself and no further question
      expect(await askTui({}, true, 'multi', 'demo')).toEqual({ at: 'root' });
      expect(select).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    });

    it('should let --tui-command say multi, under --yes or asked, and whatever the default is', async () => {
      // the default is `single` in here, so `multi` is the flag's doing and not the
      // default's. Both ways round: asked, where the branch keeps the question from
      // being put, and under --yes, where `if (yes) return DEFAULTS.layout` sitting
      // before it would hand a `--yes --tui-command ops` run a layout that cannot
      // hold the command
      expect(await askLayout({ tuiCommand: 'ops' }, false)).toBe('multi');
      expect(await askLayout({ tuiCommand: 'ops' }, true)).toBe('multi');
      expect(select).not.toHaveBeenCalled();
    });

    it('should let --layout answer before the default is asked', async () => {
      expect(await askLayout({ layout: 'multi' }, true)).toBe('multi');
      expect(await askLayout({ layout: 'multi' }, false)).toBe('multi');
      expect(select).not.toHaveBeenCalled();
    });
  });
});
