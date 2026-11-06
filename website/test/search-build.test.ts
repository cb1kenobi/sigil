import { openSearch, registerSearch } from '../src/lib/open-search.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * How search's generated files meet the build. Measured against turbo's own
 * dry run when this was written (see SIG-254); this holds the config to what
 * was measured, so that an edit to one list without the other fails here.
 */

const root = join(import.meta.dirname, '..');
const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf-8')) as {
  tasks: { build: { inputs: string[]; outputs: string[] } };
};
const scripts = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const ignored = readFileSync(join(root, '.gitignore'), 'utf-8').split('\n');

/** What the generators write, as `.gitignore` and `turbo.json` each spell it. */
const GENERATED = [
  { ignore: '/public/_pagefind/', glob: 'public/_pagefind/**' },
  { ignore: '/public/symbols.json', glob: 'public/symbols.json' },
];

describe('the search build', () => {
  it('should keep the generated files out of git', () => {
    for (const { ignore } of GENERATED) {
      assert.ok(ignored.includes(ignore), ignore);
    }
    assert.ok(!ignored.includes('/public/pagefind/'), 'the stale line is back');
  });

  it('should keep them out of the build hash, which an explicit `inputs` list does not do for it', () => {
    // `public/**` is an input, and turbo hashes a gitignored file that an
    // explicit glob matches: without these, writing the index moved the hash of
    // the build that wrote it, and every other build missed the cache
    assert.ok(turbo.tasks.build.inputs.includes('public/**'));
    for (const { glob } of GENERATED) {
      assert.ok(turbo.tasks.build.inputs.includes(`!${glob}`), `!${glob}`);
    }
  });

  it('should capture them as outputs, or a cache hit restores a site with no index', () => {
    for (const { glob } of GENERATED) {
      assert.ok(turbo.tasks.build.outputs.includes(glob), glob);
    }
    assert.ok(turbo.tasks.build.outputs.includes('.next/**'));
  });

  it('should run both generators before `next build`, which collects `public/`', () => {
    const steps = scripts.build?.split('&&').map((step) => step.trim()) ?? [];
    assert.equal(steps.at(-1), 'next build');
    assert.ok(steps.includes(scripts['search:index'] ?? '?'));
    assert.ok(steps.includes(scripts['search:symbols'] ?? '?'));
  });
});

describe('openSearch()', () => {
  it('should do nothing until the dialog has registered, then open it', () => {
    let opened = 0;
    openSearch();
    const unregister = registerSearch(() => opened++);
    openSearch();
    unregister();
    openSearch();
    assert.equal(opened, 1);
  });

  it('should not let a stale cleanup take a newer dialog off', () => {
    let opened = 0;
    const first = registerSearch(() => {});
    const second = registerSearch(() => opened++);
    first();
    openSearch();
    second();
    assert.equal(opened, 1);
  });
});
