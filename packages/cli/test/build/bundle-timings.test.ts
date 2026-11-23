/**
 * What `bundleApp()` asks rolldown to check, which is not its plugin timings.
 *
 * rolldown warns when JavaScript callbacks take most of a build, and every
 * callback in this build is the toolchain's own: the warning tells whoever is
 * building an app to optimize a plugin they did not write, and it depends on how
 * busy the machine was. On a slow Windows runner it reached the exact summary
 * `output-forms.test.ts` compares and failed it (SIG-627).
 *
 * It is provoked here with a plugin that holds the build for three seconds, and
 * it arrives at `close()` rather than at `write()`, which is why a first attempt
 * at provoking it saw nothing. A control asks rolldown the same with its default
 * checks, so the second test cannot pass for want of a warning that would never
 * have come. The real bundler runs in both. A file of its own for the reason
 * `bundle-close.test.ts` gives: `vi.mock` is module-wide.
 */

import { tempDir } from '../temp.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/** The `checks` of every `rolldown()` call the build made, and the logs it printed. */
const checks: unknown[] = [];
const logged: string[] = [];

/** Holds the build for three seconds, once, without using the CPU -- the warning counts the wait. */
function slowPlugin() {
  let held = false;
  return {
    name: 'slow',
    async transform() {
      if (!held) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      return null;
    },
  };
}

/** Whether the next `rolldown()` leaves its checks alone, as a control. */
let control = false;

vi.mock('rolldown', async (importOriginal) => {
  const real = await importOriginal<typeof import('rolldown')>();

  return {
    ...real,
    rolldown(options: Parameters<typeof real.rolldown>[0]) {
      checks.push(options.checks);
      const onLog = options.onLog;
      return real.rolldown({
        ...options,
        ...(control && { checks: {} }),
        onLog(level, log, handler) {
          logged.push(String(log.code));
          if (onLog) {
            onLog(level, log, handler);
          } else {
            handler(level, log);
          }
        },
        plugins: [...(Array.isArray(options.plugins) ? options.plugins : []), slowPlugin()],
      });
    },
  };
});

const { bundleApp } = await import('../../src/build/bundle.js');
const { discoverApp } = await import('../../src/build/discover.js');
const { resolveCommandTree } = await import('../../src/build/tree.js');

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/buildable');

describe('the checks a build asks rolldown for', () => {
  /** Builds the fixture, with a plugin that holds the build up. */
  async function build(): Promise<void> {
    logged.length = 0;
    checks.length = 0;
    const app = discoverApp(fixture);
    const tree = resolveCommandTree(join(fixture, 'src', 'commands'));

    await bundleApp({ app, binName: 'buildable', out: tempDir('sigil-timings-'), tree });
  }

  it('should warn about plugin timings when the checks are rolldown defaults', async () => {
    control = true;
    try {
      await build();
    } finally {
      control = false;
    }

    expect(logged).toContain('PLUGIN_TIMINGS');
  }, 30_000);

  it('should not ask for a warning about plugin timings', async () => {
    await build();

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ bundlerTimings: false });
    expect(logged).not.toContain('PLUGIN_TIMINGS');
  }, 30_000);
});
