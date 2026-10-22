import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The demos import their packages by name, so they go through each one's
 * `exports` map and read `dist/` -- which is the one part of the surface no
 * other test covers. Nothing type-checks them, and a named import of an export
 * that no longer exists is not a lint error: it is a `SyntaxError` at the point
 * somebody runs the file, which is after it shipped.
 *
 * `06-ansi-and-wrap.js` went on importing `padCell()` for a whole pull request
 * after the component rewrite deleted it, and the suite was green the entire
 * time. This is the cheap half of the answer -- every named import a demo
 * makes has to be something the built package actually exports -- and it is
 * static, so it costs a read rather than 28 spawned processes.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const demos = resolve(root, 'demos');

/**
 * A specifier resolved the way the *demo* resolves it, rather than the way this
 * file would.
 *
 * `demos/` is a workspace member with a manifest of its own, so what it may
 * import is what that manifest declares -- and `@ttylabs/cli` declares a
 * different set. Resolving here would therefore have asked the wrong question
 * twice over: it answered for `@ttylabs/sigil` only because this package
 * happens to depend on it too, and it threw `ERR_MODULE_NOT_FOUND` for
 * `@ttylabs/config-xml`, which the demos declare and this package does not.
 *
 * So the check reads the demo's own `node_modules`, which is also the honest
 * statement of what it is checking: the import the demo makes, resolved the way
 * node will resolve it when `demos.test.ts` spawns the file below.
 */
const fromDemos = createRequire(join(demos, 'package.json'));

/** Every `.js` under `demos/`, including the command modules in subdirectories. */
function scripts(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // `demos/` is a workspace member -- that is how it gets to import
    // `@ttylabs/sigil` by name without the *root* manifest declaring the
    // dependency, which is what used to put every file of both packages in
    // turbo's global hash. So pnpm writes a `node_modules` here, and a demo is
    // something somebody wrote rather than something a package manager linked.
    // Nothing under it is a `.js` today -- `@ttylabs/sigil` arrives as a
    // symlink, which `isDirectory()` is false for -- so this is a guard against
    // a layout change rather than a fix, and a cheap one
    if (entry.name === 'node_modules') {
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...scripts(path));
    } else if (entry.name.endsWith('.js')) {
      found.push(path);
    }
  }
  return found.sort();
}

interface DemoImport {
  names: string[];
  specifier: string;
}

/**
 * The static imports a demo makes from a workspace package. Only the named ones
 * carry a promise this test can check; a namespace or default import merely
 * has to resolve, which importing the module proves on its own.
 *
 * Every `@ttylabs/` specifier rather than `@ttylabs/sigil` alone, because the
 * reason this check exists is true of any of them: `@ttylabs/config-xml` is a
 * second package the demos import by name, and a named import of an export it
 * no longer has is the same `SyntaxError` at the same moment.
 */
