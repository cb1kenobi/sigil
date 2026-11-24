import { displayPath } from '../src/build/index.ts';
import { run } from '../src/index.js';
import { copyFixture, linkedFixture } from './copy-fixture.ts';
import { tempDir } from './temp.ts';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Runs the CLI with both streams captured.
 *
 * `console.warn` is captured into `err` beside `process.stderr.write`, and it is
 * not decoration: rolldown logs through `console.warn`, and vitest replaces
 * `globalThis.console` with a reporter of its own -- so a spy on
 * `process.stderr.write` never sees a bundler warning and any assertion about
 * one passes whatever the build did. Found by sabotage: removing the code that
 * suppresses a warning left the assertion green and printed the warning to the
 * terminal.
 */
async function sigil(...argv: string[]) {
  const chunks: Record<'err' | 'out', string[]> = { err: [], out: [] };
  const spies: { mockRestore: () => void }[] = (['stdout', 'stderr'] as const).map((stream) =>
    vi.spyOn(process[stream], 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks[stream === 'stdout' ? 'out' : 'err'].push(chunk.toString());
      return true;
    }) as typeof process.stdout.write)
  );

  for (const level of ['error', 'warn'] as const) {
    spies.push(
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        chunks.err.push(args.map(String).join(' '));
      })
    );
  }

  try {
    await run(argv);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }

  return { err: chunks.err.join(''), out: chunks.out.join('') };
}

/** Every `.mjs` the build wrote, joined -- the bundle's code and not its maps. */
function bundledCode(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8'))
    .join('');
}

/**
 * `sigil build` as a command, which is the half `bundle.test.ts` does not
 * cover: what it refuses, and what it says about what it made.
 */
