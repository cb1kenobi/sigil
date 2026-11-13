import { bundleApp } from '../src/build/bundle.ts';
import { discoverApp } from '../src/build/discover.ts';
import { resolveCommandTree } from '../src/build/tree.ts';
import { run as spawnNode, STACK, type Ran } from './spawned.ts';
import { tempDir } from './temp.ts';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, 'fixtures', 'async-schema');
const cli = resolve(here, '../src/sigil.ts');

/**
 * A schema exported as an `async` function, from source and built.
 *
 * The entry `sigil build` generates called the schema function and spread what
 * it returned without awaiting it, so an `async` schema spread a Promise: the
 * built app had no name, no description and none of the root options, and the
 * build reported success (SIG-353). `sigil reference` awaited the same export,
 * so one toolchain disagreed with itself about what a schema export is.
 *
 * The claim is the one a user meets -- **the source run and the built executable
 * do the same thing** -- so both are asked through one `describe.each` and
 * neither is the reference. The `cjs` form is the third, because it is a second
 * shape of the generated entry: a Node single executable's script, where the
 * schema's `await` has to sit inside the function the call already does.
 */
describe('an async schema built to the same help as from source', () => {
  const out = tempDir('sigil-async-schema-');
  const cjsOut = tempDir('sigil-async-schema-cjs-');
  const targets: Record<string, string> = {
    built: join(out, 'async-schema.mjs'),
    cjs: join(cjsOut, 'async-schema.cjs'),
    source: join(app, 'dev.mjs'),
  };

  beforeAll(async () => {
    const built = await spawnNode(cli, app, ['build', '--out', out]);
    expect(built.code, built.stderr).toBe(0);
    expect(existsSync(targets.built!)).toBe(true);

    // what `sigil package --runtime node` bundles, without the binary around it:
    // the file is what decides the schema's fate, and node runs it as it stands
    await bundleApp({
      app: discoverApp(app),
      binName: 'async-schema',
      form: 'cjs',
      out: cjsOut,
      sourcemap: false,
      tree: resolveCommandTree(join(app, 'commands')),
    });
    expect(existsSync(targets.cjs!)).toBe(true);
  }, 60_000);

  /** Runs one of the three somewhere unrelated, so none depends on its cwd. */
  const ask = (kind: string, ...argv: string[]): Promise<Ran> =>
    spawnNode(targets[kind]!, out, argv);

  describe.each(['source', 'built', 'cjs'])('%s', (kind) => {
    it("should name the app by the schema's name, not by its file", async () => {
      const ran = await ask(kind, '--help');

      // a built app that lost its schema says `Usage: async-schema.mjs`
      expect(ran.stdout).toMatch(/^Usage: asyncapp \[options\] <command>$/m);
      expect(ran.stderr).toBe('');
      expect(ran.code).toBe(0);
    });

    it("should print the schema's description and its root option", async () => {
      const ran = await ask(kind, '--help');

      expect(ran.stdout).toContain('An app whose schema is awaited');
      expect(ran.stdout).toMatch(/^\s+-l, --loud\s+Say it louder$/m);
    });

    it('should hand the root option to a command', async () => {
      // the short alias, because an undeclared `--loud` would still arrive as
      // `loud: true`: undeclared options produce values. An undeclared `-l` is
      // `l`, so only the declaration turns it into `loud`
      const ran = await ask(kind, 'hello', '-l');

      expect(ran.stdout).toBe('HELLO\n');
      expect(ran.stderr).not.toMatch(STACK);
      expect(ran.code).toBe(0);
    });
  });

  it('should print the same help built as from source, in both forms', async () => {
    const source = (await ask('source', '--help')).stdout;

    expect((await ask('built', '--help')).stdout).toBe(source);
    expect((await ask('cjs', '--help')).stdout).toBe(source);
  });

  describe.each(['built', 'cjs'])('%s, where the schema rejects', (kind) => {
    it('should render the message through errorHandler, with no stack and no source line', async () => {
      // SIG-353: there is no `main()` yet to catch it, so it reached Node's own
      // report -- a stack, and the whole minified line of the bundle it was on,
      // which is several kB in the cjs form. The error's own exit code is kept,
      // which is `errorHandler()`'s rule for anything `main()` catches
      const ran = await spawnNode(targets[kind]!, out, ['--help'], { ASYNC_SCHEMA: 'reject' });

      expect(ran.stderr).toBe('Error: schema rejected\n');
      expect(ran.stdout).toBe('');
      expect(ran.code).toBe(4);
    });

    it('should render a getter that throws when the schema is spread', async () => {
      // from source `main()` reads the getter and renders it; built, the entry
      // spreads the schema before `main()` exists, and a spread inside the
      // handler whose sibling is `errorHandler` escaped to Node's own report
      const ran = await spawnNode(targets[kind]!, out, ['--help'], { ASYNC_SCHEMA: 'getter' });

      expect(ran.stderr).toBe('Error: getter threw\n');
      expect(ran.code).toBe(1);
    });

    it('should refuse a schema that resolves to something that is not one', async () => {
      // what `sigil reference` refuses, in its words; spreading `null` would
      // have made an app with no name or options, which is this ticket's defect
      const ran = await spawnNode(targets[kind]!, out, ['--help'], { ASYNC_SCHEMA: 'null' });

      expect(ran.stderr).toMatch(
        /^Error: This app's entry exports no schema: .*a Promise of one\.\n$/
      );
      expect(ran.stdout).toBe('');
      expect(ran.code).toBe(1);
    });

    it('should leave a rejection main() was asked to make as a rejection', async () => {
      // `errorHandler: false` is the app saying it wants the throw, so the
      // entry's own handling must cover the schema and nothing after it: an
      // unknown command still crashes the way it does from a runner of the
      // app's own
      const ran = await spawnNode(targets[kind]!, out, ['nope', '--typo'], {
        ASYNC_SCHEMA: 'rethrow',
      });

      expect(ran.code).toBe(1);
      expect(ran.stderr).toMatch(STACK);
    });
  });
});

