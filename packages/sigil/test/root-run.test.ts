import { command } from '../src/command.js';
import { runCommand } from '../src/testing/command.js';
import type { AfterRunHookData, AnyCommand } from '../src/types.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A `run` on the schema, which is how a single-command app is written.
 *
 * The schema *is* the root command -- `parse()` builds `contexts[0]` from it --
 * and `main()` used to dispatch only the command that **matched**, so a root
 * `run` was unreachable: the app `sigil new --single` scaffolds parsed argv and
 * then did nothing at all, exit zero, nothing said. Fixed in SIG-150.
 *
 * Driven through `runCommand()` rather than `main()` with spies, because every
 * claim here is about one of the three things `main()` writes to the process --
 * what reached stdout, what reached stderr, and the exit code.
 */

/** The exit code the worker had, so that a failing run never leaves one behind. */
afterEach(() => {
  expect(process.exitCode, 'a run left an exit code on the worker').toBeUndefined();
});

/**
 * The schema `sigil new --single` scaffolds, which is the app this exists for.
 *
 * @param over - What to change about it.
 * @returns The schema.
 */
function single(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    args: [{ desc: 'Who to greet', name: '[who]' }],
    desc: 'What demo does',
    name: 'demo',
    options: { '-v, --verbose': { desc: 'Say more', type: 'bool' } },
    run({ argv }: { argv: { verbose: boolean; who?: string } }) {
      process.stdout.write(`hello ${argv.who ?? 'world'}${argv.verbose ? '!' : ''}\n`);
    },
    ...over,
  };
}

