import {
  assertUpdateCheckDeclared,
  bakedUpdateCheck,
  bundleApp,
  discoverApp,
  resolveCommandTree,
  updateCheckDefine,
  UPDATE_CHECK_DEFINE,
} from '../src/build/index.ts';
import { binaryName, hostTarget } from '../src/build/index.ts';
import { readSigilConfig, type SigilConfig } from '../src/config.ts';
import { run } from '../src/index.ts';
import { whichSync } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The update check, from `sigil.json` to a built app that really runs it.
 *
 * `src/updates/` read its worker off a path relative to its own module URL,
 * and nothing imports that file -- so no bundler could see it, every app
 * `sigil build` produced died on `ENOENT` the first time it checked for an
 * update, and the build reported complete success throughout. The suite could
 * not see it because it tested the check from **source**, where the file is
 * right there. So the test that matters here builds an app and runs it.
 *
 * It needs `dist/`, like everything else in this package, and it reaches no
 * network: the app is pointed at a port nothing is listening on, which fails
 * for a reason that says which half ran. A connection refused comes from the
 * worker and proves it was found; an `ENOENT` is the defect.
 */

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const app = join(fixtures, 'updates');

// inside the fixture's own `out/` rather than beside it: `cli.test.ts` asserts
// that every file under `test/fixtures` is tracked by git, and allows exactly
// two places for output a test writes -- an `out/` with a `.gitignore` of its
// own, and anything under a `node_modules`. A directory of untracked variants
// anywhere else fails that guard, and fails it *intermittently*, because
// whether the files are still there when `cli.test.ts` runs depends on which
// file vitest finishes first.
//
// It also has to sit under `packages/cli`, because the app imports
// `@ttylabs/sigil` by name and node resolves that by walking up from the file
// -- the nearest copy is `packages/cli/node_modules`, which is why a temp
// directory would need a symlink to work at all.
const variants = join(app, 'out', 'variants');

/** Packaging needs a runtime to embed; without one there is no binary to ask. */
const hasBun = Boolean(whichSync('bun'));

afterAll(() => {
  rmSync(variants, { force: true, recursive: true });
});

/**
 * The fixture app, copied, with a `sigil.json` of the caller's beside it.
 *
 * One fixture built against several declarations rather than a fixture per
 * declaration -- and inside the repository rather than in a temp directory,
 * because the app imports `@ttylabs/sigil` by name and node resolves that by
 * walking up from the file.
 */
function variant(name: string, config?: unknown): string {
  const root = join(variants, name);
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(app, 'package.json'), join(root, 'package.json'));
  cpSync(join(app, 'src'), join(root, 'src'), { recursive: true });
  if (config !== undefined) {
    writeFileSync(join(root, 'sigil.json'), JSON.stringify(config, null, 2));
  }
  return root;
}

/**
 * Runs the CLI with both streams captured.
 *
 * `main()` handles errors rather than rejecting -- it renders the message and
 * sets `process.exitCode` -- so a refusal is read off stderr here rather than
 * awaited as a rejection. `console.error` is captured beside
 * `process.stderr.write` because vitest replaces `globalThis.console`, which
 * is the trap `build-command.test.ts` already records.
 */
async function sigil(...argv: string[]): Promise<{ code: unknown; err: string }> {
  const chunks: string[] = [];
  const spies: { mockRestore: () => void }[] = (['stdout', 'stderr'] as const).map((stream) =>
    vi.spyOn(process[stream], 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(chunk.toString());
      return true;
    }) as never)
  );
  for (const level of ['error', 'warn'] as const) {
    spies.push(
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        chunks.push(args.map(String).join(' '));
      })
    );
  }

  const before = process.exitCode;
  try {
    await run(argv);
    return { code: process.exitCode, err: chunks.join('') };
  } finally {
    process.exitCode = before;
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

/** Builds an app root and hands back the executable. */
async function build(root: string): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'sigil-upd-'));
  const { code, err } = await sigil('build', root, '--out', out);
  expect(code, err).toBeFalsy();
  return join(out, 'fixture-updates.mjs');
}

