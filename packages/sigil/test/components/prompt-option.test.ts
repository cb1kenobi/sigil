/**
 * A prompt answered by an option or an argument (SIG-719): given, the prompt is
 * skipped; not given with nobody to ask, the run is told what to pass.
 */

import { confirm, multiselect, PromptError, select, text } from '../../src/components/prompt.js';
import { parse } from '../../src/parser/parse.js';
import { runCommand } from '../../src/testing/command.js';
import type { ParseState, Schema } from '../../src/types.js';
import { UsageError } from '../../src/util/usage-error.js';
import { screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/** The state a command's `run()` would be handed, for `deploy` and these argv. */
async function stateOf(
  argv: string[],
  options: Schema['options'],
  extra: { args?: unknown[]; env?: Record<string, string> } = {}
): Promise<ParseState> {
  return await parse({
    argv: ['deploy', ...argv],
    env: extra.env ?? {},
    schema: {
      commands: { deploy: { args: extra.args as never, options, run() {} } },
      name: 'mycli',
    },
  });
}

/** A harness with no terminal at either end, so any prompt that asks fails. */
function piped() {
  return screenSetup({ inputTTY: false, isTTY: false });
}

/** What a promise rejected with, or a failure when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('a prompt answered by an option', () => {
  describe('text()', () => {
    it('should take the value given in argv and ask nobody', async () => {
      const ui = piped();
      const state = await stateOf(['--name', 'ada'], { '--name [name]': {} });

      expect(await text({ message: 'Name?', option: '--name', state, terminal: ui.terminal })).toBe(
        'ada'
      );
      expect(ui.output).toBe('');
    });

    it('should take it from the environment, and from a declared default', async () => {
      const ui = piped();
      const fromEnv = await stateOf(
        [],
        { '--name [name]': { env: 'NAME' } },
        { env: { NAME: 'bo' } }
      );
      const fromDefault = await stateOf([], { '--name [name]': { default: 'cy' } });

      expect(
        await text({ message: 'Name?', option: '--name', state: fromEnv, terminal: ui.terminal })
      ).toBe('bo');
      expect(
        await text({
          message: 'Name?',
          option: '--name',
          state: fromDefault,
          terminal: ui.terminal,
        })
      ).toBe('cy');
    });

    it('should say what to pass when nothing answered it and nobody can be asked', async () => {
      const ui = piped();
      const state = await stateOf([], { '--name [name]': {} });

      const err = await rejection(
        text({ message: 'Name?', option: '--name', state, terminal: ui.terminal })
      );
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe('missing-option');
      expect((err as UsageError).exitCode).toBe(2);
      expect((err as Error).message).toBe(
        'Cannot ask "Name?" without a terminal; pass --name <name>'
      );
    });

    it("should hold the given value to the prompt's own validate", async () => {
      const ui = piped();
      const state = await stateOf(['--name', 'x'], { '--name [name]': {} });

      const err = await rejection(
        text({
          message: 'Name?',
          option: '--name',
          state,
          terminal: ui.terminal,
          validate: (value) => (value.length < 2 ? 'Too short' : undefined),
        })
      );
      expect((err as UsageError).code).toBe('invalid-value');
      expect((err as Error).message).toBe('Invalid value "x" for --name <name>: Too short');
    });

    it('should ask a person when there is one and nothing answered it', async () => {
      const ui = screenSetup();
      const state = await stateOf([], { '--name [name]': {} });

      const asked = text({ message: 'Name?', option: '--name', state, terminal: ui.terminal });
      await tick();
      ui.stdin.send('dee\r');
      expect(await asked).toBe('dee');
    });
  });

  describe('confirm()', () => {
    it('should take a flag that was typed, or set through its variable', async () => {
      const ui = piped();
      const typed = await stateOf(['--yes'], { '--yes': {} });
      const env = await stateOf([], { '--yes': { env: 'YES' } }, { env: { YES: '1' } });

      expect(
        await confirm({ message: 'Sure?', option: '--yes', state: typed, terminal: ui.terminal })
      ).toBe(true);
      expect(
        await confirm({ message: 'Sure?', option: '--yes', state: env, terminal: ui.terminal })
      ).toBe(true);
    });

    it("should not read a flag's implied false as an answer", async () => {
      // nobody said it, so with nobody to ask the run is told to pass it
      const ui = piped();
      const state = await stateOf([], { '--yes': {} });

      const err = await rejection(
        confirm({ message: 'Sure?', option: '--yes', state, terminal: ui.terminal })
      );
      expect((err as Error).message).toBe('Cannot ask "Sure?" without a terminal; pass --yes');
    });

    it('should take a typed false through the negated twin', async () => {
      const ui = piped();
      const state = await stateOf(['--no-yes'], { '--no-yes': {}, '--yes': {} });

      expect(
        await confirm({ message: 'Sure?', option: '--yes', state, terminal: ui.terminal })
      ).toBe(false);
    });
  });

  describe('select()', () => {
    const choices = ['us', 'eu'];

    it('should take a value that is one of the choices', async () => {
      const ui = piped();
      const state = await stateOf(['--region', 'eu'], { '--region [region]': {} });

      expect(
        await select({
          choices,
          message: 'Region?',
          option: '--region',
          state,
          terminal: ui.terminal,
        })
      ).toBe('eu');
    });

    it('should refuse a value that is not, as an invalid value', async () => {
      const ui = piped();
      const state = await stateOf(['--region', 'mars'], { '--region [region]': {} });

      const err = await rejection(
        select({ choices, message: 'Region?', option: '--region', state, terminal: ui.terminal })
      );
      expect((err as UsageError).code).toBe('invalid-value');
      expect((err as Error).message).toBe('Invalid value "mars" for --region <us|eu>');
    });

    it('should refuse a disabled choice, which a person could not pick', async () => {
      const ui = piped();
      const state = await stateOf(['--region', 'eu'], { '--region [region]': {} });

      const err = await rejection(
        select({
          choices: ['us', { disabled: 'full', label: 'eu' }],
          message: 'Region?',
          option: '--region',
          state,
          terminal: ui.terminal,
        })
      );
      expect((err as UsageError).code).toBe('invalid-value');
    });

    it('should name the values on offer when nobody can be asked', async () => {
      const ui = piped();
      const state = await stateOf([], { '--region [region]': {} });

      const err = await rejection(
        select({ choices, message: 'Region?', option: '--region', state, terminal: ui.terminal })
      );
      expect((err as Error).message).toBe(
        'Cannot ask "Region?" without a terminal; pass --region <us|eu>'
      );
    });
  });

  describe('multiselect()', () => {
    const choices = ['a', 'b', 'c'];

    it('should take every use of a repeatable option, and a single value as a list of one', async () => {
      const ui = piped();
      const many = await stateOf(['--tag', 'a', '--tag', 'c'], {
        '--tag [tag]': { multiple: true },
      });
      const one = await stateOf(['--tag', 'b'], { '--tag [tag]': {} });

      expect(
        await multiselect({
          choices,
          message: 'Tags?',
          option: '--tag',
          state: many,
          terminal: ui.terminal,
        })
      ).toEqual(['a', 'c']);
      expect(
        await multiselect({
          choices,
          message: 'Tags?',
          option: '--tag',
          state: one,
          terminal: ui.terminal,
        })
      ).toEqual(['b']);
    });

    it('should refuse a member that is not a choice', async () => {
      const ui = piped();
      const state = await stateOf(['--tag', 'a', '--tag', 'z'], {
        '--tag [tag]': { multiple: true },
      });

      const err = await rejection(
        multiselect({ choices, message: 'Tags?', option: '--tag', state, terminal: ui.terminal })
      );
      expect((err as Error).message).toBe('Invalid value "z" for --tag <a|b|c>');
    });

    it('should say what to pass when nothing answered it', async () => {
      const ui = piped();
      const state = await stateOf([], { '--tag [tag]': { multiple: true } });

      const err = await rejection(
        multiselect({ choices, message: 'Tags?', option: '--tag', state, terminal: ui.terminal })
      );
      expect((err as UsageError).code).toBe('missing-option');
    });
  });

  describe('what it names', () => {
    it('should take an argument by its name, and say so as an argument when missing', async () => {
      const ui = piped();
      const given = await stateOf(['prod'], {}, { args: [{ name: '[target]' }] });
      const missing = await stateOf(
        [],
        {},
        { args: [{ choices: ['prod', 'dev'], name: '[target]' }] }
      );

      expect(
        await text({ message: 'Where?', option: 'target', state: given, terminal: ui.terminal })
      ).toBe('prod');
      const err = await rejection(
        text({ message: 'Where?', option: 'target', state: missing, terminal: ui.terminal })
      );
      expect((err as UsageError).code).toBe('missing-argument');
      expect((err as Error).message).toBe(
        'Cannot ask "Where?" without a terminal; pass <prod|dev>'
      );
    });

    it("should take an ancestor's option, which argv reaches the same way", async () => {
      const ui = piped();
      const state = await parse({
        argv: ['--profile', 'work', 'deploy'],
        env: {},
        schema: {
          commands: { deploy: { run() {} } },
          name: 'mycli',
          options: { '--profile [profile]': {} },
        },
      });

      expect(
        await text({ message: 'Profile?', option: '--profile', state, terminal: ui.terminal })
      ).toBe('work');
    });

    it('should prefer the declared choices to the ones on offer in the message', async () => {
      const ui = piped();
      const state = await stateOf([], { '--region [region]': { choices: ['us', 'eu', 'ap'] } });

      const err = await rejection(
        select({
          choices: ['us', 'eu'],
          message: 'Region?',
          option: '--region',
          state,
          terminal: ui.terminal,
        })
      );
      expect((err as Error).message).toContain('pass --region <us|eu|ap>');
    });

    it("should refuse an option the command does not declare, as the app's mistake", async () => {
      const ui = piped();
      const state = await stateOf(['--region', 'eu'], {});

      const err = await rejection(
        text({ message: 'Region?', option: '--region', state, terminal: ui.terminal })
      );
      expect(err).toBeInstanceOf(PromptError);
      expect((err as Error).message).toBe(
        '"Region?" is answered by --region, which the command does not declare'
      );
    });

    it('should refuse an option with no state to read it from', async () => {
      const ui = piped();

      const err = await rejection(
        text({ message: 'Region?', option: '--region', terminal: ui.terminal })
      );
      expect(err).toBeInstanceOf(PromptError);
      expect((err as Error).message).toContain('has no `state` to read it from');
    });
  });

  it('should reach the serialized error with its code, through main()', async () => {
    // a run with no terminal and `--json` gets a payload a caller can match on
    const ran = await runCommand({
      argv: ['deploy', '--json'],
      schema: {
        commands: {
          deploy: {
            format: true,
            options: { '--region [region]': {} },
            async run(state) {
              return await select({
                choices: ['us', 'eu'],
                message: 'Region?',
                option: '--region',
                state,
              });
            },
          },
        },
        name: 'mycli',
      },
    });

    expect(ran.code).toBe(2);
    expect(JSON.parse(ran.err)).toEqual({
      error: {
        code: 'missing-option',
        message: 'Cannot ask "Region?" without a terminal; pass --region <us|eu>',
        name: 'UsageError',
      },
    });
  });
});