function imports(source: string): DemoImport[] {
  const found: DemoImport[] = [];
  const re = /import\s+([^'"]*?)\s*from\s*'(@ttylabs\/[^']+)'/g;
  for (const match of source.matchAll(re)) {
    const clause = match[1] ?? '';
    const braces = /\{([^}]*)\}/.exec(clause);
    const names = braces
      ? braces[1]
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          // `a as b` is a promise about `a`, which is the exported name
          .map((part) => part.split(/\s+as\s+/)[0]!.trim())
      : [];
    found.push({ names, specifier: match[2]! });
  }
  return found;
}

describe('the demos', () => {
  const files = scripts(demos);

  it('should have been found', () => {
    // a glob that matches nothing passes every assertion below it
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const name = relative(root, file);
    const declared = imports(readFileSync(file, 'utf-8'));
    if (declared.length === 0) {
      continue;
    }

    it(`should import what ${name} says it does`, async () => {
      for (const { names, specifier } of declared) {
        const file = pathToFileURL(fromDemos.resolve(specifier)).href;
        const module = (await import(file)) as Record<string, unknown>;
        for (const exported of names) {
          expect(Object.hasOwn(module, exported), `${specifier} exports ${exported}`).toBe(true);
        }
      }
    });
  }
});

/**
 * What a demo *does*, which the import check above cannot see.
 *
 * A demo that imports fine and then throws exits non-zero with a stack on
 * stderr, and nothing here would have known: the import check reads the file
 * and never runs it. So every demo is spawned, piped, and asked for its exit
 * code and its stderr.
 *
 * Piped is the interesting half rather than a limitation of CI. `demos/README.md`
 * documents what each one does without a terminal -- a spinner writes one line
 * per change, a bar one line every ten percent, a prompt fails rather than
 * waiting forever on a stdin that will never produce a keystroke -- and that is
 * the non-TTY rule the whole component layer rests on. Running them this way
 * checks the documented behaviour and needs no pty, which is what lets it run on
 * all nine of CI's node-and-os combinations.
 */

/**
 * An exact stderr, written as the lines it is.
 *
 * Two of these are several lines long, and a hand-written alternation of
 * `\r?\n` and escaped braces is a wall nobody reads or can edit safely -- so the
 * lines are the input and the escaping is this function's. Exact rather than
 * loose for the reason the whole file is: a pattern that matches almost any line
 * is the vacuous assertion this repository keeps deleting.
 *
 * `\r?` because a pipe on Windows is still whatever wrote to it.
 */
function lines(...out: string[]): RegExp {
  const escaped = out.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('\\r?\\n')}\\r?\\n$`);
}

/** A demo that does not exit `0` with nothing on stderr, and why. */
const EXPECTED: Record<string, { code: number; stderr: RegExp }> = {
  // the non-TTY rule, and `demos/README.md` prints this very line
  'demos/components/04-prompts.js': {
    code: 1,
    stderr: /^\s*Cannot prompt for "Project name" because the input is not a terminal\s*$/,
  },
  // the demo *about* errors. Its narrative is stdout; what reaches stderr is
  // what `main()` rendered and then what a handler of the app's own did with
  // the same error -- a message each time, and never a stack, which is the
  // rule `errorHandler()` exists to keep and which `STACK` below re-checks
  'demos/parser/09-errors.js': {
    code: 0,
    stderr: lines(
      'Error: Missing required arguments: <host>',
      'sorry: Error: Missing required arguments: <host>'
    ),
  },
  // the demo about output formats, whose bare run walks every command line in its
  // header. Its stderr is part of what it shows rather than a failure: an unknown
  // format's message naming what the command *does* accept, then `report`'s own
  // human form -- which is the answer to "where does a command's own drawing go
  // once stdout belongs to the serializer" -- and then `boom`'s error through the
  // built-in and through the app's own serializer, as data both times. The exit
  // code is 0 because the tour completed; each failing step's own code is printed
  // to stdout and cleared, which is `09-errors.js`'s rule one demo along
  'demos/parser/12-formats.js': {
    code: 0,
    stderr: lines(
      'Error: Unknown output format "nope". This command accepts: json, csv, yaml',
      'alpha                12',
      'bravo                7',
      'charlie "big, loud"  31',
      '{',
      '  "error": {',
      '    "message": "nothing to list, \\"alpha\\" is gone",',
      '    "name": "TypeError"',
      '  }',
      '}',
      'error',
      '"nothing to list, ""alpha"" is gone"',
      'error:',
      '  message: "nothing to list, \\"alpha\\" is gone"'
    ),
  },
};

/**
 * A stack frame reaching the output is a throw nobody caught, exit code or not
 * -- which is also what catches an unhandled rejection that still exits `0`.
 *
 * The alternation is parenthesised because it means to be either whole branch
 * and not `^(\s+at .+)` or `(node:internal\/)$`: an alternation binds looser
 * than the anchors, which is the trap `optionTypesRE` in the parser is written
 * down for.
 */
const STACK = /(^\s+at .+$)|(node:internal\/)/m;

interface Ran {
  code: number | null;
  stderr: string;
  stdout: string;
}

function run(file: string): Promise<Ran> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [file], {
      cwd: root,
      // a demo must never wait on stdin here; that is what `04-prompts.js` proves
      env: { ...process.env, COLUMNS: '80' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${relative(root, file)} did not finish within 30s`));
    }, 30_000);

    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ code, stderr, stdout });
    });
  });
}

describe('running the demos', () => {
  for (const file of scripts(demos)) {
    // the keys above are written the way the repository spells a path
    const name = relative(root, file).split(sep).join('/');
    const expected = EXPECTED[name];

    it.concurrent(`should run ${name}`, async () => {
      const { code, stderr, stdout } = await run(file);

      expect(`${stdout}${stderr}`, 'a stack reached the output').not.toMatch(STACK);
      expect(code, 'exit code').toBe(expected?.code ?? 0);
      if (expected) {
        expect(stderr).toMatch(expected.stderr);
      } else {
        expect(stderr, 'nothing was expected on stderr').toBe('');
      }
    }, 45_000);
  }
});
