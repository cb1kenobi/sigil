import {
  commandNameProblem,
  runScript,
  scaffold,
  type Language,
  type Layout,
  type ScaffoldOptions,
  type Syntax,
  type Tui,
} from '../src/scaffold/index.ts';
import { installSigil } from './installed-sigil.ts';
import { OWN_SUITE } from './own-suite.ts';
import { REMOVAL_TIMEOUT, removeTempDir, tempDir } from './temp.ts';
import { ttyPreload, typeKeys } from './tty-child.ts';
import { whichSync } from '@ttylabs/sigil/which';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, type TestContext } from 'vitest';

/**
 * `sigil new` with a full-screen app (SIG-279).
 *
 * Four things are checked, and the order is cheapest first:
 *
 * - **the scaffold**, as text: what is written for each placement and syntax,
 *   and the claims the files make that can be read without running them;
 * - **the command**, spawned with `--yes`: the flags, and the combinations of
 *   them that are refused;
 * - **the questions**, spawned on a faked terminal, since a vitest worker's
 *   streams are pipes and the one case a prompt cannot be reached is a pipe;
 * - **every variant, built and run**: the placements, the syntaxes and the two
 *   languages, each scaffolded into a directory with the packages linked in,
 *   built with `sigil build`, run piped, and its own test suite run. This is
 *   the half that is not a claim about text, and it is the one that found the
 *   scaffolded app's layout was wrong the first time it was drawn.
 *
 * Nothing here installs: a directory that links the packages this one resolves,
 * with `@ttylabs/sigil` copied under a `node_modules` the way a publish ships it,
 * is the app a package manager would have made, minus a network.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/sigil.ts');
const require = createRequire(import.meta.url);

const OPTIONS: ScaffoldOptions = {
  language: 'ts',
  layout: 'multi',
  linter: 'none',
  manager: 'pnpm',
  name: 'demo',
  version: '0.0.1',
  versions: { '@types/node': '26.6.2', typescript: '7.0.2', vitest: '5.0.3' },
};

/** The scaffold as a map of path to contents. */
function files(overrides: Partial<ScaffoldOptions> = {}): Map<string, string> {
  return new Map(scaffold({ ...OPTIONS, ...overrides }).map((file) => [file.path, file.contents]));
}

/** One file, or a failure naming what was written instead. */
function file(map: Map<string, string>, path: string): string {
  const contents = map.get(path);
  if (contents === undefined) {
    throw new Error(`${path} was not written; there is ${[...map.keys()].join(', ')}`);
  }
  return contents;
}

/** Every placement a TUI can have, with the layout it needs. */
const PLACEMENTS: readonly { layout: Layout; name: string; tui: Tui }[] = [
  { layout: 'single', name: 'single, at the app', tui: { at: 'root' } },
  { layout: 'multi', name: 'several, at the app', tui: { at: 'root' } },
  { layout: 'multi', name: 'several, at a command', tui: { at: 'command', command: 'ops' } },
];

const SYNTAXES: readonly Syntax[] = ['jsx', 'ui'];
const LANGUAGES: readonly Language[] = ['ts', 'js'];

/** What the component is called on disk for a syntax and a language. */
const COMPONENT: Record<Syntax, Record<Language, string>> = {
  jsx: { js: 'src/ui/app.jsx', ts: 'src/ui/app.tsx' },
  ui: { js: 'src/ui/app.js', ts: 'src/ui/app.ts' },
};

