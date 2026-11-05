import { type Ran, run, STACK } from './spawned.ts';
import { runApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import { createTestTerminal, ctrl, KEYS, type TestTerminal } from '@ttylabs/sigil/testing';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every example under `examples/`, run the two ways a person runs it.
 *
 * `examples/AGENTS.md` has the contract this reads, and the reasons for it.
 * In short: an example is a workspace member whose `src/root*.{tsx,ts,js}`
 * modules each export a root component `App`, which takes no props and reaches
 * the app through `useApp()`, and its `stylesheet` -- one module per template
 * syntax. Its entries run it with `runApp()`. `q` quits with `0` through
 * `useApp().exit()`, and Ctrl-C is the runner's, with `130`.
 *
 * **In-process, over a test terminal**, each root component is run with
 * `runApp()`, drawn, walked with Tab and quit with `q` and with Ctrl-C, and the
 * screen has to be given back. Where
 * an example is written in more than one syntax, every one of them has to draw
 * the same first screen -- which is the claim the two syntaxes rest on, one IR
 * behind both, checked on a real app rather than asserted in prose.
 *
 * **Spawned, piped**, each runnable entry has to be refused the way `runApp()`
 * refuses: exit `1`, nothing on stdout, the one line on stderr, and no stack
 * anywhere. The built `bin` for a JSX example, which is the only thing that
 * proves `sigil build` produced a bundle that loads, and `src/ui.{ts,js}` for
 * the twin Node runs as it is. A full-screen app in a pipe has nobody to type
 * and no screen to draw on, and a refusal a script can detect is the answer
 * Chris chose over a frame and a `0` -- so an entry that exits `0` piped has
 * stopped refusing, which is a failure here.
 *
 * Lives in this package for the reason `demos.test.ts` does: it needs `dist/`,
 * of `@ttylabs/sigil` for the test terminal and of the examples for their
 * built entries, and this is the package whose tests already require a build.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const examplesDir = resolve(root, 'examples');

/** One example, as the contract describes it. */
interface Example {
  readonly dir: string;
  readonly manifest: {
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
    name?: string;
    private?: boolean;
    scripts?: Record<string, string>;
    type?: string;
  };
  readonly name: string;
  /** The root modules, one per syntax. */
  readonly roots: readonly string[];
  /** `src/start.*`, the hand-wired runner `runApp()` replaced; the contract test wants none. */
  readonly start: string | undefined;
  /** `src/ui.*`: the twin Node runs unbuilt. */
  readonly unbuilt: string | undefined;
}

/** The first of `names` that exists in `dir`. */
function first(dir: string, names: readonly string[]): string | undefined {
  return names.map((name) => join(dir, name)).find((path) => existsSync(path));
}

/** Every directory under `examples/` that has a manifest, which is what pnpm reads too. */
function examples(): Example[] {
  if (!existsSync(examplesDir)) {
    return [];
  }

  return readdirSync(examplesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(examplesDir, entry.name, 'package.json'))
    )
    .map((entry) => {
      const dir = join(examplesDir, entry.name);
      const src = join(dir, 'src');
      const roots = existsSync(src)
        ? readdirSync(src)
            .filter((file) => /^root(\.[\w-]+)?\.(tsx|ts|js)$/.test(file))
            .sort()
            .map((file) => join(src, file))
        : [];

      return {
        dir,
        manifest: JSON.parse(
          readFileSync(join(dir, 'package.json'), 'utf-8')
        ) as Example['manifest'],
        name: entry.name,
        roots,
        start: first(src, ['start.ts', 'start.js']),
        unbuilt: first(src, ['ui.ts', 'ui.js']),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a root module exports. */
interface RootModule {
  App: () => Element;
  stylesheet: string;
}

/**
 * The line `runApp()` writes when it refuses to start, as the default `onError`
 * renders it. Its wording is `src/renderer/app.ts`'s; pinned here rather than
 * any one line, so that an entry dying of something else on the way is not
 * mistaken for the refusal.
 */
const REFUSAL = /^Error: Cannot run an app because stdin or the output is not a terminal\b.*\r?\n$/;

/**
 * Waits for `test` to hold, or fails saying what was being waited for.
 *
 * Polling, because a frame is drawn on the renderer's clock rather than per
 * key, and nothing yet says when the next one has landed -- which is SIG-309.
 */
async function until(test: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Settles with what `promise` settles with, or rejects after `ms`. */
function within<T>(promise: Promise<T>, what: string, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, fail) => {
      setTimeout(() => fail(new Error(`${what} did not happen within ${ms}ms`)), ms).unref();
    }),
  ]);
}

/**
 * The screen once the frame loop has gone quiet, so that two runs compare like
 * for like. A wait SIG-309 would make a call.
 */
async function settled(term: TestTerminal): Promise<string[]> {
  let last = '';
  let steady = 0;
  // three reads 40ms apart with nothing changing: the frame loop runs at 30fps,
  // so that is a frame period passed with no frame
  await until(
    () => {
      const now = term.viewport.join('\n');
      steady = now === last ? steady + 1 : 0;
      last = now;
      return steady >= 3;
    },
    'the screen to stop changing',
    3000
  );
  return term.viewport;
}

const COLUMNS = 60;
const ROWS = 16;

/**
 * Runs one root component the way its entry does, over a test terminal, and
 * hands back what it drew and the exit code to come.
 *
 * `detect: false` because nothing at the far end of a test terminal answers a
 * capability query, and an app's first frame does not wait for one anyway.
 *
 * @param file - The root module.
 * @returns The first settled screen, and the terminal for whatever comes next.
 */
async function mount(
  file: string
): Promise<{ done: Promise<number>; screen: string[]; term: TestTerminal }> {
  const rootModule = (await import(pathToFileURL(file).href)) as RootModule;

  const term = createTestTerminal({ columns: COLUMNS, rows: ROWS });
  const done = runApp(rootModule.App, {
    detect: false,
    sheets: [rootModule.stylesheet],
    terminal: term.terminal,
  }).exited;

  await until(() => term.screen.alternate, 'the app to take the whole screen');
  const screen = await settled(term);
  return { done, screen, term };
}

/** What `runApp()` refusing looks like from outside: `1`, one line on stderr, nothing else. */
function refused({ code, stderr, stdout }: Ran): void {
  expect(`${stdout}${stderr}`, 'a stack reached the output').not.toMatch(STACK);
  expect(code, 'exit code: the refusal is 1, and 0 means it drew or did nothing').toBe(1);
  expect(stdout, 'nothing on stdout').toBe('');
  expect(stderr, 'the one line runApp() refuses with').toMatch(REFUSAL);
}

const found = examples();

describe('the examples', () => {
  it('should have been found', () => {
    // a directory that stopped matching passes every assertion below it
    expect(found.length).toBeGreaterThan(0);
  });

  for (const example of found) {
    describe(example.name, () => {
      it('should follow the example contract', () => {
        const { manifest } = example;
        expect(manifest.name, 'the package name').toBe(`@ttylabs/example-${example.name}`);
        expect(manifest.private, 'an example is never published').toBe(true);
        expect(manifest.type, 'an example is an ES module').toBe('module');
        expect(manifest.dependencies?.['@ttylabs/sigil']).toBe('workspace:*');
        expect(
          example.roots.length,
          'a root module: src/root.tsx, src/root.ts or src/root.js'
        ).toBeGreaterThan(0);
        // the hand-wired runner examples carried before `runApp()` existed
        expect(example.start, 'src/start.* is runApp() now; delete it').toBeUndefined();
        // a JSX root needs a build, and a build needs a `bin` to write
        if (example.roots.some((file) => file.endsWith('.tsx'))) {
          expect(manifest.scripts?.build, 'a JSX example builds').toBe('sigil build');
          expect(
            Object.keys(manifest.bin ?? {}),
            'a JSX example names its built entry'
          ).toHaveLength(1);
        }
        // and something has to be runnable without one, or it is not a
        // `ui`-tag example either
        expect(
          manifest.bin !== undefined || example.unbuilt !== undefined,
          'a built bin or an unbuilt src/ui entry'
        ).toBe(true);
      });

      for (const file of example.roots) {
        it(`should export App, taking no props, and its stylesheet: ${basename(file)}`, async () => {
          // the app is reached through `useApp()`, so a root that still takes
          // props is one somebody has to remember to wire, and `runApp()` will
          // not
          const rootModule = (await import(pathToFileURL(file).href)) as RootModule;
          expect(typeof rootModule.App, 'App').toBe('function');
          expect(rootModule.App.length, 'App takes no props').toBe(0);
          expect(typeof rootModule.stylesheet, 'stylesheet').toBe('string');
        });

        it(`should draw, take Tab, and give the screen back on q: ${basename(file)}`, async () => {
          const { done, screen, term } = await mount(file);

          expect(screen.join('').trim(), 'the first screen is blank').not.toBe('');

          // round the focus ring and then some, which is the one interaction
          // every full-screen app has whatever else it does
          for (let i = 0; i < 4; i++) {
            await term.press(KEYS.tab);
          }
          await term.press('q');

          expect(await within(done, 'quitting on q')).toBe(0);
          expect(term.screen.alternate, 'the alternate screen was left').toBe(false);
          expect(term.screen.cursorHidden, 'the cursor was shown again').toBe(false);
          expect(term.stdin.rawMode, 'raw mode was put back').toBe(false);
        });

        it(`should give the screen back on Ctrl-C: ${basename(file)}`, async () => {
          // whatever the app binds, Ctrl-C ends it: an app that cannot be quit
          // is the failure a function binding seeing every key first exists to
          // prevent. 130 is what a shell reports for an interrupt
          const { done, term } = await mount(file);
          await term.press(ctrl('c'));

          expect(await within(done, 'quitting on Ctrl-C')).toBe(130);
          expect(term.screen.alternate, 'the alternate screen was left').toBe(false);
          expect(term.stdin.rawMode, 'raw mode was put back').toBe(false);
        });
      }

      if (example.roots.length > 1) {
        it('should draw the same screen in every syntax', async () => {
          const drawn: string[][] = [];
          for (const file of example.roots) {
            const { done, screen, term } = await mount(file);
            drawn.push(screen);
            await term.press('q');
            await within(done, 'quitting on q');
          }
          for (const screen of drawn.slice(1)) {
            expect(screen).toStrictEqual(drawn[0]);
          }
        });
      }

      const bin = Object.values(example.manifest.bin ?? {})[0];
      if (bin !== undefined) {
        const built = join(example.dir, bin);

        it.concurrent(`should refuse to run ${bin} piped`, async () => {
          // `pnpm test` builds every example that has a build before vitest
          // starts, and `the root build filter` fails if one is left out -- so
          // a missing bundle here means vitest was run on its own. Whether a
          // bundle that *is* there is current is not asked by modification
          // time, because that answer is wrong: a cache hit leaves `dist/`
          // untouched, so a source file touched and put back is newer than a
          // bundle that is exactly right. `examples/AGENTS.md` has the
          // measurement
          expect(existsSync(built), `${bin} is missing; run pnpm build`).toBe(true);
          refused(await run(built, example.dir));
        }, 45_000);
      }

      if (example.unbuilt !== undefined) {
        const unbuilt = example.unbuilt;

        it.concurrent(`should refuse to run ${basename(unbuilt)} piped, with nothing built`, async () => {
          refused(await run(unbuilt, example.dir));
        }, 45_000);
      }
    });
  }
});
