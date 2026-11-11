import { discoverApp, readAppCommands, resolveSpecifier } from '../../src/build/discover.js';
import { resolveCommandTree } from '../../src/build/tree.js';
import type { ResolvedCommand } from '../../src/build/tree.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apps = resolve(__dirname, '../fixtures/discover');
const repo = resolve(__dirname, '../../../..');

/** The command of a name, for reading one entry at a time. */
function at(commands: readonly ResolvedCommand[], name: string): ResolvedCommand {
  const found = commands.find((command) => command.name === name);
  if (!found) {
    throw new Error(`no "${name}" in [${commands.map((c) => c.name).join(', ')}]`);
  }
  return found;
}

/**
 * Finding the app, which is step one of the pipeline and the one that decides
 * whether anything else has something to work on.
 *
 * "Run it from the app root and it works out the rest" is the whole of what
 * makes a toolchain feel like one, and every shortcut in it is a guess -- so
 * the guesses are pinned here, and the entry it picked is reported rather than
 * assumed.
 */
describe('discovering an app', () => {
  it('should read the one executable the manifest publishes', () => {
    // what the built file should be called, and a better answer than the
    // package name: a scoped package's name is not its executable's
    const app = discoverApp(join(repo, 'packages', 'cli'));
    expect(app.manifest.bin).toBe('sigil');
    expect(app.manifest.name).toBe('@ttylabs/cli');
  });

  it('should say nothing when a manifest publishes several', () => {
    // a single-bundle build has no answer for more than one, so it leaves the
    // question to --name rather than picking one by key order
    const dir = mkdtempSync(join(tmpdir(), 'sigil-bin-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          bin: { one: './dist/one.mjs', two: './dist/two.mjs' },
          dependencies: { '@ttylabs/sigil': '*' },
          name: 'two-bins',
        })
      );
      writeFileSync(join(dir, 'src', 'index.js'), 'export default { commands: {} };\n');

      expect(discoverApp(dir).manifest.bin).toBeUndefined();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('should find the root and the entry', () => {
    const app = discoverApp(join(apps, 'router-app'));

    expect(app.root).toBe(join(apps, 'router-app'));
    expect(app.entry).toBe(join(apps, 'router-app', 'src', 'index.ts'));
    expect(app.manifest.name).toBe('router-app');
  });

  it('should take the runtime from any kind of dependency', () => {
    // which one an app declares is a packaging decision, and none of them
    // makes it less of a sigil app
    expect(() => discoverApp(join(apps, 'inline-app'))).not.toThrow();
  });

  it('should refuse a directory that does not depend on the runtime', () => {
    // every error after this one would be a worse version of the same message
    expect(() => discoverApp(join(apps, 'not-an-app'))).toThrow(
      /does not depend on @ttylabs\/sigil/
    );
  });

  it('should refuse a directory with no manifest at all', () => {
    expect(() => discoverApp(join(apps, 'router-app', 'src'))).toThrow(/No package\.json in/);
  });

  it('should say what it looked for when there is no entry', () => {
    expect(() => discoverApp(join(apps, 'no-entry'))).toThrow(/Looked for .*--entry/s);
  });

  it('should prefer source over what the manifest names', () => {
    // a published CLI points its `bin` at built output, so following it means
    // parsing a minified bundle whose specifiers are chunk names a bundler
    // invented -- `check` reads what the author edits
    const app = discoverApp(join(apps, 'built-app'));

    expect(app.entry).toBe(join(apps, 'built-app', 'src', 'index.ts'));
    expect(app.entry).not.toContain('dist');
  });

  it('should take an entry the caller names', () => {
    const app = discoverApp(join(apps, 'built-app'), { entry: 'dist/cli.mjs' });
    expect(app.entry).toBe(join(apps, 'built-app', 'dist', 'cli.mjs'));
  });

  it('should refuse an entry the caller names that is not there', () => {
    expect(() => discoverApp(join(apps, 'built-app'), { entry: 'nope.ts' })).toThrow(
      /Entry module not found/
    );
  });

  it('should find this very toolchain, which is the acceptance test', () => {
    // a framework whose toolchain is not written in it has not been tested by
    // anyone who had to live with it
    const app = discoverApp(join(repo, 'packages', 'cli'));

    expect(app.manifest.name).toBe('@ttylabs/cli');
    expect(app.entry).toBe(join(repo, 'packages', 'cli', 'src', 'index.ts'));
  });
});

describe("reading where an app's commands are", () => {
  it('should read a path as a directory for the router to walk', () => {
    const app = discoverApp(join(apps, 'router-app'));
    const { commands } = readAppCommands(app);

    expect(commands?.kind).toBe('directory');
    expect(commands).toMatchObject({ dir: join(apps, 'router-app', 'src', 'commands') });
  });

  it('should resolve that path against the entry, not the working directory', () => {
    const app = discoverApp(join(apps, 'router-app'));
    const { commands } = readAppCommands(app);

    // the entry is `src/index.ts`, so `./commands` is `src/commands`
    expect(commands).toMatchObject({ dir: join(app.entry, '..', 'commands') });
  });

  describe('a schema that writes its commands out', () => {
    it('should read each one', () => {
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);

      expect(commands?.kind).toBe('inline');
      expect(commands?.kind === 'inline' ? commands.commands.map((c) => c.name) : []).toStrictEqual(
        ['build', 'db', 'inline', 'missing']
      );
    });

    it('should follow a load() to the module beside it', () => {
      // the `.js` to `.ts` fallback is the convention this repo follows
      // itself: a TypeScript ES module imports its neighbour as `./build.js`
      // while the file on disk is `build.ts`
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'build').module).toBe(
        join(apps, 'inline-app', 'src', 'commands', 'build.ts')
      );
    });

    it("should let the placeholder's description win over the module's", () => {
      // what the placeholder declares is what help shows before the module
      // loads, which is the runtime's merge read from the other side
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'build').desc).toBe('build it');
    });

    it("should fall back to the module's description when the placeholder has none", () => {
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];
      const db = at(list, 'db');

      expect(at(db.commands, 'migrate').desc).toBe('migrate the database');
    });

    it('a translated desc was baked as English for a command declared as { load } or { path }', () => {
      // SIG-352. The object form rebuilt the command from `desc`, `hidden` and
      // `module` and dropped the lifted `descTranslated`, so the generated tree
      // printed the key as a plain string where a string path to the same
      // module printed `() => __\`...\`` -- two spellings of one declaration
      // disagreeing about whether help is translated
      const app = discoverApp(join(apps, 'translated-placeholders'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(diagnostics).toStrictEqual([]);
      for (const name of ['loaded', 'object', 'pathed']) {
        expect(at(list, name)).toMatchObject({
          desc: 'Build the app',
          descTranslated: true,
          name,
        });
      }

      // the placeholder's own literal wins, and it is prose rather than a key
      expect(at(list, 'literal').desc).toBe('Its own words');
      expect(at(list, 'literal').descTranslated).toBeUndefined();
    });

    it("a placeholder's tagged, thunked or computed desc and computed hidden were replaced by the module's", () => {
      // SIG-352. The runtime registers the placeholder as written, so whatever
      // `desc` or `hidden` it declares is what an unloaded command shows, and
      // the build baked the module's answer wherever the placeholder's was not
      // a plain literal
      const app = discoverApp(join(apps, 'placeholder-decides'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      // a tag evaluated at import is the English from source, so it is prose
      expect(at(list, 'tagged').desc).toBe('Placeholder words');
      expect(at(list, 'tagged').descTranslated).toBeUndefined();
      // a thunk is evaluated after the catalog, so it stays a key
      expect(at(list, 'thunk')).toMatchObject({ desc: 'Placeholder words', descTranslated: true });
      // unreadable: nothing baked, and said so
      expect(at(list, 'computed').desc).toBeUndefined();
      expect(at(list, 'computed').descTranslated).toBeUndefined();
      expect(at(list, 'shown').hidden).toBeUndefined();

      expect(diagnostics.map((d) => [d.severity, d.message])).toStrictEqual([
        [
          'warning',
          'the "computed" command\'s "desc" is computed rather than a string literal, so it cannot be read at build time; the built app will list it by name alone',
        ],
        [
          'warning',
          'the "shown" command\'s "hidden" is computed rather than a boolean literal, so it cannot be read at build time; the built app will list it in help',
        ],
      ]);
    });

    it("should refuse a placeholder's desc or hidden of the wrong type, in the runtime's words", () => {
      const dir = mkdtempSync(join(tmpdir(), 'sigil-placeholder-types-'));
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'types' })
        );
        mkdirSync(join(dir, 'src', 'commands'), { recursive: true });
        writeFileSync(join(dir, 'src', 'commands', 'a.js'), 'export default { run() {} };\n');
        writeFileSync(
          join(dir, 'src', 'index.js'),
          `export default {
  baseDir: import.meta.dirname,
  commands: {
    num: { desc: 42, path: './commands/a.js' },
    str: { hidden: 'yes', path: './commands/a.js' },
  },
};\n`
        );

        const { diagnostics } = readAppCommands(discoverApp(dir));

        expect(
          diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
        ).toStrictEqual([
          'Expected desc for the "num" command to be a string or a function',
          'Expected hidden to be a boolean in "str" command',
        ]);
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });

    it('should nest a subcommand under its parent', () => {
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'db').commands.map((c) => c.name)).toStrictEqual(['migrate']);
    });

    it('should take a command declared with no module at all', () => {
      const app = discoverApp(join(apps, 'inline-app'));
      const { commands } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'inline').module).toBeUndefined();
      expect(at(list, 'inline').desc).toBe('declared here, no module');
    });

    it("should read a placeholder's alias, as a string or as a list", () => {
      const app = discoverApp(join(__dirname, '../fixtures/aliased'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'remove').alias).toStrictEqual(['del']);
      // the template literal with no substitutions is a string somebody wrote
      expect(at(list, 'list').alias).toStrictEqual(['ls', 'dir']);
      expect(at(at(list, 'db').commands, 'drop').alias).toStrictEqual(['rm']);
      expect(at(at(list, 'db').commands, 'drop').default).toBe(true);
      expect(at(list, 'secret').alias).toStrictEqual(['sh']);
      expect(at(list, 'secret').hidden).toBe(true);
      // ...and a command that wrote none has none, rather than an empty list
      expect(at(at(list, 'db').commands, 'drop').hidden).toBeUndefined();
      expect(at(list, 'db').alias).toBeUndefined();
      expect(diagnostics).toStrictEqual([]);
    });

    it("should register a command under its declaration's name string, which beats the key", () => {
      // the runtime fills the key in only when `name` is undefined, so the string
      // is what the tree is keyed by and the built app's own parser reads it
      const app = discoverApp(join(__dirname, '../fixtures/aliased'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(list.map((command) => command.name)).toStrictEqual([
        'remove',
        'list',
        'secret',
        'purge, pg',
        '@zz, clear',
        'db',
      ]);
      expect(diagnostics).toStrictEqual([]);
    });

    it("should name a package a key points at by the package's own names, not the key", () => {
      // SIG-332. The runtime imports such a package when the schema is built and
      // registers it as `cmd.name ?? pkg.name`, so the key is not a spelling of
      // it, and its module's `alias` routes as a placeholder's does
      const root = join(__dirname, '../fixtures/keyed-package');
      const { commands, diagnostics } = readAppCommands(discoverApp(root));
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(list.map((command) => command.name)).toStrictEqual(['lazy, lz', 'bare-pkg']);
      expect(at(list, 'lazy, lz').alias).toStrictEqual(['pk']);
      expect(at(list, 'lazy, lz').desc).toBe('A package that names itself');
      expect(at(list, 'lazy, lz').module).toBe(join(root, 'src', 'pkg', 'index.js'));
      // named and described by its manifest, and its entry is the manifest's
      // `main` rather than an `index` module
      expect(at(list, 'bare-pkg').alias).toBeUndefined();
      expect(at(list, 'bare-pkg').desc).toBe('A package named by its manifest');
      expect(at(list, 'bare-pkg').module).toBe(join(root, 'src', 'bare', 'lib', 'command.js'));
      expect(diagnostics).toStrictEqual([]);
    });

    it('should refuse a package a key points at whose names it cannot read', () => {
      // from source each of these answers to whatever its module computes, so
      // the build cannot route the built app the same way, and says so rather
      // than baking the key
      const app = discoverApp(join(apps, 'package-names'));
      const { diagnostics } = readAppCommands(app);
      const errors = diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => /^the "(\w+)" command[^;]*|^Expected[^,]*/.exec(d.message)?.[0]);

      expect(errors).toStrictEqual([
        'the "computed" command\'s "name" is computed rather than a string literal, so it cannot be read at build time',
        'the "listed" command\'s "alias" is computed rather than a string or a list of strings, so it cannot be read at build time',
        'the "spread" command is a package whose default export spreads another object, which may carry a "name", "alias" or "default" this cannot read',
        'the "getter" command is a package whose default export declares "name" as an accessor or a method rather than a value, so it cannot be read at build time',
        'the "bracketed" command is a package whose default export has a computed key, which may be a "name", "alias" or "default" this cannot read',
        'Expected command name to be a non-empty string in the "unnamed" command',
        'the "broken" command is a package the app cannot load: Command package does not have a valid export: ' +
          join(apps, 'package-names', 'src', 'broken'),
      ]);
      // the refusal says why, where it is about the names
      expect(
        diagnostics.filter((d) => d.message.includes('answers to the names its own module'))
      ).toHaveLength(5);
    });

    it('should refuse an alias or a default of the wrong type, in the runtime’s words', () => {
      // each of these throws from source on every run, so a build that warned and
      // carried on would turn an app that cannot start into one that does. The
      // message is the runtime's own, with the command named
      const app = discoverApp(join(apps, 'wrong-types'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
      expect(errors).toStrictEqual([
        'Expected alias in "number" command to be a string or list of strings',
        'Expected alias in "mixed" command to be a string or list of strings',
        'Expected alias in "nothing" command to be a string or list of strings',
        'Expected default in "text" command to be a boolean',
        'Expected command name to be a non-empty string in the "empty" command',
        'Expected command name to be a non-empty string in the "named" command',
        'Expected alias in "flag" command to be a string or list of strings',
      ]);
      // ...and says nothing of being "computed", which none of them is
      expect(diagnostics.some((d) => d.message.includes('computed'))).toBe(false);
      expect(at(list, 'number').alias).toBeUndefined();
      expect(at(list, 'text').default).toBeUndefined();
    });

    it('should read `undefined` as the runtime does, which is as not declared', () => {
      const app = discoverApp(join(apps, 'wrong-types'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'absent').alias).toBeUndefined();
      expect(at(list, 'absent').default).toBeUndefined();
      expect(diagnostics.filter((d) => d.message.includes('"absent"'))).toStrictEqual([]);
    });

    it('should read `void 0` as `undefined` and `!0` as `true`, as the runtime does', () => {
      // both were refused as the wrong type, because an operator over a literal
      // was taken to have a known type without asking which one -- so a schema
      // the app runs from source failed to build
      const app = discoverApp(join(apps, 'wrong-types'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'voided').alias).toBeUndefined();
      expect(at(list, 'voided').default).toBeUndefined();
      expect(diagnostics.filter((d) => d.message.includes('"voided"'))).toStrictEqual([]);
      expect(at(list, 'negated').default).toBe(true);
      expect(diagnostics.filter((d) => d.message.includes('"negated"'))).toStrictEqual([]);
    });

    it('should warn about every property of a placeholder it does not bake', () => {
      const app = discoverApp(join(apps, 'unbaked'));
      const { diagnostics } = readAppCommands(app);

      const warned = diagnostics.map((d) => {
        expect(d.severity).toBe('warning');
        expect(d.message).toContain('SIG-320');
        return /the "(\w+)" command declares "(\w+)"/.exec(d.message)?.slice(1).join('.');
      });

      // the advice is per property: a module can supply what it merges in, and
      // cannot supply anything that routes
      const messages = diagnostics.map((d) => d.message);
      expect(messages.find((m) => m.includes('"run"'))).toContain("command's module");
      expect(messages.find((m) => m.includes('"options"'))).toContain("command's module");
      expect(messages.find((m) => m.includes('"commands"'))).not.toContain('module');
      expect(messages.find((m) => m.includes('"commands"'))).toContain('object literal');

      // `quiet` declares only what is baked, and `remove` has a `load` of its
      // own that is not mentioned either
      expect(warned).toStrictEqual([
        'hi.run',
        'remove.args',
        'remove.examples',
        'remove.format',
        'remove.hooks',
        'remove.options',
        'tagged.tag',
        'nested.commands',
        // a nested placeholder is read like any other
        'drop.run',
      ]);
    });

    it('should warn about an alias or a default it cannot read, naming the command', () => {
      // unreadable is not the same as absent, and an alias is the one property
      // whose loss makes a spelling unreachable rather than merely unlisted --
      // so it is said, and the command is not given a guess
      const app = discoverApp(join(apps, 'computed-alias'));
      const { commands, diagnostics } = readAppCommands(app);
      const list = commands?.kind === 'inline' ? commands.commands : [];

      expect(at(list, 'remove').alias).toBeUndefined();
      expect(at(list, 'list').alias).toBeUndefined();
      expect(at(list, 'ship').default).toBeUndefined();

      const warnings = diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message);
      expect(warnings).toHaveLength(6);
      expect(warnings.every((message) => message.includes('is computed'))).toBe(true);
      expect(warnings[0]).toContain('"remove" command\'s "alias"');
      expect(warnings[1]).toContain('"list" command\'s "alias"');
      expect(warnings[2]).toContain('"ship" command\'s "default"');
      // a computed name leaves the key as the name, and says so
      expect(warnings[3]).toContain('"push" command\'s "name"');
      expect(warnings[3]).toContain('will name it "push"');
      // the right type with a value the source does not hold is computed rather
      // than wrong: `!x` is a boolean, and a template is a string
      expect(warnings[4]).toContain('"armed" command\'s "default"');
      expect(warnings[5]).toContain('"tagged" command\'s "name"');
      expect(diagnostics.some((d) => d.severity === 'error')).toBe(false);
    });

    it('should report a module that does not resolve as an error', () => {
      // a command whose module is not there is an app that fails when that
      // command is run, which the build has no business shipping
      const app = discoverApp(join(apps, 'inline-app'));
      const { diagnostics } = readAppCommands(app);
      const missing = diagnostics.find((d) => d.message.includes('nope.js'));

      expect(missing?.severity).toBe('error');
      expect(missing?.message).toContain('"missing"');
    });

    it("should read this toolchain's own schema as a routed directory", () => {
      // the toolchain routes its own commands off the filesystem, so the build
      // reading it has to see a directory rather than a written-out list --
      // which is the dogfooding working: what it finds here is what it would
      // find in any app SIG-74 describes
      const app = discoverApp(join(repo, 'packages', 'cli'));
      const { commands } = readAppCommands(app);

      expect(commands?.kind).toBe('directory');
      expect(commands?.kind === 'directory' && commands.dir).toBe(
        join(repo, 'packages', 'cli', 'src', 'commands')
      );
    });

    it("should resolve this toolchain's own tree, descriptions and all", () => {
      // the descriptions live in the modules now, so this is the static lift
      // reading the code its own conventions produce -- which it could not do
      // until it learned to follow `export default cmd` to the const it names
      const app = discoverApp(join(repo, 'packages', 'cli'));
      const { commands } = readAppCommands(app);
      const dir = commands?.kind === 'directory' ? commands.dir : '';
      const { commands: list } = resolveCommandTree(dir);

      expect(list.map((c) => c.name)).toStrictEqual([
        'add',
        'build',
        'check',
        'new',
        'package',
        'reference',
      ]);
      expect(at(list, 'check').desc).toBe('Check an app without building it');
      expect(at(list, 'build').desc).toBe('Build an app into a bundle that depends on nothing');
      expect(at(list, 'check').module).toBe(
        join(repo, 'packages', 'cli', 'src', 'commands', 'check.ts')
      );
    });

    it('should say nothing about a module it cannot read when the placeholder describes it', () => {
      // every diagnostic the fact lift produces is about what help would show
      // before the module loads, and a placeholder `desc` is exactly that
      // answer -- so `export default check` being a reference is not a
      // problem anybody has
      const app = discoverApp(join(repo, 'packages', 'cli'));
      const { diagnostics } = readAppCommands(app);

      expect(diagnostics.filter((d) => d.severity === 'warning')).toStrictEqual([]);
    });
  });
});

describe('resolving an import specifier', () => {
  const from = join(apps, 'inline-app', 'src');

  it('should swap a .js specifier for the .ts beside it', () => {
    expect(resolveSpecifier(from, './commands/build.js')).toBe(join(from, 'commands', 'build.ts'));
  });

  it('should take an extensionless specifier', () => {
    expect(resolveSpecifier(from, './commands/build')).toBe(join(from, 'commands', 'build.ts'));
  });

  it('should answer undefined for a module that is not there', () => {
    expect(resolveSpecifier(from, './commands/nope.js')).toBeUndefined();
  });

  it('should ignore a bare specifier, which is a package', () => {
    // a package's commands are its own business
    expect(resolveSpecifier(from, '@ttylabs/sigil')).toBeUndefined();
  });
});
