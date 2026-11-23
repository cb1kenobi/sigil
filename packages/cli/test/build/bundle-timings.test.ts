/**
 * What `bundleApp()` asks rolldown to check, which is not its plugin timings.
 *
 * rolldown warns when JavaScript callbacks take most of a build, and every
 * callback in this build is the toolchain's own: the warning tells whoever is
 * building an app to optimize a plugin they did not write, and it depends on how
 * busy the machine was. On a slow Windows runner it reached the exact summary
 * `output-forms.test.ts` compares and failed it (SIG-627).
 *
 * It is provoked here with a plugin that holds the build, and it arrives at
 * `close()` rather than at `write()`, which is why a first attempt at provoking
 * it saw nothing. A control asks rolldown the same with its default checks, so
 * the second test cannot pass for want of a warning that would never have come.
 * The real bundler runs in both. A file of its own for the reason
 * `bundle-close.test.ts` gives: `vi.mock` is module-wide.
 *
 * ## What decides whether the warning comes (SIG-648)
 *
 * Not the share of the build the callbacks took, which is only what the report
 * prints. rolldown's `BuildTimings::is_plugin_bound()` asks two things of the
 * clocks on its own side: the build ran for **at least three seconds**, and its
 * non-link time was **more than 100 times the link stage** -- the one stretch of
 * a build with no plugin in it. So a hold of exactly three seconds sat on the
 * floor, and what a loaded machine takes away is the ratio: the link stage is a
 * few milliseconds on an idle one and tens of them when the process is starved,
 * so a five-second hold needs a link stage under 49 ms. That cannot be made
 * impossible by waiting, only less likely, which is why the control escalates
 * (`HOLDS`) instead of choosing one number: it stops at the first build that
 * warns, so an idle machine pays five seconds and a loaded one pays more rather
 * than failing. Measured on a macOS machine with 30 busy processes over 18
 * cores, one fixed hold failed 2 of 12 at 3.5 s, 1 of 12 at 5 s and 0 of 12 at
 * 6.5 s. CI's macOS jobs are where it showed most (two of three failed on one
 * run): a small shared virtual machine, whose link stage for this fixture's graph
 * is the likeliest to pass 29 ms -- inferred, since rolldown does not expose that
 * clock, and which is why the first hold is five seconds rather than four.
 */

import { tempDir } from '../temp.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/** The `checks` of every `rolldown()` call the build made, and the logs it printed. */
const checks: unknown[] = [];
const logged: string[] = [];

/**
 * How long each attempt holds the build, in milliseconds. The first is the
 * ordinary case; the rest are for a machine so busy that the link stage took
 * more than a hundredth of it (see the file's header).
 */
const HOLDS = [5000, 10_000];

/**
 * How long the next build holds for. The control raises it until a build warns and
 * leaves it there, so the second test holds as long as the one that was shown to
 * provoke the warning -- a shorter hold could pass that test for want of one.
 */
let hold = HOLDS[0];

/** Holds the build for `hold`, once, without using the CPU -- the warning counts the wait. */
function slowPlugin() {
  let held = false;
  return {
    name: 'slow',
    async transform() {
      if (!held) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, hold));
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
      // the first build that warns is the answer; every one that did not is a
      // build too short or a link stage too slow, not a rolldown that stopped asking
      for (const ms of HOLDS) {
        hold = ms;
        await build();
        if (logged.includes('PLUGIN_TIMINGS')) {
          break;
        }
      }
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