describe('sigil build', () => {
  let exitCode: typeof process.exitCode;
  let out: string;

  beforeEach(() => {
    exitCode = process.exitCode;
    out = mkdtempSync(join(tmpdir(), 'sigil-build-cmd-'));
  });

  afterEach(() => {
    process.exitCode = exitCode;
    rmSync(out, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it('should build an app and say what it made', async () => {
    const { err, out: stdout } = await sigil('build', join(fixtures, 'buildable'), '--out', out);

    expect(existsSync(join(out, 'buildable.mjs'))).toBe(true);
    expect(stdout).toContain('entry');
    // a chunk the entry imports statically loads with it, and says so; the rest
    // are reached through an `import()`, the runtime's own among them, which
    // may be on every run -- so `dynamic`, and never the `lazy` that claimed
    // a command had to ask for the parser
    expect(stdout).toMatch(/^chunks\/\S+\s+[\d.]+ kB\s+startup$/m);
    expect(stdout).toMatch(/^chunks\/\S+\s+[\d.]+ kB\s+dynamic$/m);
    expect(stdout).not.toMatch(/\blazy$/m);
    expect(err).toContain('4 commands');
    expect(process.exitCode).toBeFalsy();
  }, 60_000);

  it('should build a single-command app, whose schema is the command', async () => {
    // the `--layout single` layout. It was refused outright with `no "commands" found`,
    // so it ran from source and could not be built -- the works-unbundled,
    // fails-built divergence the shared route rules exist to prevent, arriving
    // through the schema rather than through a route.
    //
    // What is asserted is that the executable **answers**, not only that the
    // build exited zero: the bundle is where the generated entry's baked
    // `commands` meets a schema that has a root `run` instead, and a build that
    // wrote an app which then does nothing is the defect this is a fix for
    const { err } = await sigil('build', join(fixtures, 'discover', 'single-app'), '--out', out);

    expect(err).not.toContain('no "commands" found');
    // not `0 commands`, which is what a tree the build failed to read says
    expect(err).toContain('the root command');
    expect(process.exitCode).toBeFalsy();

    const named = spawnSync(process.execPath, [join(out, 'single-app.mjs'), 'Ada'], {
      encoding: 'utf-8',
    });

    expect(named.status, named.stderr).toBe(0);
    expect(named.stdout).toBe('hello Ada\n');

    const bare = spawnSync(process.execPath, [join(out, 'single-app.mjs')], {
      encoding: 'utf-8',
    });

    expect(bare.status, bare.stderr).toBe(0);
    expect(bare.stdout).toBe('hello world\n');
  }, 60_000);

  it('should register a scoped package as the name after its scope, built as from source', async () => {
    // SIG-389. `@acme/deploy` was `acme/deploy`, a command nobody could type, and
    // the build and the runtime read it through one function so a built app
    // answers to what the source run answers to. Asserted by running the bundle,
    // since a tree the build read right and baked wrong looks identical in a log
    const { err } = await sigil('build', join(fixtures, 'discover', 'route-names'), '--out', out);

    expect(err).toContain('2 commands');
    expect(process.exitCode).toBeFalsy();

    const run = (...argv: string[]) =>
      spawnSync(process.execPath, [join(out, 'route-names.mjs'), ...argv], { encoding: 'utf-8' });

    const deploy = run('deploy');
    expect(deploy.status, deploy.stderr).toBe(0);
    expect(deploy.stdout).toBe('deployed\n');

    // the alias a commands.json gave it, keyed by the name it registers as
    expect(run('d').stdout).toBe('deployed\n');
    expect(run('acme/deploy').status).not.toBe(0);

    // and the hidden route is still routed, and still not listed
    expect(run('secret').stdout).toBe('secret\n');
    const help = run('--help');
    expect(help.stdout).toContain('deploy');
    expect(help.stdout).not.toContain('acme/deploy');
    expect(help.stdout).not.toContain('secret');
  }, 60_000);

  it('should refuse a route name the runtime refuses, and say which file', async () => {
    // a name a command name string would read is refused from source, so a build
    // that baked it would be an app that works bundled and fails the moment it is
    // run unbundled -- or one that registers a hidden `secret` for `!secret.js`
    const app = linkedFixture(
      join(fixtures, 'discover', 'route-names'),
      'sigil-build-route-names-'
    );
    writeFileSync(join(app, 'src', 'commands', 'my cmd.js'), 'export default { run() {} };\n');

    const { err } = await sigil('build', app, '--out', out);

    expect(err).toContain('Cannot route the file "my cmd.js"');
    expect(err).toContain('contains whitespace');
    expect(err).toContain('commands.json');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(out, 'route-names.mjs'))).toBe(false);
  }, 60_000);

  // a control character in a file name cannot be created on Windows
  it.skipIf(process.platform === 'win32')(
    'should print no control character from a diagnostic located at a name that holds one (SIG-443)',
    async () => {
      // the file part of `file:line:column:` was printed exactly as it is on disk,
      // so a refusal located at `c<ESC>]0;T<BEL>d` handed a terminal an OSC that sets
      // its title -- while the message after the prefix was already escaped
      const app = linkedFixture(
        join(fixtures, 'discover', 'route-names'),
        'sigil-build-route-controls-'
      );
      // a refusal is located at the directory it was walking, so that is the name
      // that has to hold the control character for the prefix to carry it
      const name = 'c\u001b]0;T\u0007d';
      renameSync(join(app, 'src', 'commands'), join(app, 'src', name));
      writeFileSync(
        join(app, 'src', 'index.ts'),
        readFileSync(join(app, 'src', 'index.ts'), 'utf-8').replace(
          "'./commands'",
          JSON.stringify(`./${name}`)
        )
      );
      writeFileSync(join(app, 'src', name, 'my cmd.js'), 'export default { run() {} };\n');

      const { err } = await sigil('build', app, '--out', out);

      expect(err).toContain('Cannot route the file');
      expect(err).toContain('c\\x1B]0;T\\x07d: error: Cannot route');
      // every character a terminal would act on, newline aside
      expect(err.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
      expect(err).toContain('\\x1B]0;T\\x07');
      expect(process.exitCode).toBe(1);
    },
    60_000
  );

  it('should refuse an app whose schema declares neither commands nor a run', async () => {
    // the other half of the test above: a schema with no `commands` is a
    // single-command app only when it has a `run`, and an app that simply
    // forgot them has to go on being told
    const { err } = await sigil('build', join(fixtures, 'discover', 'no-run'), '--out', out);

    expect(err).toContain('no "commands" found');
    expect(existsSync(join(out, 'no-run.mjs'))).toBe(false);
    expect(process.exitCode).toBe(1);
  }, 60_000);

  it('should compile an app’s templates, and ship no parser for them', async () => {
    // the payoff, asserted rather than assumed: a compiled template ships no
    // parser, so the tag, the parser and the IR walk shake out of the bundle.
    // The marker is a *string literal* the parser throws, because the output is
    // minified and every identifier in it has been mangled
    const { err } = await sigil('build', join(fixtures, 'templated'), '--out', out);

    expect(err).toContain('1 template');

    const bundled = bundledCode(out);

    expect(bundled).not.toContain('A template produces exactly one element');
    expect(bundled).not.toContain('ui`');
  }, 60_000);

  it('should compile a template in a .tsx, which the id filter used to skip', async () => {
    // the plugin's `id` filter gated on `/\.[cm]?[jt]s$/`, so a `ui` template in
    // a `.tsx` was never asked about -- bundled interpreted, omitted from the
    // count, and the parser left in with nothing saying so. Asserted end to end
    // rather than only over the pattern, because rolldown has a JSX transform of
    // its own and whether a `.tsx` reaches this hook at all is the thing a unit
    // test cannot answer.
    //
    // This fixture is built and never run from source: node cannot load a `.tsx`
    // at all, so an app with one is a built app by construction
    const { err } = await sigil('build', join(fixtures, 'templated-tsx'), '--out', out);

    expect(err).toContain('1 template');

    const built = spawnSync(process.execPath, [join(out, 'templated-tsx.mjs'), 'show'], {
      encoding: 'utf-8',
    });

    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toContain('a template from a .tsx');

    const bundled = bundledCode(out);

    expect(bundled).not.toContain('A template produces exactly one element');
  }, 60_000);

  it('should leave the rest of the JSX transform to the app, and say nothing about it', async () => {
    // two claims about one option, and both are decisions rather than
    // behaviours. The build sets `transform.jsx.importSource` and nothing else,
    // so this fixture's `jsx: "react-jsxdev"` still reaches
    // `@ttylabs/sigil/jsx-dev-runtime` -- adding `runtime: 'automatic'` beside
    // the import source was tried and rejected precisely because it takes that
    // away. The marker is the module's own file name, which the development
    // transform passes to `jsxDEV` as a string and which therefore survives
    // minification, where every identifier does not.
    //
    // And rolldown says `compilerOptions.jsxImportSource` was overridden
    // whether or not the two agree -- this fixture names `@ttylabs/sigil`, the
    // only thing a sigil app can name -- so the warning is noise on a correct
    // build and is dropped. A warning that fires on correct code teaches people
    // to ignore warnings.
    const { err } = await sigil('build', join(fixtures, 'jsx-dev'), '--out', out);

    expect(err).not.toContain('CONFIGURATION_FIELD_CONFLICT');
    expect(process.exitCode).toBeFalsy();

    const bundled = bundledCode(out);

    expect(bundled).toContain('panel.tsx');

    const built = spawnSync(process.execPath, [join(out, 'jsx-dev.mjs'), 'greet'], {
      encoding: 'utf-8',
    });

    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toContain('Hello, world!');
  }, 60_000);

  it('should build a templated app that renders what the interpreted tag does', async () => {
    // two runs of one app: the built one, whose template was compiled, and the
    // source one, whose `ui` tag parses at run time. `emitters.test.ts` proves
    // the two agree from the IR down; this proves the splice did not break it
    // once a real bundler had written the result to disk
    await sigil('build', join(fixtures, 'templated'), '--out', out);

    const built = spawnSync(process.execPath, [join(out, 'templated.mjs'), 'greet', 'Ada'], {
      encoding: 'utf-8',
    });
    const source = spawnSync(
      process.execPath,
      [join(fixtures, 'templated', 'dev.ts'), 'greet', 'Ada'],
      { encoding: 'utf-8' }
    );

    expect(built.status, built.stderr).toBe(0);
    expect(source.status, source.stderr).toBe(0);
    expect(built.stdout).toContain('Hello, Ada!');
    expect(built.stdout).toBe(source.stdout);
  }, 60_000);

  it('should shake the utility sheet down to what the app can name', async () => {
    // the payoff, asserted the way the template one is: the sheet an app names
    // a dozen rules of leaves the bundle rather than being replaced in it, so
    // the marker is a rule the fixture cannot possibly name
    const { err } = await sigil('build', join(fixtures, 'styled'), '--out', out);

    expect(err).toMatch(/\d+ of 383 utility rules/);
    expect(err).not.toContain('383 of 383');
    expect(bundledCode(out)).not.toContain('justify-around');
  }, 60_000);

  it('should render what the unshaken sheet does', async () => {
    // the claim the whole analysis rests on: the shaken build, the unshaken
    // one, and the app run from source with the whole 383-rule sheet all
    // paint the same bytes.
    //
    // What this does *not* do is prove the shake happened. A no-op shake
    // paints the full sheet, which is what all three paint, so all three
    // still agree -- sabotaging `shakeUtilities()` to keep everything leaves
    // this green. `should shake the utility sheet down to what the app can
    // name` is the one that fails there, and the two are a pair: one says
    // something was dropped and the other says nothing was lost by it
    const plain = mkdtempSync(join(tmpdir(), 'sigil-build-plain-'));

    try {
      await sigil('build', join(fixtures, 'styled'), '--out', out);
      await sigil('build', join(fixtures, 'styled'), '--out', plain, '--no-shake');

      const shaken = spawnSync(process.execPath, [join(out, 'styled.mjs'), 'panel'], {
        encoding: 'utf-8',
      });
      const whole = spawnSync(process.execPath, [join(plain, 'styled.mjs'), 'panel'], {
        encoding: 'utf-8',
      });
      const source = spawnSync(process.execPath, [join(fixtures, 'styled', 'dev.ts'), 'panel'], {
        encoding: 'utf-8',
      });

      expect(shaken.status, shaken.stderr).toBe(0);
      // the fixture draws a border, a padded column, a bold red and a cyan,
      // so a sheet that failed to apply at all would be a blank comparison
      // that three identical empties would satisfy
      expect(shaken.stdout).toContain('┌');
      expect(shaken.stdout).toBe(whole.stdout);
      expect(shaken.stdout).toBe(source.stdout);
    } finally {
      rmSync(plain, { force: true, recursive: true });
    }
  }, 120_000);

  it('should style an element through a variant the app names, once built', async () => {
    // SIG-526: `focus:` and `md:` were generated and then loaded by nothing, so
    // no app could use one. The build sees the class names, so it generates the
    // variant rules those names need and nothing else: the built app paints the
    // focused box green and the wide one red, which the committed base sheet
    // cannot, and the same app run from source -- the base sheet only -- paints
    // all of them white. Green is SGR 32, red 31 and white 37
    const { err } = await sigil('build', join(fixtures, 'variants'), '--out', out);

    expect(err).toMatch(/\d+ of 383 utility rules, plus \d+ variant rules/);

    const paint = (entry: string, ...args: string[]) => {
      const run = spawnSync(process.execPath, [entry, 'panel', ...args], { encoding: 'utf-8' });
      expect(run.status, run.stderr).toBe(0);
      return /^\[(\d+)m/.exec(run.stdout.split(String.fromCharCode(0x1b))[1] ?? '')?.[1];
    };
    const built = join(out, 'variants.mjs');
    const source = join(fixtures, 'variants', 'dev.ts');

    expect(paint(built)).toBe('37');
    expect(paint(built, '--focused')).toBe('32');
    expect(paint(built, '--width', '100')).toBe('31');
    // a pseudo-class variant is two specificity points and a media one is one,
    // whatever order they are printed in
    expect(paint(built, '--focused', '--width', '100')).toBe('32');

    // the unbuilt answer, recorded in "The utility layer": the base set, and a
    // variant is a class that matches nothing
    expect(paint(source, '--focused')).toBe('37');
    expect(paint(source, '--width', '100')).toBe('37');
  }, 60_000);

  it('should carry no variant rule the app does not name', async () => {
    // the other half of the size argument: variants are 13 times the base set
    // and an app pays for the ones it uses. `lg:` and `dark:` are in the
    // generator and not in this app, so neither may be in its bundle
    await sigil('build', join(fixtures, 'variants'), '--out', out);

    const bundled = bundledCode(out);

    // the sheet is a string literal in the bundle, so a selector's one
    // backslash is two there
    expect(bundled).toContain('focus\\\\:border-green:focus');
    expect(bundled).not.toContain('lg\\\\:');
    expect(bundled).not.toContain('dark\\\\:');
  }, 60_000);

  it('should let both transforms rewrite one module and keep its source map', async () => {
    // `tpl.ts` holds a `ui` template *and* asks for the utility sheet, so both
    // plugins rewrite it. Two things have to survive that: what it renders,
    // and its entry in the source map -- a transform that returns code
    // without one is `SOURCEMAP_BROKEN` and silently drops the module, so a
    // pair of them is where that would show
    await sigil('build', join(fixtures, 'styled'), '--out', out);

    const built = spawnSync(process.execPath, [join(out, 'styled.mjs'), 'tpl', 'Ada'], {
      encoding: 'utf-8',
    });
    const source = spawnSync(process.execPath, [join(fixtures, 'styled', 'dev.ts'), 'tpl', 'Ada'], {
      encoding: 'utf-8',
    });

    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toContain('Ada');
    expect(built.stdout).toBe(source.stdout);

    const maps = readdirSync(join(out, 'chunks'))
      .filter((name) => name.endsWith('.map'))
      .map(
        (name) =>
          JSON.parse(readFileSync(join(out, 'chunks', name), 'utf-8')) as {
            mappings: string;
            sources: string[];
            sourcesContent: (string | null)[];
          }
      );
    const map = maps.find((one) => one.sources.some((from) => from?.endsWith('tpl.ts')));

    expect(map, 'the doubly-transformed module is in no source map').toBeDefined();
    expect(map?.mappings.length).toBeGreaterThan(0);
    // the *original* source rather than either transform's output, which is
    // what makes a stack frame land on the line the author wrote
    const at = map!.sources.findIndex((from) => from?.endsWith('tpl.ts'));
    expect(map?.sourcesContent[at]).toContain('const tpl: AnyCommand');
  }, 60_000);

  it('should keep what sigil.json safelists', async () => {
    // the escape hatch, end to end: the scan is evidence rather than proof, so
    // a class assembled out of values that never appear as literals leaves
    // nothing behind -- and this is the only way to say it anyway. Written
    // into the fixture rather than given a fixture of its own, because what is
    // being asserted is that the config reaches the shake at all
    const config = join(fixtures, 'styled', 'sigil.json');
    writeFileSync(config, JSON.stringify({ build: { safelist: ['justify-around'] } }));

    try {
      const { err } = await sigil('build', join(fixtures, 'styled'), '--out', out);

      expect(err).toMatch(/\d+ of 383 utility rules/);
      expect(bundledCode(out)).toContain('justify-around');
    } finally {
      rmSync(config, { force: true });
    }
  }, 60_000);

  it('should say so when it dropped every rule', async () => {
    // a count of zero is the one value the summary cannot speak for itself:
    // an app that asked for the utility sheet and named none of it is either
    // carrying a call it no longer uses or naming its classes somewhere the
    // scan cannot see, and the second is the unsound case arriving as a
    // layout that is subtly wrong with nothing to point at
    const { err } = await sigil('build', join(fixtures, 'opaque'), '--out', out);

    expect(err).toContain('0 of 383 utility rules');
    expect(err).toContain('No utility class is named anywhere in this app');
    expect(err).toContain('build.safelist');
  }, 60_000);

  it('should not call a build empty that kept only a variant', async () => {
    // SIG-526: a variant is something kept. The `opaque` app names no class at
    // all, so a safelisted variant is the only thing the shake keeps, and the
    // note about dropping everything would be false -- and a safelist takes a
    // qualified name like any other
    // a copy rather than the shared fixture, which `package-command.test.ts`
    // copies from another worker: a `sigil.json` written into it is one
    // another test's app would carry for as long as this build runs (SIG-655)
    const app = linkedFixture(join(fixtures, 'opaque'), 'sigil-build-variant-only-');
    writeFileSync(
      join(app, 'sigil.json'),
      JSON.stringify({ build: { safelist: ['focus:border-green'] } })
    );

    const { err } = await sigil('build', app, '--out', out);

    expect(err).toContain('0 of 383 utility rules, plus 1 variant rules');
    expect(err).not.toContain('No utility class is named');
  }, 60_000);

  it('should say nothing of the sort when it kept something', async () => {
    const { err } = await sigil('build', join(fixtures, 'styled'), '--out', out);

    expect(err).not.toContain('No utility class is named');
  }, 60_000);

  describe('a file too deeply nested to parse (SIG-638)', () => {
    // 513 unbalanced `(` inside strings is past the shake's ceiling of 512 by the
    // naive count and is nothing the parser is ever given, which is the point: a
    // fixture that really nested this deep would be what segfaults `oxc-parser`
    // (SIG-639). Nothing imports the file, so the bundler never reads it either
    const deep = `export const a = [${Array.from({ length: 513 }, () => `':('`).join(', ')}];\n`;

    it('should name the file and what it keeps, once per file', async () => {
      const app = linkedFixture(join(fixtures, 'styled'), 'sigil-build-deep-');
      writeFileSync(join(app, 'src', 'deep.ts'), deep);
      writeFileSync(join(app, 'src', 'deeper.ts'), deep);

      const { err } = await sigil('build', app, '--out', out);

      const notes = err.match(/src\/deep(er)?\.ts was read without parsing/g) ?? [];
      expect(notes).toHaveLength(2);
      // a note wraps, so a path and the words after it may be split by any whitespace
      expect(err).toMatch(/src\/deep\.ts\s+was\s+read\s+without\s+parsing/);
      expect(err).toMatch(/src\/deeper\.ts\s+was\s+read\s+without\s+parsing/);
      // measured rather than asserted by hand: the one-letter name `a` is
      // an infix of a quarter of the sheet, and a note wraps, so the words are
      // separated by any whitespace
      const kept = Number(/keeps\s+(\d+)\s+of\s+383\s+utility\s+rules/.exec(err)?.[1]);
      expect(kept).toBeGreaterThan(0);
      expect(err).toContain('--no-shake');
    }, 60_000);

    it('should say nothing about a file under the ceiling', async () => {
      const app = linkedFixture(join(fixtures, 'styled'), 'sigil-build-shallow-');
      writeFileSync(
        join(app, 'src', 'shallow.ts'),
        `export const data = [${Array.from({ length: 400 }, () => `':('`).join(', ')}];\n`
      );

      const { err } = await sigil('build', app, '--out', out);

      expect(err).not.toContain('read without parsing');
    }, 60_000);

    it('should say nothing for an app whose files all parse', async () => {
      const { err } = await sigil('build', join(fixtures, 'styled'), '--out', out);

      expect(err).not.toContain('read without parsing');
    }, 60_000);

    it.skipIf(process.platform === 'win32')(
      'should escape what a file is called',
      async () => {
        const app = linkedFixture(join(fixtures, 'styled'), 'sigil-build-deep-name-');
        // a newline is a legal name on every other platform, and an unescaped one
        // would start a line of its own in a piped build's stderr
        writeFileSync(join(app, 'src', 'a\nforged line.ts'), deep);

        const { err } = await sigil('build', app, '--out', out);

        expect(err).toContain('src/a\\x0Aforged line.ts was read without parsing');
        expect(err).not.toContain('a\nforged line');
      },
      60_000
    );

    it('should say what a file keeps on its own, whatever else the app names', async () => {
      // `bg-` beside an unknown opens every `bg-*` rule, and the deep file holds
      // no such token: if its count were the whole evidence so far rather than
      // its own, this would read as keeping them and the two builds would differ
      const lone = linkedFixture(join(fixtures, 'opaque'), 'sigil-build-deep-lone-');
      writeFileSync(join(lone, 'src', 'deep.ts'), deep);
      const beside = linkedFixture(join(fixtures, 'opaque'), 'sigil-build-deep-beside-');
      writeFileSync(join(beside, 'src', 'deep.ts'), deep);
      writeFileSync(join(beside, 'src', 'aaa.ts'), `export const c = 'bg-' + colour;\n`);

      const keeps = async (app: string): Promise<string | undefined> =>
        /keeps\s+(\d+)\s+of/.exec((await sigil('build', app, '--out', out)).err)?.[1];

      const alone = await keeps(lone);
      expect(alone).toBeDefined();
      expect(await keeps(beside)).toBe(alone);
    }, 60_000);

    it('should escape a bidi control in what a file is called, on every platform', async () => {
      const app = linkedFixture(join(fixtures, 'styled'), 'sigil-build-deep-bidi-');
      writeFileSync(join(app, 'src', 'a\u202Eb.ts'), deep);

      const { err } = await sigil('build', app, '--out', out);

      expect(err).toContain('a\\u{202E}b.ts');
      expect(err).not.toContain('\u202E');
    }, 60_000);

    it('should say nothing under --quiet', async () => {
      const app = linkedFixture(join(fixtures, 'styled'), 'sigil-build-deep-quiet-');
      writeFileSync(join(app, 'src', 'deep.ts'), deep);

      const { err } = await sigil('build', app, '--out', out, '--quiet');

      expect(err).not.toContain('read without parsing');
    }, 60_000);
  });

  it('should keep every rule under --no-shake, and say so', async () => {
    // the opposite of the above and the reason the count is in the summary at
    // all: "this app names twelve utilities" and "the analysis found nothing"
    // look identical from outside unless the build says which
    const { err } = await sigil('build', join(fixtures, 'styled'), '--out', out, '--no-shake');

    expect(err).not.toMatch(/utility rules/);
    expect(bundledCode(out)).toContain('justify-around');
  }, 60_000);

  it('should say nothing about utilities for an app that names no sheet', async () => {
    // `undefined` rather than `383 of 383`, because an app that never called
    // `utilitySheet()` has no utility sheet in its bundle and a line about one
    // would describe something that is not there
    const { err } = await sigil('build', join(fixtures, 'buildable'), '--out', out);

    expect(err).not.toContain('utility rules');
  }, 60_000);

  it('should say what it inlined, which is what the app’s own imports cost', async () => {
    // the zero-dependency promise is about what *sigil* adds; everything an
    // app imports is in the executable, and a build that says nothing about it
    // has told the author nothing they could act on
    const { out: stdout } = await sigil('build', join(fixtures, 'buildable'), '--out', out);

    expect(stdout).toContain('Inlined');
    expect(stdout).toMatch(/@ttylabs\/sigil\s+\d+\.\d+ kB/);
    // the app's own modules are not a dependency, and this is the assertion
    // that fails on Windows and nowhere else if the comparison stops
    // normalizing: rolldown hands back forward slashes there while
    // `resolve()` produces backslashes, so a raw `startsWith()` matches
    // nothing and every module of the app is filed under the app's own name
    expect(stdout).not.toContain('buildable ');
  }, 60_000);

  it('should take a name for the executable', async () => {
    await sigil('build', join(fixtures, 'buildable'), '--out', out, '--name', 'renamed');
    expect(existsSync(join(out, 'renamed.mjs'))).toBe(true);
  }, 60_000);

  it('should refuse an app that does not check out', async () => {
    // bundling an app with a type error produces an executable nobody should
    // run, and finding out at run time what a compiler knew at build time is
    // the thing a build is for
    const { err } = await sigil('build', join(fixtures, 'typecheck', 'broken'), '--out', out);

    expect(err).toContain('TS2322');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(out, 'broken-app.mjs'))).toBe(false);
  }, 60_000);

  it('should build despite a warning, which is not a failure', async () => {
    // a description the build could not read leaves a command exactly where an
    // unbundled one is
    const { err } = await sigil('build', join(fixtures, 'app'), '--out', out);

    expect(err).toContain('warning');
    expect(process.exitCode).toBeFalsy();
    expect(existsSync(join(out, 'fixture-app.mjs'))).toBe(true);
  }, 60_000);

  it("should warn about a routed module's alias and leave it out of the built app's help", async () => {
    // SIG-316. The module is read after argv matched `list`, so `ls` never
    // routed, and a built app is no different: the warning is the build saying
    // so, and the built help must not print what the warning says is ignored
    const { err } = await sigil(
      'build',
      join(fixtures, 'discover', 'module-routing'),
      '--out',
      out
    );

    expect(err).toContain('src/commands/list.ts:1:18: warning: "name" declares "ls"');
    expect(process.exitCode).toBeFalsy();

    const exe = join(out, 'module-routing.mjs');
    const help = spawnSync(process.execPath, [exe, 'help', 'list'], { encoding: 'utf-8' });
    expect(help.stdout).toContain('List things');
    expect(help.stdout).not.toContain('Alias');

    const routed = spawnSync(process.execPath, [exe, 'ls'], { encoding: 'utf-8' });
    expect(routed.status).toBe(2);
    expect(routed.stderr).toContain('Unexpected argument "ls"');
  }, 60_000);

  it("should route a commands.json's alias and default after a build, as from source", async () => {
    // SIG-324. The build reads the file through the runtime's own reader and
    // bakes what it says, so a built app answers to the same spellings
    const { err } = await sigil(
      'build',
      join(fixtures, 'discover', 'routes-manifest'),
      '--out',
      out
    );

    expect(err).toContain('"gone" names no command');
    expect(process.exitCode).toBeFalsy();

    const exe = join(out, 'routes-manifest.mjs');
    const run = (...argv: string[]) =>
      spawnSync(process.execPath, [exe, ...argv], { encoding: 'utf-8' });

    expect(run('ls').stdout).toBe('listed\n');
    expect(run().stdout).toBe('opened\n');
    expect(run('database', 'm').stdout).toBe('migrated\n');

    const help = run('--help').stdout;
    expect(help).toMatch(/list\s+List the things/);
    expect(help).toMatch(/db\s+Database things/);
    expect(help).not.toContain('open');

    const stale = run('g');
    expect(stale.status).toBe(2);
    expect(stale.stderr).toContain('Unexpected argument "g"');
  }, 60_000);

  it('a package the schema points at answered to its own name from source and to the schema key once built', async () => {
    // SIG-332. `commands: { foo: './pkg' }` over a package whose module says
    // `name: 'lazy, lz', alias: 'pk'`: the runtime imports it when the schema is
    // built and registers it under its own names, so from source `lazy`, `lz`
    // and `pk` ran and `foo` was `Unexpected argument`, while the build baked
    // the key and the built app answered the other way round. `bar` is a
    // package whose module names nothing, which the manifest's name names.
    const app = join(fixtures, 'keyed-package');
    const { err } = await sigil('build', app, '--out', out);

    // nothing about a package's own names, which are what route it
    expect(err).not.toContain('"name"');
    expect(process.exitCode).toBeFalsy();

    const exe = join(out, 'keyed-package.mjs');
    const built = (...argv: string[]) =>
      spawnSync(process.execPath, [exe, ...argv], { cwd: tmpdir(), encoding: 'utf-8' });
    const source = (...argv: string[]) =>
      spawnSync(process.execPath, [join(app, 'dev.ts'), ...argv], {
        cwd: tmpdir(),
        encoding: 'utf-8',
      });

    // what each spelling does, from source, is what it does built
    for (const spelling of ['lazy', 'lz', 'pk', 'foo', 'bare-pkg', 'bar']) {
      const [from, after] = [source(spelling), built(spelling)];
      expect({ spelling, status: after.status, stdout: after.stdout }).toStrictEqual({
        spelling,
        status: from.status,
        stdout: from.stdout,
      });
      expect(after.stderr, spelling).toBe(from.stderr);
    }

    // and that answer is the package's names, not the keys
    expect(built('lz').stdout).toBe('lazy\n');
    expect(built('pk').stdout).toBe('lazy\n');
    expect(built('bare-pkg').stdout).toBe('bare\n');
    expect(built('foo').stderr).toContain('Unexpected argument "foo"');
    expect(built('bar').status).toBe(2);

    // help lists the package's name string, described before anything loads
    const help = built('--help').stdout;
    expect(help).toMatch(/^\s+lazy, lz\s+A package that names itself$/m);
    expect(help).toMatch(/^\s+bare-pkg\s+A package named by its manifest$/m);
  }, 60_000);

  it('a translated desc was baked as English for a { load } or { path } command, beside a translated string path', async () => {
    // SIG-352. One module whose `desc` is a `__` tag, reached as `{ load }`,
    // `{ path }` and a string path. The two object forms baked the English and
    // the string path the thunk, so the built `--help` listed `loaded  Build
    // the app` beside `pathed  Die App bauen`
    const app = join(fixtures, 'discover', 'translated-placeholders');
    const { err } = await sigil('build', app, '--out', out, '--no-sourcemap');

    expect(err).not.toContain('error');
    expect(process.exitCode).toBeFalsy();

    const env = { ...process.env, LANG: undefined, LC_ALL: undefined, SIGIL_LOCALE: 'de' };
    const built = (...argv: string[]) =>
      spawnSync(process.execPath, [join(out, 'translated-placeholders.mjs'), ...argv], {
        cwd: tmpdir(),
        encoding: 'utf-8',
        env,
      });
    const source = (...argv: string[]) =>
      spawnSync(process.execPath, [join(app, 'dev.ts'), ...argv], {
        cwd: tmpdir(),
        encoding: 'utf-8',
        env,
      });

    const help = built('--help').stdout;
    for (const name of ['loaded', 'object', 'pathed']) {
      // what the built app lists before loading anything is what the app run
      // from source says once the module has loaded
      const loaded = source('help', name);
      expect(loaded.stdout, name).toContain('Die App bauen');
      expect(help).toMatch(new RegExp(`^\\s+${name}\\s+Die App bauen$`, 'm'));
    }
    expect(help).not.toContain('Build the app');

    // a placeholder's own literal is what both list before the module loads,
    // untranslated, because it is prose rather than a key
    expect(source('--help').stdout).toMatch(/^\s+literal\s+Its own words$/m);
    expect(help).toMatch(/^\s+literal\s+Its own words$/m);
  }, 60_000);

  it("a placeholder's own desc or hidden lost to the module's when it was not a plain literal", async () => {
    // SIG-352. What a placeholder declares is what an unloaded command shows
    // from source, readable or not; the build baked the module's `desc` over a
    // tagged, thunked or computed one, and the module's `hidden` over a
    // computed one
    const app = join(fixtures, 'discover', 'placeholder-decides');
    const { err } = await sigil('build', app, '--out', out, '--no-sourcemap');

    expect(err).toContain('the "computed" command\'s "desc" is computed');
    expect(err).toContain('the "shown" command\'s "hidden" is computed');
    expect(process.exitCode).toBeFalsy();

    const env = { ...process.env, LANG: undefined, LC_ALL: undefined, SIGIL_LOCALE: 'de' };
    const run = (file: string) =>
      spawnSync(process.execPath, [file, '--help'], { cwd: tmpdir(), encoding: 'utf-8', env })
        .stdout;
    const built = run(join(out, 'placeholder-decides.mjs'));
    const source = run(join(app, 'dev.ts'));

    // the same rows, from the same declarations, before anything loads
    for (const row of [
      /^\s+tagged\s+Placeholder words$/m,
      /^\s+thunk\s+Platzhalterworte$/m,
      /^\s+shown$/m,
    ]) {
      expect(source).toMatch(row);
      expect(built).toMatch(row);
    }
    expect(built).not.toContain('Die App bauen');

    // the one the build cannot read is listed by name alone, as it warned
    expect(source).toMatch(/^\s+computed\s+computed words$/m);
    expect(built).toMatch(/^\s+computed$/m);
  }, 60_000);

  it('a desc or hidden written before a spread was baked, though the spread replaces it at run time', async () => {
    // SIG-352. `{ desc: 'early', hidden: false, ...base }` runs as `base` says,
    // and the build lifted `early` with no warning -- so the built `--help`
    // listed `early  early` for a command whose description is `from base`
    const app = join(fixtures, 'discover', 'spread-order');
    const { err } = await sigil('build', app, '--out', out, '--no-sourcemap');

    expect(err).toContain('"desc" is written before a spread or a computed key');
    expect(err).toContain('"hidden" is written before a spread or a computed key');
    expect(process.exitCode).toBeFalsy();

    const built = (...argv: string[]) =>
      spawnSync(process.execPath, [join(out, 'spread-order.mjs'), ...argv], {
        cwd: tmpdir(),
        encoding: 'utf-8',
      });
    const source = (...argv: string[]) =>
      spawnSync(process.execPath, [join(app, 'dev.ts'), ...argv], {
        cwd: tmpdir(),
        encoding: 'utf-8',
      });

    // nothing is baked for `early`, so it is listed exactly as it is from
    // source before its module loads: by name alone
    const help = built('--help').stdout;
    expect(help).toMatch(/^\s+early$/m);
    expect(help).not.toMatch(/^\s+early\s+early$/m);
    expect(source('--help').stdout).toMatch(/^\s+early$/m);
    // ...while a key after the spread is still read
    expect(help).toMatch(/^\s+late\s+late$/m);

    // and once it loads, both say what the module runs with
    for (const name of ['early', 'late']) {
      expect(built('help', name).stdout, name).toBe(source('help', name).stdout);
    }
    expect(built('help', 'early').stdout).toContain('from base');
  }, 60_000);

  it("a placeholder's alias and default were read from their first spelling, so the build refused an app that starts and baked what a spread replaces", async () => {
    // SIG-430. `{ default: 'yes', default: true }` and `{ alias: 42, alias:
    // 'rm' }` start from source and failed the build; `{ alias: 'del', ...base }`
    // and `{ default: true, ...off }` baked `del` and `true`, so the built app
    // answered to a spelling and ran a default the app does not
    const app = join(fixtures, 'discover', 'placeholder-spellings');
    const { err } = await sigil('build', app, '--out', out, '--no-sourcemap');

    expect(err).not.toContain('error:');
    expect(err).toContain(
      'the "purge" command\'s "alias" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; the built app will not answer to the alias the app runs with'
    );
    expect(err).toContain(
      'the "stage" command\'s "default" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; the built app will not run it when argv names no command'
    );
    expect(process.exitCode).toBeFalsy();

    const spawn = (file: string, argv: string[]) => {
      const { status, stderr, stdout } = spawnSync(process.execPath, [file, ...argv], {
        cwd: tmpdir(),
        encoding: 'utf-8',
      });
      return { status, stderr, stdout };
    };
    const built = (...argv: string[]) => spawn(join(out, 'placeholder-spellings.mjs'), argv);
    const source = (...argv: string[]) => spawn(join(app, 'dev.ts'), argv);

    // the last spelling routes, and `del` is replaced by the spread both ways
    for (const argv of [[], ['rm'], ['del'], ['stage']]) {
      expect(built(...argv), argv.join(' ')).toStrictEqual(source(...argv));
    }
    expect(source().stdout).toBe('ship ran\n');
    expect(source('rm').stdout).toBe('remove ran\n');
    expect(source('del').stderr).toContain('Unexpected argument "del"');

    // what the spread carries is not read, so the built app does not answer to
    // it -- the one difference, and the one the warning names
    expect(source('erase').stdout).toBe('purge ran\n');
    expect(built('erase').stderr).toContain('Unexpected argument "erase"');
  }, 60_000);

  it("a placeholder's name, path and load were read from their first spelling, so the built app routed by a name and ran a module the app does not", async () => {
    // SIG-433, SIG-434. The runtime registers the last spelling of a key, and
    // the build read the first: `{ name: 'first', name: 'second' }` answered to
    // `first` built and to `second` from source, and a doubled `path` or `load`
    // bundled the module the app never runs
    const app = join(fixtures, 'discover', 'placeholder-names');
    const { err } = await sigil('build', app, '--out', out, '--no-sourcemap');

    expect(err).not.toContain('error:');
    expect(process.exitCode).toBeFalsy();

    const spawn = (file: string, argv: string[]) => {
      const { status, stderr, stdout } = spawnSync(process.execPath, [file, ...argv], {
        cwd: tmpdir(),
        encoding: 'utf-8',
      });
      return { status, stderr, stdout };
    };
    const built = (...argv: string[]) => spawn(join(out, 'placeholder-names.mjs'), argv);
    const source = (...argv: string[]) => spawn(join(app, 'dev.ts'), argv);

    const argvs = [
      ['first'],
      ['second'],
      ['final'],
      ['later'],
      ['pathed'],
      ['loaded'],
      // what a literal holds is read, and not evaluated (SIG-433, SIG-434)
      ['quote'],
      ['quoted'],
      ['quotedpath'],
      ['inlined'],
      ['deep'],
      ['logical'],
      ['conditional'],
      ['symbol'],
      ['asynced'],
    ];
    for (const argv of argvs) {
      expect(built(...argv), argv.join(' ')).toStrictEqual(source(...argv));
    }

    // the last spelling routes and the first does not, from source and built
    expect(source('second').stdout).toBe('first ran\n');
    expect(source('first').stderr).toContain('Unexpected argument "first"');
    expect(source('final').stdout).toBe('second ran\n');
    // and the module that runs is the last one named
    expect(source('pathed').stdout).toBe('b ran\n');
    expect(source('loaded').stdout).toBe('b ran\n');
    // ...and each of those runs, from source and built
    for (const argv of ['quote', 'quotedpath', 'inlined', 'deep', 'logical', 'conditional']) {
      expect(source(argv).stdout, argv).toMatch(/^[ab] ran\n$/);
    }
    expect(source('symbol').stdout).toBe('a ran\n');
    expect(source('asynced').stdout).toBe('b ran\n');
  }, 60_000);

  it('should refuse a placeholder whose name, path or load a spread or a computed key may carry or replace', async () => {
    // SIG-433, SIG-434. Each of these runs from source. A built app that guessed
    // answered to `early` where the app answers to `later`, or matched a command
    // whose module it never bundled and printed help with exit 0 -- under a
    // build that reported success. One error for each placeholder, however many
    // of its keys the spread blocks
    const app = join(fixtures, 'discover', 'placeholder-refused');
    const { err } = await sigil('build', app, '--out', out, '--no-sourcemap');

    const errors = err.split('\n').filter((line) => line.includes(': error: '));
    expect(errors).toHaveLength(7);
    const only = (command: string) => {
      const found = errors.filter((line) => line.includes(`error: the "${command}" command `));
      expect(found, command).toHaveLength(1);
      return found[0]!;
    };

    expect(only('spreadname')).toContain(
      'writes "name" before a spread or a computed key, which may replace it when the app runs'
    );
    expect(only('carriedname')).toContain('spreads another object, which may carry its "name";');
    for (const command of ['carried', 'loadcarried']) {
      expect(only(command)).toContain(
        'spreads another object, which may carry its "name", "path" or "load"'
      );
    }
    expect(only('replaced')).toContain('writes "path" before a spread or a computed key');
    expect(only('replaced')).toContain('which may carry its "name" or "load"');
    expect(only('loadreplaced')).toContain('writes "load" before a spread or a computed key');
    expect(only('computed')).toContain(
      'has a computed key, which may be its "name", "path" or "load"'
    );
    // what to write instead, which is the same for each
    for (const line of errors) {
      expect(line).toContain('literally, after the last spread or computed key');
    }
    // ...and never asks for a `path` and a `load` together, which is itself
    // refused (`Cannot combine`): one of them, and the name as well where it is
    // blocked
    expect(only('carried')).toContain(
      'spell "name" and one of "path" or "load" literally, after the last spread or computed key'
    );
    expect(only('carriedname')).toContain(
      'spell "name" literally, after the last spread or computed key'
    );
    for (const line of errors) {
      expect(line).not.toContain('"path" and "load"');
    }
    // the file and line, which is where to write it
    expect(errors[0]).toMatch(/src[\\/]index\.js:\d+:\d+: error: /);
    // and the advice that cannot be followed is not given: the name is already
    // left out
    expect(err).not.toContain('leave it out');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(out, 'placeholder-refused.mjs'))).toBe(false);

    // each one runs from source, which is what the refusal is for
    const source = (...argv: string[]) =>
      spawnSync(process.execPath, [join(app, 'dev.ts'), ...argv], {
        cwd: tmpdir(),
        encoding: 'utf-8',
      });
    expect(source('later').stdout).toBe('two ran\n');
    expect(source('carried').stdout).toBe('three ran\n');
    expect(source('loadcarried').stdout).toBe('four ran\n');
    expect(source('computed').stdout).toBe('seven ran\n');
  }, 60_000);

  it.each([
    // [app, what it runs from source, what the build says]
    // SIG-433: a name from a spread, a computed key, an accessor or an expression
    ['name-spread', 'later', 'spreads another object, which may carry its "name"'],
    ['name-before', 'later', 'writes "name" before a spread or a computed key'],
    ['name-computed-key', 'later', 'has a computed key, which may be its "name"'],
    ['name-getter', 'later', '"name" is an accessor rather than a string literal'],
    ['name-template', 'pre-x', '"name" is computed rather than a string literal'],
    ['name-call', 'later', '"name" is computed rather than a string literal'],
    // SIG-434: a module from a spread, or one the build cannot read
    ['path-spread', 'x', 'spreads another object, which may carry its "path" or "load"'],
    ['path-before', 'x', 'writes "path" before a spread or a computed key'],
    ['load-spread', 'x', 'spreads another object, which may carry its "path" or "load"'],
    ['path-join', 'x', '"path" is not a string literal'],
    ['path-shorthand', 'x', '"path" is not a string literal'],
    ['path-getter', 'x', '"path" is an accessor or a method rather than a value'],
    ['load-block', 'x', '"load" is not an arrow function returning a literal import()'],
    ['load-method', 'x', '"load" is an accessor or a method rather than a value'],
    ['both', undefined, 'Cannot combine "load" with "path" in the "x" command'],
  ])(
    'should refuse %s, which has that one thing wrong with it, and no other',
    async (name, runs, message) => {
      // SIG-433, SIG-434. Each is an app with exactly one placeholder and exactly
      // one problem, so that the exit code alone says which refusal it was: a
      // refusal that was only a warning would leave the build at exit 0, and none
      // of these has a second error to fail it. The source answers where the app
      // starts, which is why a build that said nothing was wrong
      const app = join(fixtures, 'discover', 'placeholder-single');
      const { err } = await sigil('build', app, '--entry', `src/${name}.js`, '--out', out);

      const errors = err.split('\n').filter((line) => line.includes(': error: '));
      expect(errors, err).toHaveLength(1);
      expect(errors[0]).toMatch(new RegExp(`src[\\\\/]${name}\\.js:\\d+:\\d+: error: `));
      expect(errors[0]).toContain(message);
      expect(process.exitCode).toBe(1);
      expect(existsSync(join(out, 'placeholder-single.mjs'))).toBe(false);

      const source = spawnSync(process.execPath, [join(app, 'dev.ts'), runs ?? 'x'], {
        cwd: tmpdir(),
        encoding: 'utf-8',
        env: { ...process.env, SCHEMA: join(app, 'src', `${name}.js`) },
      });
      if (runs === undefined) {
        // the runtime refuses it too, in the same words
        expect(source.stderr).toContain(message);
      } else {
        expect(source.stderr, `${name} from source`).toBe('');
        expect(source.stdout).toMatch(/^[ab] ran\n$/);
      }
    },
    60_000
  );

  it('should refuse a package the schema points at whose names it cannot read', async () => {
    // SIG-332. From source such a package answers to whatever its module
    // computes, so a build that baked the key, or guessed, would route the built
    // app differently -- the refusal a walked `commands/` package already gets
    const { err } = await sigil('build', join(fixtures, 'discover', 'package-names'), '--out', out);

    expect(err).toContain('the "computed" command\'s "name" is computed');
    expect(err).toContain('the "listed" command\'s "alias" is computed');
    expect(err).toContain('the "spread" command is a package whose default export spreads');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(out, 'package-names.mjs'))).toBe(false);
  }, 60_000);

  it('should refuse an alias of the wrong type, as the app does from source', async () => {
    // `alias: 42` throws on every run from source. A build that warned and
    // carried on would write an app that starts, which is a worse answer than
    // the error the author already gets
    const { err } = await sigil('build', join(fixtures, 'discover', 'wrong-types'), '--out', out);

    expect(err).toContain('Expected alias in "number" command to be a string or list of strings');
    expect(err).toContain('Expected default in "text" command to be a boolean');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(out, 'wrong-types.mjs'))).toBe(false);
  }, 60_000);

  it('should build despite a placeholder property it cannot carry, and say which', async () => {
    // an inline `run`, `options`, `args` and the rest apply from source and not
    // after a build (SIG-320); until they are baked the build says so rather than
    // writing an app that quietly behaves differently
    const { err } = await sigil('build', join(fixtures, 'discover', 'unbaked'), '--out', out);

    expect(err).toContain('the "hi" command declares "run"');
    expect(err).toContain('the "remove" command declares "options"');
    expect(err).toContain('SIG-320');
    expect(process.exitCode).toBeFalsy();
    expect(existsSync(join(out, 'unbaked.mjs'))).toBe(true);
  }, 60_000);

  it('should refuse --bin beside a filesystem command directory', async () => {
    // a built executable has no directories to walk, so an app bundled as it
    // stands would read paths that are not beside it
    const { err } = await sigil(
      'build',
      join(fixtures, 'buildable'),
      '--out',
      out,
      '--bin',
      'src/index.ts'
    );

    expect(err).toContain('Cannot combine --bin');
    expect(process.exitCode).toBe(1);
  }, 60_000);

  it('should refuse an entry that exports no schema, which a built app would die on at start', async () => {
    // SIG-567. The schema is written in the entry's own `main()` call, so every
    // reader finds it and the build used to succeed; the generated entry takes
    // `default ?? schema` from the module, finds neither, and stops at start
    const { err } = await sigil('build', join(fixtures, 'discover', 'inline-main'), '--out', out);

    expect(err).toContain('this entry exports none');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(out, 'inline-main.mjs'))).toBe(false);
  }, 60_000);

  it('should refuse it under --commands as well, which says where the commands are', async () => {
    const { err } = await sigil(
      'build',
      join(fixtures, 'discover', 'inline-main'),
      '--commands',
      'src/commands',
      '--out',
      out
    );

    expect(err).toContain('this entry exports none');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(out, 'inline-main.mjs'))).toBe(false);
  }, 60_000);

  it('should refuse a directory that is not a sigil app', async () => {
    const { err } = await sigil('build', join(fixtures, 'discover', 'not-an-app'), '--out', out);

    expect(err).toContain('does not depend on @ttylabs/sigil');
    expect(process.exitCode).toBe(1);
  });

  it('should refuse an app whose tsconfig preserves its JSX', async () => {
    // the build reported success and the executable died with
    // `Unexpected token '<'`, which is the shape the unresolved gate and
    // `--external` are both written for. From the command because that is where
    // the author reads the message, and the message has to name the tsconfig
    // setting: it is the fix, and one about a syntax error in generated code
    // sends them looking at the generated code
    const { err } = await sigil('build', join(fixtures, 'jsx-preserve'), '--out', out);

    expect(err).toContain('still holds JSX');
    expect(err).toContain('"jsx"');
    expect(err).toContain('tsconfig.json');
    expect(process.exitCode).toBe(1);
    // and nothing shipped, because the refusal is about not handing over a
    // bundle that would die on first use
    expect(existsSync(join(out, 'jsx-preserve.mjs'))).toBe(false);
    expect(readdirSync(out)).toStrictEqual([]);
  }, 60_000);

  it('should report an --out it cannot write as being about that', async () => {
    // a `bundle.write()` that rejects, which is what `bundle-close.test.ts`
    // needs and is worth pinning from the command as well: what the user is
    // told has to name the directory rather than whatever went wrong on the
    // way out of it.
    //
    // `--no-clean` is what makes an existing *file* reach the write, and it is
    // the whole reason this spelling is the one used. `clean()` is a single
    // `rmSync`, so without the flag the file is simply deleted and `write()`
    // makes a directory where it was -- measured, exit 0. A read-only parent
    // directory is the other way to provoke the same rejection and would have
    // to be skipped on Windows, where a mode of `0o500` stops nothing being
    // created inside it; this one runs everywhere.
    const file = join(out, 'afile');
    writeFileSync(file, 'x');

    const { err } = await sigil('build', join(fixtures, 'buildable'), '--out', file, '--no-clean');

    expect(err).toContain('EEXIST');
    expect(err).toContain(file);
    expect(process.exitCode).toBe(1);
    // still a file, so nothing was written over it
    expect(statSync(file).isFile()).toBe(true);
  }, 60_000);

  it('should refuse a custom update check url that the worker could not fetch (SIG-546)', async () => {
    const app = linkedFixture(join(fixtures, 'buildable'), 'sigil-build-custom-url-');
    writeFileSync(
      join(app, 'sigil.json'),
      JSON.stringify({ updateCheck: { path: ['v'], type: 'custom', url: 'ftp://h/latest.json' } })
    );

    const { err } = await sigil('build', app, '--out', out, '--no-sourcemap');

    expect(err).toContain('Update check "updateCheck.url" must be an absolute https:// URL');
    expect(process.exitCode).toBe(1);
  }, 60_000);

  it('should bake a custom update check url that carries a query (SIG-546)', async () => {
    const app = linkedFixture(join(fixtures, 'buildable'), 'sigil-build-custom-query-');
    writeFileSync(
      join(app, 'sigil.json'),
      JSON.stringify({
        updateCheck: { path: ['v'], type: 'custom', url: 'https://h/api/latest?channel=stable' },
      })
    );

    const { err } = await sigil('build', app, '--out', out, '--no-sourcemap');

    expect(err).not.toContain('updateCheck.url');
    expect(process.exitCode).not.toBe(1);
  }, 60_000);

  it('should bake the locale `sigil.json` named into the app it builds', async () => {
    // the wiring the command owns: `bundle.test.ts` calls `bundleApp()` with
    // the locale already read, so without this the one line that gets it out of
    // the config and into the build is pinned by nothing
    const { err } = await sigil('build', join(fixtures, 'i18n'), '--out', out, '--no-sourcemap');

    expect(err).not.toContain('Error');

    const built = spawnSync(process.execPath, [join(out, 'fixture-i18n.mjs'), '--help'], {
      cwd: tmpdir(),
      encoding: 'utf-8',
      // the locale is the *bottom* of the chain, so the environment has to say
      // nothing for the config's answer to be the one that is read
      env: {
        ...process.env,
        LANG: undefined,
        LC_ALL: undefined,
        LC_MESSAGES: undefined,
        SIGIL_LOCALE: undefined,
      },
    });

    expect(built.status).toBe(0);
    expect(built.stdout).toContain('Verwendung:');
    expect(built.stdout).toContain('Die App bauen');
  }, 60_000);
});

