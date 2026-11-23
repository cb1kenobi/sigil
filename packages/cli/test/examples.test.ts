import { type Ran, run, STACK } from './spawned.ts';
import { type App, runApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import {
  createTestTerminal,
  ctrl,
  frame,
  KEYS,
  runOnTerminal,
  type TestTerminal,
} from '@ttylabs/sigil/testing';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

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
 * **Spawned, with a terminal on stdin and stdout**, each runnable entry is run
 * as a whole process: its own schema and `main()`, the capability queries going
 * out unanswered. `waitFor()` is the first frame, a key goes in where the example
 * has one that changes the screen -- the app's own frame clock, waited on rather
 * than forced, which the in-process half cannot show since `frame()` forces it --
 * and `q` has to quit with `0`, nothing on stderr, and the screen given back.
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
    version?: string;
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

/**
 * The `compilerOptions` an example's `tsconfig.json` ends up with, following a
 * relative `extends` chain, nearest file winning. `undefined` when the example
 * has no `tsconfig.json` at all. Plain `JSON.parse()`, since every tsconfig in
 * this repository is plain JSON and `@ttylabs/sigil` does not export its JSONC
 * reader; a base that is not is a failure to read it, which is loud.
 */
function tsconfigOptions(dir: string): Record<string, unknown> | undefined {
  const read = (file: string): Record<string, unknown> => {
    const config = JSON.parse(readFileSync(file, 'utf-8')) as {
      compilerOptions?: Record<string, unknown>;
      extends?: string;
    };
    const base =
      typeof config.extends === 'string' && config.extends.startsWith('.')
        ? read(resolve(dirname(file), config.extends))
        : {};
    return { ...base, ...config.compilerOptions };
  };
  const file = join(dir, 'tsconfig.json');
  return existsSync(file) ? read(file) : undefined;
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
 * The key that changes the screen, for the examples that have one the harness
 * knows. The contract has no way to say which key does what, so this is a table
 * of the examples whose keys are documented in their own README rather than
 * something inferred: `hello`'s first row has the focus and Enter counts it, and
 * `2` takes the git client's focus to its branches, whose keys the footer then
 * lists -- whether or not the directory it was started in is a repository --
 * the settings screen's sidebar has the focus and Down shows the next section,
 * as the dashboard's does -- whose sidebar is down to its glyphs at this width, so
 * the page's name in the header is the only `Analytics` on screen -- `.` shows
 * the file manager's hidden files and says so, whatever directory it is in, and
 * `r` has the disk usage visualizer scan again and say `Rescanned`, which the
 * first scan says as `Scanned`.
 */
const KEYED: Record<string, { keys: string[]; shows: string } | undefined> = {
  dashboard: { keys: [KEYS.down], shows: 'Analytics' },
  'disk-usage': { keys: ['r'], shows: 'Rescanned' },
  'file-manager': { keys: ['.'], shows: 'Hidden files: shown' },
  'git-client': { keys: ['2'], shows: 'checkout' },
  hello: { keys: [KEYS.enter], shows: '1 press' },
  settings: { keys: [KEYS.down], shows: 'Pause all' },
};

const COLUMNS = 60;
const ROWS = 16;

/**
 * What a root module's first `import()` may take, and what a test may not be
 * charged for. The first import of an example's root is a cold one -- vite
 * transforms its JSX and loads `@ttylabs/sigil` from `dist/` -- and it is
 * usually 0.3 to 1 s, was 4.9 s on a Windows runner of a passing main run, and
 * ran past the package's 10 s `testTimeout` four times on one branch (SIG-565).
 * It is paid once per example in a `beforeAll()`, which is the one place that
 * can say so: a test's own timeout cannot be raised for one test without being
 * a number nobody reads, and the package's cannot be raised for every test
 * without hiding real slowness everywhere else. A hang is still a failure, and
 * it fails here in this long, naming the example and the file.
 */
const COLD_IMPORT_MS = 30_000;

/** The roots already asked for, so the first `import()` is the only one anybody waits on. */
const loaded = new Map<string, Promise<RootModule>>();

/**
 * A root module, imported once. The module runner caches an `import()` by its
 * URL already, so a second one is cheap either way -- measured, `mount()` after
 * the export test took 16 ms behind a 5 s import -- and what this adds is that
 * every caller waits on the one promise, which is what the `beforeAll()` below
 * has finished by the time a test asks.
 *
 * @param file - The root module.
 * @returns What it exports.
 */
function load(file: string): Promise<RootModule> {
  let module = loaded.get(file);
  if (module === undefined) {
    module = import(pathToFileURL(file).href) as Promise<RootModule>;
    loaded.set(file, module);
  }
  return module;
}

/**
 * Runs one root component the way its entry does, over a test terminal, and
 * hands back what it drew and the exit code to come.
 *
 * `detect: false` because nothing at the far end of a test terminal answers a
 * capability query, and an app's first frame does not wait for one anyway.
 *
 * @param file - The root module.
 * @returns The first screen, and the app and terminal for whatever comes next.
 */
async function mount(
  file: string
): Promise<{ app: App; done: Promise<number>; screen: string[]; term: TestTerminal }> {
  const rootModule = await load(file);

  const term = createTestTerminal({ columns: COLUMNS, rows: ROWS });
  const app = runApp(rootModule.App, {
    detect: false,
    sheets: [rootModule.stylesheet],
    terminal: term.terminal,
  });

  // the first frame, painted now rather than waited for: the app has taken the
  // whole screen and drawn once it has, and a root that takes the focus in
  // `onMount` has it
  await frame(app);
  expect(term.screen.alternate, 'the app took the whole screen').toBe(true);
  return { app, done: app.exited, screen: term.viewport, term };
}

/**
 * What a missing bundle says, which is the command that makes it and where to
 * run it from. `pnpm build` alone is wrong from `packages/cli`, where it builds
 * the toolchain and not the example.
 */
function missing(example: Example, bin: string): string {
  return `${bin} is missing: run \`pnpm build\` from the repository root, or \`pnpm --filter ${example.manifest.name} build\``;
}

/** What `runApp()` refusing looks like from outside: `1`, one line on stderr, nothing else. */
function refused({ code, stderr, stdout }: Ran): void {
  expect(`${stdout}${stderr}`, 'a stack reached the output').not.toMatch(STACK);
  expect(code, 'exit code: the refusal is 1, and 0 means it drew or did nothing').toBe(1);
  expect(stdout, 'nothing on stdout').toBe('');
  expect(stderr, 'the one line runApp() refuses with').toMatch(REFUSAL);
}

/**
 * What an example's entries say, comments stripped: `src/index.ts`, which
 * `sigil build` reads, and the unbuilt `src/ui.*` where there is one, which spells
 * the schema separately. One reader for every guard that asks what the entry
 * declares or passes on, so that two of them cannot come to read different files
 * (SIG-522, SIG-594, SIG-617).
 */
function entrySources(example: Example): string[] {
  return [join(example.dir, 'src', 'index.ts'), example.unbuilt]
    .filter((file): file is string => file !== undefined && existsSync(file))
    .map((file) =>
      readFileSync(file, 'utf-8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '')
    );
}

/**
 * The positional arguments an entry's source declares, by the word a person
 * types them as: `dir` for `{ name: 'dir' }`, `file` for `{ name: '[file]' }` and
 * for `'[file]'`, `files` for `'<files...>'`.
 *
 * Read off the `args: [...]` literal rather than imported, because an entry
 * imports its root and a root is JSX, which node cannot load -- the same reason
 * the guard above reads the word `mouse` off the text. The array is walked rather
 * than matched with a pattern, because an argument's description may hold a
 * bracket or a comma and a pattern that stopped at the first `]` would read half
 * of one: strings are skipped as strings, and only an element of the array itself
 * (a format string) or a `name` of an object in it counts. An `args` that is not
 * written out in the entry -- imported, spread, held in a local constant, a
 * `{ name }` shorthand -- reads as none, which is the
 * limit of reading source, and why `an entry that declares a positional` below
 * insists the reader still finds some in the examples that are known to have one.
 */
function positionals(source: string): string[] {
  const names: string[] = [];
  for (const start of source.matchAll(/\bargs\s*:\s*\[/g)) {
    let depth = 1;
    let key = '';
    for (let i = start.index + start[0].length; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === "'" || c === '"' || c === '`') {
        let end = i + 1;
        while (end < source.length && source[end] !== c) {
          end += source[end] === '\\' ? 2 : 1;
        }
        const text = source.slice(i + 1, end);
        if (/^\s*:/.test(source.slice(end + 1, end + 8))) {
          // a quoted key
          key = text;
        } else {
          // a string is an argument as an element of the array, or as the
          // value of a `name` one level down; anywhere else it is a description
          if (depth === 1 || (depth === 2 && key === 'name')) {
            names.push(text);
          }
          key = '';
        }
        i = end;
      } else if (c === '[' || c === '{') {
        depth++;
        key = '';
      } else if (c === ']' || c === '}') {
        depth--;
        key = '';
      } else if (/[\w$]/.test(c)) {
        let end = i;
        while (end < source.length && /[\w$]/.test(source[end])) {
          end++;
        }
        key = source.slice(i, end);
        i = end - 1;
      } else if (c === ',') {
        key = '';
      }
    }
  }
  return names.map((name) => name.replaceAll(/[<>[\].\s]/g, '')).filter((name) => name !== '');
}

const found = examples();

describe('the examples', () => {
  it('should have been found', () => {
    // a directory that stopped matching passes every assertion below it
    expect(found.length).toBeGreaterThan(0);
  });

  describe('an entry that declares a positional', () => {
    // the guard reads source, so a reader that stopped matching would let every
    // example through; these are what it is asked, and the last is that it still
    // finds the ones this repository has
    it('should be read off an object, a format string and a quoted key', () => {
      expect(positionals("args: [{ name: 'dir', desc: 'Where' }] as const")).toEqual(['dir']);
      expect(positionals("args: [{ desc: 'A log', name: '[file]' }]")).toEqual(['file']);
      expect(positionals("args: ['<files...>', '[out]']")).toEqual(['files', 'out']);
      expect(positionals('args: [{ "name": "dir" }]')).toEqual(['dir']);
    });

    it('should not take a description for an argument, or a bracket in one for the end', () => {
      expect(
        positionals("args: [{ name: 'a', desc: 'one] [two, name: x' }, { name: 'b' }]")
      ).toEqual(['a', 'b']);
    });

    it('should not take an option or a command for an argument', () => {
      expect(positionals("options: { '--mouse': 'on' }, commands: { x: './x.js' }")).toEqual([]);
      expect(positionals("args: [], options: { '--name': 'a name' }")).toEqual([]);
    });

    it('should be found in the examples that take one', () => {
      const declared = new Map(
        found.map((example) => [example.name, entrySources(example).flatMap(positionals)])
      );
      for (const [name, args] of [
        ['disk-usage', 'dir'],
        ['editor', 'dir'],
        ['file-manager', 'dir'],
        ['git-client', 'dir'],
        ['log-browser', 'file'],
      ] as const) {
        expect(declared.get(name), `${name}'s entry declares ${args}`).toContain(args);
      }
    });
  });

  for (const example of found) {
    describe(example.name, () => {
      // the cold import, paid here and not inside whichever test happens to be
      // first. `within()` is what names the hang -- the hook's own timeout is a
      // few seconds behind it, so that this message is the one that is read
      beforeAll(async () => {
        // every root is asked and every failure is named, so a broken root
        // does not hide the one beside it
        const settled = await Promise.allSettled(
          example.roots.map((file) =>
            within(load(file), `importing ${relative(root, file)}`, COLD_IMPORT_MS)
          )
        );
        const failures = settled.flatMap((result) =>
          result.status === 'rejected' ? [String((result.reason as Error).message)] : []
        );
        if (failures.length > 0) {
          throw new Error(failures.join('; '));
        }
      }, COLD_IMPORT_MS + 5000);

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

      it('should test the mouse from the entry, when the entry turns it on', () => {
        // every example's own tests mount `App` under `runApp()` and pass `mouse`
        // by hand, so the one line in an entry that reads `argv.mouse` -- or hands
        // `runApp()` a `mouse` of its own -- is run by nothing else: take it out
        // and the suite stays green over an app with no mouse (SIG-522, SIG-594).
        // Read off the entry's source, so an example that adds the flag, or turns
        // the mouse on without one, has to add the file. Any use of the word
        // outside a comment counts -- `'-m, --mouse'`, a shorthand `{ mouse }`, a
        // quoted key -- since a test owed wrongly is cheaper than one missed. The
        // file has to name what it reads, so an empty one is not an answer, and
        // the unbuilt entry too, since it spells the flag separately from the bin
        const sources = entrySources(example);
        if (!sources.some((text) => /\bmouse\b/.test(text))) {
          return;
        }

        const test = join(example.dir, 'test', 'entry.test.ts');
        expect(
          existsSync(test),
          `${example.name}'s entry turns the mouse on and ${relative(root, test)} does not exist: it spawns the entry and reads Screen.mouse`
        ).toBe(true);
        const text = readFileSync(test, 'utf-8');
        expect(text, 'the entry test reads the mouse modes').toMatch(/\bscreen\.mouse\b/);
        if (example.unbuilt !== undefined) {
          expect(text, 'the entry test spawns the unbuilt entry too').toContain(
            basename(example.unbuilt)
          );
        }
      });

      it('should test each positional argument from the entry, when the entry declares one', () => {
        // the mouse guard's other half (SIG-617). An entry hands `argv.dir` to
        // a provider -- the directory, the repository, the file -- and every
        // example's own tests mount `App` over a provider of their own, so the
        // line that carries the argument across is run by nothing else: take it
        // out and the example opens on the working directory with every test
        // still green. So each positional the entry declares is owed a test in
        // `test/entry.test.ts` that runs the entry with an argument and looks for
        // it on screen, and the way the file says which argument a test is for
        // is its title: `should open the dir it was given`, with the word as a
        // person types it. Every `ui` twin is asked too, because it declares the
        // arguments separately from the bin and a typo in one is a bug in one.
        const declared = [...new Set(entrySources(example).flatMap(positionals))];
        if (declared.length === 0) {
          return;
        }

        const test = join(example.dir, 'test', 'entry.test.ts');
        expect(
          existsSync(test),
          `${example.name}'s entry declares ${declared.join(', ')} and ${relative(root, test)} does not exist: it spawns the entry with the argument and looks for it on screen`
        ).toBe(true);
        // comments stripped, so that a test commented out is a test removed
        const text = readFileSync(test, 'utf-8')
          .replaceAll(/\/\*[\s\S]*?\*\//g, '')
          .replaceAll(/^\s*\/\/.*$/gm, '');
        expect(text, 'the entry test passes an argument').toMatch(/\bargv\b/);
        const titles = [
          ...text.matchAll(/\bit(?:\.concurrent)?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g),
        ].map((match) => match[2]);
        for (const name of declared) {
          expect(
            titles.some((title) =>
              new RegExp(`\\b${name.replaceAll(/\W/g, '\\$&')}\\b`).test(title)
            ),
            `${example.name}'s entry declares the positional ${name} and no test in ${relative(root, test)} is titled with it: add one that runs the entry with ${name} and waits for it on screen`
          ).toBe(true);
        }
        if (example.unbuilt !== undefined) {
          expect(text, 'the entry test spawns the unbuilt entry too').toContain(
            basename(example.unbuilt)
          );
        }
      });

      it.skipIf(!example.roots.some((file) => file.endsWith('.tsx')))(
        'should name sigil as its JSX import source, because the build will not check',
        () => {
          // `sigil build` overrides `jsxImportSource` on purpose, so a wrong line
          // builds; the build's own `tsc` (TS2875) stops some wrong sources, but not
          // one that resolves with an untyped JSX runtime, so this read is the check. The in-process mount does honour the tsconfig, but vitest caches
          // a transform by the module's content and not by the tsconfig, so a warm
          // cache hides an edit to the line (SIG-312). Read from the file, so
          // nothing cached can answer for it
          const options = tsconfigOptions(example.dir);
          expect(options, 'a JSX example has a tsconfig.json').toBeDefined();
          expect(options?.jsxImportSource, 'compilerOptions.jsxImportSource').toBe(
            '@ttylabs/sigil'
          );
          expect(['react-jsx', 'react-jsxdev'], 'compilerOptions.jsx').toContain(options?.jsx);
        }
      );

      for (const file of example.roots) {
        it(`should export App, taking no props, and its stylesheet: ${basename(file)}`, async () => {
          // the app is reached through `useApp()`, so a root that still takes
          // props is one somebody has to remember to wire, and `runApp()` will
          // not
          expect(loaded.has(file), 'the beforeAll() imported the root, not this test').toBe(true);
          const rootModule = await load(file);
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
      const built = bin === undefined ? undefined : join(example.dir, bin);
      // the entries a person runs, built and unbuilt
      const entries: { file: string; label: string }[] = [];
      if (bin !== undefined && built !== undefined) {
        entries.push({ file: built, label: bin });
      }
      if (example.unbuilt !== undefined) {
        entries.push({ file: example.unbuilt, label: basename(example.unbuilt) });
      }

      if (bin !== undefined && built !== undefined) {
        it.concurrent(`should refuse to run ${bin} piped`, async () => {
          // `pnpm test` builds every example that has a build before vitest
          // starts, and `the root build filter` fails if one is left out -- so
          // a missing bundle here means vitest was run on its own, which is
          // what `pnpm --filter @ttylabs/cli test` does. Its message names
          // the build to run and where, because `pnpm build` from this
          // package builds the toolchain and not the example. Whether a
          // bundle that *is* there is current is not asked by modification
          // time, because that answer is wrong: a cache hit leaves `dist/`
          // untouched, so a source file touched and put back is newer than a
          // bundle that is exactly right. `examples/AGENTS.md` has the
          // measurement
          expect(existsSync(built), missing(example, bin)).toBe(true);
          refused(await run(built, example.dir));
        }, 45_000);
      }

      if (example.unbuilt !== undefined) {
        const unbuilt = example.unbuilt;

        it.concurrent(`should refuse to run ${basename(unbuilt)} piped, with nothing built`, async () => {
          refused(await run(unbuilt, example.dir));
        }, 45_000);
      }

      for (const { file, label } of entries) {
        it.concurrent(`should draw, take a key and quit on q over a terminal stdin: ${label}`, async () => {
          // the whole process, which the in-process half cannot be: the entry's
          // own schema and `main()`, the real capability queries going out
          // unanswered, and a stdin that claims to be a terminal with `q` written
          // to it. `waitFor()` is what the first frame costs, and it is a read of
          // the child's screen rather than a timer -- a `q` written before the
          // first frame is a key no row has seen
          if (file === built) {
            expect(existsSync(file), missing(example, label)).toBe(true);
          }
          const running = runOnTerminal({
            columns: COLUMNS,
            cwd: dirname(file),
            rows: ROWS,
            run: file,
            stdin: true,
          });

          try {
            await running.waitFor(/\S/);
            // a key that changes the screen, waited on rather than forced: this
            // is the app's own frame clock, the one thing `frame()` skips
            const keyed = KEYED[example.name];
            if (keyed !== undefined) {
              await running.press(...keyed.keys);
              await running.waitFor(keyed.shows);
            }
            await running.press('q');
            const ran = await running;

            expect(`${ran.out}${ran.err}`, 'a stack reached the output').not.toMatch(STACK);
            expect(ran.err, 'nothing on stderr').toBe('');
            expect(ran.code, 'q quits with 0').toBe(0);
            expect(running.screen.alternate, 'the alternate screen was left').toBe(false);
            expect(running.screen.cursorHidden, 'the cursor was shown again').toBe(false);
          } finally {
            // a wait or an assertion that failed above leaves the child running
            // until the run's own timeout, 30 seconds of a process nobody is
            // reading. Safe after it has exited
            running.kill();
          }
        }, 45_000);

        it.concurrent(`should print the package version for --version: ${label}`, async () => {
          // `sigil build` bakes the manifest's version into the bin, and the
          // unbuilt entry has no build to do that for it, so it reads the
          // manifest itself -- otherwise `--version` is an option nobody
          // declared, and the app runs instead of answering. Run from the
          // entry's own directory, where there is no manifest, so that one
          // read from the working directory rather than beside the file fails
          // here instead of passing because the test stood in the right place
          if (file === built) {
            expect(existsSync(file), missing(example, label)).toBe(true);
          }
          const ran = await run(file, dirname(file), ['--version']);
          expect(`${ran.stdout}${ran.stderr}`, 'a stack reached the output').not.toMatch(STACK);
          expect(ran.stderr).toBe('');
          expect(ran.stdout).toBe(`${example.manifest.version}\n`);
          expect(ran.code).toBe(0);
        }, 45_000);
      }
    });
  }
});
