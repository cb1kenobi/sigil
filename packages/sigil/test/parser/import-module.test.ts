import main from '../../src/index.js';
import { runCommand } from '../../src/testing/command.js';
import type { Schema } from '../../src/types.js';
import { tempDir } from '../temp.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `importModule`, which is how a test lets its runner import what node cannot
 * (SIG-431).
 *
 * `runCommand()` reached a command module through `main()`, and `main()` imported
 * it with node's own `import()` -- so a scaffolded app whose command imports a
 * `.tsx` component failed its own test once `@ttylabs/sigil` was installed, with
 * `Unknown file extension ".tsx"`. The option replaces that `import()` for one
 * call. The end-to-end proof is `new-tui.test.ts` in `@ttylabs/cli`, which runs
 * the scaffold's own test against an installed copy; this file pins what reaches
 * the option, from every place a module the app declared is imported.
 *
 * Every module written here says `file` and every module an importer hands back
 * says `importer`, so which of the two ran is read off what was printed rather
 * than off whether something failed.
 */

/** The exit code the worker had, so that a failing run never leaves one behind. */
afterEach(() => {
  expect(process.exitCode, 'a run left an exit code on the worker').toBeUndefined();
});

/** Writes a file, making its directory. */
function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** A command module that says where it came from. */
function commandModule(said: string): string {
  return `export default { desc: 'from ${said}', run() { process.stdout.write('${said}\\n'); } };\n`;
}

/**
 * An importer that records each URL it is handed and answers with a command of
 * its own.
 */
function importer(): { importModule: (url: string) => Promise<unknown>; seen: string[] } {
  const seen: string[] = [];
  return {
    importModule(url: string): Promise<unknown> {
      seen.push(url);
      return Promise.resolve({
        default: {
          desc: 'from importer',
          run() {
            process.stdout.write('importer\n');
          },
        },
      });
    },
    seen,
  };
}

describe('importModule', () => {
  it("should import a routed command module through the caller's importModule, which node's import cannot load", async () => {
    const dir = tempDir('sigil-import-module-');
    const ops = join(dir, 'commands', 'ops.js');
    write(ops, commandModule('file'));
    const schema: Schema = { commands: join(dir, 'commands'), name: 'demo' };
    const { importModule, seen } = importer();

    const ran = await runCommand({ argv: ['ops'], importModule, schema });

    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toBe('importer\n');
    // the `file:` URL, which is what node's own `import()` is handed
    expect(seen).toEqual([pathToFileURL(ops).href]);

    // and without one, the module on disk, through node's
    const plain = await runCommand({ argv: ['ops'], schema });
    expect(plain.out).toBe('file\n');
  });

  it('should import a command declared by path, and a directory command with its index', async () => {
    const dir = tempDir('sigil-import-module-');
    const build = join(dir, 'build.js');
    const index = join(dir, 'db', 'index.js');
    const migrate = join(dir, 'db', 'migrate.js');
    write(build, commandModule('file'));
    write(index, commandModule('file'));
    write(migrate, commandModule('file'));
    const schema: Schema = { commands: { build, db: join(dir, 'db') }, name: 'demo' };

    const first = importer();
    const built = await runCommand({ argv: ['build'], importModule: first.importModule, schema });
    expect(built.out).toBe('importer\n');
    expect(first.seen).toEqual([pathToFileURL(build).href]);

    const second = importer();
    const migrated = await runCommand({
      argv: ['db', 'migrate'],
      importModule: second.importModule,
      schema,
    });
    expect(migrated.out).toBe('importer\n');
    expect(second.seen).toEqual([pathToFileURL(index).href, pathToFileURL(migrate).href]);
  });

  it("should import a package's entry through it, which happens while the schema is built", async () => {
    // a package a declaration points at is imported by `initCommand()` before any
    // argv is read, so it is the import site furthest from `loadCommand()`
    const dir = tempDir('sigil-import-module-');
    const entry = join(dir, 'pkg', 'lib', 'main.js');
    write(
      join(dir, 'pkg', 'package.json'),
      JSON.stringify({ exports: { '.': { import: './lib/main.js' } }, name: 'pkg', type: 'module' })
    );
    write(entry, commandModule('file'));
    const seen: string[] = [];

    // the module a package exports names the command, so a name only the
    // importer's module carries is reachable only if the import that named it --
    // the one made while the schema was built -- went through the importer
    const ran = await runCommand({
      argv: ['renamed'],
      importModule(url) {
        seen.push(url);
        return Promise.resolve({ default: { name: 'renamed', run: () => 'importer' } });
      },
      schema: { commands: [join(dir, 'pkg')], name: 'demo' },
    });

    expect(ran.code, ran.err).toBe(0);
    expect(ran.result).toBe('importer');
    // asked again when argv matched it, which a module cache answers with one
    // evaluation -- node's, or vitest's
    expect(new Set(seen)).toEqual(new Set([pathToFileURL(entry).href]));
  });

  it('should import through it for help, which loads a command to describe it', async () => {
    const dir = tempDir('sigil-import-module-');
    const ops = join(dir, 'commands', 'ops.js');
    write(ops, commandModule('file'));
    const { importModule, seen } = importer();

    const ran = await runCommand({
      argv: ['help', 'ops'],
      importModule,
      schema: { commands: join(dir, 'commands'), name: 'demo' },
    });

    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain('from importer');
    expect(seen).toEqual([pathToFileURL(ops).href]);
  });

  it('should keep two calls at once to their own importers', async () => {
    // `main()` itself runs concurrently, unlike `runCommand()`, and each call's
    // imports read that call's option. Each importer waits, so the two loads
    // overlap rather than running one after the other
    const dir = tempDir('sigil-import-module-');
    write(join(dir, 'commands', 'ops.js'), commandModule('file'));
    const schema: Schema = { commands: join(dir, 'commands'), name: 'demo' };
    const answered: string[] = [];
    const slow = (said: string) => async (): Promise<unknown> => {
      await new Promise((settle) => setTimeout(settle, 20));
      answered.push(said);
      return { default: { run: () => said } };
    };

    const [a, b] = await Promise.all([
      main({ argv: ['ops'], importModule: slow('a'), schema }),
      main({ argv: ['ops'], importModule: slow('b'), schema }),
    ]);

    expect([a, b]).toEqual(['a', 'b']);
    expect(answered.sort()).toEqual(['a', 'b']);
  });

  it('should not reach a nested main() that was not given one', async () => {
    // a command that composes another app runs it under that call's own options,
    // which is the rule `settings` follows: a nested call uses node's import
    // unless it is handed an importer of its own
    const dir = tempDir('sigil-import-module-');
    write(join(dir, 'inner', 'ops.js'), commandModule('file'));
    const inner: Schema = { commands: join(dir, 'inner'), name: 'inner' };
    const seen: string[] = [];

    const ran = await runCommand({
      argv: ['outer'],
      importModule(url) {
        seen.push(url);
        return Promise.resolve({ default: {} });
      },
      schema: {
        commands: {
          outer: {
            async run() {
              await main({ argv: ['ops'], schema: inner });
            },
          },
        },
        name: 'demo',
      },
    });

    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toBe('file\n');
    expect(seen).toEqual([]);
  });

  it('should refuse an importModule that is not a function, through the error path', async () => {
    const ran = await runCommand({
      argv: [],
      importModule: 'nope' as unknown as () => Promise<unknown>,
      schema: { name: 'demo' },
    });

    expect(ran.code).toBe(1);
    expect(ran.err).toBe('Error: Expected importModule to be a function\n');
  });
});
