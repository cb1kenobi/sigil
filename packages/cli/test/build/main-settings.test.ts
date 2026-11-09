import { mainSettingsIn } from '../../src/build/main-settings.js';
import { parseModule } from '../../src/build/parse-module.js';
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
