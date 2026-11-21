import { bundleError } from '../src/build/bundle.ts';
import { DiagnosticError, displayPath } from '../src/build/diagnostic.ts';
import { escaped } from '../src/commands/_inspect.ts';
import { linkedFixture } from './copy-fixture.ts';
import { run, STACK } from './spawned.ts';
import { tempDir } from './temp.ts';
import { ESC } from '@ttylabs/sigil/ansi';
import { escapeControls } from '@ttylabs/sigil/error-handler';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SIG-447: what rolldown refused was rethrown as rolldown wrote it, so a helper
 * module at `src/h<ESC>]0;PWN<BEL>d/helper.js` with a syntax error passed every
 * check of sigil's own and then retitled the reader's window from `sigil build`'s
 * stderr. SIG-443 had escaped every diagnostic where it is printed, and this was
 * not one.
 *
 * Spawned rather than called, because the claim is about the bytes a pipe gets
 * and rolldown decides its colour from the environment of the process it is in.
 * Written with escapes, never raw bytes, for the reason `sources.test.ts` exists.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/sigil.ts');
const buildable = resolve(here, 'fixtures', 'buildable');

/**
 * A root's name holding a newline and then what a problem matcher reads as a
 * diagnostic. No separator is spelled: `forged.ts` is the part after the newline,
 * so it is also what starts the forged line.
 */
const FORGED = 'sigil-forge\nforged.ts:1:1: error: pwned-';

/** A directory name that is a retitle sequence. */
const TITLE = 'h\u001b]0;PWN\u0007d';

/**
 * Every control character left in some output, newlines aside.
 *
 * SGR is taken off first, and only SGR: `FORCE_COLOR` colours what the report
 * itself chose to, and `strip()` would also take off an injected sequence, which
 * is the one thing these tests are looking for. The same reading as
 * `diagnostic-escape.test.ts`.
 */
function controls(out: string): string[] {
  const sgr = new RegExp(`${ESC}\\[[\\d;:]*m`, 'g');
  return [...out.replaceAll(sgr, '').matchAll(/\p{Cc}/gu)]
    .map((m) => m[0])
    .filter((c) => c !== '\n');
}

/**
 * The buildable fixture, with its hidden command importing `helper.js` from a
 * directory called `dir` under the app.
 *
 * @param dir - The directory the helper is in, relative to the app.
 * @param helper - The helper's source.
 * @returns The app's root.
 */
function appWithHelper(dir: string, helper: string): string {
  const app = linkedFixture(buildable, 'sigil-bundle-escape-');
  mkdirSync(join(app, dir), { recursive: true });
  writeFileSync(join(app, dir, 'helper.js'), helper);
  writeFileSync(
    join(app, 'src', 'commands', 'quiet.js'),
    `import { x } from ${JSON.stringify(`../../${displayPath(join(dir, 'helper.js'))}`)};\n` +
      "export default { desc: 'hidden away', hidden: true, run: () => process.stdout.write(`${x}\\n`) };\n"
  );
  return app;
}

/** Builds an app the way a user would, piped, with rolldown's colour on or off. */
function build(app: string, color: '0' | '3', ...argv: string[]) {
  return run(cli, app, ['build', app, ...argv], { FORCE_COLOR: color });
}

