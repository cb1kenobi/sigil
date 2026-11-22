import {
  assertUpdateCheckDeclared,
  bakedUpdateCheck,
  bundleApp,
  checkSchemaUpdateCheck,
  discoverApp,
  readSchemaUpdateCheck,
  schemaWantsUpdateCheck,
  resolveCommandTree,
  updateCheckDefine,
  UPDATE_CHECK_DEFINE,
} from '../src/build/index.ts';
import { binaryName, hostTarget } from '../src/build/index.ts';
import { readSigilConfig, type SigilConfig } from '../src/config.ts';
import { run } from '../src/index.ts';
import { tempDir } from './temp.js';
import { checkedChecker } from '@ttylabs/sigil/updates';
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
function variant(name: string, config?: unknown, entry?: string, file = 'index.js'): string {
  const root = join(variants, name);
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(app, 'package.json'), join(root, 'package.json'));
  cpSync(join(app, 'src'), join(root, 'src'), { recursive: true });
  if (entry !== undefined) {
    writeFileSync(join(root, 'src', file), entry);
  }
  if (config !== undefined) {
    writeFileSync(join(root, 'sigil.json'), JSON.stringify(config, null, 2));
  }
  return root;
}

/**
 * An entry module holding a schema with `schemaBody` in it, written into a variant of its own.
 *
 * `file` is `index.ts` for anything with `<T>x` in it: oxc reads the language off
 * the filename, and in a `.js` file the angle bracket opens JSX.
 */
function entryOf(schemaBody: string, preamble = '', file = 'index.js'): string {
  const root = variant(
    `schema-${Math.random().toString(36).slice(2, 8)}`,
    undefined,
    [preamble, `export default { name: 'x', commands: './commands', ${schemaBody} };`, ''].join(
      '\n'
    ),
    file
  );
  return join(root, 'src', file);
}

