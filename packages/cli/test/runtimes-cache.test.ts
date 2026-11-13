import { tempDir } from './temp.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The version listings are cached for a day, and this is the file that proves it.
 *
 * It mocks `cache()` rather than pointing `XDG_CACHE_HOME` somewhere, because
 * on macOS that variable is **ignored**: `paths.ts` has a platform table and
 * `~/Library/Caches` wins there, so a test that redirected the environment was
 * reading and writing the developer's real cache -- which is how the first
 * version of these tests passed for the wrong reason and then failed.
 *
 * Mocking is the house answer to this, for the reason `bundle-close.test.ts`
 * and `shake-walk.test.ts` record: the alternative is a seam on production code
 * whose only reader would be this file. And it is a file of its own because
 * `vi.mock` is hoisted and module-wide.
 */

const box = tempDir('sigil-listing-');

vi.mock('@ttylabs/sigil/paths', () => ({
  cache: (...paths: string[]) => join(box, ...paths),
}));

const { latest, resolve } = await import('../src/build/runtimes.ts');

/** Where `latest()` keeps a runtime's listing. */
function file(runtime: 'bun' | 'node'): string {
  return join(box, 'sigil/runtimes', `${runtime}-versions.json`);
}

/** Writes a listing with a given age. */
function hold(runtime: 'bun' | 'node', releases: unknown[], age: number): void {
  mkdirSync(dirname(file(runtime)), { recursive: true });
  writeFileSync(file(runtime), JSON.stringify({ releases, ts: Date.now() - age }));
}

describe('caching the version listings', () => {
  beforeEach(() => {
    rmSync(join(box, 'sigil'), { force: true, recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should reuse a fresh listing rather than fetching again', async () => {
    // Counted, not inferred from the value, and the difference is the whole
    // test: a stubbed `fetch` that throws falls through to the **stale**
    // fallback, which reads the same file and returns the same releases -- so
    // asserting only the value passed with the fresh read deleted. Two
    // mechanisms masking each other, which is the shape AGENTS.md records for
    // the JSX gate.
    let asked = 0;
    vi.stubGlobal('fetch', () => {
      asked++;
      throw new Error('offline');
    });
    hold('bun', [{ major: 9, version: '9.9.9' }], 0);

    expect(await latest('bun')).toEqual([{ major: 9, version: '9.9.9' }]);
    expect(asked).toBe(0);
  });

  it('should not reuse a listing older than a day', async () => {
    // a day is `src/updates/`'s own interval for its npm check, and is chosen
    // for the same reason: a release is interesting within a day, never within
    // a minute
    let asked = 0;
    vi.stubGlobal('fetch', () => {
      asked++;
      throw new Error('offline');
    });
    hold('bun', [{ major: 9, version: '9.9.9' }], 86_400_001);

    await latest('bun');

    expect(asked).toBe(1);
  });

  it('should fall back to a stale listing when the fetch fails', async () => {
    // offline with last week's list beats offline with nothing: a version list
    // moves every few weeks, so a stale one is mostly right, and the picker's
    // job is to offer something
    vi.stubGlobal('fetch', () => {
      throw new Error('offline');
    });
    hold('node', [{ lts: 'Krypton', major: 24, version: '24.22.1' }], 86_400_001);

    expect(await latest('node')).toEqual([{ lts: 'Krypton', major: 24, version: '24.22.1' }]);
  });

  it('should write what it fetched, so the next run reads it', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        json: () => Promise.resolve([{ lts: false, version: 'v26.12.1' }]),
        ok: true,
      })
    );

    const offered = await latest('node');

    expect(offered).toEqual([{ major: 26, version: '26.12.1' }]);
    expect(existsSync(file('node'))).toBe(true);

    const held = JSON.parse(readFileSync(file('node'), 'utf-8')) as {
      releases: unknown[];
      ts: number;
    };

    expect(held.releases).toEqual(offered);
    expect(held.ts).toBeGreaterThan(Date.now() - 60_000);
  });

  it('should ask again, not throw, over a cache file it did not write', async () => {
    // a cache that throws is worse than no cache, so anything unreadable is the
    // same answer as absent: go and ask
    let asked = 0;
    vi.stubGlobal('fetch', () => {
      asked++;
      throw new Error('offline');
    });
    mkdirSync(dirname(file('bun')), { recursive: true });
    writeFileSync(file('bun'), 'not json at all');

    await expect(latest('bun')).resolves.toEqual([]);
    expect(asked).toBe(1);
  });

  it('should never fail a run over a listing it could not save', async () => {
    // a listing that could not be written costs a request next time and nothing
    // else, which is the rule the removals in `compileAll()` and `signed()`
    // already follow
    vi.stubGlobal('fetch', () => Promise.resolve({ json: () => Promise.resolve([]), ok: true }));
    // a *file* where the cache directory should be, so the write cannot succeed
    mkdirSync(join(box, 'sigil'), { recursive: true });
    writeFileSync(join(box, 'sigil/runtimes'), 'in the way');

    await expect(latest('node')).resolves.toEqual([]);
  });
});

/**
 * Writes a listing whose `ts` is the given source text, so a test can write what
 * `JSON.stringify()` cannot -- `1e999` is Infinity once parsed.
 */
function stamp(runtime: 'bun' | 'node', ts: string): void {
  mkdirSync(dirname(file(runtime)), { recursive: true });
  writeFileSync(file(runtime), `{"releases":[{"major":9,"version":"9.9.9"}],"ts":${ts}}`);
}

