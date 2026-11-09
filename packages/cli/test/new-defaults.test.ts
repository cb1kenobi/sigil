import {
  askLanguage,
  askLayout,
  askLinter,
  askSyntax,
  askTui,
  DEFAULTS,
} from '../src/commands/new.ts';
import { confirm, select } from '@ttylabs/sigil/components/prompt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Each question reads its default from `DEFAULTS`, which `--yes` reads too.
 *
 * The prompts are stubbed to hand back what they were given as the answer to start
 * from, so what is asserted is what `sigil new` *asked for*: a menu handed
 * `value: DEFAULTS.x` and a confirmation handed `default: DEFAULTS.x`. That is the
 * claim that the highlighted entry and the value `--yes` takes are one definition.
 *
 * What it proves, and what it cannot. Passing `value` is `select()`'s contract for
 * "this one starts highlighted, and beats `initial`", and `prompt-value.test.ts` in
 * `@ttylabs/sigil` pins that on a choice that is not the first row. No default here
 * is a non-first row -- the defaults are what they are because they are first -- so
 * no end-to-end test through a real menu can tell `value` from nothing at all: the
 * highlight is row 0 either way. The stub is what can tell them apart.
 */

vi.mock('@ttylabs/sigil/components/prompt', () => ({
  confirm: vi.fn(async (options: { default?: boolean }) => options.default ?? true),
  select: vi.fn(async (options: { value?: unknown }) => options.value),
  text: vi.fn(async () => ''),
}));

beforeEach(() => {
  vi.mocked(select).mockClear();
  vi.mocked(confirm).mockClear();
});

/** The options a stubbed menu was last called with. */
function menu(): { value?: unknown } {
  return vi.mocked(select).mock.calls.at(-1)?.[0] as { value?: unknown };
}

describe('the defaults, as the questions read them', () => {
  it('should hand the layout menu its default as the entry to start on', async () => {
    expect(await askLayout({}, false)).toBe(DEFAULTS.layout);
    expect(menu().value).toBe(DEFAULTS.layout);
  });

  it('should hand the syntax menu its default as the entry to start on', async () => {
    expect(await askSyntax({}, false, { at: 'root' })).toBe(DEFAULTS.syntax);
    expect(menu().value).toBe(DEFAULTS.syntax);
  });

  it('should hand the linter menu its default as the entry to start on', async () => {
    expect(await askLinter({}, false)).toBe(DEFAULTS.linter);
    expect(menu().value).toBe(DEFAULTS.linter);
  });

  it('should hand the language confirmation its default', async () => {
    expect(await askLanguage({}, false)).toBe(DEFAULTS.language);
    expect(vi.mocked(confirm).mock.calls.at(-1)?.[0]).toMatchObject({
      default: DEFAULTS.language === 'ts',
    });
  });

  it('should hand the full-screen confirmation its default', async () => {
    // the answer is "no", which is the default and what the stub gives back
    expect(await askTui({}, false, 'multi', 'demo')).toBeUndefined();
    expect(vi.mocked(confirm).mock.calls.at(-1)?.[0]).toMatchObject({ default: DEFAULTS.tui });
  });

  it('should answer every one of them from the same list under --yes, asking nothing', async () => {
    expect(await askLayout({}, true)).toBe(DEFAULTS.layout);
    expect(await askSyntax({}, true, { at: 'root' })).toBe(DEFAULTS.syntax);
    expect(await askLinter({}, true)).toBe(DEFAULTS.linter);
    expect(await askLanguage({}, true)).toBe(DEFAULTS.language);
    expect(await askTui({}, true, 'multi', 'demo')).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('should let --tui-command say multi, whatever the default is', async () => {
    expect(await askLayout({ tuiCommand: 'ops' }, true)).toBe('multi');
  });

  it('should let --layout answer before the default is asked', async () => {
    expect(await askLayout({ layout: 'single' }, true)).toBe('single');
    expect(select).not.toHaveBeenCalled();
  });
});