// a file name holding a control character cannot be made on Windows
describe.skipIf(process.platform === 'win32')('a bundle rolldown refuses', () => {
  it('should not print a control character from the file name of a module that does not parse', async () => {
    const app = appWithHelper(join('src', TITLE), 'export const x = ;\n');

    for (const color of ['0', '3'] as const) {
      const { code, stderr, stdout } = await build(app, color);

      expect(code, stderr).toBe(1);
      expect(controls(stderr), stderr).toEqual([]);
      expect(controls(stdout), stdout).toEqual([]);
      // located the way every other diagnostic is, relative to the app, with the
      // name shown rather than acted on or stripped to nothing
      expect(stderr).toContain(
        `\n${escapeControls(displayPath(join('src', TITLE, 'helper.js')))}:1:18: error: [PARSE_ERROR] Unexpected token`
      );
      // and rolldown's own colour is taken off rather than escaped, which would
      // print `\x1B[31m` into exactly the CI log the colour was for
      expect(stderr, color).not.toContain('\\x1B[');
      expect(stderr).toContain('1 error in buildable');
      expect(stderr).not.toMatch(STACK);
    }
  }, 60_000);

  it('should not print one from an import that cannot be resolved, nor its specifier', async () => {
    // a relative import is rolldown's error and a bare one its warning, which
    // this build turns into an error of its own -- two paths, one rule
    for (const [specifier, said] of [
      [`./missing-${TITLE}.js`, 'could not be resolved'],
      [`not-a-package-${TITLE}`, 'could not be resolved, and an unresolved import is one'],
    ]) {
      const app = appWithHelper(
        join('src', TITLE),
        `import ${JSON.stringify(specifier)};\nexport const x = 1;\n`
      );

      const { code, stderr } = await build(app, '0');

      expect(code, stderr).toBe(1);
      expect(controls(stderr), stderr).toEqual([]);
      // named relative to the app, which rolldown's real path for the importer
      // of an unresolved import used not to be under a linked temp directory
      expect(stderr).toContain(
        `\n${escapeControls(displayPath(join('src', TITLE, 'helper.js')))}:1:8: error: "${escapeControls(specifier)}" ${said}`
      );
    }
  }, 60_000);

  it('should not print one from a module the build refused to empty', async () => {
    // reached through `beforeWrite`, after rolldown has read the graph: the
    // output directory holds a module only the bundle knows about, and the
    // refusal names both
    const dir = `o${TITLE}`;
    const app = appWithHelper(dir, 'export const x = 1;\n');

    const { code, stderr } = await build(app, '0', '--out', join(app, dir));

    expect(code, stderr).toBe(1);
    expect(controls(stderr), stderr).toEqual([]);
    expect(stderr).toContain(
      `which holds ${escapeControls(displayPath(join(dir, 'helper.js')))}, a module the app is built from`
    );
  }, 60_000);
  it('should not print one from a warning rolldown prints itself', async () => {
    // a warning that is not an unresolved import is rolldown's own to print, and
    // its printer names the module before the message -- on a build that goes
    // on to succeed as readily as on one that fails
    const app = appWithHelper(join('src', TITLE), "export const x = eval('1');\n");

    const { code, stderr } = await build(app, '0');

    expect(code, stderr).toBe(0);
    expect(stderr).toContain('[EVAL]');
    expect(controls(stderr), stderr).toEqual([]);
  }, 60_000);

  it('should not print one from an error rolldown did not locate', async () => {
    // an entry that is not there is an error with no file to pin it on, so it is
    // thrown as rolldown's sentence -- escaped by `diagnosticMessage()`'s rule
    // and `--bin` refuses a routed command directory, so the schema says it all
    const app = linkedFixture(buildable, 'sigil-bundle-escape-entry-');
    rmSync(join(app, 'src', 'commands'), { force: true, recursive: true });
    writeFileSync(
      join(app, 'src', 'index.ts'),
      "export default { name: 'buildable', run() {} };\n"
    );

    const { code, stderr } = await build(app, '0', '--bin', `${TITLE}.js`);

    expect(code, stderr).toBe(1);
    expect(stderr).toContain('UNRESOLVED_ENTRY');
    expect(stderr).toContain(escapeControls(TITLE));
    expect(controls(stderr), stderr).toEqual([]);
  }, 60_000);
  it('should not let a newline in a file name forge a line through a warning', async () => {
    // the rest of rolldown's message is a boxed frame that names the file again,
    // and a newline is the one character the message rule keeps -- so only the
    // first line is handed to rolldown's printer
    const app = appWithHelper(join('src', 'h\nWARN forged'), "export const x = eval('1');\n");

    const { code, stderr } = await build(app, '0');

    expect(code, stderr).toBe(0);
    expect(stderr).toContain('[EVAL]');
    expect(
      stderr.split('\n').filter((line) => line.startsWith('WARN forged')),
      stderr
    ).toEqual([]);
  }, 60_000);

  it('should not print one from a file system error the bundle step raised', async () => {
    // Node's own text, which quotes its path as it stands: the generated entry
    // goes under the app's `node_modules/.sigil`, and a file there makes the
    // `mkdir` fail with the app's root in the message
    const app = linkedFixture(buildable, `sigil-${TITLE}-`);
    writeFileSync(join(app, 'node_modules', '.sigil'), '');

    const { code, stderr } = await build(app, '0');

    expect(code, stderr).toBe(1);
    expect(stderr).toContain(escapeControls(TITLE));
    expect(controls(stderr), stderr).toEqual([]);
  }, 60_000);

  it('should not let a newline in the app root forge a line through a file system error', async () => {
    // one line, quoting a path: the part of the root after the newline starts a
    // line of its own unless the whole message is escaped, and an editor's
    // problem matcher reads `file:line:col: error: ...` at the start of one
    const app = linkedFixture(buildable, FORGED);
    writeFileSync(join(app, 'node_modules', '.sigil'), '');

    const { code, stderr } = await build(app, '0');

    expect(code, stderr).toBe(1);
    expect(stderr).toContain('ENOTDIR');
    expect(
      stderr.split('\n').filter((line) => line.startsWith('forged.ts')),
      stderr
    ).toEqual([]);
  }, 60_000);
});

