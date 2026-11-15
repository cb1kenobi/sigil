/**
 * How many times a build parses each module, counted rather than timed.
 *
 * Every pass that has a question for a module -- discovery, the static lift, the
 * settings and update-check reads, the tree, the i18n scan, the utility scan,
 * the template compile -- used to parse it again to ask, so the `styled`
 * fixture's `src/index.ts` was parsed three times and `commands/tpl.ts` four.
 * `parseModule()` keeps what it read now, keyed by the path and the source,
 * and what is asserted is the claim itself: **no file is parsed twice with the
 * same source** in one `sigil build`. A file parsed again with a *different*
 * source is right and is allowed -- `tpl.ts` is, once as written and once as
 * the template compile left it for the utility rewrite.
 *
 * `oxc-parser` is mocked the way `shake-walk.test.ts` mocks `node:fs`: the real
 * `parseSync()` runs and the wrapper only records. A file of its own, because
 * `vi.mock` is hoisted and module-wide.
 */

import { compileTemplates } from '../../src/build/compile-templates.js';
import { forgetParsedModules, parseModule } from '../../src/build/parse-module.js';
import { createShaker, shakeStyles } from '../../src/build/shake.js';
import { run } from '../../src/index.js';
import { tempDir } from '../temp.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');

/** Every `parseSync()` call since the last `reset()`, as a file and a source. */
const parsed: { file: string; source: string }[] = [];

vi.mock('oxc-parser', async (importOriginal) => {
  const real = await importOriginal<typeof import('oxc-parser')>();

  return {
    ...real,
    parseSync: (file: string, source: string, ...rest: unknown[]) => {
      parsed.push({ file, source });
      return (real.parseSync as (...args: unknown[]) => unknown)(file, source, ...rest);
    },
  };
});

/**
 * Builds a fixture with the CLI's own `build` command, its output swallowed.
 *
 * @param app - The fixture's directory.
 * @returns Every parse of a file inside the fixture, as `file` and `source`.
 */
async function build(app: string): Promise<{ file: string; source: string }[]> {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  parsed.length = 0;
  await run(['build', app, '--out', tempDir('sigil-parse-once-')]);

  return parsed.filter(({ file }) => file.startsWith(app));
}

/**
 * The parses that repeated a file and a source already parsed.
 *
 * @param parses - What was parsed, in order.
 * @returns Each repeat's file, once per repeat.
 */
function repeats(parses: { file: string; source: string }[]): string[] {
  const seen = new Set<string>();
  const again: string[] = [];
  for (const { file, source } of parses) {
    const key = `${file}\0${source}`;
    if (seen.has(key)) {
      again.push(file);
    }
    seen.add(key);
  }
  return again;
}

