import { displayPath, landsAt } from '../src/build/index.ts';
import {
  assertCleanable,
  buildReads,
  bundleWrites,
  clean,
  heldFile,
  inspect,
  resolveOut,
} from '../src/commands/_inspect.ts';
import { copyFixture } from './copy-fixture.ts';
import { tempDir } from './temp.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

    expect(() => clean(out, { clean: true, reads, root: app }, [])).toThrow(
      `Refusing to empty ${displayPath(out)}, which holds ${displayPath(join('src', 'index.js'))}`
    );
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(module)).toBe(true);
  });

  it('should refuse the command directory, naming a module in it', () => {
    const { app, module, reads } = makeApp();
    const out = resolveOut(app, join('src', 'commands'));

    expect(() => clean(out, { clean: true, reads, root: app }, [])).toThrow(
      `which holds ${displayPath(join('src', 'commands', 'hello.js'))}`
    );
    expect(existsSync(module)).toBe(true);
  });

  it('should refuse an --out that is a file the build reads, and say it is that file', () => {
    const { app, entry, reads } = makeApp();

    for (const name of [join('src', 'index.js'), 'package.json', 'sigil.json']) {
      const out = resolveOut(app, name);
      expect(() => clean(out, { clean: true, reads, root: app }, []), name).toThrow(
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
      expect(
        () => assertCleanable(resolveOut(app, spelling), { clean: true, reads, root: app }),
        spelling
      ).toThrow('and the build reads it');
    }
    expect(existsSync(entry)).toBe(true);
  });

  it('should still refuse `--out .` and `--out ..` as holding the app itself', () => {
    const { app, reads } = makeApp();

    for (const spelling of ['.', '..', `.${sep}`]) {
      expect(
        () => assertCleanable(resolveOut(app, spelling), { clean: true, reads, root: app }),
        spelling
      ).toThrow('which holds the app itself');
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

    expect(() => clean(out, { clean: true, reads, root: app }, [])).toThrow(
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

    expect(() => clean(shared, { clean: true, reads: [entry, module], root: app }, [])).toThrow(
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

      expect(() => clean(shared, { clean: true, reads: [entry, module], root: app }, [])).toThrow(
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

    expect(() =>
      clean(linked, { clean: true, reads: [entry, join(linked, 'hello.js')], root: app }, [])
    ).toThrow(`which holds ${displayPath(join('src', 'linked', 'hello.js'))}`);
    expect(existsSync(join(linked, 'hello.js'))).toBe(true);
  });

  it('should allow an --out that is itself a link to the source, because removing it removes the link', () => {
    // `rmSync()` does not follow the last link, so this unlinks `out` and
    // leaves `src` alone -- which the clean below then proves
    const { app, base, entry, module, reads } = makeApp();
    const out = join(base, 'out');
    symlinkSync(join(app, 'src'), out, 'junction');

    expect(heldFile(out, reads)).toBeUndefined();
    clean(out, { clean: true, reads, root: app }, []);

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
      expect(() => clean(out, { clean: true, reads, root: app }, [])).toThrow(
        `which holds ${displayPath(join('src', 'index.js'))}`
      );
    } else {
      expect(() => assertCleanable(out, { clean: true, reads, root: app })).not.toThrow();
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
      expect(() => assertCleanable(out, { clean: true, reads, root: app }), out).not.toThrow();
    }
  });

  it('--out src --no-clean wrote the bundle over the source, and is refused the same way', () => {
    // nothing is removed, but the entry is written over by one of the same
    // name, so a source directory is refused whether or not it is emptied
    const { app, entry, reads } = makeApp();
    const out = resolveOut(app, 'src');

    expect(() =>
      clean(out, { clean: false, reads, root: app, writes: bundleWrites('index') }, [])
    ).toThrow(
      `Refusing to build into ${displayPath(out)}, which holds ${displayPath(join('src', 'index.js'))}`
    );
    expect(existsSync(entry)).toBe(true);
  });

  it('should still let --no-clean build into the app root, which is the escape hatch', () => {
    const { app, reads } = makeApp();

    for (const out of [app, resolveOut(app, '.')]) {
      expect(
        () => assertCleanable(out, { clean: false, reads, root: app, writes: bundleWrites('cli') }),
        out
      ).not.toThrow();
    }
  });

  it('should refuse a --no-clean build into the app root that would write over what it reads', () => {
    // an entry at the root named the way the executable is, and a command
    // directory called `chunks`: the two things a build writes beside it
    const { app, reads } = makeApp();
    const bin = join(app, 'cli.mjs');
    const chunk = join(app, 'chunks', 'hello.js');
    mkdirSync(dirname(chunk));
    writeFileSync(bin, '');
    writeFileSync(chunk, '');

    expect(() =>
      assertCleanable(app, {
        clean: false,
        reads: [...reads, bin],
        root: app,
        writes: bundleWrites('cli'),
      })
    ).toThrow(`Refusing to write over ${displayPath(bin)}, which is cli.mjs`);
    expect(() =>
      assertCleanable(app, {
        clean: false,
        reads: [...reads, chunk],
        root: app,
        writes: bundleWrites('cli'),
      })
    ).toThrow(
      `Refusing to build into ${displayPath(join(app, 'chunks'))}, which holds ${displayPath(join('chunks', 'hello.js'))}`
    );
  });

  it('should ask about the directory it removes when the spelling climbs out of a symlink', () => {
    // `link/../alias/src` is `base/y/alias/src` to the kernel, which follows
    // `link` before it reads `..`, and `base/alias/src` -- the app's source --
    // to `resolve()`, which `rmSync()` is handed. The guard used to ask about
    // the first and the removal took the second. Junctions, for Windows
    const { app, base, entry, reads } = makeApp();
    symlinkSync(app, join(base, 'alias'), 'junction');
    mkdirSync(join(base, 'y', 'z'), { recursive: true });
    mkdirSync(join(base, 'y', 'alias', 'src'), { recursive: true });
    symlinkSync(join(base, 'y', 'z'), join(base, 'link'), 'junction');
    const out = `${join(base, 'link')}${sep}${join('..', 'alias', 'src')}`;

    expect(() => clean(out, { clean: true, reads, root: app }, [])).toThrow(
      `which holds ${displayPath(join('src', 'index.js'))}`
    );
    expect(existsSync(entry)).toBe(true);
  });

  it('should name a module the graph holds, and say it is the module where --out is one', () => {
    // a module `inspect()` never read -- here a vendored one -- is refused once
    // the graph is known. The modules arrive as physical paths, which is what
    // `bundleApp()` hands over
    const { app, base, reads } = makeApp();
    const lib = join(app, 'vendor', 'lib.mjs');
    mkdirSync(dirname(lib));
    writeFileSync(lib, '');
    const guard = { clean: true, reads, root: app };

    expect(() => clean(join(app, 'vendor'), guard, [landsAt(lib)])).toThrow(
      `Refusing to empty ${displayPath(join(app, 'vendor'))}, which holds ${displayPath(join('vendor', 'lib.mjs'))}, a module the app is built from`
    );
    expect(() => clean(lib, guard, [landsAt(lib)])).toThrow(
      `Refusing to remove ${displayPath(lib)}, which is ${displayPath(join('vendor', 'lib.mjs'))}, a module the app is built from`
    );
    expect(existsSync(lib)).toBe(true);
    // and a directory holding none of them is emptied as before
    const out = join(base, 'out');
    mkdirSync(out);
    clean(out, guard, [landsAt(lib)]);
    expect(existsSync(out)).toBe(false);
  });

  it('should list the catalogs the entry declares among what the build reads', () => {
    // `readAppCatalogs()` has already followed each literal `import()` to its
    // file by the time the output directory is cleaned, and the bundle reads
    // it again -- so `--out locales` emptied them and the build failed
    const app = join(tempDir('sigil-clean-source-'), 'i18n');
    copyFixture(join(fixtures, 'i18n'), app);
    const catalog = join(app, 'locales', 'de.json');

    const reads = buildReads(inspect({ cwd: app }));

    expect(reads).toContain(catalog);
    expect(() => clean(resolveOut(app, 'locales'), { clean: true, reads, root: app }, [])).toThrow(
      `which holds ${displayPath(join('locales', 'de.json'))}`
    );
    expect(existsSync(catalog)).toBe(true);
  });

  // the catalog was listed only once it parsed as a JSON object, while the
  // bundle imports it whatever it holds -- so each of these was emptied by
  // `--out locales` and the build then failed on `Module not found`
  it.each([
    ['a JavaScript catalog', 'de.js', "export default { 'Hello, {0}!': 'Hallo, {0}!' };\n"],
    [
      'a JSON catalog with a byte-order mark',
      'de.json',
      '\uFEFF{ "Hello, {0}!": "Hallo, {0}!" }\n',
    ],
    ['a JSON catalog that does not parse', 'de.json', '{ "Hello, {0}!": \n'],
    // a number rather than an array: the old check took `[]` as an object,
    // so an array row passed against the code it was written to catch
    ['a JSON catalog that is not an object', 'de.json', '42\n'],
  ])('should list %s among what the build reads', (_, name, contents) => {
    const app = join(tempDir('sigil-clean-source-'), 'i18n');
    copyFixture(join(fixtures, 'i18n'), app);
    const catalog = join(app, 'locales', name);
    rmSync(join(app, 'locales', 'de.json'));
    writeFileSync(catalog, contents);
    const entry = join(app, 'index.ts');
    writeFileSync(
      entry,
      readFileSync(entry, 'utf-8').replace(
        "import('./locales/de.json', { with: { type: 'json' } })",
        name.endsWith('.json')
          ? `import('./locales/${name}', { with: { type: 'json' } })`
          : `import('./locales/${name}')`
      )
    );

    const reads = buildReads(inspect({ cwd: app }));

    expect(reads).toContain(catalog);
    expect(() => clean(resolveOut(app, 'locales'), { clean: true, reads, root: app }, [])).toThrow(
      `which holds ${displayPath(join('locales', name))}`
    );
    expect(existsSync(catalog)).toBe(true);
  });

  it('should refuse a --no-clean out that is a link to the source, because a write goes through it', () => {
    // `lstat` of the link is the link, which is right for a removal and wrong
    // for a write: the bundle lands in `src`
    const { app, base, entry, reads } = makeApp();
    const out = join(base, 'outlink');
    symlinkSync(join(app, 'src'), out, 'junction');

    expect(() =>
      clean(out, { clean: false, reads, root: app, writes: bundleWrites('index') }, [])
    ).toThrow(
      `Refusing to build into ${displayPath(out)}, which holds ${displayPath(join('src', 'index.js'))}`
    );
    expect(existsSync(entry)).toBe(true);
    // and with cleaning asked for, the link is what is removed, so it is allowed
    expect(heldFile(out, reads)).toBeUndefined();
  });

  it('should refuse a --no-clean build into a link to the app root that writes over what it reads', () => {
    const { app, base, reads } = makeApp();
    const bin = join(app, 'cli.mjs');
    writeFileSync(bin, '');
    const out = join(base, 'rootlink');
    symlinkSync(app, out, 'junction');

    expect(() =>
      assertCleanable(out, {
        clean: false,
        reads: [...reads, bin],
        root: app,
        writes: bundleWrites('cli'),
      })
    ).toThrow(`Refusing to write over ${displayPath(join(out, 'cli.mjs'))}, which is cli.mjs`);
    // and the escape hatch still works through the link when nothing collides
    expect(() =>
      assertCleanable(out, { clean: false, reads, root: app, writes: bundleWrites('cli') })
    ).not.toThrow();
  });

  // a file symlink needs a privilege on Windows that a junction does not
  it.skipIf(process.platform === 'win32')(
    'should refuse a --no-clean write through an output file that is a link to the entry',
    () => {
      const { app, entry, reads } = makeApp();
      symlinkSync(entry, join(app, 'cli.mjs'));

      expect(() =>
        assertCleanable(app, { clean: false, reads, root: app, writes: bundleWrites('cli') })
      ).toThrow(
        `Refusing to write over ${displayPath(join(app, 'cli.mjs'))}, which is ${displayPath(join('src', 'index.js'))}`
      );
      expect(readFileSync(entry, 'utf-8')).not.toBe('');
    }
  );

  it('should read the app root spelled in another case as the root under --no-clean, where the volume folds case', () => {
    // the escape hatch, not a source directory: `APP` is `app` to a volume that
    // folds case, and was refused as holding `package.json`
    const { app, reads } = makeApp();
    const out = join(dirname(app), 'APP');

    if (foldsCase(dirname(app))) {
      expect(() =>
        assertCleanable(out, { clean: false, reads, root: app, writes: bundleWrites('cli') })
      ).not.toThrow();
    } else {
      expect(existsSync(out)).toBe(false);
    }
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