/** What `sigil build` said the utility sheet came to, or nothing. */
function ruleCount(err: string): string | undefined {
  return /(\d+) of 383 utility rules/.exec(err)?.[1];
}

/**
 * SIG-354, the shake's half: what a build keeps of the utility sheet depended on
 * whether an earlier build's `dist/` was lying beside the app.
 */
describe('a previous dist/ read as class evidence', () => {
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    exitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it('should count the same utility rules with no dist/, a shaken one and an unshaken one', async () => {
    // `--out dist2` is the path `sigil package` takes too: the bundle goes
    // somewhere other than the app's configured output, and only the directory
    // being written was excluded from the walk -- so the `dist/` an earlier
    // `sigil build` left was parsed as source, and its copy of the utility
    // sheet is evidence for every rule it kept. Measured before the fix as 25,
    // 58 and 383 of 383 for an app whose source names 25
    const app = linkedFixture(join(fixtures, 'styled'), 'sigil-build-stale-dist-');
    const count = async (): Promise<string | undefined> =>
      ruleCount((await sigil('build', app, '--out', join(app, 'dist2'))).err);

    const none = await count();

    await sigil('build', app);
    // the precondition, so that a dist/ the shake never had a chance to read
    // cannot pass this
    expect(existsSync(join(app, 'dist', 'styled.mjs'))).toBe(true);
    const shaken = await count();

    await sigil('build', app, '--no-shake');
    expect(bundledCode(join(app, 'dist'))).toContain('justify-around');
    const unshaken = await count();

    expect(none).toBeDefined();
    expect(Number(none)).toBeLessThan(383);
    expect([shaken, unshaken]).toStrictEqual([none, none]);
  }, 120_000);

  it('should leave out the directory sigil.json builds into, not only the default', async () => {
    // `build.out` is what an app that renamed its output has lying around, and
    // the rule is every configured output directory rather than one called dist
    const app = linkedFixture(join(fixtures, 'styled'), 'sigil-build-stale-out-');
    writeFileSync(join(app, 'sigil.json'), JSON.stringify({ build: { out: 'built' } }));

    const before = ruleCount((await sigil('build', app, '--out', join(app, 'dist2'))).err);
    await sigil('build', app, '--no-shake');
    expect(existsSync(join(app, 'built', 'styled.mjs'))).toBe(true);
    const after = ruleCount((await sigil('build', app, '--out', join(app, 'dist2'))).err);

    expect(Number(before)).toBeLessThan(383);
    expect(after).toBe(before);
  }, 120_000);

  it('should still read source in release/, which a build never writes', async () => {
    // the first version of the fix left out `package.out` as well, and that
    // directory holds binaries no module pattern matches -- so excluding it
    // protected nothing, and an app that keeps code under `release/` and never
    // packages lost that code's evidence: these two rules were dropped
    const app = linkedFixture(join(fixtures, 'styled'), 'sigil-build-release-src-');
    mkdirSync(join(app, 'release'));
    writeFileSync(
      join(app, 'release', 'extra.ts'),
      "export const extra = 'justify-around underline';\n"
    );

    const { err } = await sigil('build', app, '--out', join(app, 'dist2'));

    expect(err).not.toContain('Error');
    expect(bundledCode(join(app, 'dist2'))).toContain('justify-around');
  }, 60_000);
});

