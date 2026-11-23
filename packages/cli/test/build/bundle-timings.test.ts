/**
 * What `bundleApp()` asks rolldown to check, which is not its plugin timings.
 *
 * rolldown warns when JavaScript callbacks take most of a build, and every
 * callback in this build is the toolchain's own: the warning tells whoever is
 * building an app to optimize a plugin they did not write, and it depends on how
 * busy the machine was. On a slow Windows runner it reached the exact summary
 * `output-forms.test.ts` compares and failed it (SIG-627).
 *
 * The warning cannot be provoked from here -- a plugin that holds a build for
 * four seconds did not produce it on rolldown 1.3.3, and its text is in the
 * native binary -- so what is asserted is what the build handed rolldown, and
 * the real bundler still runs. A file of its own for the reason
 * `bundle-close.test.ts` gives: `vi.mock` is module-wide.
 */

import { tempDir } from '../temp.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/** The `checks` of every `rolldown()` call the build made. */
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
  it('should not ask for a warning about plugin timings', async () => {
    const app = discoverApp(fixture);
    const tree = resolveCommandTree(join(fixture, 'src', 'commands'));

    await bundleApp({ app, binName: 'buildable', out: tempDir('sigil-timings-'), tree });

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ bundlerTimings: false });
  });
});
