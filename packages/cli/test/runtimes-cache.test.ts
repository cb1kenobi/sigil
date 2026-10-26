import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

const box = mkdtempSync(join(tmpdir(), 'sigil-listing-'));

vi.mock('@ttylabs/sigil/paths', () => ({
  cache: (...paths: string[]) => join(box, ...paths),
}));

const { latest } = await import('../src/build/runtimes.ts');

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