describe('a scaffold with a full-screen app', () => {
  it('should write no full-screen app unless one was asked for', () => {
    const map = files();

    expect([...map.keys()].filter((path) => path.startsWith('src/ui/'))).toEqual([]);
    expect(map.has('test/tui.test.ts')).toBe(false);
    expect(file(map, 'package.json')).toContain('"dev": "node dev.ts"');
    // and the entry is exactly what it was: nothing launches anything
    expect(file(map, 'src/index.ts')).not.toContain('runApp');
  });

  describe.each(PLACEMENTS)('$name', ({ layout, tui }) => {
    it.each(SYNTAXES.flatMap((syntax) => LANGUAGES.map((language) => [syntax, language] as const)))(
      'should write the component and its test for %s in %s',
      (syntax, language) => {
        const map = files({ language, layout, syntax, tui });
        const e = language === 'ts' ? 'ts' : 'js';

        // in `src/ui/`, which is a place no route is read from: `.tsx` is not a route extension
        expect(map.has(COMPONENT[syntax][language])).toBe(true);
        expect([...map.keys()].filter((path) => path.startsWith('src/commands/')).sort()).toEqual(
          layout === 'single'
            ? []
            : tui.at === 'command'
              ? [`src/commands/hello.${e}`, `src/commands/ops.${e}`]
              : [`src/commands/hello.${e}`]
        );
        expect(map.has(`test/tui.test.${e}`)).toBe(true);
      }
    );

    it('should load the component from inside run, and never at the top of the module', () => {
      // the point of a lazy command tree: `demo login` has nothing to draw, so a
      // static import would pay for the renderer there for nothing
      const launcher = tui.at === 'root' ? 'src/index.ts' : 'src/commands/ops.ts';
      const source = file(files({ layout, syntax: 'ui', tui }), launcher);

      expect(source).not.toMatch(/^import /m);
      expect(source).toMatch(
        /async run\(\): Promise<void> \{[\s\S]*?await import\('@ttylabs\/sigil\/app'\)/
      );
      expect(source).toContain(
        tui.at === 'root' ? "await import('./ui/app.ts')" : "await import('../ui/app.ts')"
      );
    });

    it('should name the component file as it is, which is what Node can load unbuilt', () => {
      // a `.js` specifier builds -- see `should resolve a .js specifier to the
      // .tsx` below -- but the `ui` scaffold runs with no build at all, and Node
      // does not map `app.js` to the `app.ts` that is there
      const launcher = tui.at === 'root' ? 'src/index.' : 'src/commands/ops.';

      for (const [syntax, language, specifier] of [
        ['jsx', 'ts', 'app.tsx'],
        ['jsx', 'js', 'app.jsx'],
        ['ui', 'ts', 'app.ts'],
        ['ui', 'js', 'app.js'],
      ] as const) {
        const e = language === 'ts' ? 'ts' : 'js';
        const source = file(files({ language, layout, syntax, tui }), `${launcher}${e}`);

        expect(source).toContain(`ui/${specifier}')`);
      }
    });

    it('should leave the example command alone', () => {
      if (layout === 'single') {
        return;
      }
      expect(file(files({ layout, tui }), 'src/commands/hello.ts')).toContain('Say hello');
    });
  });

  it('should make the root the command when the app is launched from it, and leave help to a command', () => {
    // the schema's `run` is what the app does when argv named no command, which
    // is how a root TUI works at all -- see "main() dispatches a run on the schema"
    const root = file(files({ tui: { at: 'root' } }), 'src/index.ts');
    expect(root).toContain('async run()');
    expect(root).toContain("commands: './commands'");

    const command = file(files({ tui: { at: 'command', command: 'ops' } }), 'src/index.ts');
    expect(command).not.toContain('run()');
    expect(command).not.toContain('runApp');
    expect(
      file(files({ tui: { at: 'command', command: 'ops' } }), 'src/commands/ops.ts')
    ).toContain('runApp');
  });

  it('should leave a single-command app that is the screen with nothing else to do', () => {
    // a root `run` that opened the screen and also took a `who` would be two
    // programs behind one name
    const entry = file(files({ layout: 'single', tui: { at: 'root' } }), 'src/index.ts');

    expect(entry).not.toContain('args');
    expect(entry).not.toContain('hello');
    expect(
      file(files({ layout: 'single', tui: { at: 'root' } }), 'test/app.test.ts')
    ).not.toContain('greets');
  });

  it('should refuse a command placement in a single-command app', () => {
    expect(() => files({ layout: 'single', tui: { at: 'command', command: 'ops' } })).toThrow(
      'no commands to launch'
    );
  });

  describe('a JSX app, which has to be built to run', () => {
    it.each(LANGUAGES)('should build and then run the bundle for dev, in %s', (language) => {
      const manifest = JSON.parse(
        file(files({ language, syntax: 'jsx', tui: { at: 'root' } }), 'package.json')
      ) as { scripts: Record<string, string> };

      // `--quiet` because the size tables are ~25 lines before every run of the app
      expect(manifest.scripts.dev).toBe('sigil build --quiet && node dist/demo.mjs');
    });

    it.each(LANGUAGES)(
      'should write no dev runner, which could not start it, in %s',
      (language) => {
        const map = files({ language, syntax: 'jsx', tui: { at: 'root' } });

        expect(map.has('dev.ts')).toBe(false);
        expect(map.has('dev.js')).toBe(false);
      }
    );

    it('should leave the dev runner out of what tsc checks', () => {
      const tsconfig = JSON.parse(
        file(files({ syntax: 'jsx', tui: { at: 'root' } }), 'tsconfig.json')
      ) as { include: string[] };

      expect(tsconfig.include).toEqual(['src', 'test', 'vitest.config.ts']);
    });

    it('should tell a JavaScript app where its JSX comes from, which it has no tsconfig to say', () => {
      // measured: without this a `.jsx` under vitest is a `react/jsx-runtime`
      // import that is not there. A TypeScript app says it in `tsconfig.json`
      const config = file(
        files({ language: 'js', syntax: 'jsx', tui: { at: 'root' } }),
        'vitest.config.js'
      );
      expect(config).toContain("importSource: '@ttylabs/sigil'");

      expect(
        file(files({ language: 'ts', syntax: 'jsx', tui: { at: 'root' } }), 'vitest.config.ts')
      ).not.toContain('importSource');
      expect(
        file(files({ language: 'js', syntax: 'ui', tui: { at: 'root' } }), 'vitest.config.js')
      ).not.toContain('importSource');
    });

    it('should take JSX when no syntax is named', () => {
      expect(files({ tui: { at: 'root' } }).has('src/ui/app.tsx')).toBe(true);
    });
  });

  describe('a ui-tag app, which runs as it is', () => {
    it.each(LANGUAGES)('should keep the dev runner and run it with node, in %s', (language) => {
      const e = language === 'ts' ? 'ts' : 'js';
      const map = files({ language, syntax: 'ui', tui: { at: 'root' } });
      const manifest = JSON.parse(file(map, 'package.json')) as { scripts: Record<string, string> };

      expect(manifest.scripts.dev).toBe(`node dev.${e}`);
      expect(map.has(`dev.${e}`)).toBe(true);
    });

    it('should not import a .tsx anywhere, because Node cannot load one', () => {
      // the first version of the `ui` twin in `examples/hello` imported its data
      // from the `.tsx`, which is the whole of why that example has a `common.ts`
      for (const [path, contents] of files({ syntax: 'ui', tui: { at: 'root' } })) {
        if (path.startsWith('src/') || path.startsWith('dev.')) {
          expect(contents, path).not.toMatch(/\.[jt]sx'/);
        }
      }
    });
  });

  describe('the component', () => {
    it.each(SYNTAXES)('should be a small tour, in %s', (syntax) => {
      const source = file(files({ syntax, tui: { at: 'root' } }), COMPONENT[syntax].ts);

      // what the ticket asked it to show, each by its own name: the runner, a
      // panel round the list, an `onKey` prop, the footer, the app's name
      expect(source).toContain("from '@ttylabs/sigil/app'");
      expect(source).toContain("from '@ttylabs/sigil/components/panel'");
      expect(source).toContain("from '@ttylabs/sigil/components/key-help'");
      expect(source).toContain('onKey=');
      expect(source).toContain("const NAME = 'demo'");
      expect(source).toContain('keyHelp(input');
    });

    it('should import each component from its own subpath and never the barrel', () => {
      for (const syntax of SYNTAXES) {
        const source = file(files({ syntax, tui: { at: 'root' } }), COMPONENT[syntax].ts);

        expect(source).not.toMatch(/from '@ttylabs\/sigil\/components'/);
        expect(source).not.toMatch(/from '@ttylabs\/sigil'/);
      }
    });

    it.each(SYNTAXES.flatMap((syntax) => LANGUAGES.map((language) => [syntax, language] as const)))(
      'should hand the resize listener to the owner, which stops it, in %s in %s',
      (syntax, language) => {
        // `onResize()` returns the unsubscribe and an author copies this file into a
        // component that mounts and unmounts, so it is given to `onCleanup()` rather
        // than dropped. There is no cheap observable: a disposed router stops
        // dispatching whether or not the handler was taken off, so a test cannot
        // see a leaked one, and the generated text is what is pinned, as it is for
        // the stdin pin
        const source = file(
          files({ language, syntax, tui: { at: 'root' } }),
          COMPONENT[syntax][language]
        );

        expect(source).toContain('onCleanup(input.onResize(');
        expect(source).toContain("import { onCleanup, onMount } from '@ttylabs/sigil/renderer';");
      }
    );

    it('should not put a quit key on the app, which runApp() already has', () => {
      for (const syntax of SYNTAXES) {
        const source = file(files({ syntax, tui: { at: 'root' } }), COMPONENT[syntax].ts);

        expect(source).not.toContain("bind('q'");
        expect(source).not.toContain('app.exit');
      }
    });
  });

  describe('its test', () => {
    it('should drive the app over a test terminal and assert on text', () => {
      const test = file(files({ tui: { at: 'root' } }), 'test/tui.test.ts');

      expect(test).toContain('createTestTerminal');
      expect(test).toContain("from '@ttylabs/sigil/app'");
      expect(test).toContain("press('q')");
      expect(test).toContain('toBe(0)');
      expect(test).toContain('toBe(130)');
    });

    it('should pin the one thing the refusal depends on, rather than trusting the runner', () => {
      // a runner that hands its own terminal down would open the real app and wait
      // for a key. Measured on a pty: pinned it refuses, unpinned it hangs. A vitest
      // worker's streams are always pipes, so nothing in the suite can show the
      // difference, and the source is what is pinned
      const test = file(files({ tui: { at: 'root' } }), 'test/tui.test.ts');

      expect(test).toContain("Object.defineProperty(process.stdin, 'isTTY'");
      expect(test).toContain("Reflect.deleteProperty(process.stdin, 'isTTY')");
    });

    it('should assert on no border character, which an ASCII terminal does not draw', () => {
      // a panel draws ASCII where `unicodeSupported()` is false, which is every
      // Windows CI runner, so a box-drawing character in an assertion passes on
      // the machine it was written on and nowhere else
      for (const [path, contents] of files({ tui: { at: 'root' } })) {
        if (path.startsWith('test/')) {
          expect(contents, path).not.toMatch(/[─│╭╮╯╰┌┐└┘]/);
        }
      }
    });

    it.each(
      PLACEMENTS.flatMap(({ layout, name, tui }) =>
        SYNTAXES.flatMap((syntax) =>
          LANGUAGES.map((language) => ({ language, layout, name, syntax, tui }))
        )
      )
    )(
      "should hand runCommand() the test's own import only for JSX behind a command: $name, $syntax, $language",
      ({ language, layout, syntax, tui }) => {
        // `main()` imports a command module with node's `import()`, which refused
        // the `.tsx` the command imports, so the installed app failed its own
        // test (SIG-431). Everywhere else node's import already works, and an
        // option that changes nothing is one more line for the author to wonder at
        const test = file(files({ language, layout, syntax, tui }), `test/tui.test.${language}`);

        expect(test.includes('importModule: (url) => import(url)')).toBe(
          tui.at === 'command' && syntax === 'jsx'
        );
      }
    );

    it('should open the right command in the refusal test', () => {
      expect(file(files({ tui: { at: 'root' } }), 'test/tui.test.ts')).toContain('argv: []');
      expect(file(files({ tui: { at: 'command', command: 'ops' } }), 'test/tui.test.ts')).toContain(
        "argv: ['ops']"
      );
    });
  });

  describe('the README', () => {
    it('should say how to open it, and what builds it', () => {
      const root = file(files({ tui: { at: 'root' } }), 'README.md');
      expect(root).toContain('pnpm run dev   # opens the full-screen app');
      expect(root).toContain('built');

      const command = file(files({ tui: { at: 'command', command: 'ops' } }), 'README.md');
      // spelled the way the app's own manager takes arguments: pnpm has no `--`
      expect(command).toContain('pnpm run dev ops   # opens');
      expect(
        file(files({ manager: 'npm', tui: { at: 'command', command: 'ops' } }), 'README.md')
      ).toContain('npm run dev -- ops   # opens');

      // wrapped where the README wraps, which is not what is being asserted
      expect(
        file(files({ syntax: 'ui', tui: { at: 'root' } }), 'README.md').replace(/\s+/g, ' ')
      ).toContain('there is nothing to build');
    });

    it.each(['pnpm', 'npm', 'vlt'] as const)(
      'should say how to build with the manager the app was set up with, %s',
      (manager) => {
        // it said `npm run build` under every manager, in the one file that tells a
        // reader which manager to use
        const readme = file(files({ manager }), 'README.md');

        expect(readme).toContain(`\`${manager} run build\` bundles it into`);
        // `pnpm run build` holds `npm run build`, hence the look-behind
        expect(readme).not.toMatch(
          manager === 'npm' ? /pnpm run build|vlt run build/ : /(?<!p)npm run build/
        );
      }
    );

    it.each(SYNTAXES)(
      'should call the ui syntax the Sigil UI template, not the tag, in %s',
      (syntax) => {
        // the README and the component's header are read by somebody choosing
        // between two syntaxes who has not met the `ui` function; the tag is named in
        // brackets for the one who has
        const map = files({ syntax, tui: { at: 'root' } });
        const normalized = (path: string): string => file(map, path).replace(/\s+/g, ' ');

        expect(normalized('README.md')).toContain('Sigil UI template (the `ui` tag)');
        expect(normalized(COMPONENT[syntax].ts)).toContain('Sigil UI template (the `ui` tag)');
      }
    );

    it('should name only files the scaffold writes', () => {
      for (const syntax of SYNTAXES) {
        const map = files({ syntax, tui: { at: 'root' } });
        const readme = file(map, 'README.md');
        const tree = /```\n(src\/index[\s\S]*?)```/.exec(readme)?.[1] ?? '';

        for (const line of tree.split('\n').filter(Boolean)) {
          const path = line.split(/\s+/)[0] as string;
          expect(
            [...map.keys()].some((written) => written === path || written.startsWith(path)),
            `${syntax}: README lists ${path}`
          ).toBe(true);
        }
      }
    });
  });
});

describe('a command name', () => {
  it.each([
    ['', 'required'],
    ['Ops', 'lowercase'],
    ['my cmd', 'lowercase'],
    ['9lives', 'start with a letter'],
    ['hello', 'example command'],
    ['index', 'directory'],
    ['help', 'describing its commands'],
    ['completion', 'shell completion'],
    ['a/b', 'lowercase'],
  ])('should refuse %j', (name, because) => {
    expect(commandNameProblem(name)).toContain(because);
  });

  it.each(['dashboard', 'ops', 'my-app', 'a1'])('should take %s', (name) => {
    expect(commandNameProblem(name)).toBeUndefined();
  });
});

/** Runs `sigil new` in `dir`, piped. */
function run(dir: string, ...argv: string[]) {
  return spawnSync(process.execPath, [cli, 'new', ...argv, '--no-install', '--no-git'], {
    cwd: dir,
    encoding: 'utf-8',
  });
}

describe('the flags', () => {
  it('should write no full-screen app under --yes alone', () => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes').status).toBe(0);

    expect(existsSync(join(dir, 'demo', 'src', 'ui'))).toBe(false);
  });

  it('should put it on the root with --tui, in JSX', () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--tui', '--pm', 'npm');

    expect(ran.status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.tsx'))).toBe(true);
    expect(readFileSync(join(dir, 'demo', 'src', 'index.ts'), 'utf-8')).toContain('runApp');
    expect(ran.stdout).toContain('  npm run dev\n');
  });

  it('should put it on a command with --tui-command, and imply --tui', () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--tui-command', 'ops', '--pm', 'npm');

    expect(ran.status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'ops.ts'))).toBe(true);
    // the root is the one that is not the app: it shows help
    expect(readFileSync(join(dir, 'demo', 'src', 'index.ts'), 'utf-8')).not.toContain('runApp');
    expect(ran.stdout).toContain('  npm run dev -- ops\n');
  });

  it('should write the ui tag with --syntax ui, and say nothing about the alternative', () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--tui', '--syntax', 'ui');

    expect(ran.status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.ts'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'dev.ts'))).toBe(true);
    // the summary line is for somebody who was given JSX, which is the one who
    // has a build to avoid
    expect(ran.stdout).not.toContain('build-free');
  });

  it('should say once, after the steps, that the ui tag is the build-free alternative', () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--tui', '--pm', 'npm');

    expect(ran.stdout).toContain('The Sigil UI template is the build-free alternative');
    expect(ran.stdout.match(/build-free/g)).toHaveLength(1);
    expect(ran.stdout.indexOf('build-free')).toBeGreaterThan(
      ran.stdout.indexOf('npm run dev -- --help')
    );
    // and not when there is no app to have a syntax
    expect(run(tempDir('sigil-new-tui-'), 'demo', '--yes').stdout).not.toContain('build-free');
  });

  it.each([
    { flags: ['--lang', 'ts'], language: 'ts', what: 'with --lang ts' },
    { flags: [], language: 'ts', what: 'under --yes alone' },
    { flags: ['--lang', 'js'], language: 'js', what: 'with --lang js' },
  ])('should write $language $what', ({ flags, language }) => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', ...flags).status).toBe(0);

    expect(existsSync(join(dir, 'demo', 'src', `index.${language}`))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'tsconfig.json'))).toBe(language === 'ts');
  });

  it('should refuse a --lang it does not know, before the first question', () => {
    // no name and no --yes: the name would be asked first if the value were not
    // judged on the way in, and the run would end at "Cannot prompt"
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, '--lang', 'py');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('py');
    expect(ran.stderr).not.toContain('Cannot prompt');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    { flag: ['--js'], what: '--js', said: 'Unknown option "--js"' },
    { flag: ['--js=true'], what: '--js=true', said: 'Unknown option "--js"' },
    {
      flag: ['--lint', 'eslint'],
      what: '--lint eslint',
      said: 'Unknown option "--lint". Did you mean "--linter"?',
    },
    {
      flag: ['--lint=eslint'],
      what: '--lint=eslint',
      said: 'Unknown option "--lint". Did you mean "--linter"?',
    },
    { flag: ['--single'], what: '--single', said: 'Unknown option "--single"' },
  ])('should refuse the removed $what, naming it', ({ flag, said }) => {
    // `--js`, `--lint` and `--single` were renamed, and for as long as the toolchain
    // took an undeclared option as a value a script that still said one got the
    // default: exit 0, an app, and nothing said. Now it is refused, with nothing
    // written, and where the parser can name what was meant it does
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', ...flag);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain(said);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('should refuse it in the built executable too, which is the one that ships', () => {
    // the built toolchain is generated: it calls `main({ schema })` and never reaches
    // `run()`, so a setting passed there refused from source and nowhere that ships.
    // Measured before it was fixed: `dist/sigil.mjs build --outt x` ran on to
    // "No package.json", having taken `--outt` as a value
    const dir = tempDir('sigil-new-tui-');
    const ran = spawnSync(
      process.execPath,
      [resolve(here, '../dist/sigil.mjs'), 'build', '--outt', 'x'],
      {
        cwd: dir,
        encoding: 'utf-8',
      }
    );

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('Unknown option "--outt". Did you mean "--out"?');
  });

  it('should refuse a typo on another command too, which is the rule now', () => {
    // the refusal is the toolchain's and not `new`'s: `build` is not a command
    // this change touched
    const dir = tempDir('sigil-new-tui-');
    const ran = spawnSync(process.execPath, [cli, 'build', '--outt', 'x'], {
      cwd: dir,
      encoding: 'utf-8',
    });

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('Unknown option "--outt". Did you mean "--out"?');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    { config: '.oxlintrc.json', linter: 'oxlint' },
    { config: 'eslint.config.js', linter: 'eslint' },
    { config: 'biome.json', linter: 'biome' },
  ])('should set up $linter with --linter $linter, and write $config', ({ config, linter }) => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', '--linter', linter).status).toBe(0);

    expect(existsSync(join(dir, 'demo', config))).toBe(true);
  });

  it('should set up no linter with --linter none', () => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', '--linter', 'none').status).toBe(0);

    for (const config of ['.oxlintrc.json', 'eslint.config.js', 'biome.json']) {
      expect(existsSync(join(dir, 'demo', config)), config).toBe(false);
    }
  });

  it('should refuse a --linter it does not know, before the first question', () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, '--linter', 'tslint');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('tslint');
    expect(ran.stderr).not.toContain('Cannot prompt');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('should refuse --tui-command with --layout single, and say what to pass', () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--layout', 'single', '--tui-command', 'ops');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('--tui-command');
    expect(ran.stderr).toContain('--layout single');
    expect(ran.stderr).toContain('Use --layout multi, or --tui');
    // and wrote nothing, which is what refusing before the questions is for
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });

  it('should take --layout multi with --tui-command, which says what it already implies', () => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', '--layout', 'multi', '--tui-command', 'ops').status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'ops.ts'))).toBe(true);
  });

  it('should take --tui with --layout single, which is the app itself', () => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', '--layout', 'single', '--tui').status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'commands'))).toBe(false);
  });

  it.each([
    { layout: 'single', commands: false },
    { layout: 'multi', commands: true },
  ])('should write $layout with --layout $layout', ({ commands, layout }) => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', '--layout', layout).status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'commands'))).toBe(commands);
  });

  it('should refuse a --layout it does not know, before the first question', () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, '--layout', 'both');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('both');
    expect(ran.stderr).not.toContain('Cannot prompt');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['hello', 'example command'],
    ['Ops', 'lowercase'],
    ['index', 'directory'],
    ['help', 'describing its commands'],
    ['completion', 'shell completion'],
  ])('should refuse --tui-command %s', (name, because) => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--tui-command', name);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain(because);
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });

  it('should refuse --tui-command with no name, as every option that takes a value does', () => {
    const ran = run(tempDir('sigil-new-tui-'), 'demo', '--yes', '--tui-command');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('--tui-command');
  });

  it('should refuse a syntax it does not know', () => {
    const ran = run(tempDir('sigil-new-tui-'), 'demo', '--yes', '--tui', '--syntax', 'vue');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('vue');
  });

  it('should refuse --syntax where there is no app for it to apply to', () => {
    // accepted and ignored is how a typo becomes an app that is not what was asked for
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--syntax', 'ui');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('--syntax');
    expect(ran.stderr).toContain('Add --tui');
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });

  it('should take --syntax beside either TUI flag', () => {
    for (const flag of [['--tui'], ['--tui-command', 'ops']]) {
      const dir = tempDir('sigil-new-tui-');
      expect(run(dir, 'demo', '--yes', ...flag, '--syntax', 'ui').status).toBe(0);
      expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.ts'))).toBe(true);
    }
  });

  it.each([
    ['a file', '', 'is a file, so a project cannot be created there'],
    ['somewhere under a file', 'below', 'is a file, so a project cannot be created in'],
  ])('should refuse a --cwd that is %s, before the first question', (_what, below, because) => {
    // it passed every check and failed at the first mkdir with the system's
    // `ENOTDIR: not a directory`, after every question had been answered
    const dir = tempDir('sigil-new-tui-');
    writeFileSync(join(dir, 'afile'), 'not a directory');
    const ran = run(dir, 'demo', '--yes', '--cwd', below ? join('afile', below) : 'afile');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain(because);
    expect(ran.stderr).not.toContain('ENOTDIR');
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });

  it('should list the four flags in its own help', () => {
    const help = run(tempDir('sigil-new-tui-'), '--help').stdout;

    expect(help).toContain('--tui');
    expect(help).toContain('--no-tui');
    expect(help).toContain('--tui-command');
    expect(help).toContain('--syntax');
    expect(help).toContain('Sigil UI template');
  });

  it('should refuse --tui with --tui-command, which would otherwise be a flag that does nothing', () => {
    // the command used to win silently, and an accepted flag that changes nothing
    // is what every refusal in this command exists to prevent
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--tui', '--tui-command', 'ops');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('--tui');
    expect(ran.stderr).toContain('Pass one of them');
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });

  it('should refuse a bad --tui-command before it asks for a name', () => {
    // no name, no --yes, and no terminal: the name question would be refused with
    // "Cannot prompt", so reaching the flag's own message is the proof the flags
    // are checked first
    const ran = run(tempDir('sigil-new-tui-'), '--tui-command', 'Ops');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('lowercase');
    expect(ran.stderr).not.toContain('Cannot prompt');
  });

  it('should take --no-tui, which is how a script passes every flag but --yes', () => {
    // this exact invocation worked before the question existed, and without a
    // flag to answer it with, a script written then would have broken
    const dir = tempDir('sigil-new-tui-');
    const ran = run(
      dir,
      'demo',
      '--lang',
      'js',
      '--layout',
      'single',
      '--linter',
      'none',
      '--pm',
      'npm',
      '--no-tui'
    );

    expect(ran.status, ran.stderr).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'ui'))).toBe(false);
  });

  it('should leave --tui an ordinary flag beside --no-tui', () => {
    // `--no-tui` is its own destination, so passing `--tui` alone still means it
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', '--tui', '--pm', 'npm').status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'ui'))).toBe(true);
  });

  it.each([
    ['--tui', '--tui'],
    ['--tui-command ops', '--tui-command'],
    ['--syntax ui', '--syntax'],
  ])('should refuse --no-tui with %s', (flags, named) => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', ...flags.split(' '), '--no-tui');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('--no-tui');
    expect(ran.stderr).toContain(named);
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });

  it.each([
    {
      help: '  pnpm run dev --help\n',
      launch: '  pnpm run dev ops\n',
      pm: 'pnpm',
      title: 'for pnpm, which takes a command with no `--`',
      flags: ['--tui-command', 'ops'],
    },
    {
      help: '  npm run dev -- --help\n',
      launch: '  npm run dev -- ops\n',
      pm: 'npm',
      title: 'for npm, which needs the `--`',
      flags: ['--tui-command', 'ops'],
    },
    {
      help: '  vlt run dev -- --help\n',
      launch: '  vlt run dev\n',
      pm: 'vlt',
      title: 'for vlt, with the app on the root',
      flags: ['--tui'],
    },
    {
      help: '  pnpm run dev --help\n',
      launch: undefined,
      pm: 'pnpm',
      title: 'for pnpm with no app, which has only the help line',
      flags: [],
    },
  ])('should print the steps $title', ({ flags, help, launch, pm }) => {
    // pnpm passes a `--` through to the script, so `pnpm run dev -- ops` starts
    // the app with `-- ops` and the parser refuses `ops`; npm and vlt need it
    const ran = run(tempDir('sigil-new-tui-'), 'demo', '--yes', ...flags, '--pm', pm);

    expect(ran.status, ran.stderr).toBe(0);
    if (launch) {
      expect(ran.stdout).toContain(launch);
    }
    expect(ran.stdout).toContain(help);
  });

  // what was asked for, what the summary must then print, and what the second app
  // must be. The printed command is compared with the flags it was built from and
  // not with itself: reading the answer off the output is how a dropped flag hid
  it.each([
    {
      flags: ['--tui', '--pm', 'pnpm', '--linter', 'none'],
      printed:
        'sigil new <name> --pm pnpm --linter none --lang ts --layout multi --tui --syntax ui',
      second: (app: string) => {
        expect(existsSync(join(app, 'src', 'ui', 'app.ts'))).toBe(true);
        expect(existsSync(join(app, 'src', 'commands', 'hello.ts'))).toBe(true);
        expect(readFileSync(join(app, '.github', 'workflows', 'release.yml'), 'utf-8')).toContain(
          'pnpm install --frozen-lockfile'
        );
        expect(existsSync(join(app, '.oxlintrc.json'))).toBe(false);
      },
    },
    {
      flags: ['--tui-command', 'ops', '--pm', 'npm', '--linter', 'biome'],
      printed:
        'sigil new <name> --pm npm --linter biome --lang ts --layout multi --tui-command ops --syntax ui',
      second: (app: string) => {
        expect(existsSync(join(app, 'src', 'commands', 'ops.ts'))).toBe(true);
        expect(existsSync(join(app, 'biome.json'))).toBe(true);
      },
    },
    {
      flags: ['--layout', 'single', '--tui', '--lang', 'js', '--pm', 'vlt', '--linter', 'eslint'],
      printed:
        'sigil new <name> --pm vlt --linter eslint --lang js --layout single --tui --syntax ui',
      second: (app: string) => {
        // `--lang js`: the file is `.js`, and there is no tsconfig. `--layout single`: no commands
        expect(existsSync(join(app, 'src', 'ui', 'app.js'))).toBe(true);
        expect(existsSync(join(app, 'tsconfig.json'))).toBe(false);
        expect(existsSync(join(app, 'src', 'commands'))).toBe(false);
        expect(existsSync(join(app, 'eslint.config.js'))).toBe(true);
        expect(readFileSync(join(app, '.github', 'workflows', 'release.yml'), 'utf-8')).toContain(
          'vlt install --frozen-lockfile'
        );
      },
    },
  ])('should print the other syntax for $flags as the command that makes it', (row) => {
    // `--syntax` alone is refused under --yes and asks the TUI question again
    // interactively, so a hint that said only that was not runnable
    const parent = tempDir('sigil-new-tui-');
    const first = run(parent, 'app1', '--yes', ...row.flags);
    const printed = /`(sigil new [^`]+)`/.exec(first.stdout)?.[1];

    expect(first.status, first.stderr).toBe(0);
    expect(printed).toBe(row.printed);

    // run from where it was printed, which is beside `app1` and inside it: a real
    // name there collides in the first place and nests in the second, so the name
    // is a placeholder and the second app needs one of its own
    const args = (printed as string).split(' ').slice(2);
    expect(args[0]).toBe('<name>');
    expect(readFileSync(join(parent, 'app1', 'README.md'), 'utf-8')).toContain(row.printed);

    for (const from of [parent, join(parent, 'app1')]) {
      const dir = from === parent ? parent : join(parent, 'app1');
      const again = run(dir, 'app2', '--yes', ...args.slice(1));
      expect(again.status, again.stderr).toBe(0);
      row.second(join(dir, 'app2'));
      rmSync(join(dir, 'app2'), { force: true, recursive: true });
    }
  });

  // The hint has to answer every question by itself. The test above re-runs it under
  // `--yes`, which fills in whatever the hint leaves out, so a missing flag is never
  // noticed: the multi layout printed no layout at all. Here the printed command is
  // run without `--yes` and without a terminal, where any question it leaves
  // unanswered is refused as "Cannot prompt", for every placement, syntax and language
  describe.each(
    PLACEMENTS.flatMap((placement) =>
      SYNTAXES.flatMap((syntax) =>
        LANGUAGES.map((language) => ({ ...placement, language, syntax }))
      )
    )
  )('the hint for $name, $syntax, $language', ({ language, layout, syntax, tui }) => {
    const other: Syntax = syntax === 'jsx' ? 'ui' : 'jsx';
    const flags = [
      '--lang',
      language,
      '--layout',
      layout,
      ...(tui.at === 'command' ? ['--tui-command', tui.command] : ['--tui']),
      '--syntax',
      syntax,
      '--linter',
      'biome',
      '--pm',
      'npm',
    ];

    /** What the first app printed, made once for the variant and shared by its tests. */
    let made: { args: string[]; parent: string } | undefined;

    /** The command the first app's README prints, as arguments after `sigil new <name>`. */
    function printed(): { args: string[]; parent: string } {
      if (made) {
        return made;
      }
      const parent = tempDir('sigil-new-tui-');
      const first = run(parent, 'first', '--yes', ...flags);
      expect(first.status, first.stderr).toBe(0);
      const line = /^sigil new <name> .*$/m.exec(
        readFileSync(join(parent, 'first', 'README.md'), 'utf-8')
      )?.[0];
      expect(line).toBeDefined();
      made = { args: (line as string).split(' ').slice(3), parent };
      return made;
    }

    it('should name the layout, the language and the placement, and the other syntax', () => {
      const { args } = printed();

      expect(args.join(' ')).toContain(`--lang ${language} --layout ${layout}`);
      expect(args.join(' ')).toContain(
        tui.at === 'command' ? `--tui-command ${tui.command}` : '--tui'
      );
      expect(args.slice(-2)).toEqual(['--syntax', other]);
    });

    it('should run without --yes and without a terminal, and make the same app in the other syntax', () => {
      const { args, parent } = printed();
      const again = run(parent, 'again', ...args);

      expect(again.status, again.stderr).toBe(0);
      expect(again.stderr).not.toContain('Cannot prompt');
      const e = language === 'ts' ? 'ts' : 'js';
      const component = join(
        parent,
        'again',
        'src',
        'ui',
        `app.${other === 'jsx' ? (language === 'ts' ? 'tsx' : 'jsx') : e}`
      );
      expect(existsSync(component)).toBe(true);
      expect(existsSync(join(parent, 'again', 'src', 'commands'))).toBe(layout === 'multi');
      expect(
        existsSync(
          join(
            parent,
            'again',
            'src',
            'commands',
            `${tui.at === 'command' ? tui.command : 'hello'}.${e}`
          )
        )
      ).toBe(layout === 'multi');
    });
  });

  it('should be asked nothing on a terminal either, by the command it prints', async () => {
    // the same claim on a faked terminal: a question the hint left open would be
    // printed as a prompt and wait for a key that is never typed
    const parent = tempDir('sigil-new-tui-');
    const first = run(parent, 'first', '--yes', '--tui', '--linter', 'biome', '--pm', 'npm');
    const line = /^sigil new <name> .*$/m.exec(
      readFileSync(join(parent, 'first', 'README.md'), 'utf-8')
    )?.[0];
    const args = (line as string).split(' ').slice(3);

    expect(first.status).toBe(0);
    const ran = await askWith(parent, [], ['again', ...args], 80, []);

    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).not.toMatch(/^\? /m);
    expect(existsSync(join(parent, 'again', 'package.json'))).toBe(true);
  });

  it('should show the dev script the scaffold writes, in the docs and the README', () => {
    // two prose copies of a script drifted from it once already: they said
    // `sigil build &&` after the script gained `--quiet`. Compared with what the
    // manifest holds, with the line breaks the docs wrap at taken out
    const dev = (
      JSON.parse(file(files({ name: 'myapp', tui: { at: 'root' } }), 'package.json')) as {
        scripts: Record<string, string>;
      }
    ).scripts.dev as string;
    const unwrapped = (path: string): string =>
      readFileSync(resolve(here, path), 'utf-8').replace(/\s+/g, ' ');

    expect(unwrapped('../../sigil/docs/full-screen-apps.md')).toContain(dev);
    expect(unwrapped('../README.md')).toContain(dev.replace('myapp', '<name>'));
  });

  it('should print the JSX command for an app that is written in the ui tag', () => {
    const readme = file(files({ syntax: 'ui', tui: { at: 'root' } }), 'README.md');

    expect(readme).toContain(
      'sigil new <name> --pm pnpm --linter none --lang ts --layout multi --tui --syntax jsx'
    );
  });

  it('should leave the other-syntax hint on one line, since the terminal wraps and a break at 88 does not', () => {
    const ran = run(tempDir('sigil-new-tui-'), 'demo', '--yes', '--tui');
    const note = ran.stdout.split('\n').find((line) => line.startsWith('The app is in JSX'));

    expect(note).toBeDefined();
    expect(note).toContain('build-free alternative: `sigil new <name> --pm');
  });
});

