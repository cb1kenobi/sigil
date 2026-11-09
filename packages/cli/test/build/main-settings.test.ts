import { checkMainSettings, mainSettingsIn } from '../../src/build/main-settings.js';
import { parseModule } from '../../src/build/parse-module.js';
import { tempDir } from '../temp.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Finding the settings an app passes to `main()`, which a built app does not get.
 *
 * It is a warning, so the claim worth pinning hardest is the one a warning lives or
 * dies by: **it never fires on correct code**. An app may call `main()` with
 * settings; a test does it constantly. What is wrong is only an app that does it
 * and then ships through `sigil build`, and the matcher has to be certain it is
 * looking at that call and at nothing else.
 */

/** Where the settings are in a source, as `line:column` pairs. */
function found(source: string, file = 'dev.ts'): string[] {
  return mainSettingsIn(parseModule(file, source)).map((call) => `${call.line}:${call.column}`);
}

const RUNTIME = "import { main } from '@ttylabs/sigil';\n";

describe('settings passed to main()', () => {
  it('should find them in the call, at the key', () => {
    expect(found(`${RUNTIME}await main({ schema, settings: { assertCwd: false } });`)).toEqual([
      '2:22',
    ]);
  });

  it('should find them on a later line', () => {
    expect(
      found(`${RUNTIME}await main({
  schema,
  settings: { allowUnknownOptions: false },
});`)
    ).toEqual(['4:3']);
  });

  it('should find a shorthand key, which is written down', () => {
    expect(found(`${RUNTIME}const settings = { assertCwd: false };\nmain({ settings });`)).toEqual([
      '3:8',
    ]);
  });

  it('should find the value whatever it is', () => {
    expect(found(`${RUNTIME}main({ settings: build() });`)).toEqual(['2:8']);
  });

  it('should see through a type assertion on the argument', () => {
    expect(found(`${RUNTIME}main({ settings: { assertCwd: false } } as AppOptions);`)).toEqual([
      '2:8',
    ]);
  });

  describe('the callee is a binding', () => {
    it('should find an aliased import', () => {
      expect(
        found(
          "import { main as run } from '@ttylabs/sigil';\nrun({ settings: { assertCwd: false } });"
        )
      ).toEqual(['2:7']);
    });

    it('should find the default import, which is the same function', () => {
      expect(
        found("import start from '@ttylabs/sigil';\nstart({ settings: { assertCwd: false } });")
      ).toEqual(['2:9']);
    });

    it('should find a member of a namespace import', () => {
      expect(
        found(
          "import * as sigil from '@ttylabs/sigil';\nsigil.main({ settings: { assertCwd: false } });"
        )
      ).toEqual(['2:14']);
    });

    it('should ignore a local function called main', () => {
      expect(found('function main(opts) {}\nmain({ settings: { assertCwd: false } });')).toEqual(
        []
      );
    });

    it('should ignore a main imported from somewhere else', () => {
      expect(
        found("import { main } from 'other';\nmain({ settings: { assertCwd: false } });")
      ).toEqual([]);
    });

    it('should ignore a type-only import, which erases', () => {
      expect(
        found(
          "import type { main } from '@ttylabs/sigil';\nmain({ settings: { assertCwd: false } });"
        )
      ).toEqual([]);
    });

    it('should ignore a name the module binds again', () => {
      expect(
        found(`${RUNTIME}function wrap(main) { main({ settings: { assertCwd: false } }); }`)
      ).toEqual([]);
    });

    it('should ignore another export of the runtime', () => {
      expect(
        found("import { parse } from '@ttylabs/sigil';\nparse({ settings: { assertCwd: false } });")
      ).toEqual([]);
    });
  });

  describe('it never fires on correct code', () => {
    it('should say nothing about a call with no settings', () => {
      expect(found(`${RUNTIME}await main({ schema });`)).toEqual([]);
      expect(found(`${RUNTIME}await main();`)).toEqual([]);
    });

    it('should say nothing about the settings on the schema, which is where they belong', () => {
      expect(
        found(`${RUNTIME}await main({ schema: { name: 'a', settings: { assertCwd: false } } });`)
      ).toEqual([]);
    });

    it('should say nothing about settings on something that is not an argument of main()', () => {
      expect(
        found(`${RUNTIME}other({ settings: { assertCwd: false } });\nmain({ schema });`)
      ).toEqual([]);
    });

    it('should say nothing about an argument it cannot read', () => {
      // each could hold settings and could hold none, and a warning that is
      // sometimes wrong is one nobody reads
      expect(found(`${RUNTIME}main(options);`)).toEqual([]);
      expect(found(`${RUNTIME}main({ ...options });`)).toEqual([]);
      expect(found(`${RUNTIME}main({ ['settings']: {} , schema });`)).toEqual([]);
      expect(found(`${RUNTIME}main({ [key]: { assertCwd: false } });`)).toEqual([]);
    });

    it('should say nothing about empty settings, which carry nothing to lose', () => {
      expect(found(`${RUNTIME}main({ schema, settings: {} });`)).toEqual([]);
    });

    it('should say nothing about a method called settings', () => {
      expect(found(`${RUNTIME}main({ settings() { return {}; } });`)).toEqual([]);
    });
  });
});

