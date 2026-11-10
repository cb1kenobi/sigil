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
});