/** Runs a built app against a port nothing is listening on. */
function runApp(bin: string): string {
  const result = spawnSync(process.execPath, [bin], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      UPDATE_CACHE_DIR: mkdtempSync(join(tmpdir(), 'sigil-upd-cache-')),
      UPDATE_REGISTRY: 'https://127.0.0.1:1',
    },
  });
  return `${result.stdout}${result.stderr}`;
}

describe('a built app that checks for updates', () => {
  it('should reach its worker rather than a path that is not there', async () => {
    const out = runApp(await build(app));

    // the defect, named: the parent could not find the worker to pipe
    expect(out).not.toContain('ENOENT');
    expect(out).not.toContain('worker.ts');

    // and the worker ran, which is the only thing that can produce this
    expect(out).toContain('ECONNREFUSED');
  }, 60000);

  it('should honour a declaration that it checks nothing', async () => {
    const out = runApp(await build(variant('none', { updateCheck: { type: 'none' } })));

    // `check()` returned without looking at anything, which is the whole of
    // what `"none"` buys -- and the pair with the test above is what proves
    // the declaration reached the runtime rather than being read and dropped
    expect(out).toContain('OK ');
    expect(out).not.toContain('ECONNREFUSED');
    expect(out).not.toContain('FAILED');
  }, 60000);

  it('should bake a declared checker into the bundle', async () => {
    // a second port nothing is listening on rather than a real host: the
    // declaration is proved by *which* address the check reached for, and the
    // first version of this named a GitHub repository and went to the
    // network to find out it did not exist
    const bin = await build(
      variant('custom', {
        updateCheck: { path: ['version'], type: 'custom', url: 'https://127.0.0.1:2/v.json' },
      })
    );
    const out = runApp(bin);

    // port 2, which only the declaration names -- the app itself passes a
    // `registryURL` of port 1, so this is also the declaration beating the
    // default rather than merely being present
    expect(out).toContain('127.0.0.1:2');
    expect(out).not.toContain('127.0.0.1:1');
  }, 60000);
});

describe('what the build bakes in', () => {
  it('should say nothing where the app declared nothing', () => {
    // absent rather than `null`: an app that said nothing falls through to
    // `check()`'s own default, and `null` is the app saying it checks nothing
    const baked = bakedUpdateCheck({ compiled: false, config: {}, packageName: 'mycli' });
    expect(baked).toEqual({ compiled: false });
    expect('checker' in baked).toBe(false);
  });

  it('should say which kind of host it is building', () => {
    for (const compiled of [false, true]) {
      expect(bakedUpdateCheck({ compiled, config: {}, packageName: 'a' }).compiled).toBe(compiled);
    }
  });

  it('should turn "none" into a null checker', () => {
    const baked = bakedUpdateCheck({
      compiled: true,
      config: { updateCheck: { type: 'none' } },
      packageName: 'mycli',
    });
    expect(baked.checker).toBe(null);
  });

  it('should build an npm checker off the app name', () => {
    const baked = bakedUpdateCheck({
      compiled: true,
      config: { updateCheck: { type: 'npm' } },
      packageName: '@acme/mycli',
    });
    expect(baked.checker?.url).toBe(
      'https://registry.npmjs.org/-/package/%40acme%2Fmycli/dist-tags'
    );
    expect(baked.checker?.path).toEqual(['latest']);
  });

  it('should let the declaration name a package, a tag and a registry', () => {
    const baked = bakedUpdateCheck({
      compiled: true,
      config: {
        updateCheck: {
          distTag: 'next',
          package: 'other',
          registry: 'https://npm.example.com',
          type: 'npm',
        },
      },
      packageName: 'mycli',
    });
    expect(baked.checker?.url).toBe('https://npm.example.com/-/package/other/dist-tags');
    expect(baked.checker?.path).toEqual(['next']);
  });

  it('should refuse an npm check with no package to ask about', () => {
    expect(() =>
      bakedUpdateCheck({ compiled: true, config: { updateCheck: { type: 'npm' } } })
    ).toThrow(/needs a package name/);
  });

  it('should build a github checker', () => {
    const baked = bakedUpdateCheck({
      compiled: true,
      config: { updateCheck: { repo: 'acme/mycli', type: 'github' } },
      packageName: 'mycli',
    });
    expect(baked.checker?.url).toBe('https://api.github.com/repos/acme/mycli/releases/latest');
    expect(baked.checker?.prefix).toBe('v');
  });

  it('should build a custom checker', () => {
    const baked = bakedUpdateCheck({
      compiled: true,
      config: {
        updateCheck: { path: ['releases', 'stable'], type: 'custom', url: 'https://e.com/v.json' },
      },
      packageName: 'mycli',
    });
    expect(baked.checker).toEqual({
      path: ['releases', 'stable'],
      type: 'custom',
      url: 'https://e.com/v.json',
    });
  });

  it('should hand the bundler a string literal rather than an object', () => {
    // `define` replaces an identifier with a snippet of *source*, so the
    // value is stringified twice -- once into JSON and once into a literal
    // that JSON. Getting that wrong splices an object where an expression
    // goes and the bundle does not parse.
    const define = updateCheckDefine({ compiled: true });
    expect(JSON.parse(JSON.parse(define[UPDATE_CHECK_DEFINE]!))).toEqual({ compiled: true });
  });
});