/**
 * The other shapes of a schema export the entry has an answer for: a Promise
 * exported outright, which it takes; a Promise of a function, which it refuses
 * as `sigil reference` does; and a function that throws before it returns
 * anything. Built from the same fixture with `--entry`, in both forms.
 */
describe('a schema exported as a Promise, and one that throws', () => {
  /** Bundles the fixture from one of its entries, in one form. */
  const bundle = async (entry: string, form: 'cjs' | 'esm'): Promise<string> => {
    const out = tempDir(`sigil-async-schema-${entry}-${form}-`);
    await bundleApp({
      app: discoverApp(app, { entry: join(app, `${entry}.js`) }),
      binName: 'async-schema',
      form,
      out,
      sourcemap: false,
      tree: resolveCommandTree(join(app, 'commands')),
    });
    return join(out, `async-schema.${form === 'cjs' ? 'cjs' : 'mjs'}`);
  };

  const bins: Record<string, string> = {};

  beforeAll(async () => {
    for (const entry of ['promised', 'promised-fn', 'throwing']) {
      for (const form of ['esm', 'cjs'] as const) {
        bins[`${entry} ${form}`] = await bundle(entry, form);
      }
    }
  }, 60_000);

  describe.each(['esm', 'cjs'])('%s', (form) => {
    it('should await a Promise exported in place of a function', async () => {
      // the shape `await declared()` alone still lost: there is no function to
      // call, and the Promise was spread into nothing
      const ran = await spawnNode(bins[`promised ${form}`]!, app, ['hello', '-l']);

      expect(ran.stdout).toBe('HELLO\n');
      expect(ran.code).toBe(0);
      expect((await spawnNode(bins[`promised ${form}`]!, app, ['--help'])).stdout).toMatch(
        /^Usage: asyncapp \[options\] <command>$/m
      );
    });

    it('should refuse a Promise of a function, as sigil reference does', async () => {
      // the shape the message names wrongly said was allowed: the export is
      // awaited and what it holds is not called, so a function is not a schema
      const ran = await spawnNode(bins[`promised-fn ${form}`]!, app, ['--help']);

      expect(ran.stderr).toMatch(/^Error: This app's entry exports no schema: /);
      expect(ran.stdout).toBe('');
      expect(ran.code).toBe(1);
    });

    it('should render a schema that throws synchronously the way it renders a rejection', async () => {
      const ran = await spawnNode(bins[`throwing ${form}`]!, app, ['--help']);

      expect(ran.stderr).toBe('Error: schema threw\n');
      expect(ran.stdout).toBe('');
      expect(ran.code).toBe(1);
    });
  });
});
