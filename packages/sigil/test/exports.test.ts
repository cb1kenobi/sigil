import * as layoutModule from '../src/layout/index.js';
import config from '../tsdown.config.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

// `entry` is typed as string | string[] | Record<string, string>; the config
// uses the record form so the output file names are ours to pick
const entry = config.entry as Record<string, string>;

// './error-handler' -> 'error-handler', '.' -> 'index'
function entryName(subpath: string) {
  return subpath === '.' ? 'index' : subpath.slice(2);
}

describe('package exports', () => {
  it('should not expose the source tree through a wildcard', () => {
    for (const subpath of Object.keys(pkg.exports)) {
      expect(subpath).not.toContain('*');
    }
  });

  it('should point every subpath at a file the build produces', () => {
    for (const [subpath, condition] of Object.entries<any>(pkg.exports)) {
      if (subpath === './package.json') {
        continue;
      }

      const name = entryName(subpath);
      expect(entry, `"${subpath}" has no build entry`).toHaveProperty(name);
      expect(existsSync(resolve(root, entry[name]))).toBe(true);

      expect(condition).toEqual({
        types: `./dist/${name}.d.mts`,
        default: `./dist/${name}.mjs`,
      });
    }
  });

  it('should export every entry the build produces', () => {
    const exported = Object.keys(pkg.exports).map(entryName);
    for (const name of Object.keys(entry)) {
      expect(exported, `entry "${name}" is not exported`).toContain(name);
    }
  });

  it('should have main and types agree with the root export', () => {
    expect(pkg.main).toBe(pkg.exports['.'].default);
    expect(pkg.types).toBe(pkg.exports['.'].types);
  });

  it('should copy nothing it cannot find', () => {
    // this used to assert that the update worker was copied next to
    // `dist/updates.mjs`, because `updates/index.ts` read it off disk
    // relative to its own module URL -- which is the defect: that path points
    // wherever the *bundle* was written, so it worked from `node_modules` and
    // every app `sigil build` produced died on `ENOENT`. The worker is baked
    // into the bundle as a string now and there is nothing to copy, which
    // `test/dist.test.ts` asserts from the other end.
    //
    // The general half is kept: a `copy` naming a file that is not there is a
    // build quietly shipping less than it says it does
    for (const { from } of (config.copy ?? []) as { from: string }[]) {
      expect(existsSync(resolve(root, from)), from).toBe(true);
    }
  });

  it('should keep the route rules under an internal path, and out of the README', () => {
    // SIG-400: `./routes` read as an API and is plumbing -- the runtime and
    // `sigil build` read the same rules through it. An `internal` segment and no
    // README entry is what says so
    expect(Object.keys(pkg.exports)).not.toContain('./routes');
    expect(Object.keys(pkg.exports)).toContain('./internal/routes');

    const readme = readFileSync(join(root, 'README.md'), 'utf-8');
    expect(readme).not.toContain('sigil/internal');
    expect(readme).not.toContain('sigil/routes');
  });

  it('should document every export of the layout subpath in the README', () => {
    // SIG-400: the subpath was published undocumented, with names generic enough
    // to mean something else in every other module. It is public API now, and a
    // name added to its barrel is a name the README table has to carry
    const readme = readFileSync(join(root, 'README.md'), 'utf-8');
    const start = readme.indexOf('### `sigil/layout`');
    expect(start, 'the README has no `sigil/layout` section').toBeGreaterThan(-1);
    const section = readme.slice(start, readme.indexOf('\n### ', start + 1));

    for (const name of Object.keys(layoutModule)) {
      // a row of the table, not a mention in the prose around it
      expect(section, `\`${name}\` is exported and not in the README's table`).toContain(
        `\n| \`${name}(`
      );
    }

    // the types are not keys of the module, so they are named here
    for (const type of ['Box', 'LayoutNode', 'LayoutOptions', 'LayoutResult', 'Measurement']) {
      expect(section, `\`${type}\` is exported and not in the README`).toContain(`\`${type}\``);
    }
  });
});
