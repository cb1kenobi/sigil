import { main } from '../src/index.js';
import { parse } from '../src/parser/parse.js';
import { resolveSettings } from '../src/parser/settings.js';
import { runCommand } from '../src/testing/command.js';
import type { ParseState, Schema, Settings } from '../src/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `Schema.settings`, and how it combines with the settings a call passes.
 *
 * An app built with `sigil build` runs a generated `main({ schema })` that never
 * sees the settings the app's own `main()` call carried, so every one of them fell
 * back to its default once built (SIG-333). A schema is what survives the build,
 * so it has to be able to say them. Driven through `runCommand()` where the claim
 * is about what reached stdout, stderr or the exit code.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** A schema with one command, which is all a typo needs something to miss. */
function app(over: Partial<Schema> = {}): Schema {
  return { commands: { build: { run: () => 'built' } }, name: 'demo', ...over };
}

describe('settings on the schema', () => {
  it('should apply when the call passes none', async () => {
    const ran = await runCommand({
      argv: ['build', '--typo'],
      schema: app({ settings: { allowUnknownOptions: false } }),
    });

    expect(ran.err).toContain('Unknown option "--typo"');
    expect(ran.code).toBe(1);
  });

  it('should apply to parse() called on its own', async () => {
    await expect(
      parse({
        argv: ['build', '--typo'],
        schema: app({ settings: { allowUnknownOptions: false } }),
      })
    ).rejects.toThrow('Unknown option "--typo"');
  });

  it('should leave an app that declares none as permissive as it was', async () => {
    const ran = await runCommand({ argv: ['build', '--typo'], schema: app() });

    expect(ran.argv).toMatchObject({ typo: true });
    expect(ran.code).toBe(0);
  });

  it('should set the help exit code', async () => {
    const ran = await runCommand({
      argv: ['--help'],
      schema: app({ settings: { helpExitCode: 3 } }),
    });

    expect(ran.code).toBe(3);
  });

  it('should refuse a value that is not an object', async () => {
    await expect(
      parse({ argv: [], schema: app({ settings: 'strict' as unknown as Settings }) })
    ).rejects.toThrow('Expected schema settings to be an object');
    await expect(
      parse({ argv: [], schema: app({ settings: [] as unknown as Settings }) })
    ).rejects.toThrow('Expected schema settings to be an object');
  });
});

describe('settings on the call', () => {
  it('should apply when the schema declares none', async () => {
    const ran = await runCommand({
      argv: ['build', '--typo'],
      schema: app(),
      settings: { allowUnknownOptions: false },
    });

    expect(ran.err).toContain('Unknown option "--typo"');
  });
});

describe('both together', () => {
  it('should merge per key', async () => {
    const ran = await runCommand({
      argv: ['build'],
      schema: app({ settings: { allowExtraArguments: true, helpExitCode: 3 } }),
      settings: { allowUnknownOptions: false, assertCwd: false },
    });

    expect(ran.state?.settings).toEqual({
      allowExtraArguments: true,
      allowUnknownOptions: false,
      assertCwd: false,
      helpExitCode: 3,
    });
  });

  it('should let the call win a key both name', async () => {
    const ran = await runCommand({
      argv: ['build', '--typo'],
      schema: app({ settings: { allowUnknownOptions: false } }),
      settings: { allowUnknownOptions: true },
    });

    expect(ran.argv).toMatchObject({ typo: true });
    expect(ran.code).toBe(0);
  });

  it('should let the call win the other way round too', async () => {
    const ran = await runCommand({
      argv: ['build', '--typo'],
      schema: app({ settings: { allowUnknownOptions: true } }),
      settings: { allowUnknownOptions: false },
    });

    expect(ran.err).toContain('Unknown option "--typo"');
  });

  it('should treat a key the call names as undefined as not named', async () => {
    // `{ errorHandler: undefined }` is how an optional value looks at a call site,
    // and reading it as "clear the schema's" would turn a setting off by accident
    const ran = await runCommand({
      argv: ['build', '--typo'],
      schema: app({ settings: { allowUnknownOptions: false } }),
      settings: { allowUnknownOptions: undefined },
    });

    expect(ran.err).toContain('Unknown option "--typo"');
  });

  it('should write to neither source', async () => {
    const declared: Settings = Object.freeze({ allowUnknownOptions: false });
    const passed: Settings = Object.freeze({ helpExitCode: 3 });
    const schema = app({
      hooks: {
        beforeParse(state) {
          // what the toolchain's hook used to do to the caller's object
          state.settings.allowExtraArguments = true;
        },
      },
      settings: declared,
    });

    const { state } = await runCommand({ argv: ['build'], schema, settings: passed });

    expect(state?.settings).toEqual({
      allowExtraArguments: true,
      allowUnknownOptions: false,
      helpExitCode: 3,
    });
    expect(state?.settings).not.toBe(declared);
    expect(state?.settings).not.toBe(passed);
    expect(declared).toEqual({ allowUnknownOptions: false });
    expect(passed).toEqual({ helpExitCode: 3 });
  });

  it('should give a second main() that reuses the object a clean slate', async () => {
    const passed: Settings = {};
    const schema = app({
      hooks: {
        beforeParse(state) {
          state.settings.allowUnknownOptions = false;
        },
      },
    });
    await main({ argv: ['build'], schema, settings: passed });

    const later = (await main({
      argv: ['--foo'],
      schema: { name: 'other', run() {} },
      settings: passed,
    })) as ParseState;

    expect(passed).toEqual({});
    expect(later.argv.foo).toBe(true);
  });
});