/**
 * An app on disk with a schema module and, optionally, a `dev` runner.
 *
 * @param files - File name to source.
 * @param entry - Which of them is the schema module.
 * @returns What `checkMainSettings()` is handed.
 */
function appOf(
  files: Record<string, string>,
  entry = 'index.ts'
): Parameters<typeof checkMainSettings>[0] {
  const root = tempDir('sigil-main-settings-');
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  return {
    entry: join(root, entry),
    manifest: { dependencies: ['@ttylabs/sigil'], path: join(root, 'package.json') },
    root,
  };
}

const NESTED = `${RUNTIME}export default {
  name: 'outer',
  async run() {
    await main({ argv: ['--typo'], schema: inner, settings: { errorHandler: false } });
  },
};
`;

describe('which file the warning reads', () => {
  it.each([
    [
      'a function',
      `function step() { return main({ schema, settings: { errorHandler: false } }); }`,
    ],
    [
      'an async arrow',
      `export const step = async () => { await main({ schema, settings: { errorHandler: false } }); };`,
    ],
    [
      'a method',
      `export const app = { async step() { await main({ schema, settings: { errorHandler: false } }); } };`,
    ],
    [
      'a class',
      `class Step { run() { return main({ schema, settings: { errorHandler: false } }); } }`,
    ],
  ])('should say nothing about main({ settings }) inside %s in the schema module', (_, body) => {
    // the schema module is bundled, so a function in it that composes another app
    // keeps its settings when built -- and the advice to move them to the schema
    // would turn every error of the *outer* app into an unhandled rejection
    const app = appOf({
      'index.ts': `${RUNTIME}export default { name: 'outer' };
${body}
`,
    });

    expect(checkMainSettings(app)).toEqual([]);
  });

  it('should say nothing about the README pattern in a command of the schema module', () => {
    expect(checkMainSettings(appOf({ 'index.ts': NESTED }))).toEqual([]);
  });

  it('should say nothing about a top-level call in the schema module, which is a different problem', () => {
    // it runs in the built app in addition to the generated entry's `main()`, and
    // its own settings apply to that call. The double run is not a settings fault
    const app = appOf({
      'index.ts': `${RUNTIME}export default { name: 'outer' };\nawait main({ settings: { errorHandler: false } });\n`,
    });

    expect(checkMainSettings(app)).toEqual([]);
  });

  it('should report a call in the dev runner, which is never bundled', () => {
    const app = appOf({
      'dev.ts': `${RUNTIME}await main({ schema, settings: { assertCwd: false } });\n`,
      'index.ts': "export default { name: 'a' };\n",
    });

    const [found, ...rest] = checkMainSettings(app);

    expect(rest).toEqual([]);
    expect(found).toMatchObject({ column: 22, line: 2, severity: 'warning' });
    expect(found?.file).toBe(join(app.root, 'dev.ts'));
  });

  it('should read dev.js, which is what sigil new --lang js writes', () => {
    const app = appOf({
      'dev.js': `${RUNTIME}await main({ schema, settings: { assertCwd: false } });\n`,
      'index.js': "export default { name: 'a' };\n",
    });

    expect(checkMainSettings(app)).toHaveLength(1);
  });

  it('should not read a dev module that is itself the schema module', () => {
    // it is bundled then, so its top-level call is the entry's own problem and not
    // a runner's
    const app = appOf(
      {
        'dev.ts': `${RUNTIME}export default { name: 'a' };\nawait main({ settings: { assertCwd: false } });\n`,
      },
      'dev.ts'
    );

    expect(checkMainSettings(app)).toEqual([]);
  });

  it('should report a call inside a function in the dev runner too, since none of it is bundled', () => {
    const app = appOf({
      'dev.ts': `${RUNTIME}export async function go() { await main({ settings: { assertCwd: false } }); }\n`,
      'index.ts': "export default { name: 'a' };\n",
    });

    expect(checkMainSettings(app)).toHaveLength(1);
  });
});