// a compiled app has no runtime to spawn and no npm default -- npm is the
// right answer for something somebody installed and a guess for a binary
// somebody downloaded. So one that imports the check and declares nothing
// ships a feature that silently does nothing, which is a build reporting
// success over something that cannot work
describe('what sigil package refuses', () => {
  it('should refuse a binary whose check has nothing to look at', () => {
    expect(() => assertUpdateCheckDeclared({}, true)).toThrow(/@ttylabs\/sigil\/updates/);
    expect(() => assertUpdateCheckDeclared({}, true)).toThrow(/sigil\.json/);
  });

  it('should say how to say it checks nothing', () => {
    // the error has to name the way out, because an app that passes a
    // `checker` to `check()` in its own source is doing nothing wrong and
    // this cannot see that it did
    expect(() => assertUpdateCheckDeclared({}, true)).toThrow(/"none"/);
  });

  it('should allow an app that declared one', () => {
    for (const updateCheck of [
      { type: 'none' },
      { type: 'npm' },
      { repo: 'a/b', type: 'github' },
    ] satisfies SigilConfig['updateCheck'][]) {
      expect(() => assertUpdateCheckDeclared({ updateCheck }, true)).not.toThrow();
    }
  });

  it('should say nothing about an app that does not check at all', () => {
    expect(() => assertUpdateCheckDeclared({}, false)).not.toThrow();
  });
});

describe('what sigil.json will take', () => {
  function read(config: unknown): SigilConfig {
    const root = variant(`cfg-${Math.random().toString(36).slice(2, 8)}`, config);
    return readSigilConfig(root);
  }

  it('should require a kind', () => {
    expect(() => read({ updateCheck: { repo: 'a/b' } })).toThrow(/"updateCheck.type" is required/);
  });

  it('should refuse a kind it does not know', () => {
    expect(() => read({ updateCheck: { type: 'carrier-pigeon' } })).toThrow(/updateCheck.type/);
  });

  it('should refuse a field that belongs to another kind', () => {
    // almost always somebody who changed the kind and left the old field
    // behind, and taking it silently bakes a check that looks at something
    // the author stopped meaning
    expect(() => read({ updateCheck: { repo: 'a/b', type: 'npm' } })).toThrow(
      /"updateCheck.repo" does not belong to a "npm" check/
    );
    expect(() => read({ updateCheck: { distTag: 'next', repo: 'a/b', type: 'github' } })).toThrow(
      /"updateCheck.distTag" does not belong to a "github" check/
    );
  });

  it('should refuse a github check with no repo and a custom one with no url', () => {
    expect(() => read({ updateCheck: { type: 'github' } })).toThrow(/needs "updateCheck.repo"/);
    expect(() => read({ updateCheck: { path: ['v'], type: 'custom' } })).toThrow(
      /needs "updateCheck.url" and "updateCheck.path"/
    );
    expect(() => read({ updateCheck: { type: 'custom', url: 'https://e.com' } })).toThrow(
      /needs "updateCheck.url" and "updateCheck.path"/
    );
  });

  it('should take an empty github prefix, which is a real answer', () => {
    // `""` is how a repository whose tags are already versions says so, so
    // this is the one name in the file that is not refused for being empty
    const config = read({ updateCheck: { prefix: '', repo: 'a/b', type: 'github' } });
    expect(config.updateCheck?.prefix).toBe('');
  });

  it('should take each kind written correctly', () => {
    expect(read({ updateCheck: { type: 'none' } }).updateCheck?.type).toBe('none');
    expect(
      read({ updateCheck: { distTag: 'next', package: 'x', type: 'npm' } }).updateCheck?.distTag
    ).toBe('next');
    expect(
      read({ updateCheck: { path: ['a', 'b'], type: 'custom', url: 'https://e.com' } }).updateCheck
        ?.path
    ).toEqual(['a', 'b']);
  });
});

