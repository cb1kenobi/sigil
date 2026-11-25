/**
 * What `bundleApp()` asks rolldown to check, which is not its plugin timings.
 *
 * rolldown warns when JavaScript callbacks take most of a build, and every
 * callback in this build is the toolchain's own: the warning tells whoever is
 * building an app to optimize a plugin they did not write, and it depends on how
 * busy the machine was. On a slow Windows runner it reached the exact summary
 * `output-forms.test.ts` compares and failed it (SIG-627).
 *
 * ## What is asserted, and why it is not the warning (SIG-687)
 *
 * This file used to provoke the warning: hold a one-module build for five
 * seconds, then ten, with rolldown's default `checks` as a control, and assert
 * it came. It failed on a loaded macOS runner three times -- SIG-648, SIG-667 and
 * SIG-687 -- each fix buying margin against the same gate, which is a clock. That
 * gate is rolldown's `BuildTimings::is_plugin_bound()`: at least three seconds on
 * rolldown's own clock, and non-link time more than a hundred times the link
 * stage. Nothing in a test can make that hold: the link stage is wall clock on a
 * machine somebody else is using, and the third failure came after 15.4 s with
 * nothing logged at all, which is both holds missing. So the warning is no longer
 * asked for, and what this file exists to say is asserted without it.
 *
 * That is two things, both of which hold by construction rather than by margin.
 * `bundleApp()` hands rolldown `checks: { bundlerTimings: false }` -- read off the
 * options of the `rolldown()` call it really makes. And `bundlerTimings` is a name
 * rolldown still knows: its option validator warns on an unknown key under
 * `checks`, through `console.warn` and not through `onLog`, which is why that is
 * what is spied on. Together they leave
 * one thing unproved, which is that rolldown still turns a warning off when told
 * to, and that is rolldown's own documented contract rather than this build's.
 * The key being removed is what would have broken it, and the second assertion is
 * that; a rename that keeps the old name in rolldown's schema as a deprecated
 * alias is not seen.
 *
 * A file of its own for the reason `bundle-close.test.ts` gives: `vi.mock` is
 * module-wide.
 */

import { tempDir } from '../temp.js';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The `checks` of every `rolldown()` call `bundleApp()` made. */
const checks: unknown[] = [];

vi.mock('rolldown', async (importOriginal) => {
  const real = await importOriginal<typeof import('rolldown')>();

  return {
    ...real,
    rolldown(options: Parameters<typeof real.rolldown>[0]) {
      checks.push(options.checks);
      return real.rolldown(options);
    },
  };
});

const { bundleApp } = await import('../../src/build/bundle.js');
const { discoverApp } = await import('../../src/build/discover.js');
const { resolveCommandTree } = await import('../../src/build/tree.js');

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/buildable');

describe('the checks a build asks rolldown for', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Spies on what rolldown's option validator says, which it says to `console.warn`. */
  function spyOnWarnings(): string[] {
    const said: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      said.push(args.map(String).join(' '));
    });

    return said;
  }

  /** Builds the fixture for real, as `sigil build` does, to see what it asks rolldown for. */
  async function build(): Promise<void> {
    checks.length = 0;
    const app = discoverApp(fixture);
    const tree = resolveCommandTree(join(fixture, 'src', 'commands'));

    await bundleApp({ app, binName: 'buildable', out: tempDir('sigil-timings-'), tree });
  }

  /**
   * Bundles one module with the given `checks`, through the unmocked `rolldown()`,
   * and returns what its option validator said. No hold: nothing here waits for
   * rolldown to take long about anything.
   */
  async function validated(asked: unknown): Promise<string[]> {
    const said = spyOnWarnings();
    const { rolldown } = await vi.importActual<typeof import('rolldown')>('rolldown');
    const dir = tempDir('sigil-timings-one-');
    const input = join(dir, 'entry.js');
    writeFileSync(input, 'export const answer = 42;\n');

    const bundle = await rolldown({
      checks: asked as Parameters<typeof rolldown>[0]['checks'],
      input,
    });
    try {
      await bundle.write({ dir: join(dir, 'out') });
    } finally {
      await bundle.close();
    }

    return said;
  }

  it('should not ask for a warning about plugin timings', async () => {
    const said = spyOnWarnings();

    await build();

    expect(checks).toHaveLength(1);
    expect(checks[0]).toStrictEqual({ bundlerTimings: false });
    // rolldown reads `checks` through a schema and says so about a key it does not
    // know, which is what makes the assertion above mean something
    expect(said).toEqual([]);
  }, 30_000);

  it('should hand rolldown a name for the check that rolldown still knows', async () => {
    // the control (rolldown skips its validator when ROLLUP_TEST is set, which
    // fails this loudly): the validator says something when a name is wrong, so the
    // silence above is rolldown's answer and not a spy that hears nothing
    expect((await validated({ bundlerTimer: false })).join('\n')).toContain('checks.bundlerTimer');

    expect(await validated({ bundlerTimings: false })).toEqual([]);
    expect(await validated({})).toEqual([]);
  }, 30_000);
});
