import {
  commandNameProblem,
  otherSyntaxCommand,
  runScript,
  scaffold,
  type Language,
  type Layout,
  type ScaffoldOptions,
  type Syntax,
  type Tui,
} from '../src/scaffold/index.ts';
import { tempDir } from './temp.ts';
import { TTY_PRELOAD, typeKeys } from './tty-child.ts';
import { whichSync } from '@ttylabs/sigil/which';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
 * Nothing here installs: a directory that links the packages this one resolves
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

      expect(file(files({ syntax: 'ui', tui: { at: 'root' } }), 'README.md')).toContain(
        'there is nothing\nto build'
      );
    });

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

    expect(ran.stdout.match(/build-free/g)).toHaveLength(1);
    expect(ran.stdout.indexOf('build-free')).toBeGreaterThan(
      ran.stdout.indexOf('npm run dev -- --help')
    );
    // and not when there is no app to have a syntax
    expect(run(tempDir('sigil-new-tui-'), 'demo', '--yes').stdout).not.toContain('build-free');
  });

  it('should write JavaScript with --js', () => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', '--js', '--tui').status).toBe(0);

    expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.jsx'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'tsconfig.json'))).toBe(false);
  });

  it('should refuse --tui-command with --single, and say what to pass', () => {
    const dir = tempDir('sigil-new-tui-');
    const ran = run(dir, 'demo', '--yes', '--single', '--tui-command', 'ops');

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('--tui-command');
    expect(ran.stderr).toContain('Use --tui');
    // and wrote nothing, which is what refusing before the questions is for
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });

  it('should take --tui with --single, which is the app itself', () => {
    const dir = tempDir('sigil-new-tui-');
    expect(run(dir, 'demo', '--yes', '--single', '--tui').status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'src', 'commands'))).toBe(false);
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

  it('should list the four flags in its own help', () => {
    const help = run(tempDir('sigil-new-tui-'), '--help').stdout;

    expect(help).toContain('--tui');
    expect(help).toContain('--no-tui');
    expect(help).toContain('--tui-command');
    expect(help).toContain('--syntax');
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
    const ran = run(dir, 'demo', '--js', '--single', '--lint', 'none', '--pm', 'npm', '--no-tui');

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
    ['pnpm', ['--tui-command', 'ops'], '  pnpm run dev ops\n', '  pnpm run dev --help\n'],
    ['npm', ['--tui-command', 'ops'], '  npm run dev -- ops\n', '  npm run dev -- --help\n'],
    ['vlt', ['--tui'], '  vlt run dev\n', '  vlt run dev -- --help\n'],
    ['pnpm', [], undefined, '  pnpm run dev --help\n'],
  ] as const)('should print the steps the way %s takes arguments', (pm, flags, launch, help) => {
    // pnpm passes a `--` through to the script, so `pnpm run dev -- ops` starts
    // the app with `-- ops` and the parser refuses `ops`; npm and vlt need it
    const ran = run(tempDir('sigil-new-tui-'), 'demo', '--yes', ...flags, '--pm', pm);

    expect(ran.status, ran.stderr).toBe(0);
    if (launch) {
      expect(ran.stdout).toContain(launch);
    }
    expect(ran.stdout).toContain(help);
  });

  it('should print the other syntax as a command that runs as it is written', () => {
    // `--syntax` alone is refused under --yes and asks the TUI question again
    // interactively, so a hint that said only that was not runnable. Each form is
    // read back out of what was printed and run, rather than compared with itself
    for (const flags of [['--tui'], ['--tui-command', 'ops'], ['--single', '--tui', '--js']]) {
      const first = run(tempDir('sigil-new-tui-'), 'app1', '--yes', ...flags);
      const printed = /`(sigil new [^`]+)`/.exec(first.stdout)?.[1];

      expect(printed, first.stdout).toBeDefined();
      const [, , name, ...args] = (printed as string).split(' ') as [
        string,
        string,
        string,
        ...string[],
      ];
      expect(name).toBe('app1');
      expect(args).toContain('--syntax');
      expect(args.at(-1)).toBe('ui');

      const dir = tempDir('sigil-new-tui-');
      const again = run(dir, 'app2', '--yes', ...args);
      expect(again.status, again.stderr).toBe(0);
      // and it is the same app, in the other syntax
      expect(
        existsSync(join(dir, 'app2', 'src', 'ui', args.includes('--js') ? 'app.js' : 'app.ts'))
      ).toBe(true);
    }
  });

  it('should leave the other-syntax hint on one line, since the terminal wraps and a break at 88 does not', () => {
    const ran = run(tempDir('sigil-new-tui-'), 'demo', '--yes', '--tui');
    const note = ran.stdout.split('\n').find((line) => line.startsWith('The app is in JSX'));

    expect(note).toBeDefined();
    expect(note).toContain('build-free alternative: `sigil new demo --tui --syntax ui`');
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

        const [cmd, ...argv] = runScript(manager, 'dev', ...args).split(' ') as [
          string,
          ...string[],
        ];
        const ran = spawnSync(cmd, argv, {
          cwd: dir,
          encoding: 'utf-8',
          shell: process.platform === 'win32',
        });

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
  return new Promise((settle, fail) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        TTY_PRELOAD,
        cli,
        'new',
        'demo',
        '--no-install',
        '--no-git',
        '--lint',
        'none',
        '--pm',
        'npm',
        ...argv,
      ],
      {
        cwd: dir,
        env: { ...process.env, COLUMNS: '80', NO_COLOR: '1' },
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

  it('should ask for the command name, defaulting to dashboard', async () => {
    const dir = tempDir('sigil-new-tui-');
    // a command, the default name, and the ui tag
    const ran = await ask(dir, [ENTER, ENTER, 'y', DOWN, ENTER, ENTER, DOWN, ENTER]);

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('What is the command called?');
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'dashboard.ts'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'src', 'ui', 'app.ts'))).toBe(true);
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
    const ran = run(dir, 'demo', '--js', '--single', '--lint', 'none', '--pm', 'npm');

    expect(ran.status).not.toBe(0);
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });
});

/** Links the packages an app needs into it, as an install would have. */
function link(app: string): void {
  mkdirSync(join(app, 'node_modules', '@ttylabs'), { recursive: true });
  mkdirSync(join(app, 'node_modules', '@types'), { recursive: true });
  const dirs: [string, string][] = [
    [join('@ttylabs', 'sigil'), dirname(require.resolve('@ttylabs/sigil/package.json'))],
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

/** Writes a scaffold into a directory and links its packages. */
function materialize(opts: Partial<ScaffoldOptions>): string {
  const app = tempDir('sigil-tui-app-');
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
  return app;
}

/** Runs node in `cwd` with nothing on stdin and reads what it did. */
function node(cwd: string, ...argv: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...process.env, COLUMNS: '80', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => void (out += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => settle({ code, out: out.replaceAll('\r\n', '\n') }));
  });
}

/** What `runApp()` says when there is no terminal, which is the app's own refusal and not ours. */
const REFUSAL = 'not a terminal';

describe('every variant, scaffolded and run', () => {
  const variants = PLACEMENTS.flatMap((placement) =>
    SYNTAXES.flatMap((syntax) => LANGUAGES.map((language) => ({ ...placement, language, syntax })))
  );

  it.concurrent.each(variants)(
    '$name, $syntax, $language: should build or start, refuse a pipe, and pass its own tests',
    async ({ language, layout, syntax, tui }) => {
      const app = materialize({ language, layout, syntax, tui });
      const argv = tui.at === 'command' ? [tui.command] : [];

      // the entry a person runs: the bundle for JSX, which is the only form it
      // has, and the source for the `ui` tag, which needs nothing built
      let start: string[];
      if (syntax === 'jsx') {
        const built = await node(app, cli, 'build');
        expect(built.code, built.out).toBe(0);
        start = [join('dist', 'demo.mjs')];
      } else {
        start = [`dev.${language}`];
      }

      // piped, `runApp()` refuses with its own line: exit 1 and no stack. That the
      // refusal is reached at all is the proof the component was found and
      // imported, so it is also the proof the dynamic import resolved
      const piped = await node(app, ...start, ...argv);
      expect(piped.out).toContain(REFUSAL);
      expect(piped.code).toBe(1);
      expect(piped.out).not.toMatch(/^\s+at /m);

      // and the commands that are not the app never meet it
      const help = await node(app, ...start, '--help');
      expect(help.code, help.out).toBe(0);
      expect(help.out).toContain('Usage: demo');

      // its own suite, which is the test a new author copies
      const vitest = JSON.parse(
        readFileSync(join(app, 'node_modules', 'vitest', 'package.json'), 'utf-8')
      ) as { bin: { vitest: string } };
      const suite = await node(
        app,
        join('node_modules', 'vitest', vitest.bin.vitest),
        'run',
        '--reporter=default'
      );
      expect(suite.code, suite.out).toBe(0);
      expect(suite.out).toMatch(/Tests\s+\d+ passed/);
    },
    180_000
  );

  it.concurrent('should not load the renderer for a command that is not the app, though the root opens it', async () => {
    // the lazy tree is the reason for the dynamic import, so it is measured
    // rather than read off the source: a hook watches for the one subpath that
    // is the renderer, and `hello` is run beside an app that opens from the root.
    // The `ui` tag
    // only, because a built bundle has no specifier left to watch -- the build
    // has already turned each `import()` into a chunk that loads when asked
    const app = materialize({ syntax: 'ui', tui: { at: 'root' } });
    // a synchronous hook in the loader's own thread. `module.register()` is the
    // older spelling and prints DEP0205 on Node 26; `registerHooks()` is there
    // from 22.15, under the 22.19 floor
    writeFileSync(
      join(app, 'probe.mjs'),
      "import { registerHooks } from 'node:module';\nregisterHooks({\n  resolve(specifier, context, next) {\n    if (specifier === '@ttylabs/sigil/app') {\n      process.stderr.write('RENDERER LOADED\\n');\n    }\n    return next(specifier, context);\n  },\n});\n"
    );

    const hello = await node(app, '--import', './probe.mjs', 'dev.ts', 'hello', 'there');
    expect(hello.code, hello.out).toBe(0);
    expect(hello.out).toContain('hello there');
    expect(hello.out).not.toContain('RENDERER LOADED');
    expect(hello.out).not.toContain('DEP0205');

    // and the probe is shown to work, or a silent hook would pass for a lazy tree
    const ops = await node(app, '--import', './probe.mjs', 'dev.ts');
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

  it.concurrent('should still say what is wrong when the dev script builds quietly', async () => {
    // `dev` is `sigil build --quiet && node ...`, so a build that failed has to
    // say so with the tables gone, or the loop would fail with nothing on screen
    const app = materialize({ syntax: 'jsx', tui: { at: 'root' } });
    const component = join(app, 'src', 'ui', 'app.tsx');
    writeFileSync(
      component,
      `${readFileSync(component, 'utf-8')}\nexport const x: number = 'a';\n`
    );

    const built = await node(app, cli, 'build', '--quiet');

    expect(built.code).not.toBe(0);
    expect(built.out).toContain('TS2322');
    expect(built.out).not.toContain('Loads');
  }, 120_000);

  it.concurrent('should resolve a .js specifier to the .tsx in a build, though the scaffold spells it .tsx', async () => {
    // the ticket's question, asked of the build: does `import('../ui/app.js')`
    // find `app.tsx` the way a `load()` follows `.js` to `.ts`? It does, in
    // rolldown and in the app's own `tsc`, and this is what keeps it true
    const app = materialize({ syntax: 'jsx', tui: { at: 'command', command: 'ops' } });
    const command = join(app, 'src', 'commands', 'ops.ts');
    writeFileSync(
      command,
      readFileSync(command, 'utf-8').replace("'../ui/app.tsx'", "'../ui/app.js'")
    );
    expect(readFileSync(command, 'utf-8')).toContain("'../ui/app.js'");

    const built = await node(app, cli, 'build');
    expect(built.code, built.out).toBe(0);

    const piped = await node(app, join('dist', 'demo.mjs'), 'ops');
    expect(piped.out).toContain(REFUSAL);
    expect(readdirSync(join(app, 'dist'))).toContain('demo.mjs');
  }, 120_000);
});
