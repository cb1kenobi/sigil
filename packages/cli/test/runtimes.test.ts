import { NODE_BUILD_SEA } from '../src/build/compile.ts';
import {
  bunTriple,
  canEmbed,
  choices,
  compare,
  installed,
  local,
  parseSpec,
} from '../src/build/runtimes.ts';
import { whichSync } from '@ttylabs/sigil/which';
import { describe, expect, it } from 'vitest';

/**
 * Finding and comparing the runtime versions a binary can embed.
 *
 * The arithmetic and the naming are pure and always run. What touches the
 * machine -- `installed()` and `local()` -- is asserted as a *property* rather
 * than against an expected version, because the answer is whatever this machine
 * has and a test that pinned `1.4.4` would fail on the next upgrade.
 *
 * `latest()` is deliberately not tested here: it reads two public registries, so
 * a test of it is a test of the network. What is tested instead is that its
 * failure is not an error -- the picker has to degrade to what is local.
 */
describe('comparing versions', () => {
  it('should compare numerically, not lexically', () => {
    // the one that matters: `1.10.0` sorts before `1.9.0` as a string, so a
    // picker built on string order would offer the wrong latest
    expect(compare('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compare('26.10.0', '26.9.0')).toBeGreaterThan(0);
    expect(compare('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('should treat a missing component as zero', () => {
    expect(compare('1.4', '1.4.0')).toBe(0);
    expect(compare('26', '26.0.0')).toBe(0);
    expect(compare('1.4', '1.4.1')).toBeLessThan(0);
  });

  it('should be an ordering, so a sort can use it', () => {
    const sorted = ['1.9.0', '1.10.0', '1.2.0', '10.0.0'].sort(compare);

    expect(sorted).toEqual(['1.2.0', '1.9.0', '1.10.0', '10.0.0']);
  });
});

describe('which Node versions can embed themselves', () => {
  it('should refuse below the --build-sea floor, and take it from the constant', () => {
    const [major, minor] = NODE_BUILD_SEA;

    expect(canEmbed(`${major}.${minor}.0`)).toBe(true);
    expect(canEmbed(`${major}.${minor - 1}.0`)).toBe(false);
    expect(canEmbed(`${major - 1}.99.0`)).toBe(false);
  });

  it('should refuse the two LTS lines that cannot inject a blob', () => {
    // measured on the real binaries: 24.22.1 and 22.23.4, both released
    // 2026-10-20, have `--experimental-sea-config` and no way to inject what it
    // writes. `--build-sea` was not backported to either line.
    expect(canEmbed('24.22.1')).toBe(false);
    expect(canEmbed('22.23.4')).toBe(false);
  });

  it('should accept every line that has --build-sea, including future ones', () => {
    expect(canEmbed('25.5.0')).toBe(true);
    expect(canEmbed('25.9.0')).toBe(true);
    expect(canEmbed('26.12.1')).toBe(true);
    // the point of a floor rather than a list: a Node released after this was
    // written needs no edit here
    expect(canEmbed('99.0.0')).toBe(true);
  });
});

describe("Bun's own spelling of a platform", () => {
  it('should say aarch64 where the rest of this package says arm64', () => {
    // Bun's `--target` and its download cache both use its spelling, and
    // everything else here uses `arm64`. One translation, in one place.
    expect(bunTriple({ arch: 'arm64', platform: 'darwin' })).toBe('bun-darwin-aarch64');
    expect(bunTriple({ arch: 'arm64', platform: 'linux' })).toBe('bun-linux-aarch64');
  });

  it('should leave x64 alone', () => {
    expect(bunTriple({ arch: 'x64', platform: 'linux' })).toBe('bun-linux-x64');
    expect(bunTriple({ arch: 'x64', platform: 'windows' })).toBe('bun-windows-x64');
  });
});

describe('what is on this machine', () => {
  const target = { arch: 'arm64', platform: 'darwin' } as const;

  it('should find the node it is running under', () => {
    // asserted as a property rather than a value: node is certainly installed,
    // since it is running this
    const found = installed('node');

    expect(found).toBeDefined();
    expect(found?.how).toBe('path');
    expect(found?.version).toMatch(/^\d+\.\d+\.\d+/);
    // the `v` node prints is stripped, because bun does not print one and the
    // two have to compare
    expect(found?.version.startsWith('v')).toBe(false);
  });

  it('should report bun only when bun is installed', () => {
    const found = installed('bun');

    if (whichSync('bun')) {
      expect(found?.version).toMatch(/^\d+\.\d+\.\d+/);
    } else {
      expect(found).toBeUndefined();
    }
  });

  it('should list what is local newest first, with no duplicates', () => {
    const all = local('node', target);

    expect(all.length).toBeGreaterThan(0);

    const versions = all.map((one) => one.version);
    expect(new Set(versions).size).toBe(versions.length);

    for (let at = 1; at < all.length; at++) {
      expect(compare(versions[at - 1] as string, versions[at] as string)).toBeGreaterThan(0);
    }
  });

  it('should prefer the one on PATH over a cached copy of the same version', () => {
    // `local()` fills from PATH first and then skips a version it already has,
    // so the executable somebody would get by typing the name wins. Without
    // that, a cached copy could shadow the install
    const all = local('node', target);
    const onPath = installed('node');

    const same = all.filter((one) => one.version === onPath?.version);
    expect(same).toHaveLength(1);
    expect(same[0]?.how).toBe('path');
  });
});

describe('a runtime spec', () => {
  it('should read a bare runtime as "whichever version resolves"', () => {
    // pinning is for an app that cares, and most do not -- so a bare runtime is
    // not an error and carries no version
    expect(parseSpec('bun')).toEqual({ runtime: 'bun' });
    expect(parseSpec('node')).toEqual({ runtime: 'node' });
  });

  it('should read a pinned version', () => {
    expect(parseSpec('bun@1.3.14')).toEqual({ runtime: 'bun', version: '1.3.14' });
    expect(parseSpec('node@26.12.1')).toEqual({ runtime: 'node', version: '26.12.1' });
  });

  it.each(['deno', 'deno@2.0.0', '', '@1.2.3', 'Bun', 'bun '])(
    'should refuse %o as a runtime',
    (text) => {
      expect(() => parseSpec(text)).toThrow(/is not a runtime/);
    }
  );

  it.each(['bun@', 'bun@latest', 'bun@1', 'bun@1.3', 'node@v26.12.1'])(
    'should refuse %o as a version',
    (text) => {
      expect(() => parseSpec(text)).toThrow(/is not a version/);
    }
  );

  it('should refuse a Node that cannot package itself, and say what to use', () => {
    // the whole reason the floor exists, in the one message somebody will read
    // while typing the thing that cannot work
    expect(() => parseSpec('node@24.22.1')).toThrow(/cannot package itself/);
    expect(() => parseSpec('node@24.22.1')).toThrow(/bun@1\.3 is node-compat 24/);
    expect(() => parseSpec('node@22.23.4')).toThrow(/cannot package itself/);
  });

  it('should not apply that floor to bun, whose versions are unrelated', () => {
    // `canEmbed` is about Node's `--build-sea`; a bun 1.2.0 is not a node 1.2.0
    expect(() => parseSpec('bun@1.2.0')).not.toThrow();
  });
});

describe('what the picker offers', () => {
  const release = (version: string, lts?: string) => ({
    major: Number(version.split('.')[0]),
    version,
    ...(lts ? { lts } : {}),
  });
  const found = (version: string, how: 'cache' | 'path') => ({ how, path: '/x', version });

  it('should offer both runtimes whatever is installed', () => {
    // the bug this replaced: with no Bun on the machine the command refused
    // rather than offering to fetch one, which is refusing on a fact about the
    // laptop rather than about the app
    const rows = choices(
      { bun: [], node: [found('26.10.0', 'path')] },
      { bun: [release('1.4.4')], node: [release('26.12.1')] }
    );

    expect(rows.some((row) => row.value === 'bun@1.4.4')).toBe(true);
    expect(rows.some((row) => row.value === 'node@26.12.1')).toBe(true);
  });

  it('should flag what is already here, and how', () => {
    const rows = choices(
      { bun: [found('1.3.0', 'cache')], node: [found('26.10.0', 'path')] },
      { bun: [], node: [] }
    );

    expect(rows.find((row) => row.value === 'bun@1.3.0')?.label).toContain('cached');
    expect(rows.find((row) => row.value === 'node@26.10.0')?.label).toContain('installed');
  });

  it('should carry an LTS codename where the runtime has one', () => {
    const rows = choices({ bun: [], node: [] }, { bun: [], node: [release('26.12.1', 'Krypton')] });

    expect(rows.find((row) => row.value === 'node@26.12.1')?.label).toContain('Krypton');
  });

  it('should leave out a Node that cannot package itself', () => {
    // a row somebody cannot pick should not be there. Naming it explicitly
    // still explains itself, which is `parseSpec()`'s job
    const rows = choices(
      { bun: [], node: [] },
      { bun: [], node: [release('26.12.1'), release('24.22.1', 'Krypton'), release('22.23.4')] }
    );

    expect(rows.some((row) => row.value === 'node@26.12.1')).toBe(true);
    expect(rows.some((row) => row.value.startsWith('node@24'))).toBe(false);
    expect(rows.some((row) => row.value.startsWith('node@22'))).toBe(false);
  });

  it('should list newest first across both sources, not local then remote', () => {
    // a cached 1.3.0 sorted above a released 1.4.4 for a while, so the first row
    // was not the newest thing on offer
    const rows = choices(
      { bun: [found('1.3.0', 'cache')], node: [] },
      { bun: [release('1.4.4'), release('1.2.23')], node: [] }
    );

    const bun = rows.filter((row) => row.value.startsWith('bun@')).map((row) => row.value);
    expect(bun).toEqual(['bun@1.4.4', 'bun@1.3.0', 'bun@1.2.23']);
  });

  it('should cap how far back it offers, but still offer what is local', () => {
    // both registries list every line they ever published, and for Bun that
    // reaches 0.0.12 -- a runtime from before Bun could do any of this
    const old = ['1.4.4', '1.3.14', '1.2.23', '1.1.45', '1.0.36', '0.8.1', '0.0.12'];
    const rows = choices(
      { bun: [found('0.5.9', 'cache')], node: [] },
      { bun: old.map((one) => release(one)), node: [] }
    );
    const bun = rows.filter((row) => row.value.startsWith('bun@')).map((row) => row.value);

    expect(bun).not.toContain('bun@0.0.12');
    expect(bun).toContain('bun@1.4.4');
    // a local one is offered however old, because somebody put it there
    expect(bun).toContain('bun@0.5.9');
  });

  it('should end with one custom entry per runtime', () => {
    // the newest of each line cannot express "the exact version our other
    // service pins", which is the ordinary reason to care about a version
    const rows = choices({ bun: [], node: [] }, { bun: [], node: [] });

    expect(rows.map((row) => row.value)).toEqual(['custom:bun', 'custom:node']);
  });

  it('should offer no duplicate row, when a version is both local and released', () => {
    const rows = choices(
      { bun: [found('1.4.4', 'path')], node: [] },
      { bun: [release('1.4.4')], node: [] }
    );
    const bun = rows.filter((row) => row.value === 'bun@1.4.4');

    expect(bun).toHaveLength(1);
    expect(bun[0]?.label).toContain('installed');
  });
});