// the join between the two halves above: `sigil package` refuses an app that
// imports the update check, and `bundleApp()` is what answers whether it
// does. Asked of the **specifier** rather than of a resolved path, because
// the path is a different string in a monorepo, in an install and under a
// link, while the specifier is what an app writes
describe('whether the bundle reached the update check', () => {
  it('should see an app that imports it', async () => {
    const out = mkdtempSync(join(tmpdir(), 'sigil-upd-uses-'));
    try {
      const result = await bundleApp({
        app: discoverApp(app),
        binName: 'fixture-updates',
        out,
        tree: { commands: [], diagnostics: [] },
      });
      expect(result.usesUpdateCheck).toBe(true);
    } finally {
      rmSync(out, { force: true, recursive: true });
    }
  }, 60000);

  it('should not see one in an app that does not', async () => {
    // the negative matters more than the positive: a detector that always
    // answers yes refuses every packaged app, and this file already records
    // what an error that fires on correct code costs
    const buildable = join(fixtures, 'buildable');
    const out = mkdtempSync(join(tmpdir(), 'sigil-upd-unused-'));
    try {
      const result = await bundleApp({
        app: discoverApp(buildable),
        binName: 'buildable',
        out,
        tree: resolveCommandTree(join(buildable, 'src', 'commands')),
      });
      expect(result.usesUpdateCheck).toBe(false);
    } finally {
      rmSync(out, { force: true, recursive: true });
    }
  }, 60000);
});

// the half of the ticket that `sigil build` cannot reach: inside a
// single-file executable `process.execPath` is the app's **own binary**, so
// the spawned path would re-run the CLI rather than start a runtime. These
// package a real binary and ask it, because nothing short of that can tell a
// check that ran in process from one that was never attempted
describe('a packaged binary', () => {
  it.skipIf(!hasBun)(
    'should be refused when its check has nothing to look at',
    async () => {
      const out = mkdtempSync(join(tmpdir(), 'sigil-upd-pkg-'));
      try {
        const { code, err } = await sigil('package', app, '--runtime', 'bun', '--out', out);
        expect(code).toBeTruthy();
        expect(err).toContain('@ttylabs/sigil/updates');
        expect(err).toContain('"none"');

        // and it refused before writing one, which is the half that makes
        // this worth doing after the bundle rather than after the compile
        expect(readdirSync(out)).toEqual([]);
      } finally {
        rmSync(out, { force: true, recursive: true });
      }
    },
    180000
  );

  it.skipIf(!hasBun)(
    'should check in process rather than re-running itself',
    async () => {
      const root = variant('pkg', {
        updateCheck: { path: ['version'], type: 'custom', url: 'https://127.0.0.1:1/v.json' },
      });
      const out = mkdtempSync(join(tmpdir(), 'sigil-upd-pkg-'));
      const { code, err } = await sigil('package', root, '--runtime', 'bun', '--out', out);
      expect(code, err).toBeFalsy();

      const binary = join(out, binaryName('fixture-updates', hostTarget()));
      const result = spawnSync(binary, [], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          UPDATE_CACHE_DIR: mkdtempSync(join(tmpdir(), 'sigil-upd-cache-')),
        },
      });
      const text = `${result.stdout}${result.stderr}`;
      rmSync(out, { force: true, recursive: true });

      // the check was attempted, here, and reached the declared address
      expect(text).toContain('127.0.0.1:1');

      // and the binary ran once: re-executing itself would print this twice,
      // which is what spawning `process.execPath` inside an executable does
      expect(text.match(/FAILED/g) ?? []).toHaveLength(1);
    },
    180000
  );
});