/** `expression` under each wrapper `unwrapShallow()` looks through that changes nothing at run time. */
const WRAPPERS: [string, (expression: string) => string][] = [
  ['<T>', (expression) => `<Type>${expression}`],
  ['as', (expression) => `${expression} as Type`],
  ['satisfies', (expression) => `${expression} satisfies Type`],
];

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
  const out = tempDir('sigil-upd-');
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
      UPDATE_CACHE_DIR: tempDir('sigil-upd-cache-'),
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
    expect(baked).toEqual({ compiled: false, packageName: 'mycli' });
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

  it.each(['o/n\nx', 'o /n', 'o/n x', 'o/..'])(
    'should refuse a github repo that is not a name GitHub allows: %j',
    (repo) => {
      // SIG-541, from the `build` and `package` side: the same function `check` asks
      expect(() =>
        bakedUpdateCheck({
          compiled: true,
          config: { updateCheck: { repo, type: 'github' } },
          packageName: 'mycli',
        })
      ).toThrow(/must be "owner\/name"/);
    }
  );

  it.each(['not a url', 'ftp://npm.example.com', 'http://npm.example.com', 'https://h/a\nb'])(
    'should refuse an npm registry that is not an absolute https URL: %j',
    (registry) => {
      // SIG-544: `registry` is the one root `sigil.json` can set, and it was
      // joined to the request path as written
      expect(() =>
        bakedUpdateCheck({
          compiled: true,
          config: { updateCheck: { package: 'other', registry, type: 'npm' } },
          packageName: 'mycli',
        })
      ).toThrow(/"updateCheck.registry" must be an absolute https:\/\/ URL/);
    }
  );

  it('should name the key the author wrote, and not the option a builder calls it (SIG-547)', () => {
    // `registry` is `npmChecker()`'s `registryURL`, `package` is its
    // `packageName`: a refusal that said so told an author about a word they
    // never typed. One row per key that is renamed on the way in, and `repo`,
    // `url` and `path` beside them because each is refused by the same path
    const refused = (updateCheck: object, packageName = 'mycli'): string => {
      try {
        bakedUpdateCheck({ compiled: true, config: { updateCheck } as never, packageName });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };

    const cases: [key: string, builderWord: string, updateCheck: object][] = [
      ['updateCheck.registry', 'registryURL', { registry: 'http://r.example', type: 'npm' }],
      ['updateCheck.package', 'package name', { package: 42, type: 'npm' }],
      ['updateCheck.distTag', 'dist tag', { distTag: 42, package: 'p', type: 'npm' }],
      ['updateCheck.repo', 'repo', { repo: 'notarepo', type: 'github' }],
      ['updateCheck.url', 'url', { path: ['v'], type: 'custom', url: 'ftp://h' }],
      ['updateCheck.path', 'path', { path: [1], type: 'custom', url: 'https://h/x' }],
      [
        'updateCheck.prefix',
        'prefix',
        { path: ['v'], prefix: '', type: 'custom', url: 'https://h/x' },
      ],
    ];

    for (const [key, word, updateCheck] of cases) {
      const message = refused(updateCheck);
      expect(message, key).toMatch(new RegExp(`^Update check "${key}" `));
      expect(message, key).not.toContain(`Update check ${word}`);
    }
    // the sentence the builder wrote survives, so what was wrong is still said
    expect(refused({ registry: 'http://r.example', type: 'npm' })).toBe(
      'Update check "updateCheck.registry" must be an absolute https:// URL with no ' +
        'credentials, query or fragment, got "http://r.example"'
    );
    expect(refused({ repo: 'notarepo', type: 'github' })).toBe(
      'Update check "updateCheck.repo" must be "owner/name", got "notarepo"'
    );
  });

  it('should not re-word anything but the refusal of a declared key', () => {
    // an error from somewhere else keeps its own words, and its own class
    expect(() =>
      bakedUpdateCheck({
        compiled: true,
        config: { updateCheck: { type: 'npm' } },
        packageName: '',
      })
    ).toThrow(/needs a package name/);
  });

  it.each([
    'ftp://h/latest.json',
    'http://h/latest.json',
    'https://h/\nx',
    'https://h/a b',
    'latest.json',
    'https://',
    'https:///x',
    'https://user:pass@h/latest.json',
    'https://h/latest.json#frag',
  ])('should refuse a custom url that is not an absolute https URL: %j', (url) => {
    // SIG-546: it was copied across as written, so each of these was baked into
    // a worker that fetches `https:` only and swallows the failure
    expect(() =>
      bakedUpdateCheck({
        compiled: true,
        config: { updateCheck: { path: ['version'], type: 'custom', url } },
        packageName: 'mycli',
      })
    ).toThrow(/^Update check "updateCheck.url" must be an absolute https:\/\/ URL/);
  });

  it('should keep the query of a custom url, which an endpoint may need', () => {
    const baked = bakedUpdateCheck({
      compiled: true,
      config: {
        updateCheck: {
          path: ['version'],
          type: 'custom',
          url: 'https://h/api/latest?channel=stable',
        },
      },
      packageName: 'mycli',
    });
    expect(baked.checker?.url).toBe('https://h/api/latest?channel=stable');
  });

  it("should carry a custom check's prefix, which strips what the endpoint puts in front of a version (SIG-555)", () => {
    const baked = bakedUpdateCheck({
      compiled: true,
      config: {
        updateCheck: { path: ['tag'], prefix: 'v', type: 'custom', url: 'https://h/latest.json' },
      },
      packageName: 'mycli',
    });
    expect(baked.checker).toEqual({
      path: ['tag'],
      prefix: 'v',
      type: 'custom',
      url: 'https://h/latest.json',
    });
  });

  it('should refuse a custom prefix that is empty, naming the key', () => {
    const prefix = '';
    expect(() =>
      bakedUpdateCheck({
        compiled: true,
        config: { updateCheck: { path: ['tag'], prefix, type: 'custom', url: 'https://h/x' } },
        packageName: 'mycli',
      })
    ).toThrow(
      'Update check "updateCheck.prefix" must be a non-empty string with no leading whitespace or ' +
        'control character, got ""'
    );
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

  it('should print that literal with quote(), so no separator is left raw', () => {
    // SIG-353: the one helper for a string printed as source. JSON leaves
    // U+2028 raw and V8 counts it as a line break. Built from a code point so
    // that no tool between here and the file turns an escape into the character
    const separator = String.fromCharCode(0x2028);
    const packageName = `pkg${separator}name`;
    const literal = updateCheckDefine({ compiled: true, packageName })[UPDATE_CHECK_DEFINE]!;

    expect(literal.includes(separator)).toBe(false);
    expect(JSON.parse(JSON.parse(literal))).toEqual({ compiled: true, packageName });
  });

  it('should carry the package name even when nothing was declared', () => {
    // the program is `sigil` and the package is `@ttylabs/cli`, and an
    // automatic check has only the first in hand
    for (const config of [{}, { updateCheck: { type: 'none' } }] satisfies SigilConfig[]) {
      expect(
        bakedUpdateCheck({ compiled: false, config, packageName: '@ttylabs/cli' }).packageName
      ).toBe('@ttylabs/cli');
    }
  });

  it('should leave the name out where the manifest has none', () => {
    expect('packageName' in bakedUpdateCheck({ compiled: false, config: {} })).toBe(false);
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

  it('should take a prefix on a custom check, and still refuse one on an npm check', () => {
    expect(
      read({ updateCheck: { path: ['a'], prefix: 'v', type: 'custom', url: 'https://e.com' } })
        .updateCheck?.prefix
    ).toBe('v');
    expect(() => read({ updateCheck: { package: 'x', prefix: 'v', type: 'npm' } })).toThrow(
      /"updateCheck.prefix" does not belong to a "npm" check/
    );
  });

  it('should not carry headers into the build, which would put a credential in a committed file', () => {
    // an unknown key beside the section is ignored, as `config.test.ts` pins for
    // `build`, so this is a file that was read and a key that went nowhere
    const config = read({
      updateCheck: {
        headers: { authorization: 'hunter2' },
        path: ['a'],
        type: 'custom',
        url: 'https://e.com',
      },
    });
    expect(config.updateCheck).not.toHaveProperty('headers');
    const baked = bakedUpdateCheck({ compiled: true, config, packageName: 'mycli' });
    expect(JSON.stringify(baked)).not.toContain('hunter2');
    expect(baked.checker).not.toHaveProperty('headers');
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
          UPDATE_CACHE_DIR: tempDir('sigil-upd-cache-'),
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

// `updateCheck: true` on the schema is the app asking for a check without ever
// importing `@ttylabs/sigil/updates`, so the bundler's watch on that specifier
// cannot see it. The schema is read instead -- and it errs towards **not**
// refusing, because a false refusal stops a correct build while a missed one
// costs a notice that never appears
describe('whether the schema asks for an update check', () => {
  /** Read the way `sigil package` reads it. */
  function wants(schemaBody: string, preamble = ''): boolean {
    return schemaWantsUpdateCheck(entryOf(schemaBody, preamble));
  }

  it.each([
    ['true', 'updateCheck: true'],
    ['an options object', "updateCheck: { distTag: 'next' }"],
    ['a message and no checker of its own', 'updateCheck: { message: () => "update" }'],
    ['a computed value', 'updateCheck: process.env.CHECK === "1"'],
    ['a quoted key', '"updateCheck": true'],
  ])('should see %s', (_what, body) => {
    expect(wants(body)).toBe(true);
  });

  it.each([
    ['nothing', ''],
    ['false', 'updateCheck: false'],
    [
      'a checker of its own',
      "updateCheck: { checker: { type: 'x', path: ['v'], url: 'https://e.com' } }",
    ],
    ['a call building its own checker', "updateCheck: { checker: githubChecker({ repo: 'a/b' }) }"],
    // the shorthand: where to look is all there is to say
    [
      'a checker written out and given bare',
      "updateCheck: { type: 'x', path: ['v'], url: 'https://e.com' }",
    ],
    // a key this cannot read is a key it will not refuse over
    ['a computed key', "['updateCheck']: true"],
    ['a method', 'updateCheck() { return true; }'],
  ])('should not refuse over %s', (_what, body) => {
    expect(wants(body)).toBe(false);
  });
});

// `updateCheck: githubChecker({ repo })` is `{ checker: githubChecker({ repo }) }`
// said shorter, and the build has to read it as the same thing: the call is a
// binding of the import rather than a spelling, and `objectLiteral()` looks
// through a call with one object argument, so a reader that asked it first
// would take `{ repo }` for the options and refuse a correct build
describe('whether the schema names its own checker', () => {
  const builders = "import { githubChecker, npmChecker } from '@ttylabs/sigil/updates';";

  function reads(
    schemaBody: string,
    preamble = builders
  ): ReturnType<typeof readSchemaUpdateCheck> {
    return readSchemaUpdateCheck(entryOf(schemaBody, preamble));
  }

  it.each([
    ['a github checker given bare', "updateCheck: githubChecker({ repo: 'a/b' })"],
    ['an npm checker given bare', "updateCheck: npmChecker({ packageName: 'x' })"],
    ['one inside the options', "updateCheck: { checker: githubChecker({ repo: 'a/b' }) }"],
    ['one in parentheses', "updateCheck: (githubChecker({ repo: 'a/b' }))"],
    ['one written out', "updateCheck: { type: 'x', path: ['v'], url: 'https://e.com' }"],
  ])('should see %s', (_what, body) => {
    expect(reads(body)).toBe('names');
  });

  it('should see a builder imported under another name', () => {
    expect(
      reads(
        "updateCheck: gh({ repo: 'a/b' })",
        "import { githubChecker as gh } from '@ttylabs/sigil/updates';"
      )
    ).toBe('names');
    expect(
      reads(
        "updateCheck: updates.githubChecker({ repo: 'a/b' })",
        "import * as updates from '@ttylabs/sigil/updates';"
      )
    ).toBe('names');
  });

  it.each([
    ['true', 'updateCheck: true'],
    ['options with no checker', "updateCheck: { distTag: 'next' }"],
    // not the builder: a local of that name, or one from somewhere else, is
    // not a statement about where to look
    ['a call that is not the builder', "updateCheck: somethingElse({ repo: 'a/b' })"],
  ])('should see %s as asking without saying where', (_what, body) => {
    expect(reads(body)).toBe('asks');
  });

  it('should not take a local of the same name for the builder', () => {
    expect(
      reads(
        "updateCheck: githubChecker({ repo: 'a/b' })",
        'const githubChecker = (options) => options;'
      )
    ).toBe('asks');
  });

  it('should say nothing for a schema that does not ask', () => {
    expect(reads('')).toBe(undefined);
    expect(reads('updateCheck: false')).toBe(undefined);
  });

  // SIG-575: `unwrapShallow()` gained `<T>x` in SIG-569 and only `schema-module.ts`
  // had a test for it. Without the case a wrapped builder call is "asks" rather
  // than "names", and the build refuses an app that did say where to look
  describe.each(WRAPPERS)('under %s', (_wrapper, wrap) => {
    const readsTs = (body: string): ReturnType<typeof readSchemaUpdateCheck> =>
      readSchemaUpdateCheck(entryOf(body, builders, 'index.ts'));

    it.each([
      ['a builder given bare', `updateCheck: ${wrap("githubChecker({ repo: 'a/b' })")}`],
      [
        'a checker written out',
        `updateCheck: ${wrap("{ type: 'x', path: ['v'], url: 'https://e.com' }")}`,
      ],
    ])('should see %s as the bare form is seen', (_what, body) => {
      expect(readsTs(body)).toBe('names');
    });

    it('should still see options with no checker as asking without saying where', () => {
      expect(readsTs(`updateCheck: ${wrap("{ distTag: 'next' }")}`)).toBe('asks');
    });
  });
});

// SIG-564: `check()` refuses a hand-written checker that could never work, and a
// schema's `updateCheck` reaches it through `beginUpdateCheck()`, which swallows the
// refusal -- so the notice went silent and nothing told the author. The toolchain
// asks the same function of the source, and it is an error, because the app would
// never show an update notice
describe('a schema checker the update check would refuse', () => {
  const written = (url: string, path = "['version']", extra = ''): string =>
    `{ type: 'custom', url: ${url}, path: ${path}${extra} }`;

  function refused(schemaBody: string, preamble = ''): string[] {
    return checkSchemaUpdateCheck(entryOf(schemaBody, preamble)).map((d) => d.message);
  }

  it.each([
    ['a URL that is not https', `updateCheck: { checker: ${written("'http://e.com/v'")} }`, /url/],
    ['the same given bare', `updateCheck: ${written("'ftp://e.com/v'")}`, /url/],
    [
      'a URL with credentials, which is never quoted',
      `updateCheck: { checker: ${written("'https://user:hunter2@e.com/v'")} }`,
      /^(?!.*hunter2)/s,
    ],
    ['an empty path', `updateCheck: { checker: ${written("'https://e.com/v'", '[]')} }`, /path/],
    [
      'a path that is not a list',
      `updateCheck: { checker: ${written("'https://e.com/v'", "'version'")} }`,
      /path/,
    ],
    [
      'a header holding a newline',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ", headers: { Accept: 'a\\nb' }") +
        ' }',
      /header "Accept"/,
    ],
    [
      'a header name that is not a token',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ", headers: { 'Bad Name': 'x' }") +
        ' }',
      /header name/,
    ],
    [
      'a header whose value is written as an object',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ', headers: { Accept: {} }') +
        ' }',
      /header "Accept"/,
    ],
    [
      'a header whose value is written as a function',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ', headers: { Accept: () => 1 }') +
        ' }',
      /header "Accept"/,
    ],
    [
      'a header whose value is written as a bigint',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ', headers: { Accept: 1n }') +
        ' }',
      /header "Accept"/,
    ],
    [
      'a url that a spread before it does not replace',
      `updateCheck: { checker: { ...base, ...${written("'http://e.com/v'")} } }`,
      /url/,
    ],
    [
      'a url whose key is a computed string',
      `updateCheck: { checker: { ['url']: 'http://e.com/v', type: 'custom', path: ['v'] } }`,
      /url/,
    ],
    [
      'the last of two urls',
      `updateCheck: { checker: { url: 'https://e.com/v', url: 'http://e.com/v', path: ['v'] } }`,
      /url/,
    ],
    [
      'a checker in parentheses',
      `updateCheck: { checker: (${written("'http://e.com/v'")}) }`,
      /url/,
    ],
    [
      'headers written as a list of pairs',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ", headers: [['a', 'b']]") +
        ' }',
      /headers must be an object/,
    ],
    // a name is read as the type it needs, so these are still checkers written bare
    [
      'a bare literal whose path is a name',
      "updateCheck: { type: 'custom', url: 'http://e.com/v', path: keys }",
      /url/,
    ],
    [
      'a bare literal whose url is a name',
      "updateCheck: { type: 'custom', url: base, path: [] }",
      /path/,
    ],
    [
      'a bare literal beside a valid checker key, which the runtime never reads',
      `updateCheck: { ...${written("'http://e.com/v'")}, checker: ${written("'https://e.com/v'")} }`,
      /url/,
    ],
    [
      'a bare literal after a spread that may carry a checker key',
      `updateCheck: { ...opts, ${written("'http://e.com/v'").slice(2)}`,
      /url/,
    ],
    [
      'a checker with no url at all',
      "updateCheck: { checker: { type: 'custom', path: ['v'] } }",
      /url/,
    ],
  ])('should refuse %s', (_what, body, message) => {
    const found = refused(body);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/never shows an update notice/);
    expect(found[0]).toMatch(message);
  });

  it('should say what the runtime says, from the one definition of the rules', () => {
    const [message] = refused(`updateCheck: { checker: ${written("'http://e.com/v'")} }`);
    let said = '';
    try {
      checkedChecker({ path: ['version'], type: 'custom', url: 'http://e.com/v' });
    } catch (err) {
      said = (err as Error).message;
    }
    expect(said).not.toBe('');
    expect(message).toContain(said);
  });

  it('should point at the checker', () => {
    const [diagnostic] = checkSchemaUpdateCheck(
      entryOf(`updateCheck: { checker: ${written("'http://e.com/v'")} }`)
    );
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.line).toBe(2);
    expect(diagnostic?.column).toBeGreaterThan(1);
  });

  // what the source does not settle is read as valid, for the reason the schema's
  // other readers err towards not refusing: a false refusal stops a correct build
  it.each([
    ['a good literal', `updateCheck: { checker: ${written("'https://e.com/v'")} }`],
    ['a good literal given bare', `updateCheck: ${written("'https://e.com/v?c=stable'")}`],
    ['a URL that is a name', `updateCheck: { checker: ${written('base')} }`],
    ['a URL with a substitution', `updateCheck: { checker: ${written('`${base}/v`')} }`],
    ['a path that is a name', `updateCheck: { checker: ${written("'https://e.com/v'", 'keys')} }`],
    [
      'a header whose value is a template',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ', headers: { Authorization: `Bearer ${token}` }') +
        ' }',
    ],
    [
      'headers that are a name',
      `updateCheck: { checker: ${written("'https://e.com/v'", "['v']", ', headers')} }`,
    ],
    [
      'a spread that may carry the url',
      `updateCheck: { checker: { ...base, type: 'custom', path: ['v'] } }`,
    ],
    // a list is a header value Node sends
    [
      'a header whose value is a list',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ", headers: { Accept: ['a', 'b'] }") +
        ' }',
    ],
    [
      'a header that is an accessor',
      'updateCheck: { checker: ' +
        written("'https://e.com/v'", "['v']", ", headers: { get Accept() { return 'x'; } }") +
        ' }',
    ],
    // a spread after the url may have replaced it
    [
      'a url a later spread may replace',
      `updateCheck: { checker: { url: 'http://e.com/v', ...base, type: 'custom', path: ['v'] } }`,
    ],
    // what the runtime reads as options, which check npm and refuse nothing
    [
      'a bare literal whose path is a string',
      "updateCheck: { type: 'custom', url: 'http://e.com/v', path: 'version' }",
    ],
    ['a bare literal with no path', "updateCheck: { type: 'custom', url: 'http://e.com/v' }"],
    ['a bare literal with no type', "updateCheck: { url: 'http://e.com/v', path: ['v'] }"],
    [
      'an updateCheck a later spread may replace',
      `updateCheck: { checker: ${written("'http://e.com/v'")} }, ...overrides`,
    ],
    // `isChecker()` is asked first at run time: not a list, or a name, or a type
    // that is not a string, is not a checker written bare
    [
      'a bare literal whose path is an object',
      "updateCheck: { type: 'custom', url: 'http://e.com/v', path: {} }",
    ],
    [
      'a bare literal whose path is a pattern',
      "updateCheck: { type: 'custom', url: 'http://e.com/v', path: /v/ }",
    ],
    [
      'a bare literal whose type is a number',
      "updateCheck: { type: 1, url: 'http://e.com/v', path: ['v'] }",
    ],
    [
      'a bare literal whose url is a number',
      "updateCheck: { type: 'custom', url: 42, path: ['v'] }",
    ],
    // the bare form wins over a `checker` beside it, and the refusal is of the bare one
    [
      'a valid bare literal beside a refused checker key',
      `updateCheck: { ...${written("'https://e.com/v'")}, checker: ${written("'http://e.com/v'")} }`,
    ],
    ['a checker held in a variable', 'updateCheck: { checker }'],
    ['a function call that builds it', 'updateCheck: { checker: build() }'],
    ['true', 'updateCheck: true'],
    ['options with no checker', "updateCheck: { distTag: 'next' }"],
    ['false', 'updateCheck: false'],
    ['nothing', ''],
    // a builder refuses where it is called, which is the app failing to start
    ['a builder, whatever it is given', "updateCheck: customChecker({ url: 'http://e.com' })"],
  ])('should leave %s alone', (_what, body) => {
    expect(refused(body)).toEqual([]);
  });

  // SIG-575: the readers of a checker look through `<T>`, `as` and `satisfies` at
  // every level, because `updateCheck: <Options>{ checker: <Checker>{ ... } }` is
  // what an app writes to have its literal typed. A reader that stopped seeing
  // through one read the wrapped checker as no checker, and a refusal that went
  // missing is the notice that never appears, which is what SIG-564 is about
  describe.each(WRAPPERS)('written under %s', (_wrapper, wrap) => {
    const refusedTs = (body: string): string[] =>
      checkSchemaUpdateCheck(entryOf(body, '', 'index.ts')).map((d) => d.message);

    it.each([
      ['the options', `updateCheck: ${wrap(`{ checker: ${written("'http://e.com/v'")} }`)}`, /url/],
      [
        'the checker inside them',
        `updateCheck: { checker: ${wrap(written("'http://e.com/v'"))} }`,
        /url/,
      ],
      ['a checker given bare', `updateCheck: ${wrap(written("'ftp://e.com/v'"))}`, /url/],
      ['a path', `updateCheck: { checker: ${written("'https://e.com/v'", wrap('[]'))} }`, /path/],
      [
        'the headers',
        `updateCheck: { checker: ${written(
          "'https://e.com/v'",
          "['v']",
          `, headers: ${wrap("{ Accept: 'a\\nb' }")}`
        )} }`,
        /header "Accept"/,
      ],
      [
        'a header value',
        `updateCheck: { checker: ${written(
          "'https://e.com/v'",
          "['v']",
          `, headers: { Accept: ${wrap('1n')} }`
        )} }`,
        /header "Accept"/,
      ],
      [
        'a path inside a bare literal',
        `updateCheck: { type: 'custom', url: 'https://e.com/v', path: ${wrap('[]')} }`,
        /path/,
      ],
    ])(
      'should refuse a checker with %s wrapped as it refuses the bare one',
      (_what, body, message) => {
        const found = refusedTs(body);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatch(/never shows an update notice/);
        expect(found[0]).toMatch(message);
      }
    );

    it.each([
      // a list is a header value Node sends, and only a wrapped one is read through line by line
      [
        'a header value that is a list',
        `updateCheck: { checker: ${written(
          "'https://e.com/v'",
          "['v']",
          `, headers: { Accept: ${wrap("['a', 'b']")} }`
        )} }`,
      ],
      ['the options', `updateCheck: ${wrap(`{ checker: ${written("'https://e.com/v'")} }`)}`],
      ['the checker', `updateCheck: { checker: ${wrap(written("'https://e.com/v'"))} }`],
      ['a path', `updateCheck: { checker: ${written("'https://e.com/v'", wrap("['v']"))} }`],
    ])('should leave a good checker with %s wrapped alone', (_what, body) => {
      expect(refusedTs(body)).toEqual([]);
    });
  });

  it('should reach `sigil check`, `sigil build` and `sigil package` and fail each', async () => {
    const root = variant(
      'schema-refused',
      undefined,
      [
        'export default {',
        "  name: 'fixture-refused',",
        "  version: '1.0.0',",
        "  updateCheck: { checker: { type: 'custom', url: 'http://e.com/v', path: ['v'] } },",
        '  run() {},',
        '};',
        '',
      ].join('\n')
    );

    const checked = await sigil('check', root);
    expect(checked.code).toBeTruthy();
    expect(checked.err).toContain('never shows an update notice');

    const out = tempDir('sigil-upd-');
    const built = await sigil('build', root, '--out', out);
    expect(built.code).toBeTruthy();
    expect(built.err).toContain('never shows an update notice');
    expect(readdirSync(out)).toEqual([]);

    // before any runtime is chosen or fetched, so this needs neither bun nor a network
    const packaged = await sigil('package', root, '--out', out);
    expect(packaged.code).toBeTruthy();
    expect(packaged.err).toContain('never shows an update notice');
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('what the refusal says', () => {
  it('should name the schema when that is how the app asked', () => {
    expect(() => assertUpdateCheckDeclared({}, 'schema')).toThrow(/sets updateCheck in its schema/);
    expect(() => assertUpdateCheckDeclared({}, 'schema')).toThrow(/"none"/);
  });

  it('should name the import when that is how the app asked', () => {
    expect(() => assertUpdateCheckDeclared({}, 'import')).toThrow(
      /imports @ttylabs\/sigil\/updates/
    );
  });

  it('should be satisfied by a declaration whichever way the app asked', () => {
    for (const use of ['import', 'schema'] as const) {
      expect(() => assertUpdateCheckDeclared({ updateCheck: { type: 'none' } }, use)).not.toThrow();
    }
  });
});

describe('a packaged binary that asks in its schema', () => {
  const source = [
    'export default {',
    "  name: 'fixture-auto',",
    "  version: '1.0.0',",
    '  updateCheck: true,',
    "  run() { process.stdout.write('ran\\n'); },",
    '};',
    '',
  ].join('\n');

  it.skipIf(!hasBun)(
    'should be refused without ever importing the update check',
    async () => {
      const root = variant('auto-refused', undefined, source);
      const out = mkdtempSync(join(tmpdir(), 'sigil-upd-pkg-'));
      try {
        const { code, err } = await sigil('package', root, '--runtime', 'bun', '--out', out);
        expect(code).toBeTruthy();
        expect(err).toContain('sets updateCheck in its schema');
        expect(readdirSync(out)).toEqual([]);
      } finally {
        rmSync(out, { force: true, recursive: true });
      }
    },
    180000
  );

  // the checker is where to look, so an app that gives one in its schema has
  // said it -- and importing the builder to do so is what puts the update check
  // in the graph, which used to be refused as a second thing to declare
  it.skipIf(!hasBun)(
    'should package with a checker given bare in the schema, and no sigil.json',
    async () => {
      const root = variant(
        'auto-bare',
        undefined,
        [
          "import { githubChecker } from '@ttylabs/sigil/updates';",
          'export default {',
          "  name: 'fixture-bare',",
          "  version: '1.0.0',",
          "  updateCheck: githubChecker({ repo: 'acme/mycli' }),",
          "  run() { process.stdout.write('ran\\n'); },",
          '};',
          '',
        ].join('\n')
      );
      const out = mkdtempSync(join(tmpdir(), 'sigil-upd-pkg-'));
      try {
        const { code, err } = await sigil('package', root, '--runtime', 'bun', '--out', out);
        expect(code, err).toBeFalsy();

        const result = spawnSync(join(out, binaryName('fixture-updates', hostTarget())), [], {
          encoding: 'utf-8',
        });
        expect(result.stdout).toBe('ran\n');
        expect(result.stderr).toBe('');
      } finally {
        rmSync(out, { force: true, recursive: true });
      }
    },
    180000
  );

  // the other direction, because relaxing a refusal is only safe if the one
  // case it was written for still gets it: switching the check on, importing
  // the builder, and naming no place to look
  it.skipIf(!hasBun)(
    'should still be refused when it imports a builder and never gives it to updateCheck',
    async () => {
      const root = variant(
        'auto-unused-builder',
        undefined,
        [
          "import { githubChecker } from '@ttylabs/sigil/updates';",
          'void githubChecker;',
          'export default {',
          "  name: 'fixture-unused',",
          "  version: '1.0.0',",
          '  updateCheck: true,',
          "  run() { process.stdout.write('ran\\n'); },",
          '};',
          '',
        ].join('\n')
      );
      const out = mkdtempSync(join(tmpdir(), 'sigil-upd-pkg-'));
      try {
        const { code, err } = await sigil('package', root, '--runtime', 'bun', '--out', out);
        expect(code).toBeTruthy();
        expect(err).toContain('"none"');
        expect(readdirSync(out)).toEqual([]);
      } finally {
        rmSync(out, { force: true, recursive: true });
      }
    },
    180000
  );

  it.skipIf(!hasBun)(
    'should package once it says where to look, and run',
    async () => {
      const root = variant(
        'auto-declared',
        { updateCheck: { repo: 'acme/mycli', type: 'github' } },
        source
      );
      const out = mkdtempSync(join(tmpdir(), 'sigil-upd-pkg-'));
      try {
        const { code, err } = await sigil('package', root, '--runtime', 'bun', '--out', out);
        expect(code, err).toBeFalsy();

        const result = spawnSync(join(out, binaryName('fixture-updates', hostTarget())), [], {
          encoding: 'utf-8',
        });
        // stderr is not a terminal here, so the check never starts and the
        // command is unaffected -- which is the half of the contract a script
        // depends on
        expect(result.stdout).toBe('ran\n');
        expect(result.stderr).toBe('');
      } finally {
        rmSync(out, { force: true, recursive: true });
      }
    },
    180000
  );
});

// The worker had a `close` listener and no `error` one, and a runtime that
// cannot be started is reported as an `error` on the child -- so an app whose
// `process.execPath` was not there crashed with `Unhandled 'error' event ...
// spawn ENOENT` **after** `main()` had resolved and the command had succeeded,
// and a run that did its job exited 1 with a stack. Spawned rather than run
// in process because what is asserted is the exit code and stderr of a real
// process: in a vitest worker the same crash is an unhandled error charged to
// the run rather than to the test that caused it. `-e` resolves
// `@ttylabs/sigil` from the working directory, which is this package.
describe('an update worker that cannot be spawned', () => {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  /** Runs `body` in a node whose `process.execPath` names nothing, at a pretend terminal. */
  function withNoRuntime(body: string): { cache: string; result: ReturnType<typeof spawnSync> } {
    const dir = tempDir('sigil-upd-spawn-');
    // not created: `check()` makes it just before it spawns, so it existing
    // afterwards is what says the spawn was reached rather than skipped
    const cache = join(dir, 'cache');
    const script = [
      `import { main } from '@ttylabs/sigil';`,
      `import { check } from '@ttylabs/sigil/updates';`,
      `Object.defineProperty(process, 'execPath', { value: process.env.NO_RUNTIME });`,
      // `skipReason()` reads this, and a pty would say the same
      `process.stderr.isTTY = true;`,
      body,
    ].join('\n');

    // `CI` and `NO_UPDATE_NOTIFIER` are dropped because either one skips the
    // check, and CI sets the first -- which would make this pass by never
    // spawning anything
    const { CI: _ci, NO_UPDATE_NOTIFIER: _quiet, ...env } = process.env;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkg,
      encoding: 'utf-8',
      env: { ...env, CACHE_DIR: cache, NO_RUNTIME: join(dir, 'no-such-runtime') },
      timeout: 30000,
    });
    return { cache, result };
  }

  it('should not fail a command that succeeded', () => {
    const { cache, result } = withNoRuntime(
      [
        `await main({`,
        `  argv: [],`,
        `  schema: {`,
        `    help: false,`,
        `    name: 'spawn-fails',`,
        `    run: () => { process.stdout.write('ran\\n'); },`,
        `    updateCheck: { cacheDir: process.env.CACHE_DIR, registryURL: 'https://127.0.0.1:1' },`,
        `    version: '1.0.0',`,
        `  },`,
        `});`,
      ].join('\n')
    );

    expect(readdirSync(cache)).toEqual([]);
    expect(result.stdout).toBe('ran\n');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('should reject a check that waited, rather than crash', () => {
    // `wait` is the caller asking for the answer, so a worker that never
    // started is a rejection it can catch -- the same as a worker that timed
    // out -- and not an exception nobody can
    const { result } = withNoRuntime(
      [
        `try {`,
        `  await check({`,
        `    cacheDir: process.env.CACHE_DIR,`,
        `    force: true,`,
        `    packageName: 'spawn-fails',`,
        `    packageVersion: '1.0.0',`,
        `    registryURL: 'https://127.0.0.1:1',`,
        `    wait: true,`,
        `  });`,
        `  process.stdout.write('resolved\\n');`,
        `} catch (err) {`,
        `  process.stdout.write('rejected: ' + err.message + '\\n');`,
        `}`,
      ].join('\n')
    );

    expect(result.stdout).toMatch(/^rejected: spawn .*no-such-runtime ENOENT\n$/);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