describe('what escaped() does to a message', () => {
  /** What Node raises for a `mkdir` under a root that holds a newline. */
  function systemError(message: string): Error {
    return Object.assign(new Error(message), { code: 'ENOTDIR', syscall: 'mkdir' });
  }

  it('should escape the newlines of a file system error, which is one line quoting a path', () => {
    const error = systemError("ENOTDIR: not a directory, mkdir '/a\nforged.ts:1:1: error: x/b'");

    const out = escaped(error) as Error & { code?: string };

    expect(out).toBe(error);
    expect(out.message).toBe("ENOTDIR: not a directory, mkdir '/a\\x0Aforged.ts:1:1: error: x/b'");
    expect(out.code).toBe('ENOTDIR');
  });

  it("should keep the line breaks of rolldown's own message, which has structure of its own", () => {
    // `[CODE] sentence` over a frame: no `syscall`, whether or not it has a `code`
    const message = 'Build failed with 1 error:\n\n[PARSE_ERROR] Unexpected token\n   | frame\n';

    for (const extra of [{}, { code: 'PARSE_ERROR' }, { syscall: 'mkdir' }]) {
      expect((escaped(Object.assign(new Error(message), extra)) as Error).message).toBe(message);
    }
  });

  it('should escape the other control characters of both kinds', () => {
    expect((escaped(systemError('a\u001b]0;PWN\u0007b')) as Error).message).toBe(
      'a\\x1B]0;PWN\\x07b'
    );
    expect((escaped(new Error('a\u001b]0;PWN\u0007b\nc')) as Error).message).toBe(
      'a\\x1B]0;PWN\\x07b\nc'
    );
  });
});

/**
 * Text as a regular expression that matches it literally.
 *
 * @param text - The text.
 * @returns The pattern's source.
 */
function escapeRe(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The buildable fixture under a root holding a retitle, named one in its
 * manifest, with its hidden command at a file called one.
 *
 * @param name - What the manifest calls the app.
 * @returns The app's root.
 */
function appNamed(name: string): string {
  const app = linkedFixture(buildable, `sigil-${TITLE}-`);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name, type: 'module' })
  );
  rmSync(join(app, 'src', 'commands', 'quiet.js'));
  // a package the bundle inlines, which the inlined table names, and a
  // description `--tree` prints, with a line break of its own to keep
  const pkg = join(app, 'node_modules', `p${TITLE}`);
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ main: 'index.js', name: `p${TITLE}` }));
  writeFileSync(join(pkg, 'index.js'), "exports.x = 'inlined';\n");
  writeFileSync(
    join(app, 'src', 'commands', `a${TITLE}.js`),
    `import { x } from ${JSON.stringify(`p${TITLE}`)};\n` +
      `export default { desc: ${JSON.stringify(`d${TITLE}\nmore`)}, hidden: true, run: () => process.stdout.write(\`\${x}\\n\`) };\n`
  );
  return app;
}