/** How many times `latest()` asked a registry, offline, for the listing it was handed. */
async function asksFor(ts: string): Promise<number> {
  let asked = 0;
  vi.stubGlobal('fetch', () => {
    asked++;
    throw new Error('offline');
  });
  stamp('bun', ts);

  await latest('bun');

  return asked;
}

// Only "too old" was asked, `held.ts + within < Date.now()`, so a listing stamped
// while the clock was ahead -- clock skew, a clock set back, a cache directory
// restored from another machine -- was fresh until real time caught up, and a
// `ts` that is a string of digits was concatenated rather than added to. Either
// way `sigil package` went on offering an old runtime listing. SIG-420, the twin
// of SIG-376 in the update check.
describe('a version listing stamped in the future', () => {
  beforeEach(() => {
    rmSync(join(box, 'sigil'), { force: true, recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should fetch again over a listing stamped a year ahead', async () => {
    expect(await asksFor(String(Date.now() + 365 * 86_400_000))).toBe(1);
  });

  it('should fetch again over a listing stamped just past the minute of tolerance', async () => {
    // five seconds past it, which is longer than the write-to-read gap below
    expect(await asksFor(String(Date.now() + 65_000))).toBe(1);
  });

  it('should still reuse a listing stamped within the minute of tolerance', async () => {
    // a clock NTP nudged back between two runs is jitter rather than a wrong
    // clock, and refetching over it would be a request per run
    expect(await asksFor(String(Date.now() + 30_000))).toBe(0);
  });

  it('should fetch again over a listing whose ts is a string of digits', async () => {
    // stamped now and quoted: `"1762…" + 86400000` is a twenty-odd digit string,
    // which compares as a number far in the future, so it was fresh forever
    expect(await asksFor(`"${Date.now()}"`)).toBe(1);
  });

  it('should fetch again over a listing whose ts is not a finite number', async () => {
    // `1e999` parses to Infinity; a garbage string concatenated to garbage, and
    // `NaN < now` is false, so both were read as fresh
    for (const ts of ['1e999', '-1e999', '"nope"', '"NaN"', 'null', 'true', '{}', '[1]']) {
      expect(await asksFor(ts), ts).toBe(1);
    }
  });

  it('should still offer a listing stamped in the future when the fetch fails', async () => {
    // stale means "ask again", not "throw it away": offline, a listing whose
    // clock was wrong is still last week's list, which beats offering nothing
    vi.stubGlobal('fetch', () => {
      throw new Error('offline');
    });
    stamp('bun', String(Date.now() + 365 * 86_400_000));

    expect(await latest('bun')).toEqual([{ major: 9, version: '9.9.9' }]);
  });

  it('should not offer a listing whose ts is not a number when the fetch fails', async () => {
    // a stamp that is not a number is a file this did not write, which is the
    // same answer as an unreadable one
    vi.stubGlobal('fetch', () => {
      throw new Error('offline');
    });
    stamp('bun', '"nope"');

    expect(await latest('bun')).toEqual([]);
  });
});

/** A version that starts like one and then climbs, with this platform's separator. */
const climbing = ['26.12.1', '..', '..', '..', 'tmp', 'pwn'].join(sep);

describe('a version a listing hands over', () => {
  beforeEach(() => {
    rmSync(join(box, 'sigil'), { force: true, recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should not offer a Node release whose version is not a version', async () => {
    // a listing is a registry's data, and the version in it became a cache
    // path the moment it was picked -- `latestNode()` passed it through
    // unchecked. The line falls through to the next row that is one
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        json: () =>
          Promise.resolve([
            { lts: false, version: `v${climbing}` },
            { lts: false, version: 'v26.12.0' },
          ]),
        ok: true,
      })
    );

    expect(await latest('node')).toEqual([{ major: 26, version: '26.12.0' }]);
  });

  it('should not offer a Bun release whose version is not a version', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        // a line of its own, so that nothing newer in the same line hides it
        json: () =>
          Promise.resolve({
            versions: { '1.3.14': {}, [['1.4.0', '..', '..', 'tmp', 'pwn'].join(sep)]: {} },
          }),
        ok: true,
      })
    );

    expect(await latest('bun')).toEqual([{ major: 1, version: '1.3.14' }]);
  });

  it('should not offer one from a cached listing either', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('offline');
    });
    hold(
      'node',
      [
        { major: 26, version: climbing },
        { major: 24, version: '24.22.1' },
      ],
      0
    );

    expect(await latest('node')).toEqual([{ major: 24, version: '24.22.1' }]);
  });
});

describe('downloading a runtime', () => {
  const target = { arch: process.arch === 'x64' ? 'x64' : 'arm64', platform: 'linux' } as const;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should refuse a version that names a path outside the cache before fetching anything', async () => {
    // the last gate, which a version from anywhere -- the flag, `sigil.json`,
    // a listing -- reaches on its way to a download
    let asked = 0;
    vi.stubGlobal('fetch', () => {
      asked++;
      throw new Error('offline');
    });

    // either of `cacheDir()`'s two refusals, for the reason its own test gives
    await expect(resolve('node', climbing, target)).rejects.toThrow(
      /is not a node version|outside the runtime cache/
    );
    expect(asked).toBe(0);
    // where `join()` took the climb to: `download()` made its partial directory
    // there before the fetch, and the directory outlived the failed download
    expect(existsSync(join(box, 'sigil', 'tmp'))).toBe(false);
  });

  it('should name a flag that exists when the version does not', async () => {
    // it said `--runtime-version list`, a flag `sigil package` has never had
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 404 }));

    const failed = resolve('node', '99.0.0', target);

    await expect(failed).rejects.toThrow(/--runtime node@<version>/);
    await expect(failed).rejects.not.toThrow(/--runtime-version/);
  });
});
