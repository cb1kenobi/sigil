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
 * the second test does not pass for want of a warning that would never have come
 * -- in file order, and short of a stall inside its own link stage, which is why
 * its `checks` are also asserted directly.
 * A file of its own for the reason `bundle-close.test.ts` gives: `vi.mock` is
 * module-wide.
 *
 * ## What decides whether the warning comes (SIG-648)
 *
 * Not the share of the build the callbacks took, which is only what the report
 * prints. rolldown's `BuildTimings::is_plugin_bound()` asks two things of the
 * clocks on its own side: the build ran for **at least three seconds**, and its
 * non-link time was **more than 100 times the link stage** -- the one stretch of
 * a build with no plugin in it. The link stage is wall clock, so what a loaded
 * machine takes away is the ratio: it grows past a hundredth of the hold.
 *
 * ## ...and the graph it is asked of is one module (SIG-667)
 *
 * SIG-648 held the build five seconds, then ten, and it still failed on a loaded
 * macOS runner after 16.5 s -- both holds, in a row. The hold was never the
 * variable that mattered: five seconds needs a link stage under 49 ms and ten under
 * 99, and
 * `bundleApp()`'s graph is the toolchain's whole runtime, whose link stage is
 * several milliseconds to tens of them with nothing else running (the gap from
 * `buildEnd` to `renderStart`, which contains it, measured 5 to 27 ms warm, 74
 * ms cold). The control needs a warning to be *provoked*, not a real app to be
 * built, so it holds a graph of one module: the same gap measured about one
 * millisecond, cold, in twelve fresh processes. That is a margin of about fifty
 * at five seconds, where the old graph's was two warm and under one cold. It is still not a guarantee -- the link stage is wall clock and a
 * starved process stalls inside it, 5 of 120 builds at five seconds with forty
 * of them racing on top of a load average of 124 -- which is why the control still
 * escalates (`HOLDS`) rather than choosing one number.
 *
 * What `bundleApp()` is asked is only what it passes as `checks`, so that is what
 * it is asked: it is built for real, with no hold, and the `checks` it handed
 * rolldown are given to the held build. The control gives it `{}`, which is
 * rolldown's defaults; the two builds differ in nothing else.
 */

import { tempDir } from '../temp.js';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/** The `checks` of every `rolldown()` call `bundleApp()` made, and the logs it printed. */
const checks: unknown[] = [];
const logged: string[] = [];

/**
 * How long each attempt holds the build, in milliseconds. The first is the
 * ordinary case; the rest are for a machine so busy that the link stage took
 * more than a hundredth of it (see the file's header).
 */
const HOLDS = [5000, 10_000];

/**
 * How long the next held build holds for. The control raises it until a build
 * warns and leaves it there, so the second test holds as long as the one that was
 * shown to provoke the warning -- a shorter hold could pass that test for want of
 * one.
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

vi.mock('rolldown', async (importOriginal) => {
  const real = await importOriginal<typeof import('rolldown')>();

  return {
    ...real,
    rolldown(options: Parameters<typeof real.rolldown>[0]) {
      checks.push(options.checks);
      const onLog = options.onLog;
      return real.rolldown({
        ...options,
        onLog(level, log, handler) {
          logged.push(String(log.code));
          if (onLog) {
            onLog(level, log, handler);
          } else {
            handler(level, log);
          }
        },
      });
    },
  };
});

const { bundleApp } = await import('../../src/build/bundle.js');
const { discoverApp } = await import('../../src/build/discover.js');
const { resolveCommandTree } = await import('../../src/build/tree.js');

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/buildable');

describe('the checks a build asks rolldown for', () => {
  /** Builds the fixture for real, as `sigil build` does, to see what it asks rolldown for. */
  async function build(): Promise<void> {
    logged.length = 0;
    checks.length = 0;
    const app = discoverApp(fixture);
    const tree = resolveCommandTree(join(fixture, 'src', 'commands'));

    await bundleApp({ app, binName: 'buildable', out: tempDir('sigil-timings-'), tree });
  }

  /**
   * Builds one module under a plugin that holds the build, with the `checks` it is
   * given, and returns the codes of what rolldown logged -- after `close()`, which
   * is where the warning is delivered. The unmocked `rolldown()`: what is being
   * asked is what rolldown does with these checks, not what `bundleApp()` does.
   */
  async function held(asked: unknown): Promise<string[]> {
    const { rolldown } = await vi.importActual<typeof import('rolldown')>('rolldown');
    const dir = tempDir('sigil-timings-held-');
    const input = join(dir, 'entry.js');
    const codes: string[] = [];
    writeFileSync(input, 'export const answer = 42;\n');

    const bundle = await rolldown({
      checks: asked as Parameters<typeof rolldown>[0]['checks'],
      input,
      onLog(_level, log) {
        codes.push(String(log.code));
      },
      plugins: [slowPlugin()],
    });
    try {
      await bundle.write({ dir: join(dir, 'out') });
    } finally {
      await bundle.close();
    }

    return codes;
  }

  it('should warn about plugin timings when the checks are rolldown defaults', async () => {
    // the first build that warns is the answer; every one that did not is a
    // build too short or a link stage too slow, not a rolldown that stopped asking
    let codes: string[] = [];
    for (const ms of HOLDS) {
      hold = ms;
      codes = await held({});
      if (codes.includes('PLUGIN_TIMINGS')) {
        break;
      }
    }

    expect(codes).toContain('PLUGIN_TIMINGS');
  }, 30_000);

  it('should not ask for a warning about plugin timings', async () => {
    await build();

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ bundlerTimings: false });
    // a sanity check only: this build is far under rolldown's three-second floor
    expect(logged).not.toContain('PLUGIN_TIMINGS');

    // the hold that provoked the warning in the control, with what the build asked
    // for; in file order, and a stall in this build's own link stage would pass it
    // for want of a warning, which is why the assertion above is the one that holds
    expect(await held(checks[0])).not.toContain('PLUGIN_TIMINGS');
  }, 30_000);
});
