import { displayPath } from '../src/build/index.ts';
import {
  assertCleanable,
  buildReads,
  clean,
  heldFile,
  inspect,
  resolveOut,
} from '../src/commands/_inspect.ts';
import { copyFixture } from './copy-fixture.ts';
import { tempDir } from './temp.ts';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * The second half of the clean guard: an `--out` that holds what the build is
 * about to read (SIG-350). `--out src` passed `holdsApp()`, because `src` is
 * below the app rather than above it, and `clean()` removed the source before
 * rolldown failed on the entry it was about to read.
 *
 * Every app here is a temp directory, and every removal a test provokes is one
 * the guard is meant to refuse -- so a regression removes a temp directory's
 * contents rather than anything that matters, and the assertions after it say
 * so.
 */

/** A small app: an entry, one command module, a manifest and a config. */
function makeApp(): { app: string; base: string; entry: string; module: string; reads: string[] } {
  const base = tempDir('sigil-clean-source-');
  const app = join(base, 'app');
  const commands = join(app, 'src', 'commands');
  mkdirSync(commands, { recursive: true });

  const entry = join(app, 'src', 'index.js');
  const module = join(commands, 'hello.js');
  writeFileSync(entry, "export default { commands: './commands' };\n");
  writeFileSync(module, 'export default { run() {} };\n');
  writeFileSync(join(app, 'package.json'), '{}');
  writeFileSync(join(app, 'sigil.json'), '{}');

  return {
    app,
    base,
    entry,
    module,
    reads: [entry, module, join(app, 'package.json'), join(app, 'sigil.json'), commands],
  };
}

/** Whether this file system folds case, asked of the file system rather than the platform. */
function foldsCase(dir: string): boolean {
  const probe = join(dir, 'case-probe');
  writeFileSync(probe, '');
  return existsSync(join(dir, 'CASE-PROBE'));
}

