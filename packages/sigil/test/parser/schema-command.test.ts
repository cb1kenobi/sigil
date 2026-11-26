/**
 * The `schema` command every app gets, which prints each command's input as
 * JSON Schema (SIG-717). Run through `main()`, because what is being pinned is
 * what an agent sees when it types `mycli schema`.
 */

import { commandSurface, inputSchemasJson } from '../../src/reference/index.js';
import { runCommand } from '../../src/testing/command.js';
import type { Schema } from '../../src/types.js';
import { UsageError } from '../../src/util/usage-error.js';
import { describe, expect, it } from 'vitest';

/** An app with a root option, a namespace, a hidden command and a leaf. */
function app(extra: Partial<Schema> = {}): Schema {
  return {
    commands: {
      db: {
        commands: {
          migrate: {
            args: [{ name: '<target>' }],
            desc: 'Migrate the database',
            options: { '--dry-run': {} },
            run() {},
          },
          seed: { desc: 'Seed it', run() {} },
        },
        desc: 'Database tasks',
      },
      deploy: { alias: 'ship', desc: 'Ship it', run() {} },
      secret: { hidden: true, run() {} },
    },
    name: 'mycli',
    options: { '--config [file]': { desc: 'Where the config is' } },
    ...extra,
  };
}

/** The paths of the commands a run printed. */
function printed(out: string): string[] {
  return JSON.parse(out).commands.map((cmd: { path: string[] }) => cmd.path.join(' '));
}

describe('the schema command', () => {
  it("should print every runnable command's input", async () => {
    const ran = await runCommand({ argv: ['schema'], schema: app() });

    expect(ran.code, ran.err).toBe(0);
    expect(printed(ran.out)).toEqual(['db migrate', 'db seed', 'deploy']);
    const migrate = JSON.parse(ran.out).commands[0].inputSchema;
    // the root's option reaches it, which is what a caller cannot work out alone
    expect(Object.keys(migrate.properties)).toEqual(['config', 'dryRun', 'target']);
    expect(migrate.required).toEqual(['target']);
  });

  it('should print exactly what sigil reference --json-schema prints', async () => {
    // one function behind both, so the app and the toolchain cannot describe
    // one app two ways
    const ran = await runCommand({ argv: ['schema'], schema: app() });
    expect(ran.out).toBe(inputSchemasJson(await commandSurface(app())));
  });

  it('should leave the framework out of what it prints', async () => {
    // `help`, `completion` and `schema` itself are added by the parse and are
    // not the app's to describe, which is the surface's own rule
    const ran = await runCommand({ argv: ['schema'], schema: app({ run() {} }) });
    expect(printed(ran.out)).toEqual(['', 'db migrate', 'db seed', 'deploy']);
  });

  it('should print one command, and what is under it, when named', async () => {
    expect(
      printed((await runCommand({ argv: ['schema', 'db', 'migrate'], schema: app() })).out)
    ).toEqual(['db migrate']);
    expect(printed((await runCommand({ argv: ['schema', 'db'], schema: app() })).out)).toEqual([
      'db migrate',
      'db seed',
    ]);
  });

  it('should find a command by an alias, and by a topic path', async () => {
    expect(printed((await runCommand({ argv: ['schema', 'ship'], schema: app() })).out)).toEqual([
      'deploy',
    ]);

    const coloned = await runCommand({
      argv: ['schema', 'db:migrate'],
      schema: app({ topicSeparator: ':' }),
    });
    expect(printed(coloned.out)).toEqual(['db migrate']);
  });

  it('should print a hidden command when it is named, as help does', async () => {
    expect(printed((await runCommand({ argv: ['schema'], schema: app() })).out)).not.toContain(
      'secret'
    );
    expect(printed((await runCommand({ argv: ['schema', 'secret'], schema: app() })).out)).toEqual([
      'secret',
    ]);
  });

  it('should find a command whose module renames it, by the name it routes by', async () => {
    // the module's own `name` wins the merge, so the loaded command is called
    // `compile` while the registry and the surface both know it as `build`.
    // Resolving `under` from the loaded command's name matched no surface path
    // and printed an empty document with exit 0. Found by review
    const renamed = app({
      commands: {
        build: {
          load: () =>
            Promise.resolve({
              default: { name: 'compile', options: { '--minify': {} }, run() {} },
            }),
        },
      },
    });

    const ran = await runCommand({ argv: ['schema', 'build'], schema: renamed });
    expect(ran.code, ran.err).toBe(0);
    expect(printed(ran.out)).toEqual(['build']);
    expect(Object.keys(JSON.parse(ran.out).commands[0].inputSchema.properties)).toEqual([
      'config',
      'minify',
    ]);
  });

  it('should answer for an app that declares no name, with the name help prints', async () => {
    // `Schema.name` is optional and help falls back to the script's own name;
    // `commandSurface()` refuses a missing one, so `schema` crashed on an app
    // whose help listed it. Found by review
    const { name: _, ...unnamed } = app();

    const ran = await runCommand({ argv: ['schema'], schema: unnamed });
    expect(ran.code, ran.err).toBe(0);

    const usage = (await runCommand({ argv: ['--help'], schema: unnamed })).out;
    expect(usage).toContain(`Usage: ${JSON.parse(ran.out).program} `);
  });

  it('should refuse a command that does not exist the way help does', async () => {
    const ran = await runCommand({ argv: ['schema', 'deplyo'], schema: app() });

    expect(ran.code).toBe(2);
    expect(ran.error).toBeInstanceOf(UsageError);
    expect((ran.error as UsageError).code).toBe('unknown-command');
    expect(ran.err).toContain('Did you mean "deploy"?');
    expect(ran.out).toBe('');
  });

  it('should answer on an app with a required global option', async () => {
    // the document is a function of the schema, so a value argv did not carry
    // is not missing from it -- `completion`'s rule
    const ran = await runCommand({
      argv: ['schema'],
      schema: app({ options: { '--token <token>': {} } }),
    });
    expect(ran.code, ran.err).toBe(0);
    expect(JSON.parse(ran.out).program).toBe('mycli');
  });

  it('should be listed in help', async () => {
    const ran = await runCommand({ argv: ['--help'], schema: app() });
    expect(ran.out).toMatch(/schema +Print each command's input as JSON Schema/u);
  });

  it('should be turned off by schema: false', async () => {
    const ran = await runCommand({ argv: ['schema'], schema: app({ schema: false }) });
    expect(ran.code).toBe(2);
    expect(ran.err).toContain('Unexpected argument "schema"');
  });

  it("should leave an app's own schema command alone", async () => {
    const ours = await runCommand({
      argv: ['schema'],
      schema: app({ commands: { schema: { run: () => 'ours' } } }),
    });
    expect(ours.result).toBe('ours');
    expect(ours.out).toBe('');

    // an alias of that name is the app's too, which is what `find()` answers
    const aliased = await runCommand({
      argv: ['schema'],
      schema: app({ commands: { describe: { alias: 'schema', run: () => 'aliased' } } }),
    });
    expect(aliased.result).toBe('aliased');
  });
});
