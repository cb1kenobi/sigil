import { schema } from '../src/index.ts';
import { main, type ParseState, type Settings } from '@ttylabs/sigil';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The hook that makes the toolchain refuse unknown options, and what it leaves alone.
 *
 * `parse()` keeps the settings object it was handed, so a hook that wrote the flag
 * onto `state.settings` wrote it onto the caller's object. Reproduced: a `main()`
 * given a settings object left it with `allowUnknownOptions: false`, and a second
 * `main()` that reused the object and had an unrelated schema then refused an
 * undeclared option it was entitled to.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** `main()` on the toolchain's schema, answering `--version`, without printing it. */
async function version(settings: Settings): Promise<ParseState> {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return (await main({ argv: ['--version'], schema: schema(), settings })) as ParseState;
}

describe("the toolchain's unknown-option hook", () => {
  it('should set the flag on the parse it ran in', async () => {
    const state = await version({ errorHandler: false });

    expect(state.settings.allowUnknownOptions).toBe(false);
  });

  it('should leave the settings object the caller handed in as it was', async () => {
    const settings: Settings = { errorHandler: false };
    await version(settings);

    expect(settings).toEqual({ errorHandler: false });
    expect(settings.allowUnknownOptions).toBeUndefined();
  });

  it('should not refuse an undeclared option in a later parse that reuses the object', async () => {
    const settings: Settings = { errorHandler: false };
    await version(settings);

    // an unrelated schema, which declares nothing and so takes `--foo` as a value
    const later = (await main({
      argv: ['--foo'],
      schema: { name: 'other', run() {} },
      settings,
    })) as ParseState;

    expect(later.argv.foo).toBe(true);
  });
});