describe('an --out that holds the source', () => {
  it('should refuse `--out src`, which emptied the source before the build failed', () => {
    const { app, entry, module, reads } = makeApp();
    const out = resolveOut(app, 'src');

    expect(() => clean(out, app, true, reads)).toThrow(
      `Refusing to empty ${displayPath(out)}, which holds ${displayPath(join('src', 'index.js'))}`
    );
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(module)).toBe(true);
  });

  it('should refuse the command directory, naming a module in it', () => {
    const { app, module, reads } = makeApp();
    const out = resolveOut(app, join('src', 'commands'));

    expect(() => clean(out, app, true, reads)).toThrow(
      `which holds ${displayPath(join('src', 'commands', 'hello.js'))}`
    );
    expect(existsSync(module)).toBe(true);
  });

  it('should refuse an --out that is a file the build reads, and say it is that file', () => {
    const { app, entry, reads } = makeApp();

    for (const name of [join('src', 'index.js'), 'package.json', 'sigil.json']) {
      const out = resolveOut(app, name);
      expect(() => clean(out, app, true, reads), name).toThrow(
        `Refusing to remove ${displayPath(out)}, which is ${displayPath(name)}`
      );
    }
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(join(app, 'package.json'))).toBe(true);
  });

  it('should refuse the same directory however it is spelled', () => {
    const { app, entry, reads } = makeApp();

    // a relative `out` is resolved against the app before it gets here, and a
    // trailing separator, a `.` and a `..` are all gone once it has been
    for (const spelling of [
      'src',
      `src${sep}`,
      join('.', 'src'),
      `${join('src', 'commands', '..')}${sep}`,
      join('..', 'app', 'src'),
    ]) {
      expect(() => assertCleanable(resolveOut(app, spelling), app, true, reads), spelling).toThrow(
        'and the build reads it'
      );
    }
    expect(existsSync(entry)).toBe(true);
  });

  it('should still refuse `--out .` and `--out ..` as holding the app itself', () => {
    const { app, reads } = makeApp();

    for (const spelling of ['.', '..', `.${sep}`]) {
      expect(() => assertCleanable(resolveOut(app, spelling), app, true, reads), spelling).toThrow(
        'which holds the app itself'
      );
    }
  });

  it('should refuse the source reached through a symlinked directory', () => {
    // `base/alias` is the app, so `base/alias/src` is a sibling of the app by
    // spelling and its `src` on disk -- `rmSync()` follows every link on the
    // way to what it removes. A junction, so that Windows needs no privilege
    // to make one; elsewhere the type is ignored
    const { app, base, entry, reads } = makeApp();
    const alias = join(base, 'alias');
    symlinkSync(app, alias, 'junction');
    const out = join(alias, 'src');

    expect(() => clean(out, app, true, reads)).toThrow(
      `which holds ${displayPath(join('src', 'index.js'))}`
    );
    expect(existsSync(entry)).toBe(true);
  });

  it('should refuse the real directory behind a symlinked command directory', () => {
    // the modules are read through `src/commands`, which is a link to a
    // directory outside the app; emptying that directory empties the commands
    const { app, base, entry } = makeApp();
    const shared = join(base, 'shared');
    mkdirSync(shared);
    writeFileSync(join(shared, 'hello.js'), 'export default { run() {} };\n');
    const linked = join(app, 'src', 'linked');
    symlinkSync(shared, linked, 'junction');
    const module = join(linked, 'hello.js');

    expect(() => clean(shared, app, true, [entry, module])).toThrow(
      `which holds ${displayPath(join('src', 'linked', 'hello.js'))}`
    );
    expect(existsSync(join(shared, 'hello.js'))).toBe(true);
  });

  // a file symlink needs a privilege on Windows that a directory junction does
  // not, and the directory case above is the one that runs there
  it.skipIf(process.platform === 'win32')(
    'should refuse the directory a symlinked module really lives in',
    () => {
      // no directory on the way to the module is a link, so only the module's
      // real path leads to `shared`
      const { app, base, entry } = makeApp();
      const shared = join(base, 'shared');
      mkdirSync(shared);
      writeFileSync(join(shared, 'real.js'), 'export default { run() {} };\n');
      const module = join(app, 'src', 'commands', 'linked.js');
      symlinkSync(join(shared, 'real.js'), module);

      expect(() => clean(shared, app, true, [entry, module])).toThrow(
        `which holds ${displayPath(join('src', 'commands', 'linked.js'))}`
      );
      expect(existsSync(join(shared, 'real.js'))).toBe(true);
    }
  );

  it('should refuse a link the build reads its modules through', () => {
    // removing the link loses no data, but the build reads `src/linked/hello.js`
    // by that path and would fail on it -- and the spelling is the only thing
    // that sees it, since `lstat` of a link is the link and not what it reaches
    const { app, base, entry } = makeApp();
    const shared = join(base, 'shared');
    mkdirSync(shared);
    writeFileSync(join(shared, 'hello.js'), 'export default { run() {} };\n');
    const linked = join(app, 'src', 'linked');
    symlinkSync(shared, linked, 'junction');

    expect(() => clean(linked, app, true, [entry, join(linked, 'hello.js')])).toThrow(
      `which holds ${displayPath(join('src', 'linked', 'hello.js'))}`
    );
    expect(existsSync(join(linked, 'hello.js'))).toBe(true);
  });

  it('should allow an --out that is itself a link to the source, because removing it removes the link', () => {
    // `rmSync()` does not follow the last link, so this unlinks `out` and
    // leaves `src` alone -- which the clean below then proves
    const { app, base, entry, module, reads } = makeApp();
    const out = join(base, 'out');
    symlinkSync(join(app, 'src'), out, 'junction');

    expect(heldFile(out, reads)).toBeUndefined();
    clean(out, app, true, reads);

    expect(existsSync(out)).toBe(false);
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(module)).toBe(true);
  });

  it('should refuse the source spelled in another case where the file system folds case', () => {
    // `relative()` calls `SRC` and `src` strangers on POSIX, and on a volume
    // that folds case -- macOS's default -- they are one directory. Where the
    // volume does not fold, `SRC` is a different directory that does not
    // exist, and there is nothing to refuse
    const { app, entry, reads } = makeApp();
    const out = resolveOut(app, 'SRC');

    if (foldsCase(app)) {
      expect(() => clean(out, app, true, reads)).toThrow(
        `which holds ${displayPath(join('src', 'index.js'))}`
      );
    } else {
      expect(() => assertCleanable(out, app, true, reads)).not.toThrow();
    }
    expect(existsSync(entry)).toBe(true);
  });

  it('should allow an --out inside the app that holds none of the source', () => {
    const { app, base, reads } = makeApp();

    for (const out of [
      resolveOut(app, 'dist'),
      resolveOut(app, join('src', 'commands', 'dist')),
      join(base, 'elsewhere'),
    ]) {
      expect(() => assertCleanable(out, app, true, reads), out).not.toThrow();
    }
  });

  it('should refuse nothing when cleaning was not asked for', () => {
    const { app, reads } = makeApp();

    expect(() => assertCleanable(resolveOut(app, 'src'), app, false, reads)).not.toThrow();
  });

  it('should list what the build reads: the entry, every module, the manifest and the command directory', () => {
    const app = join(tempDir('sigil-clean-source-'), 'buildable');
    copyFixture(join(fixtures, 'buildable'), app);

    const reads = buildReads(inspect({ cwd: app }));

    expect(reads[0]).toBe(join(app, 'src', 'index.ts'));
    expect(reads).toContain(join(app, 'src', 'commands', 'greet.ts'));
    expect(reads).toContain(join(app, 'src', 'commands', 'db', 'migrate.js'));
    expect(reads).toContain(join(app, 'package.json'));
    // files before the directory, so a refusal names something recognisable
    expect(reads.at(-1)).toBe(join(app, 'src', 'commands'));
    // and only what exists: the fixture has no `sigil.json` and no tsconfig
    expect(reads).not.toContain(join(app, 'sigil.json'));
    expect(reads).not.toContain(join(app, 'tsconfig.json'));
  });
});