describe('a script that runs with arguments', () => {
  it.each([
    ['pnpm', 'dev', ['ops'], 'pnpm run dev ops'],
    ['npm', 'dev', ['ops'], 'npm run dev -- ops'],
    ['vlt', 'dev', ['ops'], 'vlt run dev -- ops'],
    ['pnpm', 'dev', ['--help'], 'pnpm run dev --help'],
    ['npm', 'dev', ['--help'], 'npm run dev -- --help'],
    ['vlt', 'dev', ['--help'], 'vlt run dev -- --help'],
    ['pnpm', 'dev', [], 'pnpm run dev'],
    ['npm', 'dev', [], 'npm run dev'],
    ['vlt', 'dev', [], 'vlt run dev'],
    ['npm', 'dev', ['hello', 'world'], 'npm run dev -- hello world'],
  ] as const)('should spell %s %s %j as %s', (manager, script, args, expected) => {
    expect(runScript(manager, script, ...args)).toBe(expected);
  });

  // measured rather than assumed, on every manager that is installed: the
  // spelling is a claim about what the script receives, so it is asked of the
  // script. A manager changing what it does with `--` is what this is for
  describe.each(['npm', 'pnpm', 'vlt'] as const)('%s', (manager) => {
    const installed = whichSync(manager) ? it : it.skip;
    installed.each([[['ops']], [['--help']], [['ops', '--help']]] as const)(
      'should hand %j to the script as given',
      (args) => {
        const dir = tempDir('sigil-run-script-');
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name: 'probe', scripts: { dev: 'node args.js' }, version: '0.0.0' })
        );
        writeFileSync(
          join(dir, 'args.js'),
          'console.log("ARGS" + JSON.stringify(process.argv.slice(2)));\n'
        );

        // one command string for the shell that Windows needs, since an arguments
        // array with `shell: true` is DEP0190 on Node 24 and later. The arguments
        // are plain words, so there is nothing to quote
        const command = runScript(manager, 'dev', ...args);
        const [cmd, ...argv] = command.split(' ') as [string, ...string[]];
        const ran =
          process.platform === 'win32'
            ? spawnSync(command, { cwd: dir, encoding: 'utf-8', shell: true })
            : spawnSync(cmd, argv, { cwd: dir, encoding: 'utf-8' });

        expect(ran.stderr).not.toContain('DEP0190');
        expect(/^ARGS(.*)$/m.exec(ran.stdout)?.[1], ran.stdout + ran.stderr).toBe(
          JSON.stringify(args)
        );
      }
    );
  });
});