describe('a build', () => {
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    exitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it('should parse each file and source once, across every pass', async () => {
    // `styled` has a schema, two commands, a `ui` template and the utility
    // sheet, so discovery, the lift, the tree, the utility scan, the template
    // compile and the utility rewrite all have a question for one module
    const app = join(fixtures, 'styled');
    const parses = await build(app);

    expect(process.exitCode ?? 0).to.equal(0);
    // not vacuous: the passes really did ask about these
    const files = new Set(parses.map(({ file }) => file));
    expect(files).to.include(join(app, 'src', 'index.ts'));
    expect(files).to.include(join(app, 'src', 'commands', 'tpl.ts'));
    expect(repeats(parses)).to.deep.equal([]);
  });

  it('should parse a module once when the utility scan comes after its template rewrite', async () => {
    // rolldown transforms modules concurrently, so which of two modules calling
    // `utilitySheet()` asks for the sheet first is not fixed, and the scan is
    // the pass that reads every file *as written*. When the module whose own
    // transform asks first is a templated one, the template compile has already
    // run and the style pass has parsed its output -- the one pass that parses
    // a source the disk does not hold -- before the scan reads the original
    // again. This is that order, forced: `tpl.ts` parsed as discovery reads it,
    // compiled, its output handed to the style pass, and only then the scan
    const app = join(fixtures, 'styled');
    const file = join(app, 'src', 'commands', 'tpl.ts');
    const source = readFileSync(file, 'utf-8');

    forgetParsedModules();
    parsed.length = 0;

    parseModule(file, source);
    const compiled = compileTemplates(file, source);
    expect(compiled).not.to.equal(undefined);
    const shaker = createShaker(app);
    expect(shakeStyles(file, compiled?.code ?? '', () => shaker.sheet())).not.to.equal(undefined);

    const ours = parsed.filter((one) => one.file === file);
    // not vacuous: the original, and what the template compile left of it
    expect(new Set(ours.map((one) => one.source)).size).to.equal(2);
    // ...and the scan really did read `tpl.ts`. On the fixed code its read is a
    // cache hit and leaves no record above, so a scan that stopped walking
    // `src/commands` would pass everything else here. `gap-1` and `dim` are
    // classes only `tpl.ts` names -- `panel.ts` has neither -- so they survive
    // the shake only if the scan read that file
    const css = shaker.result()?.css ?? '';
    expect(css).to.contain('.gap-1');
    expect(css).to.contain('.dim');
    expect(repeats(ours)).to.deep.equal([]);
  });

  it('should parse each file and source once in an app with catalogs', async () => {
    // `i18n`'s entry is read by discovery, the catalog check, the settings
    // check and the tree, which was three parses of one source
    const app = join(fixtures, 'i18n');
    const parses = await build(app);

    expect(new Set(parses.map(({ file }) => file))).to.include(join(app, 'index.ts'));
    expect(repeats(parses)).to.deep.equal([]);
  });

  it('should hold the trees of one build at a time, by forgetting them where a build starts', async () => {
    // the memory bound: `inspect()` empties the cache, so a process that
    // builds again does not keep the first app's trees. Keeping trees
    // by path alone would keep them -- nothing about building `i18n` reads
    // another source of `styled`'s schema module
    const styled = join(fixtures, 'styled');
    const entry = join(styled, 'src', 'index.ts');
    const source = readFileSync(entry, 'utf-8');

    await build(styled);
    const first = parseModule(entry, source);
    expect(parseModule(entry, source)).to.equal(first);

    await build(join(fixtures, 'i18n'));
    expect(parseModule(entry, source)).not.to.equal(first);
  });
});

describe('parseModule()', () => {
  beforeEach(() => {
    forgetParsedModules();
    parsed.length = 0;
  });

  it('should hand back the same tree for the same file and source', () => {
    const one = parseModule('a.ts', 'export default { desc: "a" };');
    const two = parseModule('a.ts', 'export default { desc: "a" };');

    expect(two).to.equal(one);
    expect(parsed).to.have.lengthOf(1);
  });

  it('should read a source that changed again, rather than by its path alone', () => {
    // every caller hands the source it read, so a module edited between two
    // passes -- or two builds in one process -- is a miss and never a stale hit
    const before = parseModule('a.ts', 'export default { desc: "a" };');
    const after = parseModule('a.ts', 'export default { desc: "b" };');

    expect(after).not.to.equal(before);
    expect(after.source).to.contain('"b"');
    expect(parsed).to.have.lengthOf(2);
  });

  it("should keep a path's earlier source when a changed one is read, for the rest of the build", () => {
    // a rewrite is read beside the original and not over it, because the pass
    // that reads files as written can come after the pass that reads the rewrite
    const first = parseModule('a.ts', 'export default { desc: "a" };');
    parseModule('a.ts', 'export default { desc: "b" };');

    expect(parseModule('a.ts', 'export default { desc: "a" };')).to.equal(first);
    expect(parsed).to.have.lengthOf(2);
  });

  it('should key on the path too, since the extension decides the language', () => {
    // the same text is a different parse as TypeScript and as JavaScript
    parseModule('a.ts', 'export default {};');
    parseModule('a.js', 'export default {};');

    expect(parsed).to.have.lengthOf(2);
  });

  it('should forget everything it read when a build starts', () => {
    const one = parseModule('a.ts', 'export default {};');
    forgetParsedModules();

    expect(parseModule('a.ts', 'export default {};')).not.to.equal(one);
    expect(parsed).to.have.lengthOf(2);
  });

  it('should not keep a failure, so asking again throws again', () => {
    expect(() => parseModule('a.ts', 'export default {')).to.throw(/Failed to parse/);
    expect(() => parseModule('a.ts', 'export default {')).to.throw(/Failed to parse/);
    expect(parsed).to.have.lengthOf(2);
  });
});
