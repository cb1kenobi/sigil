import { schema } from '../src/index.ts';
import { main, type ParseState, type Settings } from '@ttylabs/sigil';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The setting that makes the toolchain refuse unknown options, and what it leaves alone.
 *
 * It rides the schema (`Schema.settings`) rather than a `beforeParse` hook, which
 * is what it was until SIG-333: the generated executable calls `main({ schema })`
 * and nothing else, so only what the schema carries reaches a built app. The hook
 * existed to make that true and copied `state.settings` so as not to write onto
 * the caller's object; `main()` merges into a new object now, and these tests are
 * the part of that which the toolchain depends on.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** `main()` on the toolchain's schema, answering `--version`, without printing it. */
async function version(settings: Settings): Promise<ParseState> {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return (await main({ argv: ['--version'], schema: schema(), settings })) as ParseState;
}

describe("the toolchain's unknown-option setting", () => {
  it('should be on the schema, where a build carries it', () => {
    expect(schema().settings).toEqual({ allowUnknownOptions: false });
    // the hook this replaced, and not hooks in general: an unrelated one is fine
    expect(schema().hooks?.beforeParse).toBeUndefined();
  });

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

  it('should still be overridable by the caller', async () => {
    const state = await version({ allowUnknownOptions: true, errorHandler: false });

    expect(state.settings.allowUnknownOptions).toBe(true);
  });
});