/**
 * Runs `sigil new` on a faked terminal and types `keys` at it.
 *
 * @param dir - Where to run it.
 * @param keys - One entry per keystroke, in the order the questions come.
 * @param argv - The flags that answer the questions this is not about.
 * @returns What it printed and how it exited.
 */
function ask(
  dir: string,
  keys: readonly string[],
  ...argv: string[]
): Promise<{ code: number | null; out: string }> {
  return askWith(dir, keys, ['demo', ...argv]);
}

/**
 * `ask()` with the name left for the prompt, which is the one question the helper
 * above answers for you.
 *
 * @param dir - Where to run it.
 * @param keys - One entry per keystroke, starting with the answer to the name.
 * @param argv - The flags that answer the questions this is not about.
 * @returns What it printed and how it exited.
 */
function askName(
  dir: string,
  keys: readonly string[],
  ...argv: string[]
): Promise<{ code: number | null; out: string }> {
  return askWith(dir, keys, argv);
}

/**
 * `askName()` on a terminal of a width the test chooses.
 *
 * For a message that carries a path: it wraps at the terminal's width, so on a
 * Windows runner, whose temp directory is long, the phrase a test looks for is
 * split across two lines with padding between the halves. The words are what is
 * under test and not where they wrap, so those tests ask for a terminal too wide
 * to wrap them.
 *
 * @param columns - The width the child believes it has.
 * @param dir - Where to run it.
 * @param keys - One entry per keystroke, starting with the answer to the name.
 * @param argv - The flags that answer the questions this is not about.
 * @returns What it printed and how it exited.
 */