// SIG-457: SIG-443 and SIG-447 escaped what a failing build prints, and a build
// that succeeds still printed the app's name, its entry and its output path as
// they stood -- each the plain form a pipe gets
describe.skipIf(process.platform === 'win32')('a build that succeeds', () => {
  it('should not print a control character from the names the app chose', async () => {
    const name = `n${TITLE}`;
    const app = appNamed(name);

    const { code, stderr, stdout } = await build(app, '0');

    expect(code, stderr).toBe(0);
    expect(controls(stderr), stderr).toEqual([]);
    expect(controls(stdout), stdout).toEqual([]);
    // the summary, which leads with the app's name and ends in the file named
    // after it, both shown rather than acted on
    expect(stderr).toContain(`\n${escapeControls(name)} (src/index.ts): `);
    expect(stderr).toContain(` into dist/${escapeControls(name)}.mjs\n`);
    // and the size table names the same file the same way, rather than with the
    // control characters dropped and the rest left
    const entry = stdout
      .split('\n')
      .find((line) => line.startsWith(`${escapeControls(name)}.mjs `));
    expect(entry, stdout).toMatch(/ kB +entry$/);
    // and the inlined table names the package the app imports the same way
    expect(stdout).toMatch(new RegExp(`^p${escapeRe(escapeControls(TITLE))} +[\\d.]+ kB$`, 'm'));
  }, 60_000);

  it('should not let a newline in the app name forge a line', async () => {
    const { code, stderr, stdout } = await build(appNamed('a\nFORGED'), '0');

    expect(code, stderr).toBe(0);
    expect(stderr).toContain('a\\x0AFORGED (src/index.ts): ');
    for (const out of [stderr, stdout]) {
      expect(
        out.split('\n').filter((line) => line.startsWith('FORGED')),
        out
      ).toEqual([]);
    }
  }, 60_000);

  it('should not print one from the tree check prints, nor from its summary', async () => {
    const name = `n${TITLE}`;
    const app = appNamed(name);

    const { code, stderr, stdout } = await run(cli, app, ['check', app, '--tree'], {
      FORCE_COLOR: '0',
    });

    expect(code, stderr).toBe(0);
    expect(controls(stderr), stderr).toEqual([]);
    expect(controls(stdout), stdout).toEqual([]);
    expect(stdout).toContain(`a${escapeControls(TITLE)} (hidden)`);
    expect(stdout).toContain(escapeControls(displayPath(join('src', 'commands', `a${TITLE}.js`))));
    // the description keeps its line break for the table to lay out, and is
    // escaped otherwise
    expect(stdout).toContain(`d${escapeControls(TITLE)} more`);
    expect(stderr).toContain(`\n${escapeControls(name)} (src/index.ts): `);
  }, 60_000);

  it('should not print one from the command --bin refuses to bundle', async () => {
    // a walked command's name is its file's, and the refusal is an error
    // `main()` prints as it stands
    const app = appNamed('buildable');

    const { code, stderr } = await build(app, '0', '--bin', 'src/index.ts');

    expect(code, stderr).toBe(1);
    expect(stderr).toContain(`"a${escapeControls(TITLE)}" was found by walking`);
    expect(controls(stderr), stderr).toEqual([]);
  }, 60_000);

  it('should not print one from a reference, written or out of date', async () => {
    // the summary a written reference ends in, and the error a stale one throws,
    // which `main()` prints as it stands -- both name the app
    const name = `n${TITLE}`;
    const app = appNamed(name);
    const reference = (...argv: string[]) =>
      run(cli, app, ['reference', app, '--json', '--out', 'surface.json', ...argv], {
        FORCE_COLOR: '0',
      });

    const stale = await reference('--check');
    expect(stale.code, stale.stderr).toBe(1);
    expect(stale.stderr).toContain(`out of date in ${escapeControls(name)}`);
    expect(controls(stale.stderr), stale.stderr).toEqual([]);

    const written = await reference();
    expect(written.code, written.stderr).toBe(0);
    expect(written.stderr).toContain(`\n${escapeControls(name)} (src/index.ts): 1 file into`);
    expect(controls(written.stderr), written.stderr).toEqual([]);
  }, 60_000);
});

