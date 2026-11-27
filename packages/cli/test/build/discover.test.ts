import { discoverApp, readAppCommands, resolveSpecifier } from '../../src/build/discover.js';
import { resolveCommandTree } from '../../src/build/tree.js';
import type { ResolvedCommand } from '../../src/build/tree.js';
import { type AnyCommand, main } from '@ttylabs/sigil';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apps = resolve(__dirname, '../fixtures/discover');
const repo = resolve(__dirname, '../../../..');

/**
 * Builds a throwaway app whose schema module is `source`, with one command
 * module at `./commands/a.js` for its placeholders to point at, hands its
 * directory to `use`, and removes it afterwards.
 */
async function withSchema<T>(
  source: string,
  use: (dir: string) => T | Promise<T>,
  module = "export default { desc: 'from the module', run() {} };\n"
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-placeholder-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'app', type: 'module' })
    );
    mkdirSync(join(dir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(dir, 'src', 'commands', 'a.js'), module);
    writeFileSync(join(dir, 'src', 'index.js'), source);
    return await use(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * The one refusal a placeholder gets for a spread that may carry its `name`,
 * `path` or `load` (SIG-433, SIG-434), left out of a test about another key.
 *
 * Those placeholders spread a name -- `...base` -- to show what happens to `desc`
 * or `alias`, and a spread of a name is the shape the build refuses; the tests
 * about the refusal are the ones that assert it. Exactly one error per command
 * named is removed and none else, and one that is not there fails the test, so
 * this cannot swallow a refusal nobody expected.
 */
function withoutPlacement<T extends { message: string; severity: string }>(
  diagnostics: readonly T[],
  commands: readonly string[]
): T[] {
  const rest = [...diagnostics];
  for (const command of commands) {
    const index = rest.findIndex(
      (d) =>
        d.severity === 'error' &&
        d.message.startsWith(`the "${command}" command `) &&
        d.message.includes('the build cannot tell which')
    );
    expect(index, `a refusal for "${command}"`).toBeGreaterThanOrEqual(0);
    rest.splice(index, 1);
  }

  return rest;
}

/**
 * What the runtime throws registering one command of a schema, which is the
 * wording a build that refuses the same declaration has to match.
 */
async function runtimeRefusal(name: string, declaration: unknown): Promise<string | undefined> {
  // a schema the runtime takes prints its help, which is not this test's output
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await main({
      argv: [],
      schema: { commands: { [name]: declaration as AnyCommand } },
      settings: { errorHandler: false },
    });
  } catch (err) {
    return (err as Error).message;
  } finally {
    write.mockRestore();
  }
  return undefined;
}

/** The command of a name, for reading one entry at a time. */
function at(commands: readonly ResolvedCommand[], name: string): ResolvedCommand {
  const found = commands.find((command) => command.name === name);
  if (!found) {
    throw new Error(`no "${name}" in [${commands.map((c) => c.name).join(', ')}]`);
  }
  return found;
}

/**
 * Finding the app, which is step one of the pipeline and the one that decides
 * whether anything else has something to work on.
 *
 * "Run it from the app root and it works out the rest" is the whole of what
 * makes a toolchain feel like one, and every shortcut in it is a guess -- so
 * the guesses are pinned here, and the entry it picked is reported rather than
 * assumed.
 */
describe('discovering an app', () => {
  it('should read the one executable the manifest publishes', () => {
    // what the built file should be called, and a better answer than the
    // package name: a scoped package's name is not its executable's
    const app = discoverApp(join(repo, 'packages', 'cli'));
    expect(app.manifest.bin).toBe('sigil');
    expect(app.manifest.name).toBe('@ttylabs/cli');
  });

  it('should say nothing when a manifest publishes several', () => {
    // a single-bundle build has no answer for more than one, so it leaves the
    // question to --name rather than picking one by key order
    const dir = mkdtempSync(join(tmpdir(), 'sigil-bin-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          bin: { one: './dist/one.mjs', two: './dist/two.mjs' },
          dependencies: { '@ttylabs/sigil': '*' },
          name: 'two-bins',
        })
      );
      writeFileSync(join(dir, 'src', 'index.js'), 'export default { commands: {} };\n');

      expect(discoverApp(dir).manifest.bin).toBeUndefined();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('should find the root and the entry', () => {
    const app = discoverApp(join(apps, 'router-app'));

    expect(app.root).toBe(join(apps, 'router-app'));
    expect(app.entry).toBe(join(apps, 'router-app', 'src', 'index.ts'));
    expect(app.manifest.name).toBe('router-app');
  });

  it('should take the runtime from any kind of dependency', () => {
    // which one an app declares is a packaging decision, and none of them
    // makes it less of a sigil app
    expect(() => discoverApp(join(apps, 'inline-app'))).not.toThrow();
  });

  it('should refuse a directory that does not depend on the runtime', () => {
    // every error after this one would be a worse version of the same message
    expect(() => discoverApp(join(apps, 'not-an-app'))).toThrow(
      /does not depend on @ttylabs\/sigil/
    );
  });

  it('should refuse a directory with no manifest at all', () => {
    expect(() => discoverApp(join(apps, 'router-app', 'src'))).toThrow(/No package\.json in/);
  });

  it('should say what it looked for when there is no entry', () => {
    expect(() => discoverApp(join(apps, 'no-entry'))).toThrow(/Looked for .*--entry/s);
  });

  it('should prefer source over what the manifest names', () => {
    // a published CLI points its `bin` at built output, so following it means
    // parsing a minified bundle whose specifiers are chunk names a bundler
    // invented -- `check` reads what the author edits
    const app = discoverApp(join(apps, 'built-app'));

    expect(app.entry).toBe(join(apps, 'built-app', 'src', 'index.ts'));
    expect(app.entry).not.toContain('dist');
  });

  it('should take an entry the caller names', () => {
    const app = discoverApp(join(apps, 'built-app'), { entry: 'dist/cli.mjs' });
    expect(app.entry).toBe(join(apps, 'built-app', 'dist', 'cli.mjs'));
  });

  it('should refuse an entry the caller names that is not there', () => {
    expect(() => discoverApp(join(apps, 'built-app'), { entry: 'nope.ts' })).toThrow(
      /Entry module not found/
    );
  });

  it('should find this very toolchain, which is the acceptance test', () => {
    // a framework whose toolchain is not written in it has not been tested by
    // anyone who had to live with it
    const app = discoverApp(join(repo, 'packages', 'cli'));

    expect(app.manifest.name).toBe('@ttylabs/cli');
    expect(app.entry).toBe(join(repo, 'packages', 'cli', 'src', 'index.ts'));
  });
});

describe("reading where an app's commands are", () => {
  it('should read a path as a directory for the router to walk', () => {
    const app = discoverApp(join(apps, 'router-app'));
    const { commands } = readAppCommands(app);

    expect(commands?.kind).toBe('directory');
    expect(commands).toMatchObject({ dir: join(apps, 'router-app', 'src', 'commands') });
  });

  it('should resolve that path against the entry, not the working directory', () => {
    const app = discoverApp(join(apps, 'router-app'));
    const { commands } = readAppCommands(app);

    // the entry is `src/index.ts`, so `./commands` is `src/commands`
    expect(commands).toMatchObject({ dir: join(app.entry, '..', 'commands') });
  });

  describe('a schema that writes its commands out', () => {
    it('should read each one', () => {
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);

      expect(commands?.kind).toBe('inline');
      expect(commands?.kind === 'inline' ? commands.commands.map((c) => c.name) : []).toStrictEqual(
        ['build', 'db', 'inline', 'missing']
      );
    });

    it('should follow a load() to the module beside it', () => {
      // the `.js` to `.ts` fallback is the convention this repo follows
      // itself: a TypeScript ES module imports its neighbour as `./build.js`
      // while the file on disk is `build.ts`
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'build').module).toBe(
        join(apps, 'inline-app', 'src', 'commands', 'build.ts')
      );
    });

    it("should let the placeholder's description win over the module's", () => {
      // what the placeholder declares is what help shows before the module
      // loads, which is the runtime's merge read from the other side
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'build').desc).toBe('build it');
    });

    it("should fall back to the module's description when the placeholder has none", () => {
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];
      const db = at(list, 'db');

      expect(at(db.commands, 'migrate').desc).toBe('migrate the database');
    });

    it('a translated desc was baked as English for a command declared as { load } or { path }', () => {
      // SIG-352. The object form rebuilt the command from `desc`, `hidden` and
      // `module` and dropped the lifted `descTranslated`, so the generated tree
      // printed the key as a plain string where a string path to the same
      // module printed `() => __\`...\`` -- two spellings of one declaration
      // disagreeing about whether help is translated
      const app = discoverApp(join(apps, 'translated-placeholders'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(diagnostics).toStrictEqual([]);
      for (const name of ['loaded', 'object', 'pathed']) {
        expect(at(list, name)).toMatchObject({
          desc: 'Build the app',
          descTranslated: true,
          name,
        });
      }

      // the placeholder's own literal wins, and it is prose rather than a key
      expect(at(list, 'literal').desc).toBe('Its own words');
      expect(at(list, 'literal').descTranslated).toBeUndefined();
    });

    it("a placeholder's tagged, thunked or computed desc and computed hidden were replaced by the module's", () => {
      // SIG-352. The runtime registers the placeholder as written, so whatever
      // `desc` or `hidden` it declares is what an unloaded command shows, and
      // the build baked the module's answer wherever the placeholder's was not
      // a plain literal
      const app = discoverApp(join(apps, 'placeholder-decides'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      // a tag evaluated at import is the English from source, so it is prose
      expect(at(list, 'tagged').desc).toBe('Placeholder words');
      expect(at(list, 'tagged').descTranslated).toBeUndefined();
      // a thunk is evaluated after the catalog, so it stays a key
      expect(at(list, 'thunk')).toMatchObject({ desc: 'Placeholder words', descTranslated: true });
      // unreadable: nothing baked, and said so
      expect(at(list, 'computed').desc).toBeUndefined();
      expect(at(list, 'computed').descTranslated).toBeUndefined();
      expect(at(list, 'shown').hidden).toBeUndefined();

      expect(diagnostics.map((d) => [d.severity, d.message])).toStrictEqual([
        [
          'warning',
          'the "computed" command\'s "desc" is computed rather than a string literal, so it cannot be read at build time; the built app will list it by name alone',
        ],
        [
          'warning',
          'the "shown" command\'s "hidden" is computed rather than a boolean literal, so it cannot be read at build time; the built app will list it in help',
        ],
      ]);
    });

    it("should refuse a placeholder's desc or hidden of the wrong type, in the runtime's words", () => {
      const dir = mkdtempSync(join(tmpdir(), 'sigil-placeholder-types-'));
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'types' })
        );
        mkdirSync(join(dir, 'src', 'commands'), { recursive: true });
        writeFileSync(join(dir, 'src', 'commands', 'a.js'), 'export default { run() {} };\n');
        writeFileSync(
          join(dir, 'src', 'index.js'),
          `export default {
  baseDir: import.meta.dirname,
  commands: {
    num: { desc: 42, path: './commands/a.js' },
    str: { hidden: 'yes', path: './commands/a.js' },
  },
};\n`
        );

        const { diagnostics } = readAppCommands(discoverApp(dir));

        expect(
          diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
        ).toStrictEqual([
          'Expected desc for the "num" command to be a string or a function',
          'Expected hidden to be a boolean in "str" command',
        ]);
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });

    it('an inline `__proto__` key was read as a command, though it sets the prototype and declares none', async () => {
      // SIG-634. From source the key is prototype sugar, so `__proto__` is no
      // command; the build read it by name and, once `generateCommands()` wrote a
      // command of that name as an own key, would have given the built app one
      await withSchema(
        `export default {
  baseDir: import.meta.dirname,
  commands: { __proto__: { desc: 'sugar', path: './commands/a.js' }, ok: { desc: 'ok', path: './commands/a.js' } },
};\n`,
        (dir) => {
          const { commands } = readAppCommands(discoverApp(dir));
          expect(commands?.kind).toBe('inline');
          expect(
            commands?.kind === 'inline' ? commands.commands.map((command) => command.name) : []
          ).toStrictEqual(['ok']);
        }
      );
    });

    it("a placeholder's async desc, method hidden or non-string thunk was let through, though the runtime refuses each", async () => {
      // SIG-421. The first was worse than a warning: the build baked `x`, so the
      // built app worked while the same app from source crashed at start. The
      // other two only warned. Each is now the runtime's own error, in its
      // words -- asked of the runtime itself rather than written out here, over
      // the very schema the build read, and naming the command as it does: the
      // parsed name for a `desc`, the name string as declared for a `hidden`
      const source = `export default {
  baseDir: import.meta.dirname,
  commands: {
    'build, b': { desc: async () => 'x', path: './commands/a.js' },
    '!secret': { desc: () => 42, path: './commands/a.js' },
    gen: { *desc() {}, path: './commands/a.js' },
    nothing: { desc: () => undefined, path: './commands/a.js' },
    'remove, rm': { hidden() { return true; }, path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, async (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const schema = (
          (await import(pathToFileURL(join(dir, 'src', 'index.js')).href)) as {
            default: { commands: Record<string, unknown> };
          }
        ).default;

        const refusals: (string | undefined)[] = [];
        for (const [name, declaration] of Object.entries(schema.commands)) {
          refusals.push(await runtimeRefusal(name, declaration));
        }
        expect(refusals).toStrictEqual([
          'Expected desc for the "build" command to return a string',
          'Expected desc for the "secret" command to return a string',
          'Expected desc for the "gen" command to return a string',
          'Expected desc for the "nothing" command to return a string',
          'Expected hidden to be a boolean in "remove, rm" command',
        ]);
        expect(diagnostics.map((d) => [d.severity, d.message])).toStrictEqual(
          refusals.map((message) => ['error', message])
        );
        // and nothing is baked for any of them -- `x` least of all
        for (const name of ['build, b', '!secret', 'gen', 'nothing']) {
          expect(at(list, name).desc).toBeUndefined();
        }
        expect(at(list, 'remove, rm').hidden).toBeUndefined();
      });
    });

    it('refused a desc or hidden that a later spread or computed key replaces, though the runtime starts fine', async () => {
      // SIG-421, from review. The refusals read the last *explicit* spelling,
      // and a spread or a computed key after it replaces it -- so the value the
      // runtime registers is a fine one and the app starts, while the build
      // failed. What may be replaced is unknown, as it is in a module: a
      // warning, nothing baked, and never an error
      // `let`, so that the spread is of a name the build cannot resolve (SIG-440)
      const source = `let base = { desc: 'Build the app', path: './commands/a.js' };
export default {
  baseDir: import.meta.dirname,
  commands: {
    async: { desc: async () => 'x', ...base },
    number: { desc: () => 42, ...base },
    method: { hidden() { return true; }, ...{ hidden: false, path: './commands/a.js' } },
    computed: { desc: async () => 'x', ['desc']: 'Build the app', path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, async (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const schema = (
          (await import(pathToFileURL(join(dir, 'src', 'index.js')).href)) as {
            default: { commands: Record<string, unknown> };
          }
        ).default;

        for (const [name, declaration] of Object.entries(schema.commands)) {
          expect(await runtimeRefusal(name, declaration), name).toBeUndefined();
        }

        const before = (name: string, key: string, consequence: string) =>
          `the "${name}" command's "${key}" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; ${consequence}`;
        const carried = (name: string, key: string, consequence: string) =>
          `the "${name}" command spreads another object, which may carry ${key === 'alias' ? 'an' : 'a'} "${key}" this cannot see; ${consequence}`;
        const alias = 'the built app will not answer to the alias the app runs with';
        const isDefault = 'the built app will not run it when argv names no command';
        expect(
          withoutPlacement(diagnostics, ['async', 'number'])
            // a spread may carry `commands` too, which is asked in its own test (SIG-726)
            .filter((d) => !d.message.includes('"commands"'))
            .map((d) => [d.severity, d.message])
        ).toStrictEqual([
          ['warning', before('async', 'desc', 'the built app will list it by name alone')],
          // `base` is a name, so it may carry a `hidden` too, and the two keys
          // that route (SIG-430)
          ['warning', carried('async', 'hidden', 'the built app will list it in help')],
          ['warning', carried('async', 'alias', alias)],
          ['warning', carried('async', 'default', isDefault)],
          ['warning', before('number', 'desc', 'the built app will list it by name alone')],
          ['warning', carried('number', 'hidden', 'the built app will list it in help')],
          ['warning', carried('number', 'alias', alias)],
          ['warning', carried('number', 'default', isDefault)],
        ]);
        // ...and nothing baked, `x` least of all
        for (const name of ['async', 'number']) {
          expect(at(list, name).desc).toBeUndefined();
        }
        // a spread of a literal is what it holds and `['desc']` is `desc`, so
        // what replaces the method and the thunk is read rather than unknown
        // (SIG-433, SIG-434)
        expect(at(list, 'method').hidden).toBe(false);
        expect(at(list, 'computed').desc).toBe('Build the app');
      });
    });

    it('took any later spread or computed key for one that may replace a desc or hidden, and let an undefined past it', async () => {
      // SIG-421, review round 2. Whether a later property may replace a key is
      // read rather than assumed: `['path']` and `...{ path }` cannot, so the
      // spelling before them is the one that runs -- baked when it is readable,
      // refused when the runtime refuses it, `!` name or not. And a
      // `desc: undefined` that a spread replaces is a `desc`, not the module's
      // `let`, so that the spread is of a name the build cannot resolve (SIG-440)
      const source = `let base = { path: './commands/a.js' };
export default {
  baseDir: import.meta.dirname,
  commands: {
    keyed: { desc: 'Build the app', ['path']: './commands/a.js' },
    refused: { desc: async () => 'x', ['path']: './commands/a.js' },
    shown: { hidden: true, ...{ path: './commands/a.js' } },
    '!secret': { hidden() { return true; }, ...{ path: './commands/a.js' } },
    spread: { desc: undefined, ...{ desc: 'from spread' }, path: './commands/a.js' },
    '!quiet': { hidden: true, ...base },
  },
};\n`;

      await withSchema(source, async (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const schema = (
          (await import(pathToFileURL(join(dir, 'src', 'index.js')).href)) as {
            default: { commands: Record<string, unknown> };
          }
        ).default;

        const runtime: Record<string, string | undefined> = {};
        for (const [name, declaration] of Object.entries(schema.commands)) {
          runtime[name] = await runtimeRefusal(name, declaration);
        }
        expect(runtime).toStrictEqual({
          keyed: undefined,
          refused: 'Expected desc for the "refused" command to return a string',
          shown: undefined,
          '!secret': 'Expected hidden to be a boolean in "!secret" command',
          spread: undefined,
          '!quiet': undefined,
        });

        expect(
          withoutPlacement(diagnostics, ['quiet'])
            // a spread may carry `commands` too, which is asked in its own test (SIG-726)
            .filter((d) => !d.message.includes('"commands"'))
            .map((d) => [d.severity, d.message])
        ).toStrictEqual([
          ['error', runtime.refused],
          ['error', runtime['!secret']],
          [
            'warning',
            'the "quiet" command spreads another object, which may carry a "desc" this cannot see; the built app will list it by name alone',
          ],
          [
            'warning',
            'the "quiet" command\'s "hidden" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; the "!" in its name hides it either way, unless the value the app runs with is neither a boolean nor undefined, which the app refuses',
          ],
          // `base` is a name, so it may carry the two keys that route (SIG-430)
          [
            'warning',
            'the "quiet" command spreads another object, which may carry an "alias" this cannot see; the built app will not answer to the alias the app runs with',
          ],
          [
            'warning',
            'the "quiet" command spreads another object, which may carry a "default" this cannot see; the built app will not run it when argv names no command',
          ],
        ]);
        expect(at(list, 'keyed').desc).toBe('Build the app');
        expect(at(list, 'shown').hidden).toBe(true);
        // the runtime shows `from spread` before the module loads, and the
        // spread is a literal, so that is what is baked (SIG-433, SIG-434)
        expect(at(list, 'spread').desc).toBe('from spread');
        expect(at(list, '!quiet').hidden).toBeUndefined();
      });
    });

    it('took a spread or computed key of a non-object literal for one that may replace a desc or hidden, and baked the module’s answer over a spread that may carry it', async () => {
      // SIG-421, review round 3. An array or a string spreads its indices, a
      // primitive spreads nothing, and a literal key is what `String()` makes of
      // it -- so the spelling before them is the one that runs. And a key the
      // placeholder spells nowhere is still the placeholder's when a spread may
      // carry it, since the runtime merges the module in only where the
      // placeholder's key is `undefined`: the module's answer was baked
      const source = `export default {
  baseDir: import.meta.dirname,
  commands: {
    array: { desc: 'Build the app', ...[1, 2], path: './commands/a.js' },
    string: { desc: 'Build the app', ...'ab', path: './commands/a.js' },
    off: { hidden: true, ...false, path: './commands/a.js' },
    nulled: { desc: async () => 'x', ...null, path: './commands/a.js' },
    keyed: { desc: 'Build the app', [1]: 0, [1n]: 0, [true]: 0, [null]: 0, path: './commands/a.js' },
    // the spread is before desc, which is what makes second the one that runs
    second: { ...{ desc: 'spread' }, desc: 'second', [0]: true, path: './commands/a.js' },
    zero: { desc: async () => 'x', [0]: 1, path: './commands/a.js' },
    absent: { ...{ desc: 'from the placeholder', hidden: true }, path: './commands/a.js' },
    '!quiet': { hidden: true, ...{ hidden: undefined }, path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, async (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const schema = (
          (await import(pathToFileURL(join(dir, 'src', 'index.js')).href)) as {
            default: { commands: Record<string, unknown> };
          }
        ).default;

        const runtime: Record<string, string | undefined> = {};
        for (const [name, declaration] of Object.entries(schema.commands)) {
          runtime[name] = await runtimeRefusal(name, declaration);
        }
        expect(runtime).toStrictEqual({
          array: undefined,
          string: undefined,
          off: undefined,
          nulled: 'Expected desc for the "nulled" command to return a string',
          keyed: undefined,
          second: undefined,
          zero: 'Expected desc for the "zero" command to return a string',
          absent: undefined,
          // `undefined` is not refused, and the `!` still hides it
          '!quiet': undefined,
        });

        expect(diagnostics.map((d) => [d.severity, d.message])).toStrictEqual([
          ['error', runtime.nulled],
          ['error', runtime.zero],
        ]);
        for (const name of ['array', 'string', 'keyed']) {
          expect(at(list, name).desc, name).toBe('Build the app');
        }
        expect(at(list, 'off').hidden).toBe(true);
        expect(at(list, 'second').desc).toBe('second');
        // the placeholder's spread decides both, so the module's are not baked --
        // and it is a literal, so what it holds is (SIG-433, SIG-434)
        expect(at(list, 'absent').desc).toBe('from the placeholder');
        expect(at(list, 'absent').hidden).toBe(true);
        // a `hidden: undefined` that a literal spread puts last is not declared
        expect(at(list, '!quiet').hidden).toBeUndefined();
      });
    });

    it('took a regular expression key for one that may carry anything', async () => {
      // SIG-421, review round 4. A regular expression is a literal too, and the
      // key it converts to is `String()` of it, which is no desc. Beside it, a
      // spread of `undefined`, `void 0` or `[null]` carries no desc either
      const source = `export default {
  baseDir: import.meta.dirname,
  commands: {
    pattern: { desc: 'Build the app', [/desc/g]: 0, path: './commands/a.js' },
    undefined: { desc: 'Build the app', ...undefined, path: './commands/a.js' },
    voided: { desc: 'Build the app', ...void 0, path: './commands/a.js' },
    nulls: { desc: 'Build the app', ...[null], path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, async (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const schema = (
          (await import(pathToFileURL(join(dir, 'src', 'index.js')).href)) as {
            default: { commands: Record<string, unknown> };
          }
        ).default;

        for (const [name, declaration] of Object.entries(schema.commands)) {
          expect(await runtimeRefusal(name, declaration), name).toBeUndefined();
        }
        expect(diagnostics).toStrictEqual([]);
        for (const name of ['pattern', 'undefined', 'voided', 'nulls']) {
          expect(at(list, name).desc, name).toBe('Build the app');
        }
      });
    });

    it('took an array holding a spread for one that carries only indices, though the spread may throw', async () => {
      // SIG-421, review round 4. `[...null]` throws when the schema is
      // evaluated, so the app never starts -- and the build baked the desc
      // before it. It is not a literal read off the source, so it is unknown
      const source = `export default {
  baseDir: import.meta.dirname,
  commands: {
    spread: { desc: 'Build the app', ...[...null], path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, async (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];

        await expect(import(pathToFileURL(join(dir, 'src', 'index.js')).href)).rejects.toThrow(
          TypeError
        );
        expect(
          withoutPlacement(diagnostics, ['spread'])
            // a spread may carry `commands` too, which is asked in its own test (SIG-726)
            .filter((d) => !d.message.includes('"commands"'))
            .map((d) => [d.severity, d.message])
        ).toStrictEqual([
          [
            'warning',
            'the "spread" command\'s "desc" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; the built app will list it by name alone',
          ],
          [
            'warning',
            'the "spread" command spreads another object, which may carry a "hidden" this cannot see; the built app will list it in help',
          ],
          // ...and the two keys that route (SIG-430)
          [
            'warning',
            'the "spread" command spreads another object, which may carry an "alias" this cannot see; the built app will not answer to the alias the app runs with',
          ],
          [
            'warning',
            'the "spread" command spreads another object, which may carry a "default" this cannot see; the built app will not run it when argv names no command',
          ],
        ]);
        expect(at(list, 'spread').desc).toBeUndefined();
      });
    });

    it('should read a key built by an expression, or a spread of a conditional with an arm that is not a literal, as one that may carry anything', async () => {
      // literals are read and expressions are not evaluated, which can only
      // turn a bake into a warning and never bake a wrong value
      const source = `const flag = false;
const other = { other: 2 };
export default {
  baseDir: import.meta.dirname,
  commands: {
    joined: { desc: 'Build the app', ['de' + 'sc']: 'Joined', path: './commands/a.js' },
    either: { desc: 'Build the app', ...(flag ? { other: 1 } : other), path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, async (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const schema = (
          (await import(pathToFileURL(join(dir, 'src', 'index.js')).href)) as {
            default: { commands: Record<string, unknown> };
          }
        ).default;

        for (const [name, declaration] of Object.entries(schema.commands)) {
          expect(await runtimeRefusal(name, declaration), name).toBeUndefined();
        }
        expect(
          diagnostics
            .filter((d) => d.message.includes('"desc"'))
            .map((d) => [d.severity, d.message])
        ).toStrictEqual(
          ['joined', 'either'].map((name) => [
            'warning',
            `the "${name}" command's "desc" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; the built app will list it by name alone`,
          ])
        );
        expect(at(list, 'joined').desc).toBeUndefined();
        expect(at(list, 'either').desc).toBeUndefined();
      });
    });

    it('should read a last `undefined` as not declared, and take the module’s desc', async () => {
      // `declared()` in `placeholderFacts()`. The runtime merges the module's
      // `desc` in wherever the placeholder's is `undefined`, so the lift is what
      // applies -- where treating it as declared bakes nothing and warns that the
      // value is computed
      const source = `export default {
  baseDir: import.meta.dirname,
  commands: {
    bare: { desc: undefined, path: './commands/a.js' },
    late: { desc: 'early', desc: undefined, path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];

        expect(diagnostics).toStrictEqual([]);
        expect(at(list, 'bare').desc).toBe('from the module');
        expect(at(list, 'late').desc).toBe('from the module');
      });
    });

    it('should warn about a thunk over a computed value rather than refuse it as the wrong type', async () => {
      // the `literalType(value) !== 'function'` guard in `placeholderFacts()`. A
      // function is one of the two types a `desc` takes, so a thunk this cannot
      // read is computed rather than wrong -- and without the guard a valid app
      // failed to build
      const source = `const words = 'computed words';
export default {
  baseDir: import.meta.dirname,
  commands: {
    thunk: { desc: () => words, path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];

        expect(diagnostics.map((d) => [d.severity, d.message])).toStrictEqual([
          [
            'warning',
            'the "thunk" command\'s "desc" is computed rather than a string literal, so it cannot be read at build time; the built app will list it by name alone',
          ],
        ]);
        expect(at(list, 'thunk').desc).toBeUndefined();
      });
    });

    it('named a command by its raw key in a message where the runtime parses it', async () => {
      // SIG-421. `'build, b'` is the `build` command and `'!secret'` the
      // `secret` one, read with the runtime's own `parseName()` -- except where
      // the runtime's own message names the name string as declared, which a
      // build refusing the same thing repeats rather than improves on
      const source = `const words = 'computed words';
const names = ['rm'];
export default {
  baseDir: import.meta.dirname,
  commands: {
    'build, b': { desc: 42, path: './commands/a.js' },
    '!secret, s': { desc: words, path: './commands/a.js' },
    'ship, go': { hidden: 'yes', path: './commands/a.js' },
    'remove, rm': { default: 'yes', alias: names, path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { diagnostics } = readAppCommands(discoverApp(dir));

        expect(diagnostics.map((d) => d.message)).toStrictEqual([
          'Expected desc for the "build" command to be a string or a function',
          'the "s" command\'s "desc" is computed rather than a string literal, so it cannot be read at build time; the built app will list it by name alone',
          'Expected hidden to be a boolean in "ship, go" command',
          'the "remove" command\'s "alias" is computed rather than a string or a list of strings, so it cannot be read at build time; the built app will not answer to it',
          'Expected default in "remove, rm" command to be a boolean',
        ]);
      });
    });

    it('warned that a command hidden by a `!` would be listed because its `hidden` is computed', async () => {
      // SIG-421. A `!` and `hidden` are additive, so whatever `flag` holds the
      // built app hides the command -- the warning was false. A `hidden` of the
      // wrong type is still refused, since the runtime throws on it either way
      const source = `const flag = false;
export default {
  baseDir: import.meta.dirname,
  commands: {
    '!quiet': { hidden: flag, path: './commands/a.js' },
    '!wrong': { hidden: 'yes', path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];

        expect(diagnostics.map((d) => [d.severity, d.message])).toStrictEqual([
          ['error', 'Expected hidden to be a boolean in "!wrong" command'],
        ]);
        expect(at(list, '!quiet').hidden).toBeUndefined();
      });
    });

    it('called a placeholder’s interpolated `__` tag computed, where a module’s gets a message of its own', async () => {
      // SIG-421. The tag is the thing the author is looking at, and its
      // neighbour without an interpolation lifted fine -- so "computed rather
      // than a string literal" names nothing to act on. A thunk over one is
      // the same thing evaluated later
      const source = `import { __ } from '@ttylabs/sigil/i18n';
const who = 'you';
export default {
  baseDir: import.meta.dirname,
  commands: {
    tagged: { desc: __\`Greet \${who}\`, path: './commands/a.js' },
    thunk: { desc: () => __\`Greet \${who}\`, path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { diagnostics } = readAppCommands(discoverApp(dir));

        expect(diagnostics.map((d) => [d.severity, d.message])).toStrictEqual(
          ['tagged', 'thunk'].map((name) => [
            'warning',
            `the "${name}" command's "desc" is a translated string with a value interpolated into it, so it cannot be read at build time; the built app will list it by name alone`,
          ])
        );
      });
    });

    it('should nest a subcommand under its parent', () => {
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'db').commands.map((c) => c.name)).toStrictEqual(['migrate']);
    });

    it('should take a command declared with no module at all', () => {
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'inline').module).toBeUndefined();
      expect(at(list, 'inline').desc).toBe('declared here, no module');
    });

    it("should read a placeholder's alias, as a string or as a list", () => {
      const app = discoverApp(join(__dirname, '../fixtures/aliased'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'remove').alias).toStrictEqual(['del']);
      // the template literal with no substitutions is a string somebody wrote
      expect(at(list, 'list').alias).toStrictEqual(['ls', 'dir']);
      expect(at(at(list, 'db').commands, 'drop').alias).toStrictEqual(['rm']);
      expect(at(at(list, 'db').commands, 'drop').default).toBe(true);
      expect(at(list, 'secret').alias).toStrictEqual(['sh']);
      expect(at(list, 'secret').hidden).toBe(true);
      // ...and a command that wrote none has none, rather than an empty list
      expect(at(at(list, 'db').commands, 'drop').hidden).toBeUndefined();
      expect(at(list, 'db').alias).toBeUndefined();
      expect(diagnostics).toStrictEqual([]);
    });

    it("should register a command under its declaration's name string, which beats the key", () => {
      // the runtime fills the key in only when `name` is undefined, so the string
      // is what the tree is keyed by and the built app's own parser reads it
      const app = discoverApp(join(__dirname, '../fixtures/aliased'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(list.map((command) => command.name)).toStrictEqual([
        'remove',
        'list',
        'secret',
        'purge, pg',
        '@zz, clear',
        'db',
      ]);
      expect(diagnostics).toStrictEqual([]);
    });

    it("should name a package a key points at by the package's own names, not the key", () => {
      // SIG-332. The runtime imports such a package when the schema is built and
      // registers it as `cmd.name ?? pkg.name`, so the key is not a spelling of
      // it, and its module's `alias` routes as a placeholder's does
      const root = join(__dirname, '../fixtures/keyed-package');
      const { commands, diagnostics } = readAppCommands(discoverApp(root));
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(list.map((command) => command.name)).toStrictEqual(['lazy, lz', 'bare-pkg']);
      expect(at(list, 'lazy, lz').alias).toStrictEqual(['pk']);
      expect(at(list, 'lazy, lz').desc).toBe('A package that names itself');
      expect(at(list, 'lazy, lz').module).toBe(join(root, 'src', 'pkg', 'index.js'));
      // named and described by its manifest, and its entry is the manifest's
      // `main` rather than an `index` module
      expect(at(list, 'bare-pkg').alias).toBeUndefined();
      expect(at(list, 'bare-pkg').desc).toBe('A package named by its manifest');
      expect(at(list, 'bare-pkg').module).toBe(join(root, 'src', 'bare', 'lib', 'command.js'));
      expect(diagnostics).toStrictEqual([]);
    });

    it('should name a scoped package a key points at by what follows its scope', async () => {
      // SIG-389. The manifest's name is a name the file system gave, so it is not a
      // name string and its scope is not part of what it is called -- the runtime
      // registers `deploy`, and a build that baked `@acme/deploy` or `acme/deploy`
      // would route the built app differently
      await withSchema(
        "export default { baseDir: import.meta.dirname, commands: { x: './pkg' } };\n",
        (dir) => {
          mkdirSync(join(dir, 'src', 'pkg'), { recursive: true });
          writeFileSync(join(dir, 'src', 'pkg', 'index.js'), 'export default { run() {} };\n');
          writeFileSync(
            join(dir, 'src', 'pkg', 'package.json'),
            JSON.stringify({ main: 'index.js', name: '@acme/deploy', type: 'module' })
          );

          const { commands, diagnostics } = readAppCommands(discoverApp(dir));
          const list = commands?.kind === 'inline' ? commands.commands : [];
          expect(list.map((command) => command.name)).toStrictEqual(['deploy']);
          expect(diagnostics).toStrictEqual([]);
        }
      );
    });

    it('should refuse a package whose manifest name no route may have, as the runtime does', async () => {
      await withSchema(
        "export default { baseDir: import.meta.dirname, commands: { x: './pkg' } };\n",
        async (dir) => {
          mkdirSync(join(dir, 'src', 'pkg'), { recursive: true });
          writeFileSync(join(dir, 'src', 'pkg', 'index.js'), 'export default { run() {} };\n');
          writeFileSync(
            join(dir, 'src', 'pkg', 'package.json'),
            JSON.stringify({ main: 'index.js', name: '@acme/my pkg', type: 'module' })
          );

          const { diagnostics } = readAppCommands(discoverApp(dir));
          const errors = diagnostics.filter((d) => d.severity === 'error');
          expect(errors).toHaveLength(1);
          expect(errors[0]!.message).toMatch(
            /^the "x" command is a package the app cannot name: Cannot route the package ".*pkg" \(its package\.json name is "@acme\/my pkg"\): the command name "my pkg" contains whitespace/
          );
          expect(errors[0]!.message).toContain('commands.json');

          // and the runtime refuses the same package in the same words
          await expect(
            main({
              argv: [],
              schema: { commands: { x: join(dir, 'src', 'pkg') } },
              settings: { errorHandler: false },
            })
          ).rejects.toThrow(
            /Cannot route the package ".*pkg" \(its package\.json name is "@acme\/my pkg"\)/
          );
        }
      );
    });

    it.each([
      ['""', '', /is empty/],
      ['42', '', /its package\.json name is 42, which is not a string/],
      ['null', '', /its package\.json name is null, which is not a string/],
      // Node refuses a present name that is not a string whether or not the module names
      // itself, so the build must too -- these built, and failed from source
      ['42', "name: 'mine', ", /its package\.json name is 42, which is not a string/],
      ['null', "name: 'mine', ", /its package\.json name is null, which is not a string/],
    ])(
      'should refuse the manifest name %s, with module %j, in the runtime’s words, not its own',
      async (json, own, reason) => {
        // an empty name used to be reported as "both leave it unnamed", which the runtime
        // does not say, and a number never reached the runtime's refusal at all
        await withSchema(
          "export default { baseDir: import.meta.dirname, commands: { x: './pkg' } };\n",
          async (dir) => {
            mkdirSync(join(dir, 'src', 'pkg'), { recursive: true });
            writeFileSync(
              join(dir, 'src', 'pkg', 'index.js'),
              `export default { ${own}run() {} };\n`
            );
            writeFileSync(
              join(dir, 'src', 'pkg', 'package.json'),
              `{ "main": "index.js", "name": ${json}, "type": "module" }`
            );

            const { diagnostics } = readAppCommands(discoverApp(dir));
            const errors = diagnostics.filter((d) => d.severity === 'error');
            expect(errors).toHaveLength(1);
            expect(errors[0]!.message).toMatch(reason);
            expect(errors[0]!.message).toMatch(/Cannot route the package ".*pkg"/);
            expect(errors[0]!.message).not.toContain('both leave it unnamed');

            // refused before anything is imported, so this is sigil's refusal and not
            // Node's `ERR_INVALID_PACKAGE_CONFIG`, which `route-manifest-name.test.ts`
            // proves under a Node that loads the module itself
            await expect(
              main({
                argv: [],
                schema: { commands: { x: join(dir, 'src', 'pkg') } },
                settings: { errorHandler: false },
              })
            ).rejects.toThrow(reason);
          }
        );
      }
    );

    it("should leave a package's own module name alone, which is a declaration", async () => {
      await withSchema(
        "export default { baseDir: import.meta.dirname, commands: { x: './pkg' } };\n",
        (dir) => {
          mkdirSync(join(dir, 'src', 'pkg'), { recursive: true });
          writeFileSync(
            join(dir, 'src', 'pkg', 'index.js'),
            "export default { name: 'ship, s', run() {} };\n"
          );
          writeFileSync(
            join(dir, 'src', 'pkg', 'package.json'),
            JSON.stringify({ main: 'index.js', name: 'not a name', type: 'module' })
          );

          const { commands, diagnostics } = readAppCommands(discoverApp(dir));
          const list = commands?.kind === 'inline' ? commands.commands : [];
          expect(list.map((command) => command.name)).toStrictEqual(['ship, s']);
          expect(diagnostics.filter((d) => d.severity === 'error')).toStrictEqual([]);
        }
      );
    });

    it('should refuse a package a key points at whose names it cannot read', () => {
      // from source each of these answers to whatever its module computes, so
      // the build cannot route the built app the same way, and says so rather
      // than baking the key
      const app = discoverApp(join(apps, 'package-names'));
      const { diagnostics } = readAppCommands(app);
      const errors = diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => /^the "(\w+)" command[^;]*|^Expected[^,]*/.exec(d.message)?.[0]);

      expect(errors).toStrictEqual([
        'the "computed" command\'s "name" is computed rather than a string literal, so it cannot be read at build time',
        'the "listed" command\'s "alias" is computed rather than a string or a list of strings, so it cannot be read at build time',
        'the "spread" command is a package whose default export spreads another object, which may carry a "name", "alias" or "default" this cannot read',
        'the "getter" command is a package whose default export declares "name" as an accessor or a method rather than a value, so it cannot be read at build time',
        'the "bracketed" command is a package whose default export has a computed key, which may be a "name", "alias" or "default" this cannot read',
        'Expected command name to be a non-empty string in the "unnamed" command',
        'the "broken" command is a package the app cannot load: Command package does not have a valid export: ' +
          join(apps, 'package-names', 'src', 'broken'),
      ]);
      // the refusal says why, where it is about the names
      expect(
        diagnostics.filter((d) => d.message.includes('answers to the names its own module'))
      ).toHaveLength(5);
    });

    it('should refuse an alias or a default of the wrong type, in the runtime’s words', () => {
      // each of these throws from source on every run, so a build that warned and
      // carried on would turn an app that cannot start into one that does. The
      // message is the runtime's own, with the command named
      const app = discoverApp(join(apps, 'wrong-types'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
      expect(errors).toStrictEqual([
        'Expected alias in "number" command to be a string or list of strings',
        'Expected alias in "mixed" command to be a string or list of strings',
        'Expected alias in "nothing" command to be a string or list of strings',
        'Expected default in "text" command to be a boolean',
        'Expected command name to be a non-empty string in the "empty" command',
        'Expected command name to be a non-empty string in the "named" command',
        'Expected alias in "flag" command to be a string or list of strings',
      ]);
      // ...and says nothing of being "computed", which none of them is
      expect(diagnostics.some((d) => d.message.includes('computed'))).toBe(false);
      expect(at(list, 'number').alias).toBeUndefined();
      expect(at(list, 'text').default).toBeUndefined();
    });

    it('should refuse an alias a route name could not be, in the runtime’s words and with its advice (SIG-688)', () => {
      // from source `initCommand()` refuses each of these on every start, so a build
      // that baked one is an app that cannot run. One function says it for both
      const app = discoverApp(join(apps, 'bad-aliases'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toStrictEqual(
        [
          'Invalid alias "a b" in the "spaced" command: it contains whitespace, which a command name string reads as a separator between aliases. An alias is one name typed on the command line, so write it without whitespace or a ",", and list each spelling as an entry of its own.',
          'Invalid alias "!ls" in the "hidden" command: it starts with "!", which a command name string reads as hiding the command. An alias is a plain name, so write it without the "!" -- to hide the command, set "hidden" to true.',
          'Invalid alias "a,b" in the "comma" command: it contains a ",", which a command name string reads as a separator between aliases. An alias is one name typed on the command line, so write it without whitespace or a ",", and list each spelling as an entry of its own.',
          'Invalid alias "" in the "empty" command: it is empty. An alias is a name typed on the command line, so remove it.',
        ]
      );
      expect(at(list, 'fine').alias).toEqual(['f', 'a!b', 'a@b']);
    });

    it('should read `undefined` as the runtime does, which is as not declared', () => {
      const app = discoverApp(join(apps, 'wrong-types'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'absent').alias).toBeUndefined();
      expect(at(list, 'absent').default).toBeUndefined();
      expect(diagnostics.filter((d) => d.message.includes('"absent"'))).toStrictEqual([]);
    });

    it('should read `void 0` as `undefined` and `!0` as `true`, as the runtime does', () => {
      // both were refused as the wrong type, because an operator over a literal
      // was taken to have a known type without asking which one -- so a schema
      // the app runs from source failed to build
      const app = discoverApp(join(apps, 'wrong-types'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'voided').alias).toBeUndefined();
      expect(at(list, 'voided').default).toBeUndefined();
      expect(diagnostics.filter((d) => d.message.includes('"voided"'))).toStrictEqual([]);
      expect(at(list, 'negated').default).toBe(true);
      expect(diagnostics.filter((d) => d.message.includes('"negated"'))).toStrictEqual([]);
    });

    it('should warn about a property it does not bake inside a literal spread or under a string computed key', async () => {
      // SIG-433, SIG-434. Read off what the literal spells, as the rest of a
      // placeholder is: an inline `run` in a spread of an object literal, or
      // under `['run']`, is as absent from the built app as one written plainly
      // -- built prints help where source runs it
      const source = `export default {
  baseDir: import.meta.dirname,
  commands: {
    direct: { run() {}, path: './commands/a.js' },
    spread: { ...{ run() {} }, path: './commands/a.js' },
    quoted: { ['run']() {}, path: './commands/a.js' },
    nested: { ...{ ...{ options: { '--force': 'f' } } }, path: './commands/a.js' },
    baked: { ...{ desc: 'baked' }, ['hidden']: true, path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { diagnostics } = readAppCommands(discoverApp(dir));
        const warned = diagnostics
          .map((d) => /the "(\w+)" command declares "(\w+)"/.exec(d.message)?.slice(1).join('.'))
          .filter(Boolean);

        expect(warned).toStrictEqual(['direct.run', 'spread.run', 'quoted.run', 'nested.options']);
      });
    });

    it('should lift the desc of a command module that spreads a literal, and not say it cannot see it', async () => {
      // SIG-433, SIG-434. A placeholder's literal spread is baked and a module's
      // was reported as one that "may carry a desc this cannot see", which was
      // false -- the build can see it, and it is what help lists
      const source = `export default {
  baseDir: import.meta.dirname,
  commands: { lit: { path: './commands/lit.js' } },
};\n`;
      const module = `export default { ...{ desc: 'Module desc' }, ['hidden']: false, run() {} };\n`;

      await withSchema(source, (dir) => {
        writeFileSync(join(dir, 'src', 'commands', 'lit.js'), module);
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];

        expect(diagnostics).toStrictEqual([]);
        expect(at(list, 'lit').desc).toBe('Module desc');
        expect(at(list, 'lit').hidden).toBe(false);
      });
    });

    it("should tell a placeholder's annotations to move into the module, which a build keeps", async () => {
      // SIG-718. They are read when the surface is walked, which loads every
      // module, so the module is where they survive a build -- and the advice
      // says so rather than only that they are dropped
      const source = `export default {
  baseDir: import.meta.dirname,
  commands: {
    go: { path: './commands/go.js', destructive: false, idempotent: true, readOnly: true },
  },
};\n`;

      await withSchema(source, (dir) => {
        writeFileSync(join(dir, 'src', 'commands', 'go.js'), 'export default { run() {} };\n');
        const { diagnostics } = readAppCommands(discoverApp(dir));

        expect(diagnostics.map((d) => /declares "(\w+)"/.exec(d.message)?.[1])).toStrictEqual([
          'destructive',
          'idempotent',
          'readOnly',
        ]);
        for (const d of diagnostics) {
          expect(d.severity).toBe('warning');
          expect(d.message).toContain("declare it in the command's module instead");
        }
      });
    });

    it.each([
      ['a getter', "get commands() { return { sub: './commands/a.js' }; }"],
      ['a setter', 'set commands(value) {}'],
      ['a method', "commands() { return { sub: './commands/a.js' }; }"],
    ])(
      'should say a placeholder whose only commands is %s is not carried into a built app',
      async (_what, member) => {
        // SIG-732. The build cannot run code, so the built app has none of the
        // subcommands the runtime gets from it. That is `warnUnbaked()`'s message and
        // nothing else's -- no accessor-specific one -- and it is worded for it: the
        // property is not carried, it applies from source only, and the way out is an
        // object literal
        const source = `export default {
  baseDir: import.meta.dirname,
  commands: { x: { path: './commands/a.js', ${member} } },
};\n`;

        await withSchema(source, (dir) => {
          const { commands, diagnostics } = readAppCommands(discoverApp(dir));
          const list = commands?.kind === 'inline' ? commands.commands : [];

          expect(diagnostics.map((d) => d.message)).toEqual([
            'the "x" command declares "commands" in the schema, which `sigil build` does not carry into a built app (SIG-320); it applies when the app runs from source and not after a build, so write it as an object literal of commands, which is the one form the build reads',
          ]);
          expect(diagnostics[0]!.severity).toBe('warning');
          expect(at(list, 'x').commands).toEqual([]);
        });
      }
    );

    describe('a key written to a spread const after its declaration (SIG-736)', () => {
      const placeholder = (before: string, spread = '...shared') =>
        `${before}\nexport default { baseDir: import.meta.dirname, commands: { x: { ${spread}, path: './commands/a.js' } } };\n`;
      const read = (source: string) =>
        withSchema(source, (dir) => readAppCommands(discoverApp(dir)).diagnostics);
      const unbaked = (diagnostics: readonly { message: string }[]) =>
        diagnostics
          .map((d) => /declares "(\w+)" in the schema/.exec(d.message)?.[1])
          .filter((key) => key !== undefined);

      it.each([
        ['a property assignment', `shared.options = { '--force': {} };`],
        ['a string-keyed one', `shared['options'] = { '--force': {} };`],
        ['a logical assignment', `shared.options ??= {};`],
        ['a destructuring target', `[shared.options] = [{}];`],
        ['an object pattern with a default', `({ a: shared.options = {} } = {});`],
        ['an update', `shared.options++;`],
        ['one inside a function', `function late() { shared.options = {}; }`],
      ])(
        'should report a key the const is given by %s as the spread carrying it',
        async (_what, write) => {
          // the literal holds `hidden` and nothing else, so `options` was reported by
          // nothing while the runtime's placeholder has it
          const diagnostics = await read(placeholder(`const shared = { hidden: true };\n${write}`));

          expect(unbaked(diagnostics)).toEqual(['options']);
          expect(diagnostics.find((d) => d.message.includes('"options"'))).toMatchObject({
            severity: 'warning',
          });
        }
      );

      it('should not report a key that is only read, which the const never held', async () => {
        // a read cannot add a key, and `sealedObject()` gives up on the const for it all
        // the same
        const diagnostics = await read(
          placeholder(`const shared = { hidden: true };\nconsole.log(shared.options);`)
        );

        expect(unbaked(diagnostics)).toEqual([]);
      });

      it.each([
        ['a computed key of a write', `cache[shared.id] = 1;`],
        ['a default of a pattern', `[x = shared.dflt] = [];`],
        ['the object a member write goes through', `shared.nested.leaf = 1;`],
      ])('should not report what is only read to reach a write: %s', async (_what, write) => {
        const diagnostics = await read(
          placeholder(`const shared = { hidden: true };\nconst cache = {};\nlet x;\n${write}`)
        );

        // `nested` is read to reach the leaf and writes nothing to the const
        expect(unbaked(diagnostics)).toEqual([]);
      });

      it('should report the key once when the literal holds it too', async () => {
        const diagnostics = await read(
          placeholder(`const shared = { options: {} };\nshared.options = { '--force': {} };`)
        );

        expect(unbaked(diagnostics)).toEqual(['options']);
      });

      it('should report each key written, and not a baked one', async () => {
        const diagnostics = await read(
          placeholder(
            `const shared = { hidden: true };\nshared.options = {};\nshared.run = () => {};\nshared.desc = 'x';`
          )
        );

        // `desc` is baked and is the other readers' to report, not this one's
        expect(unbaked(diagnostics).sort()).toEqual(['options', 'run']);
      });

      it('should report commands written to the const, which the build never reads from a write', async () => {
        const diagnostics = await read(
          placeholder(
            `const shared = { hidden: true };\nshared.commands = { sub: './commands/a.js' };`
          )
        );

        expect(unbaked(diagnostics)).toEqual(['commands']);
      });

      it('should say nothing more for a computed write, which may be any key, than for any spread it cannot read', async () => {
        // `shared[k] = x` is no list of keys: the answer is the one a spread of an
        // unreadable name has always had, and the literal's own keys are still reported
        const diagnostics = await read(
          placeholder(`const shared = { run() {} };\nconst k = 'options';\nshared[k] = {};`)
        );

        expect(unbaked(diagnostics)).toEqual(['run']);
      });

      it('should report nothing for a const nothing is written to that holds only baked keys', async () => {
        const diagnostics = await read(placeholder(`const shared = { hidden: true };`));

        expect(unbaked(diagnostics)).toEqual([]);
      });
    });

    it('should warn about every property of a placeholder it does not bake', () => {
      const app = discoverApp(join(apps, 'unbaked'));
      const { diagnostics } = readAppCommands(app);

      const warned = diagnostics.map((d) => {
        expect(d.severity).toBe('warning');
        expect(d.message).toContain('SIG-320');
        return /the "(\w+)" command declares "(\w+)"/.exec(d.message)?.slice(1).join('.');
      });

      // the advice is per property: a module can supply what it merges in, and
      // cannot supply anything that routes
      const messages = diagnostics.map((d) => d.message);
      expect(messages.find((m) => m.includes('"run"'))).toContain("command's module");
      expect(messages.find((m) => m.includes('"options"'))).toContain("command's module");
      expect(messages.find((m) => m.includes('"commands"'))).not.toContain('module');
      expect(messages.find((m) => m.includes('"commands"'))).toContain('object literal');

      // `quiet` declares only what is baked, and `remove` has a `load` of its
      // own that is not mentioned either
      expect(warned).toStrictEqual([
        'hi.run',
        'remove.args',
        'remove.examples',
        'remove.format',
        'remove.hooks',
        'remove.options',
        'tagged.tag',
        'nested.commands',
        // a nested placeholder is read like any other
        'drop.run',
      ]);
    });

    it("read a placeholder's alias and default from their first spelling, so the build refused an app that starts and baked a value the runtime replaces", async () => {
      // SIG-430. The runtime registers the object a placeholder ends up as, so
      // the last spelling of a key is the one that routes -- and the build read
      // the first. A spelling a later spread or computed key may replace, or a
      // key a spread may carry and nothing spells, is unknown: a warning and
      // nothing baked, as a computed one is, and never refused
      // `let`, so that the spreads are of names the build cannot resolve (SIG-440)
      const source = `let base = { alias: 'erase', path: './commands/a.js' };
let off = { default: false, path: './commands/a.js' };
export default {
  baseDir: import.meta.dirname,
  commands: {
    ship: { default: 'yes', default: true, path: './commands/a.js' },
    remove: { alias: 42, alias: 'rm', path: './commands/a.js' },
    unset: { alias: 'del', alias: undefined, default: true, default: void 0, path: './commands/a.js' },
    late: { alias: 'rm', alias: 42, path: './commands/a.js' },
    method: { default: true, default() {}, path: './commands/a.js' },
    getter: { alias: 'del', get alias() { return 'erase'; }, path: './commands/a.js' },
    purge: { alias: 'del', ...base },
    stage: { default: true, ...off },
    keyed: { alias: 'del', ['alias']: 'erase', path: './commands/a.js' },
    // a spread of a literal is what it holds, and is read, not unknown
    literal: { alias: 'del', ...{ alias: 'rm', default: true }, path: './commands/a.js' },
    carried: { ...base },
  },
};\n`;

      await withSchema(source, async (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const schema = (
          (await import(pathToFileURL(join(dir, 'src', 'index.js')).href)) as {
            default: { commands: Record<string, unknown> };
          }
        ).default;

        const runtime: Record<string, string | undefined> = {};
        for (const [name, declaration] of Object.entries(schema.commands)) {
          runtime[name] = await runtimeRefusal(name, declaration);
        }
        expect(runtime).toStrictEqual({
          // argv names nothing, so the runtime dispatched it as the default --
          // and a schema with no `baseDir` cannot find its module, which no
          // other command here gets far enough to ask for
          ship: 'Command module not found: ./commands/a.js',
          remove: undefined,
          unset: undefined,
          late: 'Expected command alias to be a string or list of strings',
          method: 'Expected default in "method" command to be a boolean',
          getter: undefined,
          purge: undefined,
          stage: undefined,
          keyed: undefined,
          literal: 'Command module not found: ./commands/a.js',
          carried: undefined,
        });

        const before = (name: string, key: string, consequence: string) =>
          `the "${name}" command's "${key}" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; ${consequence}`;
        const carried = (name: string, key: string, consequence: string) =>
          `the "${name}" command spreads another object, which may carry ${key === 'alias' ? 'an' : 'a'} "${key}" this cannot see; ${consequence}`;
        const alias = 'the built app will not answer to the alias the app runs with';
        const isDefault = 'the built app will not run it when argv names no command';
        expect(
          withoutPlacement(diagnostics, ['purge', 'stage', 'carried'])
            // `desc` and `hidden` say what they always said about a spread, and
            // `commands` is asked in its own test (SIG-726)
            .filter((d) => !/"(?:commands|desc|hidden)"/.test(d.message))
            .map((d) => [d.severity, d.message])
        ).toStrictEqual([
          // each refused where the runtime refuses, and nowhere else
          ['error', 'Expected alias in "late" command to be a string or list of strings'],
          ['error', runtime.method],
          [
            'warning',
            'the "getter" command\'s "alias" is computed rather than a string or a list of strings, so it cannot be read at build time; the built app will not answer to it',
          ],
          ['warning', before('purge', 'alias', alias)],
          ['warning', carried('purge', 'default', isDefault)],
          ['warning', carried('stage', 'alias', alias)],
          ['warning', before('stage', 'default', isDefault)],
          ['warning', carried('carried', 'alias', alias)],
          ['warning', carried('carried', 'default', isDefault)],
        ]);

        // the last spelling is what is baked...
        expect(at(list, 'ship').default).toBe(true);
        expect(at(list, 'remove').alias).toStrictEqual(['rm']);
        // ...an `undefined` last is not declared...
        expect(at(list, 'unset').alias).toBeUndefined();
        expect(at(list, 'unset').default).toBeUndefined();
        // ...and nothing earlier is baked in place of what may replace it
        for (const name of ['late', 'getter', 'purge', 'carried']) {
          expect(at(list, name).alias, name).toBeUndefined();
        }
        // ...while a computed key written as a string, and a spread of a
        // literal, are the keys they spell (SIG-433, SIG-434)
        expect(at(list, 'keyed').alias).toStrictEqual(['erase']);
        expect(at(list, 'literal').alias).toStrictEqual(['rm']);
        expect(at(list, 'literal').default).toBe(true);
        for (const name of ['method', 'stage', 'purge', 'carried']) {
          expect(at(list, name).default, name).toBeUndefined();
        }
      });
    });

    it("read a placeholder's name from its last spelling, and refused one the build cannot read", async () => {
      // SIG-433. The runtime registers the object a placeholder ends up as, and
      // the build keyed its tree by the first `name` it found: `first` where the
      // app answers to `second`. A name nothing here can read is refused rather
      // than warned about, because a built app routed by the wrong one is a
      // command that is simply not there
      // `let`, so that the spread is of a name the build cannot resolve (SIG-440)
      const source = `let named = { name: 'later' };
const key = 'name';
const prefix = 'pre';
const nm = () => 'got';
const on = true;
export default {
  baseDir: import.meta.dirname,
  commands: {
    twice: { name: 'first', name: 'second', path: './commands/a.js' },
    unset: { name: 'gone', name: undefined, path: './commands/a.js' },
    settled: { name: 'early', ...named, name: 'final', path: './commands/a.js' },
    inside: { name: 'early', ...{ other: 1 }, path: './commands/a.js' },
    spreadLiteral: { name: 'early', ...{ name: 'literal' }, path: './commands/a.js' },
    quoted: { ['name']: 'quoted', path: './commands/a.js' },
    quotedLast: { name: 'early', ['name']: 'quotedLast', path: './commands/a.js' },
    symbols: { [Symbol.for('name')]: 1, name: 'symbols', path: './commands/a.js' },
    unrelated: { ...(on && { hidden: true }), path: './commands/a.js' },
    before: { name: 'early', ...named, path: './commands/a.js' },
    carried: { ...named, path: './commands/a.js' },
    keyed: { name: 'early', [key]: 'later', path: './commands/a.js' },
    only: { [key]: 'later', path: './commands/a.js' },
    conditional: { ...(on && { name: 'cond' }), path: './commands/a.js' },
    template: { name: \`\${prefix}-x\`, path: './commands/a.js' },
    call: { name: nm(), path: './commands/a.js' },
    ident: { name: prefix, path: './commands/a.js' },
    getter: { get name() { return 'got'; }, path: './commands/a.js' },
    method: { name() {}, path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const names = list.map((command) => command.name);
        const errors = (command: string) =>
          diagnostics
            .filter((d) => d.severity === 'error' && d.message.includes(`"${command}" command`))
            .map((d) => d.message);

        // the last spelling, and `undefined` is not declared
        expect(names).toContain('second');
        expect(names).not.toContain('first');
        expect(names).toContain('unset');
        // spelled after the spread, so nothing replaces it; a spread that cannot
        // carry one is no reason to refuse; and what a literal holds is read
        expect(names).toContain('final');
        expect(names).toContain('early');
        expect(names).toContain('literal');
        // ...as is a computed key that is a string, and a symbol is not a name
        expect(names).toContain('quoted');
        expect(names).toContain('quotedLast');
        expect(names).toContain('symbols');
        expect(names).toContain('unrelated');
        for (const command of [
          'twice',
          'unset',
          'settled',
          'inside',
          'spreadLiteral',
          'quoted',
          'quotedLast',
          'symbols',
          'unrelated',
        ]) {
          expect(errors(command), command).toEqual([]);
        }

        // each of these is refused once, and says what to write instead
        const blocked = (command: string, how: string) => {
          const [one, ...rest] = errors(command);
          expect(rest, command).toEqual([]);
          expect(one, command).toContain(how);
          expect(one, command).toContain('spell "name" literally, after the last spread');
        };
        blocked('before', 'writes "name" before a spread or a computed key, which may replace it');
        blocked('carried', 'spreads another object, which may carry its "name"');
        blocked('keyed', 'writes "name" before a spread or a computed key');
        blocked('only', 'has a computed key, which may be its "name"');
        blocked('conditional', 'spreads another object, which may carry its "name"');

        // a name that is written and cannot be read is refused in its own words
        for (const command of ['template', 'call', 'ident']) {
          const [one, ...rest] = errors(command);
          expect(rest, command).toEqual([]);
          expect(one, command).toContain('"name" is computed rather than a string literal');
          expect(one, command).toContain('write "name" as a string literal');
        }
        expect(errors('getter')[0]).toContain('"name" is an accessor rather than a string literal');
        expect(errors('getter')).toHaveLength(1);
        // ...and a method is what the runtime refuses for a name
        expect(errors('method')).toEqual([
          'Expected command name to be a non-empty string in the "method" command',
        ]);
      });
    });

    it("read a placeholder's path and load from their last spelling, and refused a module the build cannot read", async () => {
      // SIG-434. A `path` the build cannot see is a module it does not bundle,
      // and the built app then matches the command and has nothing to run. The
      // refusal is for a module that is not known, or known and unreadable: one
      // that is spelled, that nothing replaces and that is a literal decides
      const source = `import { join } from 'node:path';
let pathed = { path: './commands/a.js' };
let loaded = { load: () => import('./commands/a.js') };
const key = 'path';
const path = './commands/a.js';
const on = true;
export default {
  baseDir: import.meta.dirname,
  commands: {
    twice: { path: './commands/a.js', path: './commands/b.js' },
    twiceLoad: { load: () => import('./commands/a.js'), load: () => import('./commands/b.js') },
    unset: { path: './commands/a.js', path: undefined, load: () => import('./commands/b.js') },
    settled: { ...pathed, path: './commands/b.js' },
    beside: { ...loaded, path: './commands/b.js' },
    literal: { path: './commands/b.js', ...{ other: 1 } },
    spreadLiteral: { desc: 'literal', ...{ path: './commands/b.js' } },
    spreadLoad: { ...{ load: () => import('./commands/b.js') } },
    quoted: { ['path']: './commands/b.js' },
    quotedLoad: { ['load']: () => import('./commands/b.js') },
    quotedLast: { path: './commands/a.js', ['path']: './commands/b.js' },
    symbols: { [Symbol('x')]: 1, path: './commands/b.js' },
    asyncLoad: { load: async () => import('./commands/b.js') },
    conditional: { ...(on && { hidden: true }), path: './commands/b.js' },
    carried: { desc: 'carried', ...pathed },
    replaced: { path: './commands/a.js', ...pathed },
    loadCarried: { desc: 'carried', ...loaded },
    loadReplaced: { load: () => import('./commands/a.js'), ...loaded },
    keyed: { [key]: './commands/a.js' },
    conditionalLoad: { ...(on && { load: () => import('./commands/a.js') }) },
    joined: { path: join(import.meta.dirname, 'commands', 'a.js') },
    shorthand: { path },
    named: { path: path },
    template: { path: \`./commands/\${key}.js\` },
    getter: { get path() { return './commands/a.js'; } },
    block: { load: () => { return import('./commands/a.js'); } },
    method: { load() { return import('./commands/a.js'); } },
    both: { path: './commands/a.js', load: () => import('./commands/b.js') },
  },
};\n`;

      await withSchema(source, (dir) => {
        writeFileSync(join(dir, 'src', 'commands', 'b.js'), 'export default { run() {} };\n');
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const module = (name: string) => at(list, name).module?.split(/[\\/]/).at(-1);
        // what is said about a module: a spread beside a `path` also says it
        // cannot tell the name, which the name test is about
        const errors = (command: string) =>
          diagnostics
            .filter(
              (d) =>
                d.severity === 'error' &&
                d.message.includes(`"${command}" command`) &&
                /which module to bundle|^Cannot combine/.test(d.message)
            )
            .map((d) => d.message);

        // the last spelling is the module, what a literal holds is read, and a
        // key a spread may carry beside one that is known needs no say
        for (const command of [
          'twice',
          'twiceLoad',
          'unset',
          'settled',
          'beside',
          'literal',
          'spreadLiteral',
          'spreadLoad',
          'quoted',
          'quotedLoad',
          'quotedLast',
          'symbols',
          'asyncLoad',
          'conditional',
        ]) {
          expect(module(command), command).toBe('b.js');
          expect(errors(command), command).toEqual([]);
        }

        // not known: refused once, naming every key blocked, and what to write
        const blocked = (command: string, how: string) => {
          const [one, ...rest] = errors(command);
          expect(rest, command).toEqual([]);
          expect(one, command).toContain(how);
          expect(one).toMatch(/which module to bundle for (?:the command|it)/);
          expect(one, command).toContain('literally, after the last spread or computed key');
          expect(module(command), command).toBeUndefined();
        };
        blocked('carried', 'spreads another object, which may carry its "name", "path" or "load"');
        blocked(
          'loadCarried',
          'spreads another object, which may carry its "name", "path" or "load"'
        );
        blocked('keyed', 'has a computed key, which may be its "name", "path" or "load"');
        blocked(
          'replaced',
          'writes "path" before a spread or a computed key, which may replace it'
        );
        blocked('loadReplaced', 'writes "load" before a spread or a computed key');
        // a conditional is what its arms carry, so only `load` is in question
        blocked('conditionalLoad', 'spreads another object, which may carry its "load"');

        // known and unreadable: refused, and what the build can bundle is said
        const unreadable = (command: string, why: string) => {
          const [one, ...rest] = errors(command);
          expect(rest, command).toEqual([]);
          expect(one, command).toContain(why);
          expect(one, command).toContain(
            'can only bundle a module whose "path" is a string literal or whose "load" is an arrow returning a literal import()'
          );
          expect(module(command), command).toBeUndefined();
        };
        for (const command of ['joined', 'shorthand', 'named', 'template']) {
          unreadable(command, `"path" is not a string literal`);
        }
        unreadable('getter', '"path" is an accessor or a method rather than a value');
        unreadable('block', '"load" is not an arrow function returning a literal import()');
        unreadable('method', '"load" is an accessor or a method rather than a value');

        // and both is the runtime's own refusal, in its words
        expect(errors('both')).toEqual([
          'Cannot combine "load" with "path" in the "both" command: both name the module that is the command, so only one of them can be it',
        ]);
      });
    });

    it('read a spread of a const that is only ever spread, for all seven keys, in the shape the app is written in', async () => {
      // SIG-440. `{ ...base, path: './commands/a.js' }` is the natural way to share
      // a few keys between placeholders, and was refused for `name`, `path` and
      // `load` and warned about for the rest, because `base` is a name. A const
      // nothing else names is what it was declared as, so it is read like the
      // literal it is -- `name` and `path` need no spelling after the spread
      const source = `const named = { name: 'later' };
const pathed = { path: './commands/a.js' };
const loaded = { load: () => import('./commands/a.js') };
const shared = { desc: 'Shared words', hidden: true, alias: 'sh', default: true };
const replaced = { desc: 'from the const' };
export default {
  baseDir: import.meta.dirname,
  commands: {
    one: { ...named, path: './commands/a.js' },
    two: { ...pathed },
    three: { ...loaded },
    four: { ...shared, path: './commands/a.js' },
    five: { desc: 'early', ...replaced, path: './commands/a.js' },
    six: { name: 'early', ...named, ...pathed },
    seven: { ...{ ...pathed }, ...named },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const module = (name: string) => at(list, name).module?.split(/[\\/]/).at(-1);

        // nothing is refused or warned about for any of them
        expect(diagnostics.map((d) => d.message)).toEqual([]);

        // `name`, then `path` and `load`: what the const holds, where the app puts it
        expect(list.map((command) => command.name)).toEqual([
          'later',
          'two',
          'three',
          'four',
          'five',
          'later',
          'later',
        ]);
        for (const command of ['later', 'two', 'three', 'four', 'five']) {
          expect(module(command), command).toBe('a.js');
        }

        // `desc`, `hidden`, `alias` and `default` are the same reading
        expect(at(list, 'four').desc).toBe('Shared words');
        expect(at(list, 'four').hidden).toBe(true);
        expect(at(list, 'four').alias).toEqual(['sh']);
        expect(at(list, 'four').default).toBe(true);
        // ...and the spread is what runs where it follows a spelling of the key
        expect(at(list, 'five').desc).toBe('from the const');
      });
    });

    it('read a const spread twice as the object it is, and not as a key written before a spread', async () => {
      // SIG-440, review. The same members come back for each spread of one const, so
      // the position of the last spelling was the first spread's and `path` read as
      // written before the second
      const source = `const pathed = { path: './commands/a.js' };
let other = { hidden: true };
export default {
  baseDir: import.meta.dirname,
  commands: {
    twice: { ...pathed, ...other, ...pathed, name: 'twice' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        // `other` may carry the five other keys, which is a warning each; the module is
        // spelled after it and is not an error
        expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(at(list, 'twice').module?.split(/[\\/]/).at(-1)).toBe('a.js');
      });
    });

    it('read a spread of a const carrying options, args and a handler, which no build reads', async () => {
      // SIG-725. A shared base is most often one carrying `options`, and every
      // array or object in it made the const unreadable -- including the ones the
      // build never looks inside. What it takes off a placeholder is named, so the
      // const resolves, and the keys it does not carry are still said
      const source = `const shared = {
  args: [{ name: 'target' }],
  hooks: { init() {} },
  options: { '--force': { type: 'bool' } },
  path: './commands/a.js',
};
export default {
  baseDir: import.meta.dirname,
  commands: { one: { ...shared, desc: 'one' } },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];

        expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(at(list, 'one').module?.split(/[\\/]/).at(-1)).toBe('a.js');
        // what is not carried into a built app is said, once per key, at the
        // spread the author wrote rather than the declaration it came from
        const unbaked = diagnostics.filter((d) => d.message.includes('does not carry'));
        expect(unbaked.map((d) => /declares "(\w+)"/.exec(d.message)?.[1])).toEqual([
          'args',
          'hooks',
          'options',
        ]);
        const line = source.split('\n').findIndex((each) => each.includes('...shared')) + 1;
        expect(unbaked.map((d) => d.line)).toEqual([line, line, line]);
      });
    });

    it('refused a spread of a const whose alias or another key the build reads is an array or object, as it always did', async () => {
      // SIG-725. A shallow copy shares an array or an object with the const, so
      // a key the build read and a hook then changed would be one it had baked
      // the other value of. Only those keys keep a const refused
      //
      // What the refusal quotes is what the const may carry (SIG-731): every one of
      // them holds `path` beside the key under test, and `name` and `load` are
      // quoted only where the const holds them. A const that visibly lacks a key is
      // no carrier of it, so it is not named in the refusal as it used to be
      for (const [held, carries] of [
        ["alias: ['b']", 'its "path"'],
        // (`commands` is the same refusal: asserted on the guard itself, and
        // through a read below, 'refused a placeholder spreading a const that holds
        // commands')
        ["name: ['b']", 'its "name" or "path"'],
        ['hidden: []', 'its "path"'],
        ["desc: { text: 'x' }", 'its "path"'],
      ] as const) {
        const source = `const base = { ${held}, path: './commands/a.js' };
export default {
  baseDir: import.meta.dirname,
  commands: { x: { ...base } },
};\n`;

        await withSchema(source, (dir) => {
          const { commands, diagnostics } = readAppCommands(discoverApp(dir));
          const list = commands?.kind === 'inline' ? commands.commands : [];
          const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

          expect(errors, held).toHaveLength(1);
          expect(errors[0], held).toContain(
            `the "x" command spreads another object, which may carry ${carries};`
          );
          expect(at(list, 'x').module, held).toBeUndefined();
        });
      }
    });

    it('read the schema that spreads a shared base, and not the base as a second schema', async () => {
      // SIG-728. A `const` holding `commands` that is spread into the schema was a
      // schema of its own, so the build said `found 2 schemas` and read nothing
      const source = `const base = { baseDir: import.meta.dirname, commands: { old: './commands/a.js' } };
export default { ...base, commands: { fresh: './commands/a.js' } };\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics, found } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];

        expect(diagnostics).toEqual([]);
        expect(found).toBe(true);
        // the last `commands` is the one an object keeps
        expect(list.map((each) => each.name)).toEqual(['fresh']);
      });
    });

    it('read a baseDir a sealed base carries, so a relative commands directory is not reported for lacking one', async () => {
      // SIG-728. The schema is the object the runtime reads, and its `baseDir` is
      // whichever of its members spells one: the build looked at what was written in
      // the literal and warned that nothing said what the path is relative to
      const source = `const base = { baseDir: import.meta.dirname };
export default { ...base, commands: './commands' };\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));

        expect(diagnostics).toEqual([]);
        expect(commands).toEqual({ dir: join(dir, 'src', 'commands'), kind: 'directory' });
      });
    });

    it('warned when a spread the build cannot read follows the commands it read', async () => {
      // SIG-728, review. The base is a part of the schema and not a second one, so
      // nothing said `found 2 schemas` any more -- while the app runs the base's
      // `commands`, written last, and the build read `stale`
      const source = `const base = { commands: { real: './commands/a.js' } };
export default { baseDir: import.meta.dirname, commands: { stale: './commands/a.js' }, ...base };\n`;

      await withSchema(source, (dir) => {
        const { diagnostics } = readAppCommands(discoverApp(dir));

        expect(diagnostics.map((d) => d.message)).toEqual([
          expect.stringContaining('"commands" is written before a spread or a computed key'),
        ]);
        expect(diagnostics[0]).toMatchObject({ severity: 'warning' });
      });
    });

    describe('what may set the baseDir, or replace the commands, of a schema (SIG-729, SIG-730)', () => {
      const read = (source: string) =>
        withSchema(source, (dir) => readAppCommands(discoverApp(dir)));
      const messages = (diagnostics: readonly { message: string }[]) =>
        diagnostics.map((d) => d.message);

      it.each([
        ['a let', `let base = { baseDir: import.meta.dirname };`],
        ['an exported const', `export const base = { baseDir: import.meta.dirname };`],
        ['an import', `import { base } from './base.js';`],
        ['a call', `const base = load();`],
      ])(
        'said a spread of %s may carry the baseDir, and not that the schema sets none',
        async (_what, declaration) => {
          // the runtime reads the `baseDir` the spread carries; the build could not read
          // it and said there was none, which is a claim about the app it cannot make
          const { commands, diagnostics } = await read(
            `${declaration}\nexport default { ...base, commands: './commands' };\n`
          );

          expect(messages(diagnostics)).toEqual([
            expect.stringContaining('a spread in the schema may carry a "baseDir" this cannot see'),
          ]);
          expect(messages(diagnostics)[0]).not.toContain('sets no "baseDir"');
          expect(diagnostics[0]).toMatchObject({ column: 18, line: 2, severity: 'warning' });
          expect(commands?.kind).toBe('directory');
        }
      );

      it('said a computed key may carry the baseDir, and where it is', async () => {
        const { diagnostics } = await read(
          `export default { [key()]: 1, commands: './commands' };\n`
        );

        expect(messages(diagnostics)).toEqual([
          expect.stringContaining('a computed key in the schema may carry a "baseDir"'),
        ]);
      });

      it.each([
        ['nothing', `export default { commands: './commands' };`, 'sets no "baseDir"'],
        [
          'a spread that cannot carry one',
          `export default { ...{ name: 'x' }, ...null, commands: './commands' };`,
          'sets no "baseDir"',
        ],
        [
          'a baseDir the spread follows, which is still spelled',
          `let base = {};\nexport default { baseDir: import.meta.dirname, ...base, commands: './commands' };`,
          undefined,
        ],
        [
          'a baseDir after the spread',
          `let base = {};\nexport default { ...base, baseDir: import.meta.dirname, commands: './commands' };`,
          undefined,
        ],
        [
          'a baseDir of undefined followed by a spread that may carry one',
          `let base = {};\nexport default { baseDir: undefined, ...base, commands: './commands' };`,
          'a spread in the schema may carry a "baseDir"',
        ],
        [
          'a baseDir of undefined and nothing after it',
          `export default { baseDir: undefined, commands: './commands' };`,
          'sets no "baseDir"',
        ],
        [
          'a spread of a const that visibly holds no baseDir',
          // read for a member, so it is not sealed and `lacksResolver()` is what is asked
          `const mixin = { name: 'x' };\nmixin.name = 'y';\nexport default { ...mixin, commands: './commands' };`,
          'sets no "baseDir"',
        ],
        [
          'an accessor baseDir, which the runtime reads',
          `export default { get baseDir() { return import.meta.dirname; }, commands: './commands' };`,
          undefined,
        ],
      ])('kept the answer for %s', async (_what, source, said) => {
        const { diagnostics } = await read(`${source}\n`);

        if (said) {
          expect(messages(diagnostics)).toEqual([expect.stringContaining(said)]);
        } else {
          expect(diagnostics).toEqual([]);
        }
      });

      it.each([
        ['null', 'null'],
        ['an empty string', "''"],
        ['an empty template', '``'],
        ['false', 'false'],
        ['0', '0'],
      ])(
        'warned that a baseDir of %s sets none, as the runtime resolves from the working directory',
        async (_what, value) => {
          // SIG-733. `initCommand()` asks `baseDir ? resolve(baseDir, file) : file`, so
          // a falsy `baseDir` is none to the runtime, as `undefined` is -- measured by
          // running an app with each, from a directory its commands are not under,
          // where relative `commands` were not found for any of them
          const { diagnostics } = await read(
            `export default { baseDir: ${value}, commands: './commands' };\n`
          );

          expect(messages(diagnostics)).toEqual([expect.stringContaining('sets no "baseDir"')]);
          expect(diagnostics[0]).toMatchObject({ severity: 'warning' });
        }
      );

      it.each([
        ['a string', "'/srv/app'"],
        ['a call', 'process.cwd()'],
        ['a name', 'dir'],
      ])('did not warn that a baseDir of %s sets none, which it may not', async (_what, value) => {
        // only a literal that is falsy is known to be none
        const { diagnostics } = await read(
          `const dir = '/srv/app';\nexport default { baseDir: ${value}, commands: './commands' };\n`
        );

        expect(diagnostics).toEqual([]);
      });

      it('said a spread may carry the baseDir after a baseDir of null, as it does after undefined', async () => {
        const { diagnostics } = await read(
          `let base = {};\nexport default { baseDir: null, ...base, commands: './commands' };\n`
        );

        expect(messages(diagnostics)).toEqual([
          expect.stringContaining('a spread in the schema may carry a "baseDir"'),
        ]);
      });

      it.each([
        ['get', `get commands() { return { b: './commands/a.js' }; }`],
        ['set', `set commands(value) {}`],
        ['method', `commands() {}`],
      ])('warned that %s of commands after a plain one replaces it', async (_what, accessor) => {
        // `lastPlain()` skips an accessor, so the build baked `./commands` over a
        // schema whose app runs the getter, and said nothing
        const { commands, diagnostics } = await read(
          `export default { baseDir: import.meta.dirname, commands: { a: './commands/a.js' }, ${accessor} };\n`
        );

        expect(messages(diagnostics)).toEqual([
          expect.stringContaining(
            '"commands" is written before an accessor or a method of the same name, which replaces it when the app runs'
          ),
        ]);
        expect(diagnostics[0]).toMatchObject({ severity: 'warning' });
        // what is read is what was written, as it is for a spread
        expect(commands?.kind === 'inline' ? commands.commands.map((c) => c.name) : []).toEqual([
          'a',
        ]);
      });

      it.each([
        ['a getter', `get commands() { return { z: './commands/a.js' }; }`],
        ['a method', `commands() { return { z: './commands/a.js' }; }`],
      ])(
        'said a schema whose only commands is %s cannot be read, and not that there are none (SIG-734)',
        async (_what, member) => {
          // the schema has commands, the build cannot run the code that gives them, and
          // the built app has none: an error, as a computed `commands` is
          const { commands, diagnostics, found } = await read(
            `export default { baseDir: import.meta.dirname, ${member} };\n`
          );

          expect(messages(diagnostics)).toEqual([
            '"commands" is an accessor or a method rather than an object literal, so it cannot be read at build time and a built app will not have these commands; it applies when the app runs from source and not after a build, so write it as an object literal of commands, or pass --commands to name a command directory',
          ]);
          expect(diagnostics[0]).toMatchObject({ column: 48, line: 1, severity: 'error' });
          // `found` is what keeps `sigil check` from adding `no "commands" found`
          expect(found).toBe(true);
          expect(commands).toBeUndefined();
        }
      );

      it('read the schema that holds the getter through a shared base, as the schema it is', async () => {
        const { diagnostics, found } = await read(
          `const base = { get commands() { return {}; } };\nexport default { ...base, baseDir: import.meta.dirname, run() {} };\n`
        );

        expect(messages(diagnostics)).toEqual([
          expect.stringContaining('is an accessor or a method'),
        ]);
        expect(found).toBe(true);
      });

      it('did not claim a setter alone, which the runtime reads as no commands at all', async () => {
        const { diagnostics, found } = await read(
          `export default { baseDir: import.meta.dirname, set commands(value) {}, run() {} };\n`
        );

        expect(diagnostics).toEqual([]);
        expect(found).toBe(false);
      });

      it.each([
        [
          'a helper that is read by a member',
          `const registry = { get commands() { return []; } };\nconsole.log(registry.commands);\nexport default { baseDir: import.meta.dirname, commands: { x: { path: './commands/a.js' } } };\n`,
        ],
        [
          'a method of a helper in a single-command app',
          `const api = { commands() { return []; } };\nexport default { name: 'x', run() { api.commands(); } };\n`,
        ],
        [
          'a helper nested in the schema',
          `export default { name: 'x', run() { const h = { get commands() { return 1; } }; } };\n`,
        ],
      ])(
        'did not claim an accessor of commands in %s, which is no schema',
        async (_what, source) => {
          // review: an accessor is claimed only for what is exported, since a plain
          // `commands` is claimed anywhere and a method of that name is a likelier helper
          const { diagnostics, found } = await read(source);

          expect(messages(diagnostics).filter((m) => m.includes('accessor or a method'))).toEqual(
            []
          );
          expect(messages(diagnostics).filter((m) => m.includes('schemas in this module'))).toEqual(
            []
          );
          expect(found).toBe(source.includes('commands: {'));
        }
      );

      it('did not claim a schema for an accessor of another name', async () => {
        const { diagnostics, found } = await read(
          `export default { baseDir: import.meta.dirname, get desc() { return 'x'; } };\n`
        );

        expect(diagnostics).toEqual([]);
        expect(found).toBe(false);
      });

      it('did not warn about an accessor that comes before the plain commands, which wins', async () => {
        const { diagnostics } = await read(
          `export default { baseDir: import.meta.dirname, get commands() { return {}; }, commands: { a: './commands/a.js' } };\n`
        );

        expect(diagnostics).toEqual([]);
      });

      it('gave one warning when a spread and an accessor both follow', async () => {
        const { diagnostics } = await read(
          `let base = {};\nexport default { baseDir: import.meta.dirname, commands: {}, ...base, get commands() { return {}; } };\n`
        );

        // the accessor is the spelling that runs and `lastPlain()` still answers the
        // plain one: one warning for the pair
        expect(diagnostics).toHaveLength(1);
        expect(messages(diagnostics)[0]).toContain('"commands" is written before');
      });

      it('warned about nothing for a spread of a const that something reads, which visibly holds no commands', async () => {
        // the const is not sealed -- a member of it is read -- and cannot hold a `commands`
        const { diagnostics } = await read(
          `const mixin = { name: 'x', tags: [] };\nmixin.tags.push('y');\nexport default { baseDir: import.meta.dirname, commands: { a: './commands/a.js' }, ...mixin };\n`
        );

        expect(diagnostics).toEqual([]);
      });

      it.each([
        ['a member assignment of commands', `const mixin = { name: 'x' };\nmixin.commands = {};`],
        ['a string-keyed one', `const mixin = { name: 'x' };\nmixin['commands'] = {};`],
        ['a computed one', `const mixin = { name: 'x' };\nmixin[key()] = {};`],
        ['a read of it', `const mixin = { name: 'x' };\nconsole.log(mixin.commands);`],
        ['an assign', `const mixin = { name: 'x' };\nObject.assign(mixin, other);`],
        ['a closure that calls it', `const mixin = { name: 'x' };\nconst f = () => mutate(mixin);`],
        ['a delete', `const mixin = { name: 'x' };\ndelete mixin.commands;`],
        [
          'a parenthesized optional call',
          `const mixin = { name: 'x' };\n(mixin?.valueOf)().commands = {};`,
        ],
        [
          'an optional call of a member',
          `const mixin = { t() { this.commands = {}; } };\nmixin.t?.();`,
        ],
        ['a method called on it', `const mixin = { name: 'x' };\nmixin.valueOf().commands = {};`],
        [
          'its own method called',
          `const mixin = { set(k, v) { this[k] = v; } };\nmixin.set('commands', {});`,
        ],
        [
          'an inherited setter called',
          `const mixin = { name: 'x' };\nmixin.__defineGetter__('commands', () => ({}));`,
        ],
        ['a member tagged', `const mixin = { t() { this.commands = {}; } };\nmixin.t\`\`;`],
        ['a member constructed', `const mixin = { name: 'x' };\nnew mixin.constructor();`],
        ['a literal that has commands', `const mixin = { commands: {} };`],
        ['a literal with an accessor', `const mixin = { get x() { return 1; } };`],
        ['a literal with a __proto__', `const mixin = { __proto__: other };`],
        ['a literal with a computed key', `const mixin = { [key()]: 1 };`],
        ['a literal that spreads a name', `const inner = { a: 1 };\nconst mixin = { ...inner };`],
        ['a let', `let mixin = { name: 'x' };`],
        ['an export', `export const mixin = { name: 'x' };`],
        ['an import', `import { mixin } from './mixin.js';`],
        ['a call', `const mixin = make();`],
      ])('kept warning that a spread may replace commands for %s', async (_what, declaration) => {
        const { diagnostics } = await read(
          `${declaration}\nexport default { baseDir: import.meta.dirname, commands: { a: './commands/a.js' }, ...mixin };\n`
        );

        expect(messages(diagnostics)).toEqual([
          expect.stringContaining('"commands" is written before a spread or a computed key'),
        ]);
      });
    });

    it('read what a base spread inside a placeholder holds as a base, and warned of the commands it cannot read', async () => {
      // SIG-725, SIG-728. A schema module holding a `const` with `commands` in it
      // could not be built, so the refusal was asserted on the guard and not through
      // a read: the const is a part of the schema that spreads it, and what it
      // carries -- a shared `commands` -- is not a thing the build reads. It was
      // refused for a `name`, a `path` and a `load` it does not hold until SIG-731,
      // and is a warning about the commands alone now
      const source = `const base = { commands: { sub: './commands/a.js' } };
export default {
  baseDir: import.meta.dirname,
  commands: { x: { ...base, path: './commands/a.js' } },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

        expect(diagnostics.map((d) => d.message).join('\n')).not.toContain('schemas');
        expect(list.map((each) => each.name)).toEqual(['x']);
        // the const holds no `name`, `path` or `load`, so nothing about the command
        // is unknown but what it carries beside them (SIG-731): it is read, and the
        // `commands` the build cannot see are warned about, as for any spread
        expect(errors).toEqual([]);
        expect(at(list, 'x').module?.split(/[\\/]/).at(-1)).toBe('a.js');
        expect(diagnostics.map((d) => d.message)).toEqual([
          expect.stringContaining(
            'the "x" command spreads another object, which may carry a "commands" this cannot see'
          ),
        ]);
        expect(at(list, 'x').commands).toEqual([]);
      });
    });

    it.each([
      // [what is wrong with it, the const]
      ['a let', `let base = { commands: { old: './commands/a.js' } };`],
      ['an exported const', `export const base = { commands: { old: './commands/a.js' } };`],
      [
        'a const something is passed to',
        `const base = { commands: { old: './commands/a.js' } };\nObject.assign(base, {});`,
      ],
      [
        'a const that is read',
        `const base = { commands: { old: './commands/a.js' } };\nconsole.log(base.commands);`,
      ],
    ])('kept reading %s as a schema of its own, as it was', async (_what, declaration) => {
      // SIG-728. What the build cannot show to be a part of the schema is not
      // taken for one: the module still has two, and the build still says it
      // cannot choose between them
      const source = `${declaration}
export default { ...base, commands: { fresh: './commands/a.js' } };\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics, found } = readAppCommands(discoverApp(dir));

        expect(found).toBe(true);
        expect(commands).toBeUndefined();
        expect(diagnostics.map((d) => d.message)).toEqual([
          'found 2 schemas in this module; pass --commands to say which command directory to check',
        ]);
      });
    });

    it('pointed a refusal about what a const carried at the spread, and not at the const', async () => {
      // SIG-725. The error is about the command, and the line to change is the
      // spread that brought the const in -- `at` took the earliest position of what
      // it quoted, which was the declaration, at the top of the file
      const source = [
        `const base = { name: 'later', path: './commands/a.js' };`,
        ``,
        `let mixin = {};`,
        ``,
        `export default {`,
        `  baseDir: import.meta.dirname,`,
        `  commands: {`,
        `    x: {`,
        `      ...base,`,
        `      ...mixin,`,
        `    },`,
        `  },`,
        `};`,
        ``,
      ].join('\n');

      await withSchema(source, (dir) => {
        const { diagnostics } = readAppCommands(discoverApp(dir));
        const errors = diagnostics.filter((d) => d.severity === 'error');

        // `name`, `path` are written before a spread that may replace them
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toContain('writes "name" and "path" before a spread');
        expect(errors[0]).toMatchObject({ column: 7, line: 9 });
      });
    });

    it('read a placeholder’s nested commands through its spreads, and said where it could not', async () => {
      // SIG-726. `commands` was read off the properties written in the literal, so
      // a spread that carried the subcommands -- or replaced the ones written -- was
      // not seen at all: the built app had one set of subcommands and the app
      // another, and nothing said so
      const source = `let mixin = {};
const defaults = { hidden: false };
export default {
  baseDir: import.meta.dirname,
  commands: {
    plain: { path: './commands/a.js', commands: { sub: { path: './commands/a.js' } } },
    after: { ...defaults, path: './commands/a.js', commands: { sub: { path: './commands/a.js' } } },
    literal: { path: './commands/a.js', commands: { old: { path: './commands/a.js' } }, ...{ commands: { fresh: { path: './commands/a.js' } } } },
    carried: { ...mixin, name: 'carried', path: './commands/a.js' },
    written: { commands: { sub: { path: './commands/a.js' } }, ...mixin, name: 'written', path: './commands/a.js' },
    undef: { commands: undefined, ...mixin, name: 'undef', path: './commands/a.js' },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];
        const subs = (name: string) =>
          (at(list, name).commands ?? []).map((command) => command.name);

        expect(subs('plain')).toEqual(['sub']);
        // a const nothing else touches is read, so what is written after it runs
        expect(subs('after')).toEqual(['sub']);
        // the spread of a literal is what runs, so `old` is dead and `fresh` is not
        expect(subs('literal')).toEqual(['fresh']);
        // a spread it cannot read may carry them: said, and nothing baked in their
        // place. One that may replace the ones written is said too, and what is
        // written is kept -- a mixin that carries none is the usual one, and a
        // built app without subcommands the app has is the worse way to be wrong
        expect(subs('carried')).toEqual([]);
        expect(subs('written')).toEqual(['sub']);
        // ...but only where something is written: `undefined` is not, so what the
        // spread carries is the question and the answer is the one for a carrier
        expect(subs('undef')).toEqual([]);

        const warned = diagnostics
          // (`undef` is also one of the keys the build does not carry, which is SIG-320's)
          .filter((d) => d.message.includes('"commands"') && !d.message.includes('does not carry'))
          .map((d) => [d.severity, d.message]);
        expect(warned).toEqual([
          [
            'warning',
            'the "carried" command spreads another object, which may carry a "commands" this cannot see; the built app will not have its subcommands',
          ],
          [
            'warning',
            'the "written" command\'s "commands" is written before a spread or a computed key, which may replace it when the app runs; the built app has the subcommands as written',
          ],
          [
            'warning',
            'the "undef" command\'s "commands" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; the built app will not have its subcommands',
          ],
        ]);
        expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      });
    });

    it('refused a spread of a const that something else can change, with the message it always had', async () => {
      // SIG-440. The guard is what makes the reading above safe: a wrong answer
      // for a `name`, a `path` or a `load` is a built app that routes by another
      // name or runs no module, with a build that said nothing. So a name the
      // build cannot show nothing else touches stays what it was -- refused for
      // those three, a warning for `alias` and `default`. Each of these is one of
      // the cases the rule gives up on rather than argues about
      const cases: ReadonlyArray<[string, string]> = [
        ['assigned', 'const base = { path: "./commands/a.js" };\nbase.path = "./commands/b.js";'],
        ['let', 'let base = { path: "./commands/a.js" };'],
        [
          'passed',
          'const base = { path: "./commands/a.js" };\nObject.assign(base, { path: "./commands/b.js" });',
        ],
        ['called', 'const base = { path: "./commands/a.js" };\nmutate(base);'],
        [
          'captured',
          'const base = { path: "./commands/a.js" };\nconst swap = () => { base.path = "./commands/b.js"; };',
        ],
        ['exported', 'export const base = { path: "./commands/a.js" };'],
        ['listed', 'const base = { path: "./commands/a.js" };\nexport { base };'],
        ['getter', 'const base = { get path() { return "./commands/a.js"; } };'],
        ['computed', 'const key = "path";\nconst base = { [key]: "./commands/a.js" };'],
        ['chained', 'const inner = { path: "./commands/a.js" };\nconst base = { ...inner };'],
        ['called-in', 'const base = freeze({ path: "./commands/a.js" });'],
      ];

      const PATH_ONLY = new Set(['assigned', 'captured']);

      for (const [what, declaration] of cases) {
        const source = `${declaration}
export default {
  baseDir: import.meta.dirname,
  commands: {
    x: { ...base },
    y: { desc: 'y', alias: 'why', default: true, ...base, name: 'y', path: './commands/a.js' },
  },
};\n`;

        await withSchema(source, (dir) => {
          const { commands, diagnostics } = readAppCommands(discoverApp(dir));
          const list = commands?.kind === 'inline' ? commands.commands : [];
          const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

          // `x` has no module and no name the build can read: refused, once. What it
          // quotes is what the const may carry: a const only ever written `path` to
          // visibly holds no `name` and no `load` (SIG-731)
          expect(errors, what).toHaveLength(1);
          expect(errors[0], what).toContain(
            PATH_ONLY.has(what)
              ? 'the "x" command spreads another object, which may carry its "path";'
              : 'the "x" command spreads another object, which may carry its "name", "path" or "load"'
          );
          expect(at(list, 'x').module, what).toBeUndefined();
          // `y` writes `name` and `path` after the spread, which decides both;
          // `alias` and `default` are written before it, so they are unknown --
          // unless all that touches the const is a write of `path`, which cannot
          // put an `alias` there: that is read, as a const that visibly holds no
          // such key always is (SIG-730)
          if (PATH_ONLY.has(what)) {
            expect(at(list, 'y').alias, what).toEqual(['why']);
            return;
          }
          expect(at(list, 'y').alias, what).toBeUndefined();
          expect(at(list, 'y').default, what).toBeUndefined();
          const warnings = diagnostics
            .filter((d) => d.severity === 'warning')
            .map((d) => d.message);
          expect(
            warnings.some((message) =>
              message.includes('"y" command\'s "alias" is written before a spread')
            ),
            what
          ).toBe(true);
        });
      }
    });

    it('read a placeholder that spreads a const visibly holding no name, path or load, though it is not sealed', async () => {
      // SIG-731. The const has a member read (`mixin.tags.push()`), which keeps it from
      // being read as the literal it is, and it holds none of the three keys that
      // route and bundle a placeholder: nothing can have written one to it, so the
      // spread carries none and the refusal for "may carry its name, path or load"
      // was about nothing. It is the same question the replacing side asks (SIG-730)
      const source = `const mixin = { tags: ['a'] };
mixin.tags.push('b');
export default {
  baseDir: import.meta.dirname,
  commands: {
    x: { alias: 'why', ...mixin, path: './commands/a.js' },
    y: { ...mixin, load: () => import('./commands/a.js') },
  },
};\n`;

      await withSchema(source, (dir) => {
        const { commands, diagnostics } = readAppCommands(discoverApp(dir));
        const list = commands?.kind === 'inline' ? commands.commands : [];

        expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(list.map((each) => each.name)).toEqual(['x', 'y']);
        expect(at(list, 'x').module?.split(/[\\/]/).at(-1)).toBe('a.js');
        expect(at(list, 'y').module?.split(/[\\/]/).at(-1)).toBe('a.js');
        // `alias` is written before a spread that holds none either
        expect(at(list, 'x').alias).toEqual(['why']);
        // what else it holds is said, at the spread, as it is for a sealed one
        expect(
          diagnostics.map((d) => /the "(\w+)" command declares "(\w+)"/.exec(d.message)?.[0])
        ).toEqual(['the "x" command declares "tags"', 'the "y" command declares "tags"']);
      });
    });

    it.each([
      ['an inline run', 'run() {}', ['run']],
      ['options', "options: { '--force': { desc: 'x' } }", ['options']],
      ['hooks and args', "hooks: {}, args: ['<x>']", ['hooks', 'args']],
    ])(
      'warned of what a spread of an unsealed const holding %s does not carry',
      async (_what, held, keys) => {
        // SIG-731, review. The const holds none of `name`, `path` and `load`, so it is no
        // longer refused for them -- and that refusal was the only thing that said
        // what else the const holds, which a built app does not carry. Silently
        // building it was a built app that prints help where the app runs `run`
        const source = `const shared = { ${held} };
console.log(shared.run);
export default {
  baseDir: import.meta.dirname,
  commands: { rm: { ...shared, path: './commands/a.js' } },
};\n`;

        await withSchema(source, (dir) => {
          const { diagnostics } = readAppCommands(discoverApp(dir));

          expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
          expect(diagnostics.map((d) => /declares "(\w+)"/.exec(d.message)?.[1])).toEqual(keys);
          expect(diagnostics.every((d) => d.line === 5 && d.message.includes('SIG-320'))).toBe(
            true
          );
        });
      }
    );

    it.each([
      // [what it is, the const, what the placeholder writes after the spread]
      [
        'a path the placeholder respells',
        "const shared = { path: './commands/b.js', run() {} };",
        "path: './commands/a.js'",
      ],
      [
        'a path something reads',
        'const shared = { run() {} };\nconsole.log(shared.path);',
        "path: './commands/a.js'",
      ],
      [
        'a name, a path and a load the placeholder respells',
        "const shared = { name: 'q', run() {}, options: {} };",
        "name: 'rm', path: './commands/a.js', load: undefined",
      ],
    ])(
      'warned of what a spread of a const with %s does not carry',
      async (_what, declaration, after) => {
        // SIG-731, review round 2. The refusal is per key and skipped for one the
        // placeholder spells after the spread, so a const could be neither refused nor
        // reported: the keys are reported for any const whose members are all visible
        const source = `${declaration}
console.log(shared.run);
export default {
  baseDir: import.meta.dirname,
  commands: { rm: { ...shared, ${after} } },
};\n`;

        await withSchema(source, (dir) => {
          const { diagnostics } = readAppCommands(discoverApp(dir));

          expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
          expect(
            diagnostics.map((d) => /declares "(\w+)"/.exec(d.message)?.[1]).filter(Boolean)
          ).toContain('run');
        });
      }
    );

    it.each([
      // [what the const is put through, the statement or declaration]
      ['a write of the name', `const mixin = { tags: [] };\nmixin.name = 'later';`],
      ['a write of the name by index', `const mixin = { tags: [] };\nmixin['name'] = 'later';`],
      ['a write of a computed key', `const mixin = { tags: [] };\nmixin[process.env.K] = 'later';`],
      ['a delete of the name', `const mixin = { tags: [] };\ndelete mixin.name;`],
      [
        'a write through a called member',
        `const mixin = { tags: [] };\nmixin.valueOf().name = 'later';`,
      ],
      ['a tagged template', `const mixin = { tags: [] };\nmixin.tag\`x\`;`],
      ['a constructed member', `const mixin = { tags: [] };\nnew mixin.Thing();`],
      ['Object.assign', `const mixin = { tags: [] };\nObject.assign(mixin, { name: 'later' });`],
      ['a call', `const mixin = { tags: [] };\nmutate(mixin);`],
      ['a closure', `const mixin = { tags: [] };\nconst swap = () => { mixin.name = 'later'; };`],
      ['an import', `import mixin from './mixin.js';`],
      ['an export', `export const mixin = { tags: [] };`],
      ['a let', `let mixin = { tags: [] };`],
      ['a getter', `const mixin = { get tags() { return []; } };`],
      ['a spread of a name', `const inner = { tags: [] };\nconst mixin = { ...inner };`],
    ])('refused a spread of a const put through %s, as it was', async (what, declaration) => {
      // SIG-731. Everything SIG-730 keeps a warning for stays a carrier here: the
      // guard is one function, so what may write a `name` to the const is what may
      // carry one into the placeholder. Nothing of the three is spelled by the
      // placeholder after the spread, so `name` is the one asked about
      const source = `${declaration}
export default {
  baseDir: import.meta.dirname,
  commands: { x: { ...mixin, path: './commands/a.js' } },
};\n`;

      await withSchema(source, (dir) => {
        const { diagnostics } = readAppCommands(discoverApp(dir));
        const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

        expect(errors, what).toHaveLength(1);
        expect(errors[0], what).toContain(
          'the "x" command spreads another object, which may carry its "name";'
        );
      });
    });

    it('should warn about an alias or a default it cannot read, naming the command', () => {
      // unreadable is not the same as absent, and an alias is the one property
      // whose loss makes a spelling unreachable rather than merely unlisted --
      // so it is said, and the command is not given a guess
      const app = discoverApp(join(apps, 'computed-alias'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'remove').alias).toBeUndefined();
      expect(at(list, 'list').alias).toBeUndefined();
      expect(at(list, 'ship').default).toBeUndefined();

      const warnings = diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message);
      expect(warnings).toHaveLength(4);
      expect(warnings.every((message) => message.includes('is computed'))).toBe(true);
      expect(warnings[0]).toContain('"remove" command\'s "alias"');
      expect(warnings[1]).toContain('"list" command\'s "alias"');
      expect(warnings[2]).toContain('"ship" command\'s "default"');
      // the right type with a value the source does not hold is computed rather
      // than wrong: `!x` is a boolean
      expect(warnings[3]).toContain('"armed" command\'s "default"');

      // a computed name is not a warning, since from source it answers to what
      // the expression gives and the built app would answer to the key
      // (SIG-433), as a package's does (SIG-332)
      const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain('the "push" command\'s "name" is computed');
      expect(errors[1]).toContain('the "tagged" command\'s "name" is computed');
      for (const message of errors) {
        expect(message).toContain('write "name" as a string literal');
      }
    });

    it('should report a module that does not resolve as an error', () => {
      // a command whose module is not there is an app that fails when that
      // command is run, which the build has no business shipping
      const app = discoverApp(join(apps, 'inline-app'));
      const { diagnostics } = readAppCommands(app);
      const missing = diagnostics.find((d) => d.message.includes('nope.js'));

      expect(missing?.severity).toBe('error');
      expect(missing?.message).toContain('"missing"');
    });

    it("should read this toolchain's own schema as a routed directory", () => {
      // the toolchain routes its own commands off the filesystem, so the build
      // reading it has to see a directory rather than a written-out list --
      // which is the dogfooding working: what it finds here is what it would
      // find in any app SIG-74 describes
      const app = discoverApp(join(repo, 'packages', 'cli'));
      const { commands } = readAppCommands(app);

      expect(commands?.kind).toBe('directory');
      expect(commands?.kind === 'directory' && commands.dir).toBe(
        join(repo, 'packages', 'cli', 'src', 'commands')
      );
    });

    it("should resolve this toolchain's own tree, descriptions and all", () => {
      // the descriptions live in the modules now, so this is the static lift
      // reading the code its own conventions produce -- which it could not do
      // until it learned to follow `export default cmd` to the const it names
      const app = discoverApp(join(repo, 'packages', 'cli'));
      const { commands } = readAppCommands(app);
      const dir = commands?.kind === 'directory' ? commands.dir : '';
      const { commands: list } = resolveCommandTree(dir);

      expect(list.map((c) => c.name)).toStrictEqual([
        'add',
        'build',
        'check',
        'new',
        'package',
        'reference',
      ]);
      expect(at(list, 'check').desc).toBe('Check an app without building it');
      expect(at(list, 'build').desc).toBe('Build an app into a bundle that depends on nothing');
      expect(at(list, 'check').module).toBe(
        join(repo, 'packages', 'cli', 'src', 'commands', 'check.ts')
      );
    });

    it('should say nothing about a module it cannot read when the placeholder describes it', () => {
      // every diagnostic the fact lift produces is about what help would show
      // before the module loads, and a placeholder `desc` is exactly that
      // answer -- so `export default check` being a reference is not a
      // problem anybody has
      const app = discoverApp(join(repo, 'packages', 'cli'));
      const { diagnostics } = readAppCommands(app);

      expect(diagnostics.filter((d) => d.severity === 'warning')).toStrictEqual([]);
    });
  });
});

describe('resolving an import specifier', () => {
  const from = join(apps, 'inline-app', 'src');

  it('should swap a .js specifier for the .ts beside it', () => {
    expect(resolveSpecifier(from, './commands/build.js')).toBe(join(from, 'commands', 'build.ts'));
  });

  it('should take an extensionless specifier', () => {
    expect(resolveSpecifier(from, './commands/build')).toBe(join(from, 'commands', 'build.ts'));
  });

  it('should answer undefined for a module that is not there', () => {
    expect(resolveSpecifier(from, './commands/nope.js')).toBeUndefined();
  });

  it('should ignore a bare specifier, which is a package', () => {
    // a package's commands are its own business
    expect(resolveSpecifier(from, '@ttylabs/sigil')).toBeUndefined();
  });
});