function askNameAt(
  columns: number,
  dir: string,
  keys: readonly string[],
  ...argv: string[]
): Promise<{ code: number | null; out: string }> {
  return askWith(dir, keys, argv, columns);
}

/** Runs `sigil new` on a faked terminal with these arguments and types these keys. */
function askWith(
  dir: string,
  keys: readonly string[],
  args: readonly string[],
  columns = 80,
  answered: readonly string[] = ['--linter', 'none', '--pm', 'npm']
): Promise<{ code: number | null; out: string }> {
  return new Promise((settle, fail) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        ttyPreload(columns),
        cli,
        'new',
        ...args,
        '--no-install',
        '--no-git',
        // the linter and the manager answered, so that the questions a test is about
        // are the only ones left -- except for a test about those
        ...answered,
      ],
      {
        cwd: dir,
        env: { ...process.env, COLUMNS: String(columns), NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => void (out += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => settle({ code, out }));
    typeKeys(child, keys);
  });
}

const ENTER = '\r';
const DOWN = '\u001B[B';
const BACKSPACE = '\u007F';

describe('the questions', () => {
  it('should ask about a full-screen app after the layout, and default to none', async () => {
    const dir = tempDir('sigil-new-tui-');
    // TypeScript yes, several commands, and then Enter on the TUI question
    const ran = await ask(dir, [ENTER, ENTER, ENTER]);

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('Include a full-screen app (TUI)?');
    expect(ran.out.indexOf('Will it have subcommands?')).toBeLessThan(
      ran.out.indexOf('Include a full-screen app (TUI)?')
    );
    // none, so neither of the questions that follow one
    expect(ran.out).not.toContain('Launch it from');
    expect(ran.out).not.toContain('Which template syntax?');
    expect(existsSync(join(dir, 'demo', 'src', 'ui'))).toBe(false);
  });

  it('should ask where, naming the app, and put it on the root by default', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER, 'y', ENTER, ENTER]);

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('Launch it from `demo`, or from a command?');
    expect(ran.out).toContain('Which template syntax?');
    expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.tsx'))).toBe(true);
    expect(readFileSync(join(dir, 'demo', 'src', 'index.ts'), 'utf-8')).toContain('runApp');
  });

  it('should ask for the command name, and offer none', async () => {
    const dir = tempDir('sigil-new-tui-');
    // a command, a name typed out, and the Sigil UI template
    const ran = await ask(dir, [ENTER, ENTER, 'y', DOWN, ENTER, 'dash', ENTER, DOWN, ENTER]);

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('What is the command called?');
    // it used to be offered as a default and a placeholder, which is a name
    // nobody chose; the user has to type one
    expect(ran.out).not.toContain('dashboard');
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'dash.ts'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.ts'))).toBe(true);
  });

  it.each([
    ['nothing', []],
    ['only spaces', [' ', ' ']],
  ])('should not submit %s for the command name, and say why', async (_what, typed) => {
    const dir = tempDir('sigil-new-tui-');
    // Enter on the empty field is refused under it and the field is still there,
    // so what follows is typed into the same prompt and submits
    const ran = await ask(dir, [
      ENTER,
      ENTER,
      'y',
      DOWN,
      ENTER,
      ...typed,
      ENTER,
      ...typed.map(() => BACKSPACE),
      'ops',
      ENTER,
      ENTER,
    ]);

    expect(ran.out).toContain('A command name is required');
    expect(ran.code, ran.out).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'ops.ts'))).toBe(true);
  });

  it('should take a name that was typed, and refuse one that is taken', async () => {
    const dir = tempDir('sigil-new-tui-');
    // `hello` is refused on Enter, so the field is still there to finish: the
    // remaining keys complete `hello` to `helloops`
    const ran = await ask(dir, [
      ENTER,
      ENTER,
      'y',
      DOWN,
      ENTER,
      'hello',
      ENTER,
      'ops',
      ENTER,
      ENTER,
    ]);

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('example command');
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'helloops.ts'))).toBe(true);
  });

  it('should not ask where for a single command, which has nowhere but itself', async () => {
    const dir = tempDir('sigil-new-tui-');
    // TypeScript yes, a single command, a full-screen app yes, and JSX
    const ran = await ask(dir, [ENTER, DOWN, ENTER, 'y', ENTER]);

    expect(ran.code).toBe(0);
    expect(ran.out).not.toContain('Launch it from');
    expect(ran.out).toContain('Which template syntax?');
    expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'src', 'commands'))).toBe(false);
  });

  it('should not ask what a flag already answered', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER], '--tui-command', 'ops', '--syntax', 'ui');

    expect(ran.code).toBe(0);
    expect(ran.out).not.toContain('Include a full-screen app');
    expect(ran.out).not.toContain('Launch it from');
    expect(ran.out).not.toContain('Which template syntax?');
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'ops.ts'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.ts'))).toBe(true);
  });

  it('should not ask where when --tui said the app itself', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER, ENTER], '--tui');

    expect(ran.code).toBe(0);
    expect(ran.out).not.toContain('Launch it from');
    expect(ran.out).toContain('Which template syntax?');
  });

  it('should refuse a --syntax that a "no" to the app leaves nothing to apply to', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER, 'n'], '--syntax', 'ui');

    expect(ran.code).not.toBe(0);
    expect(ran.out).toContain('--syntax');
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });

  it('should not submit an empty name, and say why', async () => {
    // Enter on the empty field used to submit, fail, and end the run. Now it is
    // refused under the field and the field is still there to type into
    const dir = tempDir('sigil-new-tui-');
    const ran = await askName(dir, [ENTER, 'demo', ENTER, ENTER, ENTER], '--no-tui');

    expect(ran.out).toContain('A name is required');
    // and no suggestion of what to type
    expect(ran.out).not.toContain('my-cli');
    expect(ran.code, ran.out).toBe(0);
    expect(existsSync(join(dir, 'demo', 'package.json'))).toBe(true);
  });

  it('should not submit a name made of spaces', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await askName(
      dir,
      [' ', ' ', ENTER, BACKSPACE, BACKSPACE, 'demo', ENTER, ENTER, ENTER],
      '--no-tui'
    );

    expect(ran.out).toContain('A name is required');
    expect(ran.code, ran.out).toBe(0);
    expect(existsSync(join(dir, 'demo', 'package.json'))).toBe(true);
  });

  it.each([
    ['Demo', 'lowercase', 4],
    ['a/b', 'lowercase letters', 3],
    ['.hidden', 'dot or an underscore', 7],
  ])(
    'should refuse the name %s at the prompt, and let it be corrected',
    async (typed, because, length) => {
      // the check the positional argument goes through, so the two cannot disagree
      const dir = tempDir('sigil-new-tui-');
      const ran = await askName(
        dir,
        [typed, ENTER, ...Array.from({ length }, () => BACKSPACE), 'demo', ENTER, ENTER, ENTER],
        '--no-tui'
      );

      expect(ran.out).toContain(because);
      expect(ran.code, ran.out).toBe(0);
      expect(existsSync(join(dir, 'demo', 'package.json'))).toBe(true);
    }
  );

  // A message with a path in it wraps at the terminal's width, and where the path
  // is most of a line the phrase is cut through its middle: on a Windows runner,
  // whose temp directory is about 56 columns, it came out as "already exists  and
  // is not empty" or "already  exists and...", split by the padding of a wrapped
  // line. Measured at 80 columns by sweeping the length of the path: it is split at
  // every length from 50 to 68 and whole at 72, where the path takes a line to
  // itself, so whether a test passes depends on how long the machine's temp
  // directory happens to be. A real user sees the wrap read correctly. The words
  // are what these assert and not where they wrap, so they use a terminal too wide
  // to wrap them
  const WIDE = 400;

  it('should refuse a name whose directory is taken, at the prompt', async () => {
    // knowable the moment the name is, so it can be corrected in the same field
    // and not by starting the run again
    const dir = tempDir('sigil-new-tui-');
    mkdirSync(join(dir, 'demo'));
    writeFileSync(join(dir, 'demo', 'keep.txt'), 'mine');
    const ran = await askNameAt(
      WIDE,
      dir,
      ['demo', ENTER, ...Array.from({ length: 4 }, () => BACKSPACE), 'other', ENTER, ENTER, ENTER],
      '--no-tui'
    );

    expect(ran.out).toContain('already exists and is not empty');
    expect(ran.code, ran.out).toBe(0);
    expect(existsSync(join(dir, 'other', 'package.json'))).toBe(true);
    expect(readFileSync(join(dir, 'demo', 'keep.txt'), 'utf-8')).toBe('mine');
  });

  it('should accept a name whose directory exists and is empty', async () => {
    // `git init` and then `sigil new` is an ordinary order, and the same rule the
    // argument has: only something in the way is in the way
    const dir = tempDir('sigil-new-tui-');
    mkdirSync(join(dir, 'demo'));
    const ran = await askNameAt(WIDE, dir, ['demo', ENTER, ENTER, ENTER], '--no-tui');

    expect(ran.out).not.toContain('already exists');
    expect(ran.code, ran.out).toBe(0);
    expect(existsSync(join(dir, 'demo', 'package.json'))).toBe(true);
  });

  it('should check the name against --cwd, where the project would be made', async () => {
    const dir = tempDir('sigil-new-tui-');
    const apps = join(dir, 'apps');
    mkdirSync(join(apps, 'demo'), { recursive: true });
    writeFileSync(join(apps, 'demo', 'keep.txt'), 'mine');
    const ran = await askNameAt(
      WIDE,
      dir,
      ['demo', ENTER, ...Array.from({ length: 4 }, () => BACKSPACE), 'other', ENTER, ENTER, ENTER],
      '--no-tui',
      '--cwd',
      apps
    );

    expect(ran.out).toContain('already exists and is not empty');
    expect(ran.code, ran.out).toBe(0);
    expect(existsSync(join(apps, 'other', 'package.json'))).toBe(true);
  });

  it('should open each menu on the entry --yes would have taken', async () => {
    // the defaults are one list, and the menus read their highlight from it: asked
    // interactively, the layout and syntax menus open on the entries --yes takes
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER, 'y', ENTER, ENTER], '--linter', 'none');

    expect(ran.out).toContain('❯ Yes, several commands');
    expect(ran.out).toContain('❯ JSX');

    const yes = tempDir('sigil-new-tui-');
    expect(run(yes, 'demo', '--yes', '--tui', '--linter', 'none').status).toBe(0);
    expect(existsSync(join(yes, 'demo', 'src', 'commands', 'hello.ts'))).toBe(true);
    expect(existsSync(join(yes, 'demo', 'src', 'ui', 'app.tsx'))).toBe(true);
  });

  it('should open the linter menu on oxlint, which --yes takes', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await askWith(dir, [ENTER, ENTER, ENTER], ['demo', '--no-tui'], 80, [
      '--pm',
      'npm',
    ]);

    expect(ran.out).toContain('❯ oxlint');
    expect(existsSync(join(dir, 'demo', '.oxlintrc.json'))).toBe(true);
  });

  it('should offer the Sigil UI template by that name', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER, 'y', ENTER, ENTER]);

    expect(ran.out).toContain('Which template syntax?');
    expect(ran.out).toContain('Sigil UI template');
    // a newcomer does not know what a "tag" is
    expect(ran.out).not.toContain('The ui tag');
  });

  it('should ask which language when --lang was not passed', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER], '--no-tui');

    expect(ran.out).toContain('Would you like to use TypeScript?');
    expect(existsSync(join(dir, 'demo', 'src', 'index.ts'))).toBe(true);
  });

  it.each([
    ['ts', 'index.ts'],
    ['js', 'index.js'],
  ])('should not ask which language when --lang %s answered it', async (lang, file) => {
    // a flag was `false` when absent, so "TypeScript" could not be said without
    // --yes and the question was asked of everyone who had already answered it
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER], '--lang', lang, '--no-tui');

    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).not.toContain('Would you like to use TypeScript?');
    expect(ran.out).toContain('Will it have subcommands?');
    expect(existsSync(join(dir, 'demo', 'src', file))).toBe(true);
  });

  it('should not ask whether there are subcommands when --tui-command names one', async () => {
    // a command to launch from is a command, so the question is answered. It used
    // to be asked, and "No, a single command" then failed with a guard from the
    // scaffold after every other question had been answered
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER], '--tui-command', 'dash', '--syntax', 'ui');

    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).not.toContain('Will it have subcommands?');
    expect(ran.out).not.toContain('no commands to launch');
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'dash.ts'))).toBe(true);
  });

  it('should not ask about a full-screen app after --no-tui', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER], '--no-tui');

    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).not.toContain('Include a full-screen app');
    expect(existsSync(join(dir, 'demo', 'src', 'ui'))).toBe(false);
  });

  it('should describe the choices without a "today" a new app has never had', async () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = await ask(dir, [ENTER, ENTER, 'y', ENTER, ENTER]);

    expect(ran.out).toContain('demo on its own shows help');
    expect(ran.out).not.toContain('today');
  });

  it('should refuse to ask without a terminal, as it does for every other question', () => {
    // a script that passes every flag but neither --yes nor --no-tui meets the
    // question the way it meets any other unanswered one. --no-tui is how it
    // opts out, which the flag tests above pin
    const dir = tempDir('sigil-new-tui-');
    const ran = run(
      dir,
      'demo',
      '--lang',
      'js',
      '--layout',
      'single',
      '--linter',
      'none',
      '--pm',
      'npm'
    );

    expect(ran.status).not.toBe(0);
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });
});

