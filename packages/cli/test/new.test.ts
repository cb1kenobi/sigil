import { label, outputName, parseTarget } from '../src/build/compile.ts';
import { nameProblem, scaffold, type ScaffoldOptions } from '../src/scaffold/index.js';
import { runCommand } from '@ttylabs/sigil/testing';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `sigil new`.
 *
 * The templates are checked here; whether a scaffolded app actually installs,
 * runs, checks and builds is `demos`-shaped work that needs a network and a
 * package manager, so it is done by hand rather than in the suite. What *is*
 * checked is every claim the templates make that can be read without running
 * them -- and the two that bit during development, which were both silent.
 */

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/sigil.ts');

const OPTIONS: ScaffoldOptions = {
  language: 'ts',
  layout: 'multi',
  linter: 'oxlint',
  manager: 'pnpm',
  name: 'demo',
  version: '0.0.1',
  versions: { '@types/node': '26.6.2', typescript: '7.0.2', vitest: '5.0.3' },
};

/** The scaffold as a map, for asking about one file. */
function files(overrides: Partial<ScaffoldOptions> = {}): Map<string, string> {
  return new Map(scaffold({ ...OPTIONS, ...overrides }).map((file) => [file.path, file.contents]));
}

/** One file's parsed JSON. */
function json(path: string, overrides: Partial<ScaffoldOptions> = {}): Record<string, never> {
  return JSON.parse(files(overrides).get(path) as string) as Record<string, never>;
}

describe('an app name', () => {
  it.each([
    ['', 'A name is required'],
    ['.hidden', 'dot or an underscore'],
    ['_private', 'dot or an underscore'],
    ['@acme/thing', 'scoped'],
    ['MyCli', 'lowercase'],
    ['my cli', 'lowercase letters'],
  ])('should refuse %s', (name, because) => {
    expect(nameProblem(name)).toContain(because);
  });

  it.each(['my-cli', 'mycli', 'my.cli', 'my_cli', 'cli2'])('should take %s', (name) => {
    expect(nameProblem(name)).toBeUndefined();
  });
});

