import { readRoutes } from '@ttylabs/sigil/routes';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The toolchain's own command surface, committed and checked.
 *
 * This is `registry.test.ts`'s shape one artifact along: a fact about the output
 * that a build checks rather than a reader trusts. The surface is the public API
 * of a CLI, so a pull request that renames a flag should **fail** -- and what it
 * fails is this, because `@ttylabs/cli`'s own publish runs no build check and the
 * committed file is the thing that matters.
 *
 * Why a test rather than the build: the build does not write a reference, and the
 * reason is recorded on `src/reference/load.ts` -- an option lives only inside the
 * module that declares it, so a reference means importing the app, which is the
 * one thing `sigil build` refuses by design. What an *app* fails is whatever it
 * puts `sigil reference --check` in front of, which for this repository is
 * `pnpm test`.
 *
 * Driven from **source** rather than from `dist/`, because a stale `dist/` is
 * silent: a test that spawned the bundle would assert against a binary predating
 * the edit under review, which is the one failure a drift check cannot have.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'src', 'sigil.ts');
const commandsDir = join(root, 'src', 'commands');
const pages = resolve(root, '..', '..', 'website', 'src', 'reference');
const snapshot = join(root, 'command-surface.json');

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * An empty destination, somewhere nothing commits.
 *
 * A path inside the repository would be the obvious thing and is a trap: the
 * sabotage pass's own `--check writes nothing` mutation **wrote** into it, which
 * left a directory behind that made these two tests pass for the wrong reason on
 * the next run -- the control failing is how that was found. A temp directory is
 * removed whatever a mutation does with it.
 *
 * @param file - A file inside it, for the snapshot's sake.
 * @returns The path.
 */
function nowhere(file?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-surface-'));
  temps.push(dir);
  return file ? join(dir, file) : join(dir, 'empty');
}

/**
 * A minimal app in a temp directory, with no `sigil.json` at all.
 *
 * Which is what the three guards below need and what this repository cannot
 * provide: `packages/cli`'s own `sigil.json` names both destinations, so every
 * run against it has somewhere to put things. A fixture inside the repository
 * would be written into by the write tests, so it is a temp app.
 *
 * @returns Its root.
 */
function tempApp(nested: readonly string[] = []): string {
  const made = mkdtempSync(join(tmpdir(), 'sigil-app-'));
  temps.push(made);
  const dir = join(made, ...nested);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'temp-app' }),
    'utf-8'
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'index.mjs'),
    'export default { name: "temp-app", commands: { go: { desc: "Go", run() {} } } };\n',
    'utf-8'
  );

  return dir;
}

/**
 * Runs the toolchain from source.
 *
 * @param argv - The arguments.
 * @param cwd - Where to run it, defaulting to the package.
 * @returns What it said and how it ended.
 */
/**
 * What a shell passes as `--out` when the printed command is pasted into it.
 *
 * Which is the only form of "safe to paste" worth asserting: a string compare
 * against the quoting this happens to write cannot see a quoting a shell still
 * expands. `bash` is spawned with the program defined as a function that prints
 * its own arguments, so what comes back is the argument the shell built.
 *
 * Both shells, because they do not agree about what an unquoted word is: zsh
 * expands one that begins with `=` and bash does not, so a bash-only probe
 * could not see the one character that was still in the safe class.
 *
 * @param stderr - What the diagnostic printed.
 * @param want - The destination, used to find the line.
 * @param shell - Which shell to parse it with.
 * @returns The `--out` argument as the shell read it.
 */
function parsed(stderr: string, want: string, shell = 'bash'): string {
  // between the **first** backtick and the **last** one on the line rather than
  // by a `[^`]*` run: the message wraps the command in a pair of backticks for a
  // human to see, and a destination may hold one -- which made the greedy form
  // necessary and is a fact about the message rather than about the quoting
  const held = stderr.split('\n').find((it) => it.includes('`sigil reference '));

  if (held === undefined) {
    throw new Error(`No command in:\n${stderr}`);
  }

  // from the backtick that opens the **command** rather than the first one on
  // the line: the line begins with the stale page's own path, and that path
  // holds the backticks too in the one case this helper exists for
  const from = held.indexOf('`sigil reference ');
  const line = held.slice(from + 1, held.lastIndexOf('`'));

  const script = `sigil() { while [ $# -gt 0 ]; do if [ "$1" = --out ]; then printf '%s' "$2"; return; fi; shift; done; }\n${line}`;
  const out = spawnSync(shell, ['-c', script], { encoding: 'utf-8' });

  // the spelling is asserted too, so that a quoting which happens to survive
  // this particular path still has to be the one the comment describes
  expect(line, want).toContain(want.includes("'") ? "'\\''" : `'${want}'`);
  return out.stdout;
}