/** The copy of `@ttylabs/sigil` every app in this file links to, made once. */
let installed: string | undefined;

/**
 * Links the packages an app needs into it, as an install would have.
 *
 * `@ttylabs/sigil` is a link to a **copy** under a `node_modules`, made once for
 * the file, and never a link to the workspace (SIG-431). Where the runtime
 * resolves to is what decides whether vitest transforms it, and a runtime vitest
 * transformed imported a command module with vite's `import()`, which compiled
 * the `.tsx` that node's refuses -- so the two JSX apps launched from a command
 * passed here and failed once installed. A link into a `node_modules` is how
 * pnpm installs every package, so this is an install's layout, and one copy
 * rather than sixteen keeps what each test leaves for a Windows runner to remove
 * to what it left before. The other three are links to this package's own, which
 * already resolve under a `node_modules`.
 */
function link(app: string): void {
  mkdirSync(join(app, 'node_modules', '@ttylabs'), { recursive: true });
  mkdirSync(join(app, 'node_modules', '@types'), { recursive: true });
  installed ??= installSigil(join(tempDir('sigil-installed-'), 'node_modules'));
  const dirs: [string, string][] = [
    [join('@ttylabs', 'sigil'), installed],
    [join('@types', 'node'), dirname(require.resolve('@types/node/package.json'))],
    ['typescript', dirname(require.resolve('typescript/package.json'))],
    ['vitest', dirname(require.resolve('vitest/package.json'))],
  ];
  for (const [name, target] of dirs) {
    // a junction, which Windows makes without the privilege a symlink needs and
    // every other platform reads as an ordinary directory link
    symlinkSync(target, join(app, 'node_modules', name), 'junction');
  }
}