describe('the scaffold', () => {
  it('should name every tool its scripts run', () => {
    // the defect this is here for, and it was silent: the linter's version was
    // read off a manifest that did not have it, `JSON.stringify` dropped the
    // undefined, and the app got a `lint` script for a tool nothing installed.
    //
    // Every script rather than the `lint` one, which is what it walked: the
    // `test` script arrived later and named `vitest`, so dropping `vitest` from
    // the devDependencies while leaving the script was the same defect on a
    // second script and this stayed green. The tools that are not packages are
    // an explicit list, so the next one is a decision somebody makes
    const BUILTIN = new Set(['node', 'sigil', 'tsc']);

    for (const linter of ['oxlint', 'eslint', 'biome', 'none'] as const) {
      const manifest = json('package.json', { linter });
      const scripts = manifest.scripts as Record<string, string>;
      const deps = manifest.devDependencies as Record<string, string>;

      for (const [name, script] of Object.entries(scripts)) {
        const tool = script.split(' ')[0] as string;
        if (BUILTIN.has(tool)) {
          continue;
        }
        const named = Object.keys(deps).some((dep) => dep.includes(tool));

        expect(
          named,
          `${linter}: the "${name}" script runs "${tool}" and nothing installs it`
        ).toBe(true);
      }

      for (const [dep, spec] of Object.entries(deps)) {
        expect(spec, `${linter}: ${dep} has no version`).toBeTruthy();
      }
    }
  });

  it('should write no lint script when there is no linter', () => {
    const manifest = json('package.json', { linter: 'none' });
    expect((manifest.scripts as Record<string, string>).lint).toBeUndefined();
    expect(files({ linter: 'none' }).has('.oxlintrc.json')).toBe(false);
  });

  it('should write the linter config the manifest implies', () => {
    expect(files({ linter: 'oxlint' }).has('.oxlintrc.json')).toBe(true);
    expect(files({ linter: 'eslint' }).has('eslint.config.js')).toBe(true);
    expect(files({ linter: 'biome' }).has('biome.json')).toBe(true);
  });

  it('should set lib and types, which an ejected component needs', () => {
    // not boilerplate: lib.dom declares setInterval(): number, which shadows
    // node's NodeJS.Timeout and makes an ejected spinner fail to compile with
    // `Property 'unref' does not exist on type 'number'`
    const options = json('tsconfig.json').compilerOptions as unknown as Record<string, string[]>;
    expect(options.lib).toStrictEqual(['esnext']);
    expect(options.types).toStrictEqual(['node']);
  });

  it('should configure JSX, which is the canonical syntax', () => {
    // the same kind of line as `lib` and `types`, and it was missing: without
    // `jsx` a `.tsx` is TS17004 in the editor, and with `jsx` but no
    // `jsxImportSource` it is TS2875, naming `react/jsx-runtime` -- a package a
    // sigil app does not depend on. `sigil build` hands the bundler the same
    // import source, so what this buys is `tsc` agreeing with the build rather
    // than the build being right on its own
    const options = json('tsconfig.json').compilerOptions as unknown as Record<string, string>;
    expect(options.jsx).toBe('react-jsx');
    expect(options.jsxImportSource).toBe('@ttylabs/sigil');
  });

  it('should write no tsconfig for a JavaScript app', () => {
    expect(files({ language: 'js' }).has('tsconfig.json')).toBe(false);
    expect(files({ language: 'js' }).has('src/index.js')).toBe(true);
    expect(files({ language: 'js' }).has('dev.js')).toBe(true);
  });

  it('should say what a relative path in the schema is relative to', () => {
    // the other silent one: without `baseDir` the build resolves './commands'
    // against the entry and the runtime resolves it against the working
    // directory, so the app builds and then cannot start
    const entry = files().get('src/index.ts') as string;
    expect(entry).toContain('baseDir: import.meta.dirname');
    expect(entry).toContain("commands: './commands'");
  });

  it('should not need a baseDir for a single-command app', () => {
    const entry = files({ layout: 'single' }).get('src/index.ts') as string;
    expect(entry).not.toContain('commands:');
    expect(entry).toContain('run(');
  });

  it('should scaffold a single-command app that produces its output', async () => {
    // The gap that let SIG-150 ship, which is why this is here rather than
    // among the text assertions: the single layout's generated test asserted
    // `--help`, and `--help` worked. What did not was the thing the app is
    // *for* -- `main()` dispatched only the command that matched and the root
    // is never one, so the as-scaffolded app answered `demo world` with no
    // output at all, exit zero.
    //
    // This file's own header says running a scaffolded app needs a network and
    // a package manager, and for the single layout that is too strong: its
    // entry imports nothing, so the one file can be written out and imported.
    // `--js` deliberately, because a `.ts` under vitest would prove vite can
    // read TypeScript rather than anything about this schema.
    const scratch = mkdtempSync(join(tmpdir(), 'sigil-single-'));

    try {
      const entry = join(scratch, 'single-entry.js');
      writeFileSync(
        entry,
        files({ language: 'js', layout: 'single' }).get('src/index.js') as string
      );

      const { default: schema } = (await import(pathToFileURL(entry).href)) as {
        default: Record<string, unknown>;
      };
      const ran = await runCommand({ argv: ['world'], schema });

      expect(ran.code).toBe(0);
      expect(ran.out).toBe('hello world\n');
      expect(ran.err).toBe('');
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  it('should keep the dev runner out of the entry names discovery looks for', () => {
    // `src/cli` is one of them, so a dev runner called that would be a second
    // entry candidate sitting beside the real one
    const paths = [...files().keys()];
    expect(paths).toContain('dev.ts');
    expect(paths).not.toContain('src/cli.ts');
  });

  it('should write a sigil.json so add does not have to guess', () => {
    // `.json` rather than `.jsonc`, because one reader serves both extensions:
    // a comment in a `sigil.json` is read rather than reported, so the name an
    // app already had costs it nothing. `readSigilConfig()` reads a `.jsonc`
    // too, for an app that prefers to say so in the file name
    expect(json('sigil.json')).toStrictEqual({ components: 'src/components' });
    expect([...files().keys()]).not.toContain('sigil.jsonc');
  });

  it('should write a test that runs the app through the real main()', () => {
    const test = files().get('test/app.test.ts') as string;

    // `runCommand()` rather than `parse()` and the command's own `run()`: a
    // reimplementation is a second answer to what a parse means, and the
    // scaffold is where an author learns which one to reach for
    expect(test).toContain("from '@ttylabs/sigil/testing'");
    expect(test).toContain('runCommand(');
    // relative to `test/`, which is where it lands -- the dev runner is at the
    // root and its specifier is a different one
    expect(test).toContain("from '../src/index.ts'");
  });

  it('should tell the reader that a test runner has no terminal', () => {
    // the whole reason the subpath exists, and the one thing a test like the
    // one above cannot demonstrate: a worker's streams are pipes, so every
    // render comes out at the fallback width with no colour -- the one case
    // that cannot fail. An author who is never told will not derive it
    const test = files().get('test/app.test.ts') as string;

    expect(test).toContain('runOnTerminal()');
    expect(test).toMatch(/pipes/);
  });

  it('should turn the console intercept off, which the capture depends on', () => {
    // measured rather than assumed: with vitest's default, a command that
    // writes with `console.log` has its output taken by the reporter and
    // `ran.out` comes back empty for a command that works perfectly
    const config = files().get('vitest.config.ts') as string;

    expect(config).toContain('disableConsoleIntercept: true');
  });

  it('should name the test file in the paths it type-checks', () => {
    // `sigil build` type-checks with the app's own tsconfig, so a test left out
    // of `include` is one the editor checks and the build does not
    expect(json('tsconfig.json').include).toEqual(['src', 'test', 'dev.ts', 'vitest.config.ts']);
  });

  it("should write the test and its config in the app's own language", () => {
    const paths = [...files({ language: 'js' }).keys()];

    expect(paths).toContain('test/app.test.js');
    expect(paths).toContain('vitest.config.js');
    expect(paths).not.toContain('test/app.test.ts');
  });
});

describe('the command, end to end', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sigil-new-'));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  /** Spawned through `process.execPath`, since a shebang starts nothing on Windows. */
  function run(...argv: string[]) {
    return spawnSync(process.execPath, [cli, ...argv], { cwd: dir, encoding: 'utf-8' });
  }

  it('should create an app', () => {
    const result = run('new', 'demo', '--yes', '--no-install', '--no-git');
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'demo', 'package.json'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'src', 'commands', 'hello.ts'))).toBe(true);
  });

  it('should name its argument for what it is', () => {
    // it is the project's name *and* its directory, and calling it `name`
    // read as though a path would do -- which it will not, because the name
    // is validated as an npm package name
    expect(run('new', '--help').stdout).toContain('[project-name]');
  });

  it('should create it somewhere else when told to', () => {
    const result = run('new', 'demo', '--cwd', 'apps', '--yes', '--no-install', '--no-git');
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'apps', 'demo', 'package.json'))).toBe(true);
  });

  it('should say where it put it, and give a cd that works', () => {
    // the file listing used to be the only thing naming the destination, and
    // `cd <name>` was wrong the moment --cwd sent the project somewhere else
    const result = run('new', 'demo', '--cwd', 'apps', '--yes', '--no-install', '--no-git');

    // both paths are printed through `displayPath`, so they are forward-slashed
    // on every platform -- `join` here would be backslashed on Windows
    expect(result.stdout).toContain(join(dir, 'apps', 'demo').replaceAll('\\', '/'));
    expect(result.stdout).toContain('cd apps/demo');
  });

  /**
   * A directory holding a fake executable per name, and nothing else.
   *
   * The whole question is which package managers are on `PATH`, so the test
   * has to own `PATH` -- asking the machine would make the answer depend on
   * what happens to be installed on it, which is different on every developer's
   * laptop and on each of CI's nine combinations.
   */
  function withManagers(...names: string[]): string {
    const bin = join(dir, 'bin');
    // emptied first, or a second call in one case inherits the first's
    // executables and is answering a question nobody asked
    rmSync(bin, { force: true, recursive: true });
    mkdirSync(bin, { recursive: true });
    for (const name of names) {
      // a `.cmd` on Windows, where an extensionless file is not a program
      // and `which` is right to say so
      const file = join(bin, `${name}${process.platform === 'win32' ? '.cmd' : ''}`);
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, 0o755);
    }
    return bin;
  }

  /**
   * The environment, with `PATH` replaced rather than joined by a second key.
   *
   * Windows env names are case-insensitive and `process.env` there holds
   * `Path`, so spreading it and adding `PATH` hands the child both -- and which
   * one wins is nothing to rely on.
   */
  function envWithPath(path: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') {
        delete env[key];
      }
    }
    return { ...env, PATH: path };
  }

  /** Scaffolds with only `names` installed, and answers which manager it chose. */
  function managerFor(...names: string[]): string | undefined {
    const result = spawnSync(
      process.execPath,
      [cli, 'new', 'demo', '--yes', '--no-install', '--no-git'],
      { cwd: dir, encoding: 'utf-8', env: envWithPath(withManagers(...names)) }
    );
    return /^\s*(\S+) run dev/m.exec(result.stdout)?.[1];
  }

  it('should use the only package manager that is installed', () => {
    expect(managerFor('npm')).toBe('npm');
    rmSync(join(dir, 'demo'), { force: true, recursive: true });
    expect(managerFor('vlt')).toBe('vlt');
    rmSync(join(dir, 'demo'), { force: true, recursive: true });
    expect(managerFor('pnpm')).toBe('pnpm');
  });

  it('should prefer pnpm when there is a choice', () => {
    expect(managerFor('pnpm', 'vlt', 'npm')).toBe('pnpm');
  });

  it('should fall back to npm when pnpm is not one of them', () => {
    expect(managerFor('vlt', 'npm')).toBe('npm');
  });

  it('should say npm when it can find none of them', () => {
    // npm ships with node, so an empty answer is a PATH this cannot see
    // rather than a machine with no package manager on it
    expect(managerFor()).toBe('npm');
  });

  it('should take --pm over what is installed', () => {
    const result = spawnSync(
      process.execPath,
      [cli, 'new', 'demo', '--pm', 'vlt', '--yes', '--no-install', '--no-git'],
      { cwd: dir, encoding: 'utf-8', env: envWithPath(withManagers('pnpm', 'npm')) }
    );
    expect(result.stdout).toContain('vlt run dev');
  });

  it('should refuse a --pm it does not know', () => {
    const result = run('new', 'demo', '--pm', 'yarn', '--yes', '--no-install', '--no-git');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('yarn');
  });

  it('should take an absolute --cwd', () => {
    const target = join(dir, 'absolute');
    run('new', 'demo', '--cwd', target, '--yes', '--no-install', '--no-git');
    expect(existsSync(join(target, 'demo', 'package.json'))).toBe(true);
  });

  it('should make a --cwd that is not there yet', () => {
    // the scaffold makes each file's directory as it goes, so naming somewhere
    // new is `mkdir -p` rather than an error
    run('new', 'demo', '--cwd', 'a/b/c', '--yes', '--no-install', '--no-git');
    expect(existsSync(join(dir, 'a', 'b', 'c', 'demo', 'package.json'))).toBe(true);
  });

  it('should expand a ~ the shell did not eat', () => {
    // `--cwd "~/projects"` is quoted, so the tilde reaches the process -- and
    // `resolve()` alone would make a directory *called* `~`, which is the
    // failure paths.ts already records.
    //
    // Home is pointed at the temp directory so this never writes to a real
    // one, and it takes *both* variables: `expand()` goes through
    // `os.homedir()`, which reads `HOME` on POSIX and `USERPROFILE` on
    // Windows. Setting only the first passes everywhere it was written and
    // scaffolds into the actual profile directory on the one platform it was
    // not.
    const home = join(dir, 'fake-home');
    const result = spawnSync(
      process.execPath,
      [cli, 'new', 'demo', '--cwd', '~/projects', '--yes', '--no-install', '--no-git'],
      {
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(home, 'projects', 'demo', 'package.json'))).toBe(true);
    expect(existsSync(join(dir, '~'))).toBe(false);
  });

  it('should still refuse a path as the name', () => {
    // saying where and saying what it is called are two questions, and this is
    // the half that stays a package name
    const result = run('new', 'sub/dir/app', '--yes', '--no-install', '--no-git');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lowercase letters');
  });

  it('should refuse a directory with something already in it', () => {
    run('new', 'demo', '--yes', '--no-install', '--no-git');
    const again = run('new', 'demo', '--yes', '--no-install', '--no-git');
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('not empty');
  });

  it('should refuse a name it cannot use', () => {
    const result = run('new', 'My-CLI', '--yes', '--no-install', '--no-git');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lowercase');
  });

  it('should depend on published versions', () => {
    // there was a `--link` that pointed a scaffolded app at a checkout, for
    // as long as these packages were unpublished. A local path in a
    // dependency keeps working right up until somebody commits it, so the
    // flag went with the publish rather than staying as an escape hatch
    run('new', 'demo', '--yes', '--no-install', '--no-git');
    const manifest = JSON.parse(readFileSync(join(dir, 'demo', 'package.json'), 'utf-8')) as Record<
      string,
      Record<string, string>
    >;

    for (const spec of [
      manifest.dependencies?.['@ttylabs/sigil'],
      manifest.devDependencies?.['@ttylabs/cli'],
    ]) {
      expect(spec).toBeDefined();
      expect(spec).not.toMatch(/^(file|link):/);
    }
  });
});

