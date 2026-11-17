import { displayPath } from '../src/build/diagnostic.ts';
import { linkedFixture } from './copy-fixture.ts';
import { run, STACK } from './spawned.ts';
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