function run(
  argv: string[],
  cwd = root
): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [bin, ...argv], { cwd, encoding: 'utf-8' });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

/** The routes `src/commands/` holds, which is what the CLI walks. */
function routes(): string[] {
  return (readRoutes(commandsDir)?.routes ?? []).map((route) => route.name).sort();
}

/** The committed snapshot. */
function surface(): { commands: { path: string[]; tokens: string[] }[]; program: string } {
  return JSON.parse(readFileSync(snapshot, 'utf-8'));
}

describe('the committed command surface', () => {
  it('should be what the app declares', () => {
    // the input is `src/commands/` and the expectation is the committed file,
    // which is what keeps this from being a tautology: deriving one from the
    // other would be a check that passes whatever either says
    const result = run(['reference', '--json', '--check']);

    expect(result.stderr, 'run `pnpm --filter @ttylabs/cli reference`').not.toContain('error:');
    expect(result.status).toBe(0);
  });

  it('should fail when it is not', () => {
    // what input makes the check matter: a destination holding nothing at all,
    // which is every file missing. Without it the test above passes for a
    // `--check` that never compares anything
    const result = run(['reference', '--json', '--out', nowhere('surface.json'), '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing from the command reference');
  });

  it('should name every command the directory holds', () => {
    const it = surface();
    const paths = it.commands.map((cmd) => cmd.path.join(' '));

    expect(it.program).toBe('sigil');
    // the root is in it, which is what carries the global options an app
    // declares; every route is in it, which is what says nothing was skipped
    expect(paths).toContain('');
    for (const name of routes()) {
      expect(paths, name).toContain(name);
    }
  });

  it('should hold neither the framework’s commands nor its flags', () => {
    // an app's snapshot should move when the app moves and not when the
    // framework does, which is why the surface is built from the schema rather
    // than from a parse: `help`, `completion`, `--help` and `--version` are
    // `parse()`'s own additions
    const json = readFileSync(snapshot, 'utf-8');
    const it = JSON.parse(json) as {
      commands: { options: { long: string[] }[]; path: string[] }[];
    };
    const tokens = new Set(it.commands.flatMap((cmd) => cmd.path));
    const spellings = new Set(it.commands.flatMap((cmd) => cmd.options.flatMap((o) => o.long)));

    for (const absent of ['completion', 'help']) {
      expect([...tokens], absent).not.toContain(absent);
    }
    for (const absent of ['--help', '--version']) {
      expect([...spellings], absent).not.toContain(absent);
    }

    // and the **presence** half, because an absence asserted on its own is
    // satisfied by a snapshot that lost every command it ever had -- which is
    // the one failure this file is otherwise blind to, since a substring search
    // for `"help"` passes over an empty document. Found by review. The toolchain
    // has four commands plus the root; `src/commands/` is where they are, and
    // the sibling test reads that directory rather than trusting this number
    expect(it.commands.length).toBeGreaterThan(4);
    expect([...tokens]).toContain('reference');
  });

  it('should hold no absolute path, no version and no date', () => {
    const json = readFileSync(snapshot, 'utf-8');
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;

    expect(json).not.toContain(root);
    expect(json).not.toContain(version);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  });
});

describe('a reference with nowhere to go', () => {
  it('should refuse a --check that has nothing to compare', () => {
    // with no destination a plain run prints one document to stdout, and
    // `--check` has nothing to compare it against -- so it says what to set
    // rather than exiting zero over a comparison it never made
    const result = run(['reference', tempApp(), '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Nothing to check');
    expect(result.stderr).toContain('"out"');
  });

  it('should write relative to the app rather than to where it was run', () => {
    // one `sigil.json` has to mean one destination whichever directory the
    // command was run from, which is the rule `components` already keeps -- and
    // the same resolution has to hold for `--out`, or a CI step that `cd`s
    // first writes somewhere else
    const dir = tempApp();
    // a working directory of its own, so that neither assertion can be decided
    // by something in the repository: `expect(existsSync(root/docs))` was the
    // first spelling and the sabotage pass's own relative-path mutation left a
    // `packages/cli/docs` behind, after which it failed over a tree with
    // nothing wrong with it
    const from = mkdtempSync(join(tmpdir(), 'sigil-cwd-'));
    temps.push(from);

    expect(run(['reference', dir, '--out', 'docs'], from).status).toBe(0);
    expect(existsSync(join(dir, 'docs', 'index.md'))).toBe(true);
    expect(existsSync(join(from, 'docs'))).toBe(false);
  });

  it('should name a destination the shorter of relative and absolute', () => {
    // whichever is shorter, which is one rule where the first version had a
    // rule and a claim that did not match it: it used the relative form unless
    // it climbed out of the app at all, under a comment saying it used the
    // shorter one -- and the toolchain's own destination is
    // `../../website/src/reference`, twenty-eight characters against
    // eighty-five, so the summary printed an absolute path with somebody's home
    // directory in it. Found by running the generator and reading the line
    const dir = tempApp();
    const inside = run(['reference', dir, '--out', join(dir, 'docs')]);

    expect(inside.stderr).toContain('docs');
    expect(inside.stderr).not.toContain(dir);

    // and the absolute form where that really is the shorter of the two, which
    // is what says a comparison is being made rather than one branch taken.
    // The depth is **computed** rather than written down, because which form is
    // shorter depends on how long the platform's temp root is: `/tmp` on Linux
    // is four characters and macOS's is about fifty, so an app sixteen levels
    // down prints the absolute form on one and the relative on the other -- a
    // hard-coded depth asserted the wrong half here twice. One `../` is three
    // characters and the destination's own name is four
    const absolute = join(tmpdir(), 'sigil-app-XXXXXX', 'docs').length;
    const levels = Array.from({ length: Math.ceil((absolute - 'docs'.length) / 3) + 1 }, (_, at) =>
      String.fromCharCode(97 + (at % 26))
    );
    const deep = tempApp(levels);
    const out = resolve(deep, ...levels.map(() => '..'), 'docs');

    expect(relative(deep, out).length).toBeGreaterThan(out.length);
    expect(run(['reference', deep, '--out', out]).stderr).toContain(out);
  });

  it('should tell a reader to remove a stale page rather than to re-run', () => {
    // `sigil reference` writes a missing or an out-of-date file and **does
    // not** remove a stale one, so a message telling a reader to run it over a
    // left-over page is an instruction that does nothing
    const dir = tempApp();
    // an **absolute** destination, which is taken as given rather than resolved
    // against anything: a relative one here would let the sabotage pass's own
    // resolution mutation write a `docs/` into the package, which is the litter
    // that made three guards look covered
    const docs = join(dir, 'docs');

    run(['reference', dir, '--out', docs]);
    writeFileSync(join(docs, 'gone.md'), '# gone\n', 'utf-8');

    const result = run(['reference', dir, '--out', docs, '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Delete it by hand');
    expect(result.stderr).not.toContain('to refresh it');
    // and the command it names is the one that was **run**, with every argument
    // this invocation passed: a message naming less than was typed tells the
    // reader to run something that writes somewhere else -- without `[dir]`,
    // pasting it in this repository writes *this* toolchain's reference into the
    // app's docs directory. Found by review, twice
    expect(result.stderr).toContain(`sigil reference ${dir} --out ${docs}`);
  });

  it('should quote an argument a shell would not read as one word', () => {
    // the enumeration was wrong: `;`, `&`, `|`, `(`, `)` and `<` were not in the
    // class, so a destination called `docs/foo;rm` printed a command whose
    // second half is a second command. What is matched now is the set a shell
    // treats as ordinary, which is small and known. Found by review
    const dir = tempApp();
    // **no space in it**, which is what makes this a test of the class rather
    // than of the space: the old pattern caught `foo;rm -rf` because of the
    // space and left `foo;rm` alone, and `;` is the character that turns a
    // printed command into two
    const docs = join(dir, 'foo;rm');

    run(['reference', dir, '--out', docs]);
    writeFileSync(join(docs, 'gone.md'), '# gone\n', 'utf-8');

    const result = run(['reference', dir, '--out', docs, '--check']);

    expect(result.status).toBe(1);
    // asserted by handing the printed command to **bash**, which is what "safe
    // to paste" means: the first version compared against `JSON.stringify`, and
    // double quotes are what bash, zsh and PowerShell all still expand `$` and
    // a backtick inside -- so a path ending `foo$HOME` was passed as
    // `foo/Users/...` and one ending in a backtick ran the command in it. A
    // string compare against the unsafe spelling could not see that. Found by
    // review
    expect(parsed(result.stderr, docs)).toBe(docs);
  });

  it('should quote an argument a shell would expand inside double quotes', () => {
    // the pair `JSON.stringify` could not hold: `$` and a backtick expand
    // inside double quotes and not inside single ones. Found by review
    for (const name of ['foo$HOME', 'foo`echo PWNED`', "foo'quote", '=out']) {
      const dir = tempApp();
      const docs = join(dir, name);

      run(['reference', dir, '--out', docs]);
      writeFileSync(join(docs, 'gone.md'), '# gone\n', 'utf-8');

      const result = run(['reference', dir, '--out', docs, '--check']);

      expect(result.status, name).toBe(1);
      expect(parsed(result.stderr, docs), name).toBe(docs);
      // **zsh** as well, which is the shell this diagnostic is pasted into by
      // default and the one that expands an unquoted word beginning with `=`:
      // measured, `=out` is passed as `/bin/ls`'s directory there and as `=out`
      // in bash, so bash alone could not see it. Found by review
      expect(parsed(result.stderr, docs, 'zsh'), name).toBe(docs);
    }
  });

  it('should name the entry it was given, which decides what it would write', () => {
    // without it the command printed regenerates the *conventional* entry, so a
    // reader following it puts back the page it was just told is stale. Found by
    // review
    const dir = tempApp();
    const docs = join(dir, 'docs');

    writeFileSync(
      join(dir, 'src', 'other.mjs'),
      'export default { name: "temp-app", commands: { stay: { run() {} } } };\n',
      'utf-8'
    );
    run(['reference', dir, '--entry', 'src/other.mjs', '--out', docs]);
    writeFileSync(join(docs, 'gone.md'), '# gone\n', 'utf-8');

    const result = run(['reference', dir, '--entry', 'src/other.mjs', '--out', docs, '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--entry src/other.mjs');
  });
});

describe('the generated markdown reference', () => {
  it('should be what the app declares', () => {
    const result = run(['reference', '--check']);

    expect(result.stderr, 'run `pnpm --filter @ttylabs/cli reference`').not.toContain('error:');
    expect(result.status).toBe(0);
  });

  it('should fail when it is not', () => {
    const result = run(['reference', '--out', nowhere(), '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing from the command reference');
  });

  it('should be a page the website can read', () => {
    // the contract `website/src/lib/reference.ts` rests on, asserted from the
    // package that has tests. The front matter's values are JSON -- which is a
    // subset of YAML, so a site that wants a YAML parser gets one and a site
    // that would rather not take a dependency can use `JSON.parse` -- and the
    // nav is built from `title` and `path`
    const names = readdirSync(pages).filter((name) => name.endsWith('.md'));

    expect(names.length).toBeGreaterThan(1);

    for (const name of names) {
      // normalized, because git checks a markdown file out with CRLF on Windows
      // and a fence matched with `\n` on either side would match nothing there
      const text = readFileSync(join(pages, name), 'utf-8').replaceAll('\r\n', '\n');

      expect(text.startsWith('---\n'), name).toBe(true);

      const end = text.indexOf('\n---\n', 3);
      expect(end, name).toBeGreaterThan(0);

      const keys: Record<string, unknown> = {};
      for (const line of text.slice(4, end).split('\n')) {
        const at = line.indexOf(':');
        expect(at, `${name}: ${line}`).toBeGreaterThan(0);
        keys[line.slice(0, at)] = JSON.parse(line.slice(at + 1).trim());
      }

      expect(typeof keys.title, name).toBe('string');
      expect(Array.isArray(keys.path), name).toBe(true);
      // the body is under the fence and starts at the heading the title names
      expect(
        text
          .slice(end + 5)
          .trimStart()
          .startsWith('# '),
        name
      ).toBe(true);
    }
  });

  it('should have a page for the index and one per visible command', () => {
    const names = readdirSync(pages)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();

    expect(names).toStrictEqual(['index', ...routes()].sort());
  });
});