/**
 * The release workflow, which is the half of packaging a scaffold can supply.
 *
 * The drift guard is the one worth having. The workflow spells five targets and
 * five binary names as literal text, so nothing in a build connects it to
 * `parseTarget()` or `binaryName()` -- and a scaffolded CI that fails on an
 * app's first tag is the worst possible place to find that out. These assert
 * the literals against the functions that have to accept them.
 */
describe('the release workflow', () => {
  /** The workflow, as the scaffold writes it. */
  function workflow(overrides: Partial<ScaffoldOptions> = {}): string {
    return files(overrides).get('.github/workflows/release.yml') as string;
  }

  it('should be written, because a release is every target at once', () => {
    expect(workflow()).toBeDefined();
  });

  it('should name only targets sigil package accepts', () => {
    // every `--target` in the file, read back out rather than listed again here
    const named = [...workflow().matchAll(/--target (\S+)/g)].map((m) => m[1] as string);

    expect(named.length).toBeGreaterThan(0);

    for (const text of named) {
      // the assertion: a target the workflow names has to be one the command
      // reads, and `parseTarget()` throws on anything else
      expect(label(parseTarget(text))).toBe(text);
    }
  });

  it('should attach a file for each target, named the way package names it', () => {
    const file = workflow();
    const named = [...file.matchAll(/--target (\S+)/g)].map((m) => m[1] as string);

    const all = named.map((text) => parseTarget(text));

    for (const target of all) {
      // through `outputName()` rather than spelled here, so this asserts the
      // workflow's literals against the convention `sigil package` actually
      // follows -- the target suffix a release gets, and the `.exe` that is
      // easy to get wrong and impossible to notice from a Mac
      expect(file).toContain(`dist/${outputName('demo', target, all)}`);
    }

    // and nothing it does not build, which is what catches a target removed
    // from the package step and left in the release step
    const attached = [...file.matchAll(/dist\/demo-(\S+)/g)].map((m) =>
      (m[1] as string).replace(/\.exe$/, '')
    );
    expect([...attached].sort()).toEqual([...named].sort());
  });

  it('should run every target in one job, which is what bun buys', () => {
    // a matrix would be the Node shape, and the comment says so -- this is the
    // assertion that the scaffolded workflow is the single-job one
    expect(workflow()).not.toContain('strategy:');
    expect(workflow()).toContain('oven-sh/setup-bun');
  });

  it.each([
    ['pnpm', 'pnpm install --frozen-lockfile', 'pnpm exec sigil package', 'pnpm run test'],
    ['npm', 'npm ci', 'npx sigil package', 'npm run test'],
    // `vlt` is the ternary's fallthrough branch and was the one manager this
    // test did not read -- which is also the one whose spellings nobody had
    // verified when the workflow was written, so misspelling `vlt exec` as
    // `vlt x` would have passed the suite. Checked against a real vlt 1.1.1:
    // `install --frozen-lockfile`, `exec <executable>` and `run <script>` are
    // all real.
    ['vlt', 'vlt install --frozen-lockfile', 'vlt exec sigil package', 'vlt run test'],
  ] as const)(
    'should spell its commands with %s, the manager the app was set up with',
    (manager, install, exec, test) => {
      // a scaffolded CI that installs with a manager the app was not set up
      // with fails on the first tag, which is the one run nobody gets to redo
      const file = workflow({ manager });

      expect(file).toContain(install);
      expect(file).toContain(exec);
      expect(file).toContain(test);
    }
  );

  it('should install any manager the runner does not already have', () => {
    // npm ships with Node and pnpm is on the GitHub runner images. `vlt` is
    // neither, and the workflow ran `vlt install` on a runner where nothing had
    // installed it -- so the release failed at its first step on the first tag.
    expect(workflow({ manager: 'vlt' })).toContain('npm install --global vlt');

    // and nothing superfluous for the two that are already there
    expect(workflow({ manager: 'npm' })).not.toContain('--global');
    expect(workflow({ manager: 'pnpm' })).not.toContain('--global');
  });

  it('should name the runtime itself, and leave sigil.json out of it', () => {
    // This asserted the opposite and the opposite was a bug: the scaffold
    // pinned `"runtime": "bun"` in `sigil.json`, so `sigil package` arrived with
    // the question already answered, the picker never fired, and an author with
    // no Bun got `bun is not installed` for an app they had never been asked
    // about.
    //
    // CI cannot be asked, so the workflow names it on its own command line --
    // which is also where it belongs, since that file installs Bun itself and
    // so is right whatever the author's machine has.
    const config = JSON.parse(files().get('sigil.json') as string) as {
      package?: { runtime?: string };
    };

    expect(config.package).toBeUndefined();
    expect(workflow()).toContain('--runtime bun');
  });
});