describe('a run on the schema', () => {
  it('should run it when argv named no command', async () => {
    const ran = await runCommand({ argv: ['World'], schema: single() });

    expect(ran.out).toBe('hello World\n');
    expect(ran.err).toBe('');
    expect(ran.code).toBe(0);
  });

  it('should run it when argv is empty', async () => {
    const ran = await runCommand({ argv: [], schema: single() });

    expect(ran.out).toBe('hello world\n');
    expect(ran.code).toBe(0);
  });

  it("should hand it the schema's own args and options", async () => {
    // the whole of what makes the root a command: its `args` and `options` are
    // the schema's, and there is no subcommand for them to belong to
    const ran = await runCommand({ argv: ['--verbose', 'Ada'], schema: single() });

    expect(ran.out).toBe('hello Ada!\n');
    expect(ran.argv).toMatchObject({ verbose: true, who: 'Ada' });
  });

  it('should resolve what it returned', async () => {
    const ran = await runCommand({ argv: [], schema: { name: 'demo', run: () => 'answered' } });

    expect(ran.result).toBe('answered');
  });

  it('should resolve the parse state when it returned nothing', async () => {
    // `main()`'s `?? state`, which is its answer for every command that
    // returns nothing rather than a rule of its own
    const ran = await runCommand({ argv: [], schema: { name: 'demo', run: () => undefined } });

    expect(ran.result).toBe(ran.state);
  });

  it('should leave state.cmd undefined, because the root was never matched', async () => {
    // `cmd` is the command argv matched, and argv matched none. Reading it to
    // find out what argv named has to go on being answerable
    const ran = await runCommand({ argv: [], schema: single() });

    expect(ran.out).toBe('hello world\n');
    expect(ran.state?.cmd).toBeUndefined();
  });

  it('should still refuse a required argument it was not given', async () => {
    // the schema's own arguments are validated whether or not anything
    // dispatches the root, which is what made this a dispatch fix rather than
    // a parse one
    const ran = await runCommand({ argv: [], schema: single({ args: [{ name: '<who>' }] }) });

    expect(ran.out).toBe('');
    expect(ran.err).toContain('<who>');
    expect(ran.code).not.toBe(0);
  });

  describe('what outranks it', () => {
    it('should answer --help instead', async () => {
      const ran = await runCommand({ argv: ['--help'], schema: single() });

      expect(ran.out).toContain('What demo does');
      expect(ran.out).not.toContain('hello');
      expect(ran.code).toBe(0);
    });

    it('should keep the schema’s own argument on the help screen', async () => {
      // the cost the other available fix would have paid: a hidden `default`
      // command runs, and then `[who]` belongs to the command rather than to
      // the schema and leaves the root usage line
      const ran = await runCommand({ argv: ['--help'], schema: single() });

      expect(ran.out).toContain('[who]');
      expect(ran.out).toContain('Who to greet');
    });

    it('should answer --version instead', async () => {
      const ran = await runCommand({ argv: ['--version'], schema: single({ version: '1.2.3' }) });

      expect(ran.out).toBe('1.2.3\n');
    });

    it('should dispatch a default command instead', async () => {
      // an explicit declaration outranks the root answering by position: a
      // command marked `default` has its own name, args and help entry
      const ran = await runCommand({
        argv: [],
        schema: single({
          commands: { serve: command({ default: true, run: () => 'served' }) },
        }),
      });

      expect(ran.result).toBe('served');
      expect(ran.out).toBe('');
    });

    it('should dispatch the command argv named instead', async () => {
      const ran = await runCommand({
        argv: ['build'],
        schema: single({ commands: { build: command({ run: () => 'built' }) } }),
      });

      expect(ran.result).toBe('built');
      expect(ran.out).toBe('');
    });
  });

  it('should not answer for a command argv named that has no run', async () => {
    // a namespace command matched, so the root is not what argv asked for --
    // the fallback is reached by `state.cmd` being unset rather than by its
    // `run` being unset, which is the distinction that keeps this true
    const ran = await runCommand({
      argv: ['db'],
      schema: single({
        commands: { db: command({ commands: { migrate: command({ run: () => undefined }) } }) },
      }),
    });

    expect(ran.out).not.toContain('hello');
    expect(ran.out).toContain('migrate');
  });

  it('should answer rather than printing help for a schema that declares commands', async () => {
    // one rule rather than one per schema shape: a root `run` is what the app
    // does when argv named no command, whether or not it has subcommands too.
    // Making it conditional on declaring no `commands` would mean a `run` going
    // silent the day somebody added a commands directory beside it
    const hello: AnyCommand = command({ desc: 'Say hello', run: () => undefined });
    const ran = await runCommand({ argv: [], schema: single({ commands: { hello } }) });

    expect(ran.out).toBe('hello world\n');
    expect(ran.out).not.toContain('Commands:');
  });

  it('should still print help for a schema that declares commands and no run', async () => {
    const hello: AnyCommand = command({ desc: 'Say hello', run: () => undefined });
    const ran = await runCommand({ argv: [], schema: { commands: { hello }, name: 'demo' } });

    expect(ran.out).toContain('Commands:');
    expect(ran.out).toContain('hello');
  });

  it('should refuse a run that is not a function, the way a command does', async () => {
    // the root goes through `initCommand()` like every other command, so the
    // check that refuses `run: 'nope'` on a command refuses it on the schema.
    // `null` is the same refusal, which is `Command.run`'s `| null` being a
    // type that permits what the runtime throws on -- see `after-run.test.ts`,
    // where a test named for it passed for the wrong reason. That is why the
    // `run` this adds to `Schema` is not typed `| null`
    const ran = await runCommand({ argv: [], schema: single({ run: null }) });

    expect(ran.out).toBe('');
    expect(ran.err).toContain('Invalid run function');
    expect(ran.code).not.toBe(0);
  });

  describe('the hooks it fires', () => {
    it('should fire afterRun with the root as the command that ran', async () => {
      const seen: string[] = [];
      const ran = await runCommand({
        argv: [],
        schema: single({
          hooks: {
            afterRun: (data: AfterRunHookData): void => {
              seen.push(`${data.cmd.name}:${data.result.ok ? 'ok' : 'threw'}`);
            },
          },
        }),
      });

      expect(ran.out).toBe('hello world\n');
      // once rather than twice: the root context is `initCommand()` over a copy
      // of the schema, so the schema's hook is reachable twice and the dedupe
      // is on the function
      expect(seen).toEqual(['demo:ok']);
    });

    it('should fire afterRun with the throw for a root run that failed', async () => {
      const seen: string[] = [];
      const ran = await runCommand({
        argv: [],
        schema: single({
          hooks: {
            afterRun: (data: AfterRunHookData): void => {
              seen.push(`${data.cmd.name}:${data.result.ok ? 'ok' : 'threw'}`);
            },
          },
          run: () => {
            throw new Error('nope');
          },
        }),
      });

      expect(seen).toEqual(['demo:threw']);
      expect(ran.err).toContain('nope');
      expect(ran.code).not.toBe(0);
    });

    it('should fire beforeError for an error the root run threw', async () => {
      const seen: unknown[] = [];
      const ran = await runCommand({
        argv: [],
        schema: single({
          hooks: {
            beforeError: (err: unknown): void => {
              seen.push((err as Error).message);
            },
          },
          run: () => {
            throw new Error('nope');
          },
        }),
      });

      expect(seen).toEqual(['nope']);
      expect(ran.error).toBeInstanceOf(Error);
      expect(ran.code).not.toBe(0);
    });
  });
});