/** What running node in an app said. */
interface Ran {
  /** The exit code, or `null` for a child that was killed. */
  readonly code: number | null;
  /** stdout and stderr, interleaved as they arrived. */
  readonly out: string;
}

/** A scaffolded app, and node run inside it. */
interface App {
  /** The app's directory. */
  readonly app: string;
  /** Runs node in the app with nothing on stdin, and reads what it did. */
  readonly node: (...argv: string[]) => Promise<Ran>;
}

/**
 * Writes a scaffold into a directory, links its packages, and ties both to the
 * test that asked for it.
 *
 * The directory goes when that test finishes rather than when the file does.
 * An app is about a hundred entries once it has been built and its own suite
 * has run, every one of them new to a Windows runner's scanner, and the sixteen
 * of them were half of what this file's `afterAll` had to remove -- the hook
 * that ran past its budget on Windows (SIG-426).
 *
 * The removal waits for every child the test started to close first. A test
 * that times out does not: vitest aborts its `signal` and goes straight on to
 * `onTestFinished`, with the test's own `await` still pending. So the signal
 * ends each child's whole process tree (`spawnNode()`), and the hook waits for
 * those children before it removes anything, since one still running writes
 * its `node_modules/.vitest-cache` back into a directory already gone. A child
 * that never closes holds the hook until `REMOVAL_TIMEOUT`, which fails it and
 * leaves the directory to the file's `afterAll`.
 */
function materialize(
  opts: Partial<ScaffoldOptions>,
  { onTestFinished, signal }: Pick<TestContext, 'onTestFinished' | 'signal'>
): App {
  const app = tempDir('sigil-tui-app-');
  const children: Promise<Ran>[] = [];
  onTestFinished(async () => {
    const settled = await Promise.allSettled(children);
    await removeTempDir(app);
    // a child that failed while the test was still waiting on it has already
    // failed the test; one that failed after a timeout, ending its tree, has
    // no test left to fail but this hook
    const failed = signal.aborted
      ? settled.flatMap((each) =>
          each.status === 'rejected' && each.reason !== signal.reason ? [each.reason] : []
        )
      : [];
    if (failed.length > 0) {
      throw new AggregateError(failed, 'Could not end every child this test started');
    }
  }, REMOVAL_TIMEOUT);
  const manifest = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf-8')) as {
    devDependencies: Record<string, string>;
  };

  for (const entry of scaffold({
    ...OPTIONS,
    manager: 'npm',
    name: 'demo',
    versions: manifest.devDependencies,
    ...opts,
  })) {
    mkdirSync(dirname(join(app, entry.path)), { recursive: true });
    writeFileSync(join(app, entry.path), entry.contents);
  }
  link(app);
  return {
    app,
    node: (...argv) => {
      const ran = spawnNode(app, signal, argv);
      children.push(ran);
      return ran;
    },
  };
}

/**
 * Ends a process and everything descended from it.
 *
 * The whole tree, because ending the process alone was measured to leave its
 * descendants running: a nested `vitest run` uses forked workers, and killing
 * that vitest with SIGTERM or SIGKILL on macOS left its worker running under
 * pid 1, mid-test. Windows kills one process at a time, so it is
 * `taskkill /T`, which walks the tree by parent pid. POSIX has no such call, so
 * the tree is read from `ps` and walked here. Each process found is stopped
 * before the next look, so none of them can start another in between, and
 * only once a look finds nothing new is every one of them killed.
 *
 * A process group would be one call, and it was the first version: the child
 * spawned `detached` and the group killed. It is not used, because a detached
 * child is in no terminal's foreground group, so a Ctrl-C of the suite never
 * reached it. vitest exits on SIGINT without stopping anything it spawned, a
 * worker thread gets no signal events to clean up in, and so a nested suite
 * kept running in the app directory after the run it belonged to had ended.
 * Measured, with a nested test that waits two minutes: ten processes were
 * still running five seconds after the Ctrl-C. Spawned in the suite's own
 * group, the Ctrl-C reaches every one of them, as it did before SIG-426.
 *
 * @param pid - The process at the root of the tree.
 */
function endTree(pid: number, list: () => string = listProcesses): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
    return;
  }
  // everything stopped is killed whatever happens below, `list()` throwing
  // included: a process left stopped holds its directory and never closes
  const tried = new Set<number>();
  try {
    for (let found = [pid]; found.length > 0;) {
      for (const each of found) {
        tried.add(each);
        try {
          process.kill(each, 'SIGSTOP');
        } catch {
          // it has already gone
        }
      }
      const below = new Map<number, number[]>();
      for (const line of list().trim().split('\n')) {
        const [child, parent] = line.trim().split(/\s+/).map(Number);
        if (child !== undefined && parent !== undefined) {
          below.set(parent, [...(below.get(parent) ?? []), child]);
        }
      }
      const tree: number[] = [];
      for (const queue = [pid]; queue.length > 0;) {
        for (const child of below.get(queue.shift()!) ?? []) {
          tree.push(child);
          queue.push(child);
        }
      }
      found = tree.filter((each) => !tried.has(each));
    }
  } finally {
    for (const each of tried) {
      try {
        process.kill(each, 'SIGKILL');
      } catch {
        // it has already gone
      }
    }
  }
}

/**
 * Every process on the machine as `pid ppid` lines, from `ps`.
 *
 * A look that fails throws, naming `ps`, rather than answering with nothing: an
 * empty answer would read as a tree with no descendants, and `endTree()` would
 * kill the root alone and leave its workers running in the directory that is
 * about to be removed. Bounded, since it runs while a test is being torn down.
 *
 * @param command - What to run, which is `ps` except in the test that makes it fail.
 * @returns The listing.
 */
function listProcesses(command = 'ps'): string {
  const ran = spawnSync(command, ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8', timeout: 5000 });
  const why =
    ran.error?.message ??
    (ran.signal !== null
      ? `it was killed by ${ran.signal}`
      : ran.status !== 0
        ? `it exited ${ran.status}${ran.stderr.trim() ? `: ${ran.stderr.trim()}` : ''}`
        : ran.stdout.trim() === ''
          ? 'it listed nothing'
          : undefined);
  if (why !== undefined) {
    throw new Error(`Could not end a child's process tree, because ps failed: ${why}`, {
      cause: ran.error,
    });
  }
  return ran.stdout;
}

/**
 * Runs node in `cwd` with nothing on stdin and reads what it did, and ends the
 * child and everything it started if `signal` is aborted.
 *
 * It settles on `close` in every case, abort included: `spawn()`'s own `signal`
 * option rejects the moment the abort happens, while the child is still alive.
 *
 * @param cwd - The directory to run in.
 * @param signal - The test's, aborted when the test times out.
 * @param argv - The arguments to node.
 * @returns The exit code and what was written, or a rejection with the abort's
 *   reason once the tree has gone.
 */
function spawnNode(cwd: string, signal: AbortSignal, argv: readonly string[]): Promise<Ran> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...process.env, COLUMNS: '80', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // a failure to end the tree is what the child's promise rejects with, so
    // that `materialize()`'s hook can fail the test with it once it has closed
    let failure: unknown;
    const end = (): void => {
      if (child.pid !== undefined) {
        try {
          endTree(child.pid);
        } catch (err) {
          failure = err;
        }
      }
    };
    signal.addEventListener('abort', end, { once: true });
    if (signal.aborted) {
      end();
    }

    let out = '';
    child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => void (out += chunk.toString()));
    child.on('error', (err) => {
      signal.removeEventListener('abort', end);
      fail(err);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', end);
      if (failure !== undefined) {
        fail(failure);
      } else if (signal.aborted) {
        fail(signal.reason);
      } else {
        settle({ code, out: out.replaceAll('\r\n', '\n') });
      }
    });
  });
}

