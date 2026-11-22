import { displayPath } from '../../src/build/diagnostic.ts';
import { readAppCatalogs } from '../../src/build/i18n.ts';
import {
  checkSchemaUpdateCheck,
  discoverApp,
  readAppCommands,
  readSchemaUpdateCheck,
  schemaWantsUpdateCheck,
  walkTree,
} from '../../src/build/index.ts';
import { checkMainSettings } from '../../src/build/main-settings.ts';
import { findSchema, schemaModule } from '../../src/build/schema-module.ts';
import { buildReads, inspect } from '../../src/commands/_inspect.ts';
import { tempDir } from '../temp.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Reading a schema that the entry imports rather than writes.
 *
 * Every pass that reads the schema off source used to read the entry module, so an
 * app that kept its schema in a file of its own was read as an app with no schema:
 * the update-check checks stayed silent and the command tree said `no "commands"
 * found` (SIG-566). `schemaModule()` is the one place that says where the schema
 * is, and the readers are asserted here against an app that keeps it elsewhere --
 * each test fails when that reader goes back to opening the entry.
 */

/** An app on disk, from a map of relative path to source. Returns the root. */
function appOf(files: Record<string, string>): string {
  const root = tempDir('sigil-schema-module-');
  const all = {
    'package.json': JSON.stringify({
      dependencies: { '@ttylabs/sigil': '*' },
      name: 'schema-module-app',
      type: 'module',
    }),
    ...files,
  };

  for (const [name, source] of Object.entries(all)) {
    const file = join(root, ...name.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}

const RUNTIME = "import { main } from '@ttylabs/sigil';\n";
/** A schema that asks for a check, names no checker, and routes `./commands`. */
const ASKS =
  "export default { baseDir: import.meta.dirname, commands: './commands', updateCheck: true };\n";

/** The schema's file, relative to the app. */
function whereIs(root: string, entry = 'src/index.js'): string {
  const found = schemaModule(join(root, ...entry.split('/')));
  return found.slice(root.length + 1).replaceAll('\\', '/');
}

describe('which module holds the schema', () => {
  it('should be the entry when the entry writes the schema', () => {
    const root = appOf({ 'src/index.js': 'export default { commands: "./commands" };\n' });

    expect(whereIs(root)).toBe('src/index.js');
  });

  it('should follow `export default` of an imported name', () => {
    const root = appOf({
      'src/index.js': "import schema from './schema.js';\nexport default schema;\n",
      'src/schema.js': ASKS,
    });

    expect(whereIs(root)).toBe('src/schema.js');
  });

  it('should follow a default re-export', () => {
    const root = appOf({
      'src/index.js': "export { default } from './schema.js';\n",
      'src/schema.js': ASKS,
    });

    expect(whereIs(root)).toBe('src/schema.js');
  });

  it('should follow a named import that is exported as the default', () => {
    const root = appOf({
      'src/index.js': "import { schema } from './schema.js';\nexport { schema as default };\n",
      'src/schema.js': `export const schema = ${ASKS.slice('export default '.length)}`,
    });

    expect(whereIs(root)).toBe('src/schema.js');
  });

  it('should follow the `schema` export, which a built app reads when there is no default', () => {
    const root = appOf({
      'src/index.js': "export { default as schema } from './schema.js';\n",
      'src/schema.js': ASKS,
    });

    expect(whereIs(root)).toBe('src/schema.js');
  });

  it('should follow a re-export through a barrel to the file that writes it', () => {
    const root = appOf({
      'src/index.js': "export { default } from './lib/index.js';\n",
      'src/lib/index.js': "export { default } from './schema.js';\n",
      'src/lib/schema.js': ASKS,
    });

    expect(whereIs(root)).toBe('src/lib/schema.js');
  });

  it('should follow a `.js` specifier to the `.ts` file that answers to it', () => {
    const root = appOf({
      'src/index.ts': "import schema from './schema.js';\nexport default schema;\n",
      'src/schema.ts': ASKS,
    });

    expect(whereIs(root, 'src/index.ts')).toBe('src/schema.ts');
  });

  it('should follow an entry that also holds directives, types and type-only imports', () => {
    const root = appOf({
      'src/index.ts': [
        "'use strict';",
        "import type { Schema } from './types.js';",
        "import schema from './schema.js';",
        'export type { Schema };',
        'interface Options { readonly name: string }',
        'type Name = Options["name"];',
        'export type Both = Name | Options;',
        'export default schema;',
        '',
      ].join('\n'),
      'src/schema.ts': ASKS,
    });

    expect(whereIs(root, 'src/index.ts')).toBe('src/schema.ts');
  });

  it('should follow what an entry hands to main() when it exports no schema', () => {
    for (const call of ['main({ schema })', 'main({ schema: schema })', 'main(schema)']) {
      const root = appOf({
        'src/index.js': `${RUNTIME}import schema from './schema.js';\nawait ${call};\n`,
        'src/schema.js': ASKS,
      });

      expect(findSchema(join(root, 'src', 'index.js'))).toEqual({
        file: join(root, 'src', 'schema.js'),
        viaMain: true,
      });
    }
  });

  it('should read an entry that exports a schema and also starts itself as the entry', () => {
    // it does more than forward, so the schema may be partly written here
    const root = appOf({
      'src/index.js': `${RUNTIME}import schema from './schema.js';\nawait main({ schema });\nexport default schema;\n`,
      'src/schema.js': ASKS,
    });

    expect(whereIs(root)).toBe('src/index.js');
  });

  describe('what it cannot read for certain is the entry, as it always was', () => {
    const cases: Record<string, Record<string, string>> = {
      'a package import': {
        'src/index.js': "import schema from 'some-package';\nexport default schema;\n",
      },
      'a specifier nothing answers to': {
        'src/index.js': "import schema from './missing.js';\nexport default schema;\n",
      },
      'a namespace': {
        'src/index.js': "import * as schema from './schema.js';\nexport default schema;\n",
        'src/schema.js': ASKS,
      },
      'a schema built by a call': {
        'src/index.js': "import base from './schema.js';\nexport default { ...base, name: 'x' };\n",
        'src/schema.js': ASKS,
      },
      'a local binding': {
        'src/index.js':
          "import base from './schema.js';\nconst schema = { ...base };\nexport default schema;\n",
        'src/schema.js': ASKS,
      },
      'a file that does not parse': {
        'src/index.js': "import schema from './schema.js';\nexport default schema;\n",
        'src/schema.js': 'export default {',
      },
      'a file that is not a script': {
        'src/index.js':
          "import schema from './schema.json' with { type: 'json' };\nexport default schema;\n",
        'src/schema.json': '{ "updateCheck": true }',
      },
      'a name the other module does not export': {
        'src/index.js': "import { nothing } from './schema.js';\nexport default nothing;\n",
        'src/schema.js': ASKS,
      },
      'an entry that adds the keys to the schema it imports': {
        'src/index.js':
          "import schema from './schema.js';\nObject.assign(schema, { commands: './commands' });\nexport default schema;\n",
        'src/schema.js': "export default { name: 'a' };\n",
      },
      'an entry that assigns to a named import it exports as the schema': {
        'src/index.js':
          "import { base } from './base.js';\nbase.commands = './commands';\nexport { base as schema };\n",
        'src/base.js': 'export const base = {};\n',
      },
      'an entry that imports a module for what it does to the schema': {
        'src/index.js':
          "import './patch.js';\nimport schema from './schema.js';\nexport default schema;\n",
        'src/patch.js': "import schema from './schema.js';\nschema.commands = './commands';\n",
        'src/schema.js': ASKS,
      },
      'an entry that re-exports something from a module that changes the schema': {
        'src/index.js':
          "import schema from './schema.js';\nexport { ready } from './setup.js';\nexport default schema;\n",
        'src/setup.js':
          "import schema from './schema.js';\nschema.updateCheck = false;\nexport const ready = true;\n",
        'src/schema.js': ASKS,
      },
      'an entry that imports a binding from a module that changes the schema': {
        'src/index.js':
          "import schema from './schema.js';\nimport { ready } from './setup.js';\nexport default schema;\nexport { ready };\n",
        'src/setup.js':
          "import schema from './schema.js';\nschema.updateCheck = false;\nexport const ready = true;\n",
        'src/schema.js': ASKS,
      },
      'an entry that re-exports everything from a module that changes the schema': {
        'src/index.js':
          "import schema from './schema.js';\nexport * from './patch.js';\nexport default schema;\n",
        'src/patch.js': "import schema from './schema.js';\nschema.commands = './x';\n",
        'src/schema.js': ASKS,
      },
      'an export declared in a forwarding module, which may do anything': {
        'src/index.js':
          "import schema from './schema.js';\nexport const ready = Object.assign(schema, { commands: './x' });\nexport default schema;\n",
        'src/schema.js': ASKS,
      },
      'a main() call with a second schema key': {
        'src/index.js': `${RUNTIME}import a from './a.js';\nimport b from './b.js';\nmain({ schema: a, schema: b });\n`,
        'src/a.js': ASKS,
        'src/b.js': ASKS,
      },
      'a main() call with a spread that may bring a schema': {
        'src/index.js': `${RUNTIME}import a from './a.js';\nimport options from './options.js';\nmain({ schema: a, ...options });\n`,
        'src/a.js': ASKS,
        'src/options.js': 'export default {};\n',
      },
      'a main() call with a second argument': {
        'src/index.js': `${RUNTIME}import a from './a.js';\nmain({ schema: a }, patch(a));\n`,
        'src/a.js': ASKS,
      },
      'a barrel that changes the schema it passes on': {
        'src/index.js': "export { default } from './mid.js';\n",
        'src/mid.js':
          "import schema from './schema.js';\nschema.settings = {};\nexport default schema;\n",
        'src/schema.js': ASKS,
      },
      'an entry that starts itself and does something else': {
        'src/index.js': `${RUNTIME}import schema from './schema.js';\nschema.updateCheck = false;\nawait main({ schema });\n`,
        'src/schema.js': ASKS,
      },
      'a re-export cycle': {
        'src/index.js': "export { default } from './a.js';\n",
        'src/a.js': "export { default } from './b.js';\n",
        'src/b.js': "export { default } from './a.js';\n",
      },
      'an `export *` that may supply the schema': {
        'src/index.js': "import { schema } from './barrel.js';\nexport { schema };\n",
        'src/barrel.js': "export * from './schema.js';\n",
        'src/schema.js': 'export const schema = {};\n',
      },
      'a main() call whose schema is in two files': {
        'src/index.js': `${RUNTIME}import a from './a.js';\nimport b from './b.js';\nmain({ schema: a });\nmain({ schema: b });\n`,
        'src/a.js': ASKS,
        'src/b.js': ASKS,
      },
      'a main() call whose schema is written in it': {
        'src/index.js': `${RUNTIME}import other from './other.js';\nmain({ schema: { commands: './c' } });\nmain({ schema: other });\n`,
        'src/other.js': ASKS,
      },
      'a main() that is not the runtime': {
        'src/index.js':
          "import schema from './schema.js';\nfunction main() {}\nmain({ schema });\n",
        'src/schema.js': ASKS,
      },
    };

    for (const [name, files] of Object.entries(cases)) {
      it(`should answer the entry for ${name}`, () => {
        expect(whereIs(appOf(files))).toBe('src/index.js');
      });
    }

    it('should answer the entry for a file that does not exist', () => {
      expect(schemaModule(join(tempDir('sigil-schema-module-'), 'nothing.js'))).toMatch(
        /nothing\.js$/
      );
    });
  });
});

describe('a schema imported from another file', () => {
  /** The same app, with the schema written in a file of its own. */
  function split(schema: string, extra: Record<string, string> = {}): string {
    return appOf({
      'src/index.js': "export { default } from './config/schema.js';\n",
      'src/config/schema.js': schema,
      ...extra,
    });
  }

  it('should have its asking for an update check read, which was silent', () => {
    const root = split(ASKS);
    const entry = join(root, 'src', 'index.js');

    expect(readSchemaUpdateCheck(entry)).toBe('asks');
    expect(schemaWantsUpdateCheck(entry)).toBe(true);
  });

  it('should have its naming a checker read, which was silent', () => {
    const root = split(
      "export default { updateCheck: { checker: { type: 'custom', url: 'https://example.com/v', path: ['v'] } } };\n"
    );

    expect(readSchemaUpdateCheck(join(root, 'src', 'index.js'))).toBe('names');
  });

  it('should have a checker the runtime refuses reported, in the file it is written in', () => {
    const root = split(
      [
        'export default {',
        '  name: "x",',
        "  updateCheck: { checker: { type: 'custom', url: 'not a url', path: ['v'] } },",
        '};',
        '',
      ].join('\n')
    );

    const [diagnostic, ...rest] = checkSchemaUpdateCheck(join(root, 'src', 'index.js'));

    expect(rest).toEqual([]);
    expect(diagnostic?.file).toBe(join(root, 'src', 'config', 'schema.js'));
    // the line and column of the checker's `{` in that file
    expect([diagnostic?.line, diagnostic?.column]).toEqual([3, 27]);
    expect(diagnostic?.severity).toBe('error');
  });

  it('should have its commands found, relative to the file that declares them', () => {
    const root = split(
      "export default { baseDir: import.meta.dirname, commands: './commands' };\n"
    );

    const read = readAppCommands(discoverApp(root));

    expect(read.found).toBe(true);
    expect(read.commands).toEqual({
      dir: join(root, 'src', 'config', 'commands'),
      kind: 'directory',
    });
    expect(read.diagnostics).toEqual([]);
  });

  it('should warn about a missing baseDir at the schema, not at the entry', () => {
    const root = split("\nexport default { commands: './commands' };\n");

    const [warning, ...rest] = readAppCommands(discoverApp(root)).diagnostics;

    expect(rest).toEqual([]);
    expect(warning?.file).toBe(join(root, 'src', 'config', 'schema.js'));
    expect([warning?.line, warning?.column]).toEqual([2, 28]);
    expect(warning?.message).toContain(displayPath(join(root, 'src', 'config')));
  });

  it('should have its single-command `run` read, so the app is not called empty', () => {
    const root = split('export default { run() {} };\n');

    expect(readAppCommands(discoverApp(root))).toMatchObject({ found: false, root: true });
  });

  it('should have its catalogs read, from the loader relative to the schema', () => {
    const root = split(
      "export default { locales: { de: () => import('./de.json', { with: { type: 'json' } }) } };\n",
      { 'src/config/de.json': '{ "Hello": "Hallo" }' }
    );

    const read = readAppCatalogs(discoverApp(root));

    expect(read.declared).toBe(true);
    expect(read.catalogs.map((c) => c.locale)).toEqual(['de']);
    expect(read.files).toEqual([join(root, 'src', 'config', 'de.json')]);
  });

  describe('the settings a warning describes', () => {
    const dev =
      "import { main } from '@ttylabs/sigil';\nimport schema from './src/index.js';\nawait main({ schema, settings: { allowUnknownOptions: true } });\n";

    it('should be read from the schema, saying what a built app uses', () => {
      const root = split(
        'const schema = { settings: { allowUnknownOptions: false } };\nexport default schema;\n',
        { 'dev.js': dev }
      );

      const [warning] = checkMainSettings(discoverApp(root));

      expect(warning?.message).toContain("A built app uses the schema's `allowUnknownOptions`.");
    });

    it('should keep the general sentence when the entry does more than forward the schema', () => {
      // an entry that touches the schema could change `settings` where the count in the
      // schema's own file cannot see it
      const root = appOf({
        'dev.js': dev,
        'src/index.js':
          "import schema from './config/schema.js';\nschema.settings.allowUnknownOptions = true;\nexport default schema;\n",
        'src/config/schema.js':
          'const schema = { settings: { allowUnknownOptions: false } };\nexport default schema;\n',
      });

      const [warning] = checkMainSettings(discoverApp(root));

      expect(warning?.message).not.toContain('A built app uses');
    });
  });

  it('should be one the build will not clean over', () => {
    const root = split(ASKS);

    expect(buildReads(inspect({ cwd: root }))).toContain(join(root, 'src', 'config', 'schema.js'));
  });
});

describe('an entry that adds to the schema it imports', () => {
  const root = (): string =>
    appOf({
      'src/index.js':
        "import schema from './schema.js';\nObject.assign(schema, { baseDir: import.meta.dirname, commands: './commands', updateCheck: true });\nexport default schema;\n",
      'src/schema.js': "export default { name: 'a' };\n",
    });

  it('should still have its commands read from the entry, as an app that builds today does', () => {
    const read = readAppCommands(discoverApp(root()));

    expect(read.found).toBe(true);
    expect(read.diagnostics).toEqual([]);
  });

  it('should still have its update check read from the entry', () => {
    expect(readSchemaUpdateCheck(join(root(), 'src', 'index.js'))).toBe('asks');
  });
});

describe('commands written out in a schema imported from another file', () => {
  it('should resolve a `load` specifier against the schema, not the entry', () => {
    const root = appOf({
      'src/index.js': "export { default } from './config/schema.js';\n",
      'src/config/schema.js':
        "export default { commands: { hi: { load: () => import('./hi.js') } } };\n",
      'src/config/hi.js': 'export default { run() {} };\n',
    });

    const read = readAppCommands(discoverApp(root));

    expect(read.commands?.kind).toBe('inline');
    const [hi] = read.commands?.kind === 'inline' ? read.commands.commands : [];
    expect(hi?.module).toBe(join(root, 'src', 'config', 'hi.js'));
  });

  it('should name the schema file when it declares none, not the entry', () => {
    const root = appOf({
      'src/index.js': "export { default } from './config/schema.js';\n",
      'src/config/schema.js': "export default { name: 'x' };\n",
    });

    const { diagnostics } = inspect({ cwd: root });
    const [none] = diagnostics.filter((d) => d.message.includes('no "commands" found'));

    expect(none?.file).toBe(join(root, 'src', 'config', 'schema.js'));
  });
});

describe('an entry that calls main() with a schema it imports', () => {
  const files = {
    'src/index.js': `${RUNTIME}import schema from './schema.js';\nawait main({ schema });\n`,
    'src/schema.js': `${ASKS.replace('updateCheck: true', "updateCheck: { checker: { type: 'custom', url: 'nope', path: ['v'] } }")}`,
  };

  it('should be checked as the app the entry says it is', () => {
    const { diagnostics } = inspect({ cwd: appOf(files) });
    const messages = diagnostics.map((d) => d.message);

    expect(messages.some((m) => m.includes('this updateCheck checker is refused'))).toBe(true);
    expect(messages.some((m) => m.includes('no "commands" found'))).toBe(false);
  });

  it('should still be an error, because a built app imports the entry for a schema it has none of', () => {
    const { diagnostics } = inspect({ cwd: appOf(files) });
    const [exported] = diagnostics.filter((d) => d.message.includes('exports none'));

    expect(exported?.severity).toBe('error');
    expect(exported?.file).toMatch(/index\.js$/);
  });

  it('should not be said when --commands says where the commands are', () => {
    const root = appOf({ ...files, 'src/commands/hi.js': 'export default { run() {} };\n' });

    const { diagnostics } = inspect({ commands: join(root, 'src', 'commands'), cwd: root });

    expect(diagnostics.some((d) => d.message.includes('exports none'))).toBe(false);
  });

  it('should not be said of an entry that exports its schema', () => {
    const { diagnostics } = inspect({
      cwd: appOf({ ...files, 'src/index.js': "export { default } from './schema.js';\n" }),
    });

    expect(diagnostics.some((d) => d.message.includes('exports none'))).toBe(false);
  });
});

describe('a ui template in a schema imported from another file', () => {
  /** A template whose interpolation sits inside a quoted value, which cannot be compiled. */
  const BROKEN = 'export const banner = () => ui`<text class="a ${\'b\'} c">x</text>`;\n';
  const TEMPLATE = "import { ui } from '@ttylabs/sigil/template';\n";

  /** The template diagnostics of an app, which are the only ones with this wording. */
  function templateErrors(root: string) {
    return inspect({ cwd: root }).diagnostics.filter((d) =>
      d.message.includes('An interpolation inside a quoted value')
    );
  }

  it('should be reported with the schema file, line and column, as one in the entry is', () => {
    const root = appOf({
      'src/index.js': "export { default } from './config/schema.js';\n",
      'src/config/schema.js': `${TEMPLATE}\n${BROKEN}\nexport default { name: 'x' };\n`,
    });

    const [error, ...rest] = templateErrors(root);

    expect(rest).toEqual([]);
    expect(error).toMatchObject({
      column: 29,
      file: join(root, 'src', 'config', 'schema.js'),
      line: 3,
      severity: 'error',
    });
  });

  it('should be reported where the schema is reached through the entry`s main() call', () => {
    const root = appOf({
      'src/index.js': `${RUNTIME}import schema from './schema.js';\nawait main({ schema });\n`,
      'src/schema.js': `${TEMPLATE}${BROKEN}${ASKS}`,
    });

    expect(templateErrors(root).map((d) => basename(d.file ?? ''))).toEqual(['schema.js']);
  });

  it('should be reported once when the schema file is also a command module', () => {
    const root = appOf({
      'src/index.js': "export { default } from './schema.js';\n",
      'src/schema.js': `${TEMPLATE}${BROKEN}export default { commands: { again: { load: () => import('./schema.js') } } };\n`,
    });
    const modules = [...walkTree(inspect({ cwd: root }).commands)].map((c) => c.command.module);

    // the fixture is only meaningful if the schema file really is a command's module
    expect(modules).toContain(join(root, 'src', 'schema.js'));
    expect(templateErrors(root)).toHaveLength(1);
  });

  it('should be reported once when the schema is written in the entry', () => {
    const root = appOf({ 'src/index.js': `${TEMPLATE}${BROKEN}${ASKS}` });

    expect(templateErrors(root)).toHaveLength(1);
  });
});