describe('what the built app uses instead', () => {
  const dev = `${RUNTIME}await main({ schema, settings: { allowUnknownOptions: true, errorHandler: false } });\n`;

  /** The one message a runner produced. */
  function said(files: Record<string, string>): string {
    return checkMainSettings(appOf(files))[0]!.message;
  }

  it("should name the schema's setting where the schema sets the key, and the default where it does not", () => {
    const message = said({
      'dev.ts': dev,
      'index.ts':
        "const schema = { name: 'a', settings: { allowUnknownOptions: false } };\nexport default schema;\n",
    });

    expect(message).toContain(
      "A built app uses the schema's `allowUnknownOptions` and the default `errorHandler`."
    );
  });

  it('should say the default for every key when the schema sets none', () => {
    const message = said({ 'dev.ts': dev, 'index.ts': "export default { name: 'a' };\n" });

    expect(message).toContain(
      'A built app uses the default `allowUnknownOptions` and `errorHandler`.'
    );
  });

  it('should keep the general message when the schema cannot be read that far', () => {
    for (const entry of [
      'export default makeSchema();\n',
      "export default { ...base, name: 'a' };\n",
      "export default { name: 'a', settings: shared };\n",
      "export default { name: 'a', settings: { ...shared } };\n",
    ]) {
      const message = said({ 'dev.ts': dev, 'index.ts': entry });

      expect(message).toContain('move them to `settings` on the schema');
      expect(message).not.toContain('A built app uses');
    }
  });

  it.each([
    [
      'assigned later',
      "const schema = { name: 'a' };\nschema.settings = { errorHandler: false, allowUnknownOptions: false };\nexport default schema;\n",
    ],
    [
      'replaced later',
      "const schema = { name: 'a', settings: {} };\nschema.settings = { errorHandler: false };\nexport default schema;\n",
    ],
    [
      'mutated later',
      "const schema = { name: 'a', settings: {} };\nschema.settings.errorHandler = false;\nexport default schema;\n",
    ],
    [
      'mutated by Object.assign',
      "const schema = { name: 'a', settings: {} };\nObject.assign(schema.settings, { errorHandler: false });\nexport default schema;\n",
    ],
    [
      'assigned later, exported as default by name',
      "const schema = { name: 'a' };\nschema.settings = { errorHandler: false };\nexport { schema as default };\n",
    ],
    [
      'under a computed key',
      "const K = 'settings';\nexport default { name: 'a', [K]: { errorHandler: false } };\n",
    ],
    [
      'wrapped in a call, which can return anything',
      "export default withHouseDefaults({ name: 'a' });\n",
    ],
    [
      'wrapped in a call, through a const',
      "const schema = defineApp({ name: 'a' });\nexport default schema;\n",
    ],
    [
      'wrapped in a call that has settings written in the literal',
      "export default withHouseDefaults({ name: 'a', settings: { errorHandler: false } });\n",
    ],
    [
      'a duplicate key inside settings, where the last is undefined',
      "export default { name: 'a', settings: { errorHandler: false, errorHandler: undefined } };\n",
    ],
    [
      'a duplicate key, where the last wins',
      "export default { name: 'a', settings: { errorHandler: false }, settings: { allowUnknownOptions: false } };\n",
    ],
  ])('should keep the general message when the schema is %s', (_, entry) => {
    // a built app uses the schema's value for each of these, and the detail would
    // say it uses the default -- so it is not said
    const message = said({ 'dev.ts': dev, 'index.ts': entry });

    expect(message).toContain('move them to `settings` on the schema');
    expect(message).not.toContain('A built app uses');
  });

  it('should still say it for a binding that is only declared and exported', () => {
    const message = said({
      'dev.ts': dev,
      'index.ts':
        "const schema = { name: 'a', settings: { errorHandler: false } };\nexport { schema as default };\n",
    });

    expect(message).toContain("A built app uses the schema's `errorHandler`");
  });

  it('should look through parentheses and type assertions on the schema, which change nothing', () => {
    for (const entry of [
      "export default ({ name: 'a', settings: { errorHandler: false } });\n",
      "export default { name: 'a', settings: { errorHandler: false } } as const;\n",
      "const schema = { name: 'a', settings: { errorHandler: false } } satisfies object;\nexport default schema;\n",
    ]) {
      expect(said({ 'dev.ts': dev, 'index.ts': entry })).toContain("the schema's `errorHandler`");
    }
  });

  it('should keep the general message when the call has keys it cannot enumerate', () => {
    for (const settings of [
      '{ ...shared }',
      '{ [key]: 1 }',
      'shared',
      '{ errorHandler: false, errorHandler: undefined }',
    ]) {
      const message = said({
        'dev.ts': `${RUNTIME}await main({ schema, settings: ${settings} });\n`,
        'index.ts': "export default { name: 'a' };\n",
      });

      expect(message).not.toContain('A built app uses');
    }
  });

  it('should not report a call whose every key is undefined, which the merge reads as not named', () => {
    const app = appOf({
      'dev.ts': `${RUNTIME}await main({ schema, settings: { errorHandler: undefined } });\n`,
      'index.ts': "export default { name: 'a' };\n",
    });

    expect(checkMainSettings(app)).toEqual([]);
  });
});