/**
 * SIG-354, the template half: a template that cannot be compiled reached the
 * user inside rolldown's aggregated message, with seven of the toolchain's own
 * stack frames under it.
 */
describe('a template that cannot be compiled', () => {
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    exitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  /** What every stack frame node prints starts with. */
  const FRAME = /^\s+at /m;

  /** What the template parser says about the interpolations below. */
  const QUOTED = 'An interpolation inside a quoted value is not supported';

  /**
   * A copy of the `templated` fixture whose command imports broken templates
   * from modules `check` does not read -- so the bundle is what finds them --
   * in two modules, and twice in one of them.
   *
   * @returns The app's root.
   */
  function brokenHelpers(): string {
    const app = linkedFixture(join(fixtures, 'templated'), 'sigil-build-bad-tpl-');
    writeFileSync(
      join(app, 'src', 'helper.ts'),
      [
        "import { ui } from '@ttylabs/sigil/template';",
        '',
        'export const one = () => ui`<text class="a ${\'b\'} c">x</text>`;',
        '',
        'export const two = () => ui`<text><box /></text>`;',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(app, 'src', 'other.ts'),
      [
        "import { ui } from '@ttylabs/sigil/template';",
        '',
        'export const three = () => ui`<text class="p ${\'q\'}">y</text>`;',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(app, 'src', 'commands', 'greet.ts'),
      [
        "import { command, type AnyCommand } from '@ttylabs/sigil';",
        "import { renderToString } from '@ttylabs/sigil/element';",
        "import { one, two } from '../helper.ts';",
        "import { three } from '../other.ts';",
        '',
        'const greet: AnyCommand = command({',
        "  desc: 'Greet with templates that do not compile',",
        '  run() {',
        '    process.stdout.write(renderToString(one()) + renderToString(two()) + renderToString(three()));',
        '  },',
        '});',
        '',
        'export default greet;',
        '',
      ].join('\n')
    );
    return app;
  }

  it('should print each failure as one located line, with no stack', async () => {
    const app = brokenHelpers();

    const { err, out } = await sigil('build', app);

    // one line per template, relative to the app and forward-slashed, which is
    // what every other diagnostic the build prints looks like -- and every
    // template, in both modules, rather than the first one rolldown reached
    const helper = displayPath(join('src', 'helper.ts'));
    expect(err).toContain(`${helper}:3:26: error: ${QUOTED}`);
    expect(err).toContain(`${helper}:5:26: error: An element cannot go inside <text>`);
    expect(err).toContain(`${displayPath(join('src', 'other.ts'))}:3:28: error: ${QUOTED}`);
    expect(err).toContain('3 errors in templated');

    // and nothing of the toolchain's own: not a frame, not rolldown's wrapper,
    // not the error's class name
    expect(err).not.toMatch(FRAME);
    expect(out).not.toMatch(FRAME);
    expect(err).not.toContain('Build failed with');
    expect(err).not.toContain('TemplateCompileError');

    expect(process.exitCode).toBe(1);
    // what the refused build wrote is unwound, as it is for the other gates
    expect(existsSync(join(app, 'dist', 'templated.mjs'))).toBe(false);
  }, 60_000);

  it('should say the same line from check, build and package', async () => {
    // a command module is one `check` reads, so all three find it before any
    // bundling, and say it identically
    const app = linkedFixture(join(fixtures, 'templated'), 'sigil-build-bad-cmd-');
    writeFileSync(
      join(app, 'src', 'commands', 'greet.ts'),
      [
        "import { command, type AnyCommand } from '@ttylabs/sigil';",
        "import { renderToString } from '@ttylabs/sigil/element';",
        "import { ui } from '@ttylabs/sigil/template';",
        '',
        'const greet: AnyCommand = command({',
        "  desc: 'Greet with a template that does not compile',",
        '  run() {',
        '    process.stdout.write(renderToString(ui`<text class="a ${\'b\'} c">x</text>`));',
        '  },',
        '});',
        '',
        'export default greet;',
        '',
      ].join('\n')
    );
    const line = `${displayPath(join('src', 'commands', 'greet.ts'))}:8:41: error: ${QUOTED}`;

    for (const argv of [
      ['check', app],
      ['build', app],
      // the read refuses before any pre-flight, so this needs no compiler and
      // fetches nothing
      ['package', app, '--runtime', 'bun', '--out', join(app, 'release')],
    ]) {
      process.exitCode = undefined;
      const { err, out } = await sigil(...argv);

      expect(err, argv[0]).toContain(line);
      expect(err, argv[0]).not.toMatch(FRAME);
      expect(out, argv[0]).not.toMatch(FRAME);
      expect(process.exitCode, argv[0]).toBe(1);
    }
  }, 60_000);

  it('should refuse an unknown prop on a box and a text before the app runs (SIG-614)', async () => {
    // the cascade refused these on the first frame, as a style error, which is
    // after the build had reported success. `check` and `build` read the same
    // template and say the same line
    const app = linkedFixture(join(fixtures, 'templated'), 'sigil-build-bad-prop-');
    writeFileSync(
      join(app, 'src', 'commands', 'greet.ts'),
      [
        "import { command, type AnyCommand } from '@ttylabs/sigil';",
        "import { renderToString } from '@ttylabs/sigil/element';",
        "import { ui } from '@ttylabs/sigil/template';",
        '',
        'const greet: AnyCommand = command({',
        "  desc: 'Greet with props nothing reads',",
        '  run() {',
        '    process.stdout.write(renderToString(ui`<box padddding="1">x</box>`));',
        '    process.stdout.write(renderToString(ui`<text colour="red">y</text>`));',
        '  },',
        '});',
        '',
        'export default greet;',
        '',
      ].join('\n')
    );
    const file = displayPath(join('src', 'commands', 'greet.ts'));

    for (const argv of [
      ['check', app],
      ['build', app],
    ]) {
      process.exitCode = undefined;
      const { err, out } = await sigil(...argv);

      expect(err, argv[0]).toContain(`${file}:8:41: error: <box> has no prop \`padddding\``);
      expect(err, argv[0]).toContain(`${file}:9:41: error: <text> has no prop \`colour\``);
      expect(err, argv[0]).not.toMatch(FRAME);
      expect(out, argv[0]).not.toMatch(FRAME);
      expect(process.exitCode, argv[0]).toBe(1);
    }
  }, 60_000);
});

/**
 * SIG-350: `sigil build --out src` removed the app's source and then failed,
 * because the clean guard refused only an `--out` at or above the app root. The
 * app is a copy in a temp directory, so a regression removes the copy's source
 * rather than a fixture's.
 */
describe('sigil build into its own source', () => {
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    exitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  /** A copy of the `buildable` fixture, and the files the build reads from it. */
  function copyApp(): { app: string; sources: string[] } {
    const app = join(tempDir('sigil-build-into-src-'), 'buildable');
    copyFixture(join(fixtures, 'buildable'), app);
    return {
      app,
      sources: [
        join(app, 'src', 'index.ts'),
        join(app, 'src', 'commands', 'greet.ts'),
        join(app, 'src', 'commands', 'db', 'migrate.js'),
      ],
    };
  }

  /**
   * Links `@ttylabs/sigil` into an app outside the workspace, so the bundle
   * resolves it from a temp directory. A junction, so Windows needs no
   * privilege to make one; elsewhere the type is ignored.
   */
  function linkSigil(app: string): void {
    mkdirSync(join(app, 'node_modules', '@ttylabs'), { recursive: true });
    symlinkSync(
      resolve(fixtures, '..', '..', '..', 'sigil'),
      join(app, 'node_modules', '@ttylabs', 'sigil'),
      'junction'
    );
  }

  /** A small app of the test's own, with `@ttylabs/sigil` linked in. */
  function smallApp(name: string, files: Record<string, string>): string {
    const app = join(tempDir('sigil-build-into-src-'), name);
    linkSigil(app);
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name, type: 'module' })
    );
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(dirname(join(app, file)), { recursive: true });
      writeFileSync(join(app, file), body);
    }
    return app;
  }

  const RUN = "export default { name: 'x', run() { console.log('ran'); } };\n";

  it('--out . --no-clean shakes to what a separate --out keeps', async () => {
    // `--out .` makes the output directory the app root, and the shaker leaves
    // the output directory out of its class evidence. Applied to the root
    // itself, that exclusion skipped the whole app: no source was read, every
    // rule off the safelist was shaken out, and the build reported success
    const app = join(tempDir('sigil-build-into-src-'), 'styled');
    copyFixture(join(fixtures, 'styled'), app);
    linkSigil(app);
    const kept = (err: string) => /(\d+) of 383 utility rules/.exec(err)?.[1];

    const elsewhere = await sigil('build', app, '--out', tempDir('sigil-build-into-src-'));
    const here = await sigil('build', app, '--out', '.', '--no-clean');

    expect(process.exitCode).toBeFalsy();
    expect(kept(elsewhere.err)).toBeDefined();
    expect(kept(here.err)).toBe(kept(elsewhere.err));
  }, 60_000);

  it.each([
    ['cli', 'is refused, because it would write cli.mjs over the entry'],
    ['other', 'still builds beside the manifest, which is the escape hatch'],
  ])(
    'a package called %s with a root entry cli.mjs, built --out . --no-clean, %s',
    async (name) => {
      const app = smallApp(name, { 'cli.mjs': RUN });

      const { err } = await sigil('build', app, '--entry', 'cli.mjs', '--out', '.', '--no-clean');

      if (name === 'cli') {
        expect(err).toContain(
          `Refusing to write over ${displayPath(join(app, 'cli.mjs'))}, which is cli.mjs`
        );
        expect(process.exitCode).toBeTruthy();
      } else {
        expect(err).not.toContain('Refusing');
        expect(process.exitCode).toBeFalsy();
        expect(existsSync(join(app, 'other.mjs'))).toBe(true);
      }
      expect(readFileSync(join(app, 'cli.mjs'), 'utf-8')).toBe(RUN);
    },
    60_000
  );

  it('--out . --no-clean wrote the bundle over a helper only the bundle reads, and reported success', async () => {
    // `tool.mjs` is imported by the entry and named nowhere the guard can see
    // before the bundle, and the package is called `tool` -- so the entry
    // the build writes is `tool.mjs`. Refused before anything is written
    const helper = "export const t = 'helper';\n";
    const app = smallApp('tool', {
      'src/index.mjs': `import { t } from '../tool.mjs';\nexport default { name: 'x', run() { console.log(t); } };\n`,
      'tool.mjs': helper,
    });

    const { err } = await sigil('build', app, '--out', '.', '--no-clean');

    expect(err).toContain(
      `Refusing to write ${displayPath(join(app, 'tool.mjs'))}, which is tool.mjs, a module the app is built from`
    );
    // the sentence and nothing else: rolldown wraps an error raised in a hook
    // as `[plugin sigil:own-source] RolldownError` with six frames of its own
    expect(err).not.toContain('RolldownError');
    expect(err).not.toMatch(/\n\s+at /);
    expect(process.exitCode).toBeTruthy();
    expect(readFileSync(join(app, 'tool.mjs'), 'utf-8')).toBe(helper);
    expect(existsSync(join(app, 'chunks'))).toBe(false);
  }, 60_000);

  describe('a previous bundle, which the shaker must not read as evidence', () => {
    // since the clean waits for the module graph, a previous bundle is still on
    // disk when the shaker walks the app, and its exclusion compared spellings:
    // a second build with `--out` spelled through `/tmp` kept 52 of 383 rules
    // and then 58, where it keeps 25. A junction stands in for `/tmp` here,
    // because it spells the same directory another way on every platform
    function styledApp(): { app: string; base: string } {
      const base = tempDir('sigil-build-into-src-');
      const app = join(base, 'styled');
      copyFixture(join(fixtures, 'styled'), app);
      mkdirSync(join(app, 'node_modules', '@ttylabs'), { recursive: true });
      symlinkSync(
        resolve(fixtures, '..', '..', '..', 'sigil'),
        join(app, 'node_modules', '@ttylabs', 'sigil'),
        'junction'
      );
      return { app, base };
    }

    const KEPT = /(\d+) of 383 utility rules/;

    it.each([
      [
        '--out spelled through a link to the app',
        (app: string, base: string) => {
          symlinkSync(app, join(base, 'alias'), 'junction');
          return join(base, 'alias', 'dist');
        },
      ],
      [
        '--out a link to the previous output',
        (app: string) => {
          symlinkSync(join(app, 'dist'), join(app, 'outlink'), 'junction');
          return join(app, 'outlink');
        },
      ],
    ])(
      'should keep what the first build kept, with %s',
      async (_, spell) => {
        const { app, base } = styledApp();

        const first = await sigil('build', app);
        const kept = KEPT.exec(first.err)?.[1];
        expect(kept, first.err).toBeDefined();

        const second = await sigil('build', app, '--out', spell(app, base));

        expect(KEPT.exec(second.err)?.[1], second.err).toBe(kept);
        expect(process.exitCode).toBeFalsy();
      },
      60_000
    );
  });

  it('should unlink an --out that is a link to a module directory, and leave the module alone', async () => {
    // `outlink` points at `lib/`, which holds `lib/tool.mjs`, a module the
    // entry imports. Removing `outlink` unlinks it and takes nothing behind it,
    // so the module check, which is about what a removal would take, is not
    // asked of a link -- asking it would refuse a build that loses nothing
    const tool = "export const t = 'tool';\n";
    const app = smallApp('lapp', {
      'lib/tool.mjs': tool,
      'src/index.mjs': `import { t } from '../lib/tool.mjs';\nexport default { name: 'x', run() { console.log(t); } };\n`,
    });
    symlinkSync(join(app, 'lib'), join(app, 'outlink'), 'junction');

    const { err } = await sigil('build', app, '--out', 'outlink');

    expect(err).not.toContain('Refusing');
    expect(process.exitCode).toBeFalsy();
    expect(lstatSync(join(app, 'outlink')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(app, 'outlink', 'lapp.mjs'))).toBe(true);
    expect(readFileSync(join(app, 'lib', 'tool.mjs'), 'utf-8')).toBe(tool);
  }, 60_000);

  it('--out vendor emptied a vendored module only the bundle reads, then failed on it', async () => {
    // nothing before the bundle names `vendor/lib.mjs` -- the entry imports it
    // -- so the clean waits for the graph, and refuses with the module named
    const lib = "export const t = 'vendored';\n";
    const app = smallApp('vapp', {
      'src/index.mjs': `import { t } from '../vendor/lib.mjs';\nexport default { name: 'x', run() { console.log(t); } };\n`,
      'vendor/lib.mjs': lib,
    });

    const { err } = await sigil('build', app, '--out', 'vendor');

    expect(err).toContain(
      `Refusing to empty ${displayPath(join(app, 'vendor'))}, which holds ${displayPath(join('vendor', 'lib.mjs'))}, a module the app is built from`
    );
    expect(err).not.toContain('Module not found');
    expect(err).not.toMatch(/\n\s+at /);
    expect(process.exitCode).toBeTruthy();
    expect(readFileSync(join(app, 'vendor', 'lib.mjs'), 'utf-8')).toBe(lib);
  }, 60_000);

  it('should still empty an output directory that holds no module, once the graph says so', async () => {
    // the clean moved to after the graph is read, and it still has to happen:
    // a build that leaves the last one behind publishes the union of both
    const app = smallApp('sapp', {
      'dist/stale.txt': 'stale\n',
      'src/index.mjs': RUN,
    });

    const { err } = await sigil('build', app);

    expect(err).not.toContain('Refusing');
    expect(process.exitCode).toBeFalsy();
    expect(existsSync(join(app, 'dist', 'stale.txt'))).toBe(false);
    expect(existsSync(join(app, 'dist', 'sapp.mjs'))).toBe(true);
  }, 60_000);

  it('--out outlink --no-clean, outlink a link to src, wrote the bundle over the source', async () => {
    const app = smallApp('buildable', { 'src/buildable.mjs': RUN });
    symlinkSync(join(app, 'src'), join(app, 'outlink'), 'junction');

    const { err } = await sigil(
      'build',
      app,
      '--entry',
      join('src', 'buildable.mjs'),
      '--out',
      'outlink',
      '--no-clean'
    );

    expect(err).toContain(
      `Refusing to build into ${displayPath(join(app, 'outlink'))}, which holds ${displayPath(join('src', 'buildable.mjs'))}`
    );
    expect(process.exitCode).toBeTruthy();
    expect(readFileSync(join(app, 'src', 'buildable.mjs'), 'utf-8')).toBe(RUN);
  }, 60_000);

  it('sigil build --out src deleted the app source and then failed on the missing entry', async () => {
    const { app, sources } = copyApp();

    const { err } = await sigil('build', app, '--out', 'src');

    expect(err).toContain(
      `Refusing to empty ${displayPath(join(app, 'src'))}, which holds ${displayPath(join('src', 'index.ts'))}`
    );
    expect(err).not.toContain('Module not found');
    expect(process.exitCode).toBeTruthy();
    for (const file of sources) {
      expect(existsSync(file), file).toBe(true);
    }
  }, 60_000);

  it('a build.out of src in sigil.json deleted the app source the same way', async () => {
    const { app, sources } = copyApp();
    writeFileSync(join(app, 'sigil.json'), `${JSON.stringify({ build: { out: 'src' } })}\n`);

    const { err } = await sigil('build', app);

    expect(err).toContain(
      `Refusing to empty ${displayPath(join(app, 'src'))}, which holds ${displayPath(join('src', 'index.ts'))}`
    );
    expect(process.exitCode).toBeTruthy();
    for (const file of sources) {
      expect(existsSync(file), file).toBe(true);
    }
    expect(existsSync(join(app, 'sigil.json'))).toBe(true);
  }, 60_000);

  it('sigil build --out src --no-clean wrote the bundle over the source and reported success', async () => {
    // nothing removed, but `<out>/<bin>.mjs` is the entry when the entry is
    // `src/<bin>.mjs` -- so it is refused whether or not it is emptied
    const { app, sources } = copyApp();

    const { err } = await sigil('build', app, '--out', 'src', '--no-clean');

    expect(err).toContain(
      `Refusing to build into ${displayPath(join(app, 'src'))}, which holds ${displayPath(join('src', 'index.ts'))}`
    );
    expect(process.exitCode).toBeTruthy();
    expect(existsSync(join(app, 'src', 'buildable.mjs'))).toBe(false);
    for (const file of sources) {
      expect(existsSync(file), file).toBe(true);
    }
  }, 60_000);

  it('sigil build --out locales deleted the catalogs the entry declares', async () => {
    const app = join(tempDir('sigil-build-into-src-'), 'i18n');
    copyFixture(join(fixtures, 'i18n'), app);

    const { err } = await sigil('build', app, '--out', 'locales');

    expect(err).toContain(
      `Refusing to empty ${displayPath(join(app, 'locales'))}, which holds ${displayPath(join('locales', 'de.json'))}`
    );
    expect(process.exitCode).toBeTruthy();
    expect(existsSync(join(app, 'locales', 'de.json'))).toBe(true);
  }, 60_000);

  it('should refuse the command directory, naming a module the build reads from it', async () => {
    const { app, sources } = copyApp();

    const { err } = await sigil('build', app, '--out', join('src', 'commands'));

    expect(err).toContain(
      `Refusing to empty ${displayPath(join(app, 'src', 'commands'))}, which holds`
    );
    expect(err).toContain('and the build reads it');
    expect(process.exitCode).toBeTruthy();
    for (const file of sources) {
      expect(existsSync(file), file).toBe(true);
    }
  }, 60_000);
});