describe('the settings main() reads itself', () => {
  /** A working directory that no longer exists, as `process.cwd()` reports it. */
  function vanished(): void {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: process.cwd failed: uv_cwd');
    });
  }

  it('should check the working directory by default', async () => {
    vanished();
    const ran = await runCommand({ argv: ['build'], schema: app() });

    expect(ran.err).toContain('Current working directory does not exist');
  });

  it("should honor the schema's assertCwd", async () => {
    vanished();
    const ran = await runCommand({
      argv: ['build'],
      schema: app({ settings: { assertCwd: false } }),
    });

    expect(ran.err).toBe('');
    expect(ran.code).toBe(0);
  });

  it("should let the call's assertCwd beat the schema's", async () => {
    vanished();
    const ran = await runCommand({
      argv: ['build'],
      schema: app({ settings: { assertCwd: false } }),
      settings: { assertCwd: true },
    });

    expect(ran.err).toContain('Current working directory does not exist');
  });

  it("should honor the schema's errorHandler", async () => {
    const seen: unknown[] = [];
    const ran = await runCommand({
      argv: ['nope'],
      schema: app({
        settings: {
          allowUnexpectedArguments: false,
          errorHandler(err) {
            seen.push(err);
            process.stderr.write('custom: handled\n');
            process.exitCode = 9;
          },
        },
      }),
    });

    expect(seen).toHaveLength(1);
    expect(ran.err).toBe('custom: handled\n');
    expect(ran.code).toBe(9);
  });

  it('should honor a schema errorHandler of false by rethrowing', async () => {
    await expect(
      runCommand({
        argv: ['build', '--typo'],
        schema: app({ settings: { allowUnknownOptions: false, errorHandler: false } }),
      })
    ).rejects.toThrow('Unknown option "--typo"');
  });

  it("should let the call's errorHandler beat the schema's", async () => {
    const ran = await runCommand({
      argv: ['build', '--typo'],
      schema: app({
        settings: {
          allowUnknownOptions: false,
          errorHandler() {
            process.stderr.write('schema handler\n');
          },
        },
      }),
      settings: {
        errorHandler() {
          process.stderr.write('call handler\n');
        },
      },
    });

    expect(ran.err).toBe('call handler\n');
  });

  it('should fall back to the built-in handler when the settings cannot be read', async () => {
    const ran = await runCommand({
      argv: [],
      schema: app({ settings: 'nope' as unknown as Settings }),
    });

    expect(ran.err).toContain('Expected schema settings to be an object');
    expect(ran.code).toBe(1);
  });
});

describe('a nested main()', () => {
  it("should not inherit the outer call's settings", async () => {
    let inner: ParseState | undefined;
    const ran = await runCommand({
      argv: ['go'],
      schema: {
        commands: {
          go: {
            async run() {
              inner = (await main({
                argv: ['--typo'],
                schema: { name: 'inner', run() {} },
              })) as ParseState;
            },
          },
        },
        name: 'outer',
        settings: { allowUnknownOptions: false },
      },
      settings: { helpExitCode: 4 },
    });

    expect(ran.err).toBe('');
    expect(inner?.argv.typo).toBe(true);
    expect(inner?.settings).toEqual({});
  });

  it("should run under its own schema's settings when it declares them", async () => {
    let inner: unknown;
    await runCommand({
      argv: ['go'],
      schema: {
        commands: {
          go: {
            async run() {
              inner = await main({
                argv: ['--typo'],
                schema: { name: 'inner', run() {}, settings: { allowUnknownOptions: false } },
                settings: { errorHandler: false },
              }).catch((err: unknown) => err);
            },
          },
        },
        name: 'outer',
      },
    });

    expect((inner as Error).message).toContain('Unknown option "--typo"');
  });
});

describe('resolveSettings()', () => {
  it('should return a new object even with nothing to merge', () => {
    const passed: Settings = { helpExitCode: 1 };

    expect(resolveSettings(undefined, passed)).toEqual(passed);
    expect(resolveSettings(undefined, passed)).not.toBe(passed);
    expect(resolveSettings(undefined, undefined)).toEqual({});
  });
});
