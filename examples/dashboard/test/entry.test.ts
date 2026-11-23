import { type Screen, runOnTerminal } from '@ttylabs/sigil/testing';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Whether the mouse is on, read off what the entry writes to the terminal it was
 * started on.
 *
 * The dashboard has no `--mouse` flag: its entry hands `runApp()` a `mouse` of
 * its own, `{ motion: true }`, because the chart's crosshair follows the pointer
 * with no button held. The tests beside this one mount `App` under `runApp()`
 * themselves and pass `mouse` by hand, so none of them runs that line -- delete
 * it and the suite stays green over a dashboard that cannot be clicked (SIG-594,
 * which is SIG-522's finding for the examples with a flag).
 *
 * The built `bin` is spawned, as a whole process over a terminal on stdin and
 * stdout; the dashboard has no `ui` twin, because its root is JSX. What is
 * asserted is the terminal the entry left, as `Screen.mouse` reads it off the
 * bytes -- the mouse modes on while it ran and none once it had quit -- rather
 * than what `runApp()` was given, since a spy on it would pass for an entry that
 * handed the option to something else.
 */

const dir = resolve(import.meta.dirname, '..');
const bin = join(dir, 'dist', 'dashboard.mjs');

/** Where the entry is run from, so that it leaves nothing in the working directory of whoever ran the suite. */
const cwd = mkdtempSync(join(tmpdir(), 'sigil-dashboard-entry-'));
afterAll(() => {
  rmSync(cwd, { force: true, maxRetries: 5, recursive: true });
});

/** What the entry showed while it ran, and what it left behind on `q`. */
interface Started {
  /** The mouse modes the terminal was in once the entry had quit: handed back is all `false`. */
  after: Screen['mouse'];
  /** The mouse modes the terminal was in after the first frame. */
  during: Screen['mouse'];
}

/** A terminal with no mouse reporting on, which is what an entry owes it on quitting. */
const quiet = { buttons: false, motion: false, sgr: false };

/** The entry, from its start to its exit on `q`. */
async function started(): Promise<Started> {
  expect(
    existsSync(bin),
    `${bin} is missing: run \`pnpm build\` from the repository root, or \`pnpm --filter @ttylabs/example-dashboard build\``
  ).toBe(true);
  const running = runOnTerminal({ columns: 100, cwd, rows: 30, run: bin, stdin: true });
  try {
    // the first frame, so that `q` is a key somebody has read. Longer than the
    // default: several cold node starts at once, on a runner that may be slow
    await running.waitFor(/\S/, { timeout: 20_000 });
    // read while it runs: the mouse is on before the first frame is drawn
    const during = running.screen.mouse;
    await running.press('q');
    const ran = await running;
    expect(ran.err, 'nothing on stderr').toBe('');
    expect(ran.code, 'q quits with 0').toBe(0);
    return { after: running.screen.mouse, during };
  } finally {
    running.kill();
  }
}

describe('the entry', () => {
  it('should report the mouse with motion and hand it back on quitting', async () => {
    const ran = await started();
    expect(
      ran.during,
      'motion tracking, for the chart crosshair, in the encoding the app reads'
    ).toEqual({
      buttons: false,
      motion: true,
      sgr: true,
    });
    expect(ran.after, 'and turned off again').toEqual(quiet);
  }, 45_000);
});