describe('ending a process tree', () => {
  /** Whether a process is still there, which a signal of 0 asks without sending one. */
  function running(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // POSIX only: Windows is `taskkill /T`, which reads no listing
  it.skipIf(process.platform === 'win32').for([
    { command: 'sigil-no-such-ps', failing: 1, why: /ENOENT/ },
    { command: 'false', failing: 2, why: /exited 1/ },
  ])(
    'should kill everything it stopped, and say ps failed, when look $failing fails ($command)',
    async ({ command, failing, why }) => {
      // a node that starts a node, says its pid, and waits: a root and a child
      const root = spawn(
        process.execPath,
        [
          '-e',
          "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);",
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const exited = new Promise<NodeJS.Signals | null>((settle) =>
        root.once('exit', (_code, signal) => settle(signal))
      );
      const child = Number(
        await new Promise<string>((settle) =>
          root.stdout.once('data', (data) => settle(String(data)))
        )
      );
      let looks = 0;

      try {
        expect(() =>
          endTree(root.pid!, () => listProcesses(++looks === failing ? command : 'ps'))
        ).toThrow(new RegExp(`because ps failed: .*${why.source}`));

        // the root is stopped before the first look, so it is killed whichever
        // look fails, and the child only once a look has found it. Raced, so a
        // root left stopped fails here and reaches the `finally` that kills it
        const late = new Promise<string>((settle) => setTimeout(() => settle('still there'), 5000));
        expect(await Promise.race([exited, late])).toBe('SIGKILL');
        if (failing === 2) {
          for (let wait = 0; running(child) && wait < 100; wait++) {
            await new Promise((settle) => setTimeout(settle, 20));
          }
          expect(running(child)).toBe(false);
        }
      } finally {
        for (const pid of [root.pid!, child]) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // it has already gone
          }
        }
      }
    }
  );
});

/** What `runApp()` says when there is no terminal, which is the app's own refusal and not ours. */
const REFUSAL = 'not a terminal';

describe('every variant, scaffolded and run', () => {
  const variants = PLACEMENTS.flatMap((placement) =>
    SYNTAXES.flatMap((syntax) => LANGUAGES.map((language) => ({ ...placement, language, syntax })))
  );

  it.concurrent.for(variants)(
    '$name, $syntax, $language: should build or start, refuse a pipe, and pass its own tests',
    { timeout: 180_000 },
    async ({ language, layout, syntax, tui }, test) => {
      const { node } = materialize({ language, layout, syntax, tui }, test);
      const argv = tui.at === 'command' ? [tui.command] : [];

      // the entry a person runs: the bundle for JSX, which is the only form it
      // has, and the source for the `ui` tag, which needs nothing built
      let start: string[];
      if (syntax === 'jsx') {
        const built = await node(cli, 'build');
        expect(built.code, built.out).toBe(0);
        start = [join('dist', 'demo.mjs')];
      } else {
        start = [`dev.${language}`];
      }

      // piped, `runApp()` refuses with its own line: exit 1 and no stack. That the
      // refusal is reached at all is the proof the component was found and
      // imported, so it is also the proof the dynamic import resolved
      const piped = await node(...start, ...argv);
      expect(piped.out).toContain(REFUSAL);
      expect(piped.code).toBe(1);
      expect(piped.out).not.toMatch(/^\s+at /m);

      // and the commands that are not the app never meet it
      const help = await node(...start, '--help');
      expect(help.code, help.out).toBe(0);
      expect(help.out).toContain('Usage: demo');

      // its own suite, which is the test a new author copies
      const suite = await node(...OWN_SUITE);
      expect(suite.code, suite.out).toBe(0);
      expect(suite.out).toMatch(/Tests\s+\d+ passed/);
    }
  );

  it.concurrent('should not load the renderer for a command that is not the app, though the root opens it', async (test) => {
    // the lazy tree is the reason for the dynamic import, so it is measured
    // rather than read off the source: a hook watches for the one subpath that
    // is the renderer, and `hello` is run beside an app that opens from the root.
    // The `ui` tag
    // only, because a built bundle has no specifier left to watch -- the build
    // has already turned each `import()` into a chunk that loads when asked
    const { app, node } = materialize({ syntax: 'ui', tui: { at: 'root' } }, test);
    // a synchronous hook in the loader's own thread. `module.register()` is the
    // older spelling and prints DEP0205 on Node 26; `registerHooks()` is there
    // from 22.15, under the 22.19 floor
    writeFileSync(
      join(app, 'probe.mjs'),
      "import { registerHooks } from 'node:module';\nregisterHooks({\n  resolve(specifier, context, next) {\n    if (specifier === '@ttylabs/sigil/app') {\n      process.stderr.write('RENDERER LOADED\\n');\n    }\n    return next(specifier, context);\n  },\n});\n"
    );

    const hello = await node('--import', './probe.mjs', 'dev.ts', 'hello', 'there');
    expect(hello.code, hello.out).toBe(0);
    expect(hello.out).toContain('hello there');
    expect(hello.out).not.toContain('RENDERER LOADED');
    expect(hello.out).not.toContain('DEP0205');

    // and the probe is shown to work, or a silent hook would pass for a lazy tree
    const ops = await node('--import', './probe.mjs', 'dev.ts');
    expect(ops.out).toContain('RENDERER LOADED');
  }, 120_000);

  it('should write a component and a test that are already formatted', () => {
    // the component is the file an author copies, so it should read as though it
    // was written by hand: a template that splices an object in at the wrong depth
    // is a file that looks generated. The repository's own oxfmt rules are the
    // reference, over every variant at once. `test/app.test.*` is left out: it is
    // the older file and its import order is a separate question
    const all = tempDir('sigil-tui-format-');
    const written: string[] = [];
    const every = PLACEMENTS.flatMap((placement) =>
      SYNTAXES.flatMap((syntax) =>
        LANGUAGES.map((language) => ({ ...placement, language, syntax }))
      )
    );

    for (const [index, { language, layout, syntax, tui }] of every.entries()) {
      for (const entry of scaffold({ ...OPTIONS, language, layout, syntax, tui })) {
        if (entry.path.startsWith('src/') || entry.path.startsWith('test/tui.test.')) {
          const target = join(all, String(index), entry.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, entry.contents);
          written.push(target);
        }
      }
    }

    const root = resolve(here, '../../..');
    const oxfmt = createRequire(join(root, 'package.json')).resolve('oxfmt/package.json');
    const bin = (
      JSON.parse(readFileSync(oxfmt, 'utf-8')) as { bin: string | Record<string, string> }
    ).bin;
    const ran = spawnSync(
      process.execPath,
      [
        join(dirname(oxfmt), typeof bin === 'string' ? bin : (bin.oxfmt as string)),
        '--check',
        '-c',
        join(root, '.oxfmtrc.json'),
        ...written,
      ],
      { encoding: 'utf-8' }
    );

    expect(written.length).toBeGreaterThan(40);
    expect(ran.stdout + ran.stderr, 'oxfmt would change these').toMatch(
      /All matched files use the correct format/
    );
    expect(ran.status).toBe(0);
  });

  it.concurrent('should size the footer by columns and not by characters, for an item with wide ones', async (test) => {
    // a copied template gets its own item names, and one in a script that takes
    // two columns a character is the case `.length` gets wrong: the status is
    // measured short, the footer is given too much, and the status is pushed off
    // the row. `stringWidth()` is what the component asks
    const { app, node } = materialize({ syntax: 'ui', tui: { at: 'root' } }, test);
    for (const path of [join('src', 'ui', 'app.ts'), join('test', 'tui.test.ts')]) {
      writeFileSync(
        join(app, path),
        readFileSync(join(app, path), 'utf-8').replaceAll('Settings', '設定設定設定')
      );
    }

    // the narrow-terminal test alone: the resize test goes down to 22 columns,
    // which a status this wide does not fit in whatever measures it
    const ran = await node(...OWN_SUITE, '-t', 'in a narrow terminal');

    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toMatch(/Tests\s+1 passed/);
  }, 120_000);

  it.concurrent('should still say what is wrong when the dev script builds quietly', async (test) => {
    // `dev` is `sigil build --quiet && node ...`, so a build that failed has to
    // say so with the tables gone, or the loop would fail with nothing on screen
    const { app, node } = materialize({ syntax: 'jsx', tui: { at: 'root' } }, test);
    const component = join(app, 'src', 'ui', 'app.tsx');
    writeFileSync(
      component,
      `${readFileSync(component, 'utf-8')}\nexport const x: number = 'a';\n`
    );

    const built = await node(cli, 'build', '--quiet');

    expect(built.code).not.toBe(0);
    expect(built.out).toContain('TS2322');
    expect(built.out).not.toContain('Loads');
  }, 120_000);

  it.concurrent('should resolve a .js specifier to the .tsx in a build, though the scaffold spells it .tsx', async (test) => {
    // the ticket's question, asked of the build: does `import('../ui/app.js')`
    // find `app.tsx` the way a `load()` follows `.js` to `.ts`? It does, in
    // rolldown and in the app's own `tsc`, and this is what keeps it true
    const { app, node } = materialize(
      { syntax: 'jsx', tui: { at: 'command', command: 'ops' } },
      test
    );
    const command = join(app, 'src', 'commands', 'ops.ts');
    writeFileSync(
      command,
      readFileSync(command, 'utf-8').replace("'../ui/app.tsx'", "'../ui/app.js'")
    );
    expect(readFileSync(command, 'utf-8')).toContain("'../ui/app.js'");

    const built = await node(cli, 'build');
    expect(built.code, built.out).toBe(0);

    const piped = await node(join('dist', 'demo.mjs'), 'ops');
    expect(piped.out).toContain(REFUSAL);
    expect(readdirSync(join(app, 'dist'))).toContain('demo.mjs');
  }, 120_000);
});