// SIG-456's other half: an error `main()` prints as it stands, quoting the app's
// root or a value from its config, found by review of SIG-456 and SIG-457
describe.skipIf(process.platform === 'win32')('an app the toolchain refuses', () => {
  it('should not print one from the root of an app it cannot read', async () => {
    const root = tempDir(`sigil-${TITLE}-`);
    const cases: [string, string[]][] = [
      // no manifest at all
      ['No package.json in', []],
      // a manifest that does not depend on the runtime
      ['does not depend on', ['package.json', '{"name":"x"}']],
      // a manifest that does, and no entry
      [
        'No entry module found in',
        ['package.json', '{"name":"x","dependencies":{"@ttylabs/sigil":"*"}}'],
      ],
    ];

    for (const [said, file] of cases) {
      if (file.length) {
        writeFileSync(join(root, file[0]!), file[1]!);
      }
      const { code, stderr } = await run(cli, root, ['build', root], { FORCE_COLOR: '0' });

      expect(code, stderr).toBe(1);
      expect(stderr).toContain(said);
      expect(stderr).toContain(escapeControls(TITLE));
      expect(controls(stderr), stderr).toEqual([]);
    }

    const { code, stderr } = await run(cli, root, ['build', root, '--entry', `e${TITLE}.ts`], {
      FORCE_COLOR: '0',
    });
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(`Entry module not found: `);
    expect(stderr).toContain(`e${escapeControls(TITLE)}.ts`);
    expect(controls(stderr), stderr).toEqual([]);
  }, 60_000);

  it('should not print one from a root that holds both config files', async () => {
    const app = appNamed('buildable');
    writeFileSync(join(app, 'sigil.json'), '{}');
    writeFileSync(join(app, 'sigil.jsonc'), '{}');

    const { code, stderr } = await build(app, '0');

    expect(code, stderr).toBe(1);
    expect(stderr).toContain('has both sigil.json and sigil.jsonc');
    expect(stderr).toContain(escapeControls(TITLE));
    expect(controls(stderr), stderr).toEqual([]);
  }, 60_000);

  it('should not print one from an external package names', async () => {
    const app = appNamed('buildable');

    const { code, stderr } = await run(
      cli,
      app,
      ['package', app, '--runtime', 'node', '--external', `ev${TITLE}il`],
      { FORCE_COLOR: '0' }
    );

    expect(code, stderr).toBe(1);
    expect(stderr).toContain(`external packages: "ev${escapeControls(TITLE)}il"`);
    expect(controls(stderr), stderr).toEqual([]);
  }, 60_000);
});

describe('a specifier that holds a newline', () => {
  it('should not forge a second diagnostic line', async () => {
    // a specifier is a string literal the app wrote, so this needs no file name
    // the platform refuses, and it is the one character `diagnosticMessage()`
    // lets through: the producer escapes it, which is SIG-443's rule
    const app = appWithHelper(
      'src',
      "import 'x\\nsrc/forged.ts:1:1: error: FORGED';\nexport const x = 1;\n"
    );

    const { code, stderr } = await build(app, '0');

    expect(code, stderr).toBe(1);
    expect(stderr).toContain('could not be resolved');
    expect(
      stderr.split('\n').filter((line) => line.startsWith('src/forged.ts')),
      stderr
    ).toEqual([]);
  }, 60_000);
});

describe('an error a plugin threw with a null location', () => {
  it('should be reported on its module rather than throw over the null', () => {
    // a JavaScript plugin's error comes back from rolldown as the object it
    // threw, and `loc: null` beside an `id` read as located and then threw a
    // TypeError over `null.column`
    const id = join('app', 'src', `${TITLE}.js`);
    const error = bundleError(
      Object.assign(new Error('Build failed'), {
        errors: [{ id, loc: null, message: 'boom', plugin: 'p' }],
      })
    );

    expect(error).toBeInstanceOf(DiagnosticError);
    const [found] = (error as DiagnosticError).diagnostics;
    expect(found).toMatchObject({ column: undefined, file: id, line: undefined, message: 'boom' });
    expect(controls(error.message), error.message).toEqual([]);
  });
});
