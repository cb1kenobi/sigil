import { type Screen, runOnTerminal } from '@ttylabs/sigil/testing';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Whether `--mouse` reaches `runApp()`, read off what each entry writes to the
 * terminal it was started on.
 *
 * The entry is the one place the flag is wired -- `argv.mouse` into `runApp()`'s
 * `mouse` option -- and the tests beside this one all mount `App` under
 * `runApp()` themselves and pass `mouse` by hand, so none of them runs the line
 * that does it. Take it out and the suite stays green over a browser with no
 * mouse at all (SIG-522).
 *
 * Both entries are spawned, as a whole process over a terminal on stdin and
 * stdout, because they are two schemas that spell the flag separately: the built
 * `bin` is `src/index.ts` as `sigil build` read it, and `src/ui.ts` is the `ui`
 * twin Node runs as it is. What is asserted is the terminal the entry left, as
 * `Screen.mouse` reads it off the bytes -- the mouse modes on while it ran and
 * none once it had quit -- rather than what `runApp()` was given, since a spy on
 * it would pass for an entry that handed the option to something else.
 */

const dir = resolve(import.meta.dirname, '..');
const bin = join(dir, 'dist', 'log-browser.mjs');
const entries = [
  { file: bin, label: 'dist/log-browser.mjs' },
  { file: join(dir, 'src', 'ui.ts'), label: 'src/ui.ts' },
];

/** Where the entry is run from, so that it leaves nothing in the working directory of whoever ran the suite. */
const cwd = mkdtempSync(join(tmpdir(), 'sigil-log-browser-entry-'));
afterAll(() => {
  rmSync(cwd, { force: true, maxRetries: 5, recursive: true });
});

/** A log file to read, which the simulated pods would never print a line of. */
const log = join(cwd, 'app.log');
writeFileSync(log, 'a line only the file holds\n');

/** What the entry showed while it ran, and what it left behind on `q`. */
interface Started {
  /** Whether the alternate screen was up while it ran, which is that the app drew. */
  alternate: boolean;
  /** The mouse modes the terminal was in once the entry had quit: handed back is all `false`. */
  after: Screen['mouse'];
  /** The mouse modes the terminal was in after the first frame. */
  during: Screen['mouse'];
}

/** A terminal with no mouse reporting on, which is what an entry owes it on quitting. */
const quiet = { buttons: false, motion: false, sgr: false };

/** The entry, from its start to its exit on `q`, once the screen shows `shows`. */
async function started(
  file: string,
  flags: string[],
  { shows = /\S/ }: { shows?: RegExp } = {}
): Promise<Started> {
  if (file === bin) {
    expect(
      existsSync(file),
      `${file} is missing: run \`pnpm build\` from the repository root, or \`pnpm --filter @ttylabs/example-log-browser build\``
    ).toBe(true);
  }
  const running = runOnTerminal({
    argv: flags,
    columns: 80,
    cwd,
    rows: 24,
    run: file,
    stdin: true,
  });
  try {
    // the first frame, so that `q` is a key somebody has read. Longer than the
    // default: four cold node starts at once, on a runner that may be slow
    await running.waitFor(/\S/, { timeout: 20_000 });
    await running.waitFor(shows, { timeout: 20_000 });
    // read while it runs: the mouse is on before the first frame is drawn
    const { alternate, mouse: during } = running.screen;
    await running.press('q');
    const ran = await running;
    expect(ran.err, 'nothing on stderr').toBe('');
    expect(ran.code, 'q quits with 0').toBe(0);
    return { after: running.screen.mouse, alternate, during };
  } finally {
    running.kill();
  }
}

describe('the entry', () => {
  for (const { file, label } of entries) {
    it.concurrent(`should report the mouse with --mouse and hand it back on quitting: ${label}`, async () => {
      const ran = await started(file, ['--mouse']);
      expect(ran.during, 'button tracking, in the encoding the app reads').toEqual({
        buttons: true,
        motion: false,
        sgr: true,
      });
      expect(ran.after, 'and turned off again').toEqual(quiet);
    }, 45_000);

    it.concurrent(`should leave the terminal selecting text without --mouse: ${label}`, async () => {
      const ran = await started(file, []);
      expect(ran.alternate, 'the app drew').toBe(true);
      expect(ran.during, 'no tracking mode and no mouse encoding').toEqual(quiet);
    }, 45_000);

    it.concurrent(`should read the file it was given instead of the simulated pods: ${label}`, async () => {
      // a `[file]` that did not reach `environment()` leaves the pods, none of
      // which has this line
      await started(file, [log], { shows: /a line only the file holds/ });
    }, 45_000);
  }
});
