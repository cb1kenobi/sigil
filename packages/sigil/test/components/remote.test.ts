/**
 * What a component says to a reader that is not a terminal (SIG-722): progress
 * reports, and prompts asked of somebody else.
 */

import { createProgress } from '../../src/components/progress.js';
import {
  askRemotely,
  confirm,
  multiselect,
  password,
  PromptError,
  type RemoteQuestion,
  select,
  text,
} from '../../src/components/prompt.js';
import { createSpinner } from '../../src/components/spinner.js';
import { observeProgress, type ProgressUpdate } from '../../src/output.js';
import { parse } from '../../src/parser/parse.js';
import type { ParseState } from '../../src/types.js';
import { screenSetup } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
});

/** Every report until the test ends. */
function heard(): ProgressUpdate[] {
  const updates: ProgressUpdate[] = [];
  stops.push(observeProgress((update) => updates.push(update)));
  return updates;
}

/** A harness with no terminal at either end. */
function piped() {
  return screenSetup({ inputTTY: false, isTTY: false });
}

describe('progress reports', () => {
  it('should report a progress bar where it is and of how much', () => {
    const updates = heard();
    const ui = piped();
    const bar = createProgress({ terminal: ui.terminal, text: 'working', total: 4 });

    bar.tick();
    bar.tick();
    bar.done('finished');

    expect(updates.at(0)).toEqual({ message: 'working', progress: 1, total: 4 });
    expect(updates.at(-1)).toEqual({ message: 'finished', progress: 4, total: 4 });
  });

  it('should report even a quiet bar, because a report is not output', () => {
    const updates = heard();
    const ui = piped();
    createProgress({ quiet: true, terminal: ui.terminal, total: 2 }).tick();

    expect(updates.at(-1)).toMatchObject({ progress: 1, total: 2 });
  });

  it('should report a spinner as a count of what it said, which only grows', () => {
    const updates = heard();
    const ui = piped();
    const spinner = createSpinner({ terminal: ui.terminal, text: 'one' }).start();
    spinner.text = 'two';
    spinner.succeed('three');

    expect(updates).toEqual([
      { message: 'one', progress: 1 },
      { message: 'two', progress: 2 },
      { message: 'three', progress: 3 },
    ]);
  });

  it('should still tell the others when one observer throws', () => {
    stops.push(
      observeProgress(() => {
        throw new Error('broken reader');
      })
    );
    const updates = heard();
    const ui = piped();

    expect(() => createProgress({ terminal: ui.terminal, total: 1 }).tick()).not.toThrow();
    expect(updates).toHaveLength(1);
  });

  it('should stop telling an observer once it is taken away', () => {
    const updates: ProgressUpdate[] = [];
    const stop = observeProgress((update) => updates.push(update));
    stop();
    createProgress({ terminal: piped().terminal, total: 1 }).tick();
    expect(updates).toEqual([]);
  });
});

describe('a prompt asked remotely', () => {
  /** Installs an asker that answers with `value`, recording what it was asked. */
  function answering(value: unknown): RemoteQuestion[] {
    const asked: RemoteQuestion[] = [];
    stops.push(
      askRemotely((question) => {
        asked.push(question);
        return Promise.resolve({ answered: true, value });
      })
    );
    return asked;
  }

  it('should ask where there is no terminal, and answer with what came back', async () => {
    const asked = answering('eu');
    const ui = piped();

    expect(await select({ choices: ['us', 'eu'], message: 'Region?', terminal: ui.terminal })).toBe(
      'eu'
    );
    expect(asked).toEqual([
      {
        choices: [
          { label: 'us', value: 'us' },
          { label: 'eu', value: 'eu' },
        ],
        kind: 'select',
        message: 'Region?',
      },
    ]);
  });

  it("should map a label back to its choice's value", async () => {
    answering(['Two']);
    const ui = piped();
    const picked = await multiselect({
      choices: [
        { label: 'One', value: 1 },
        { label: 'Two', value: 2 },
      ],
      message: 'Which?',
      terminal: ui.terminal,
    });
    expect(picked).toEqual([2]);
  });

  it("should hold an answer to the prompt's own rules", async () => {
    answering('x');
    const ui = piped();

    await expect(
      text({
        message: 'Name?',
        terminal: ui.terminal,
        validate: (value) => (value.length < 2 ? 'Too short' : undefined),
      })
    ).rejects.toThrow('"Name?": Too short');
  });

  it('should be a cancelled prompt when it was declined', async () => {
    stops.push(askRemotely(() => Promise.resolve({ answered: false })));
    const ui = piped();

    const err = await confirm({ message: 'Sure?', terminal: ui.terminal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PromptError);
    expect((err as PromptError).aborted).toBe(true);
  });

  it('should never hand a password to a remote asker', async () => {
    const asked = answering('hunter2');
    const ui = piped();

    await expect(password({ message: 'Token?', terminal: ui.terminal })).rejects.toThrow(
      'because the input is not a terminal'
    );
    expect(asked).toEqual([]);
  });

  it('should fail as before where the asker cannot ask this question', async () => {
    stops.push(askRemotely(() => undefined));
    const ui = piped();

    await expect(text({ message: 'Name?', terminal: ui.terminal })).rejects.toThrow(
      'because the input is not a terminal'
    );
  });

  it('should not ask anybody else where there is a terminal to ask on', async () => {
    const asked = answering('remote');
    const ui = screenSetup();

    const answer = text({ message: 'Name?', terminal: ui.terminal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    ui.stdin.send('local\r');
    expect(await answer).toBe('local');
    expect(asked).toEqual([]);
  });
});

describe('a remote asker and a prompt answered by an option, together', () => {
  /** The state `deploy` is handed, with `--region` and `--yes` declared. */
  async function deployState(argv: string[], input?: Record<string, unknown>): Promise<ParseState> {
    return await parse({
      argv: ['deploy', ...argv],
      env: {},
      input,
      schema: {
        commands: { deploy: { options: { '--region [name]': {}, '--yes': {} }, run() {} } },
        name: 'mycli',
      },
    });
  }

  /** Installs an asker that answers with `value`, recording what it was asked. */
  function answering(value: unknown): RemoteQuestion[] {
    const asked: RemoteQuestion[] = [];
    stops.push(
      askRemotely((question) => {
        asked.push(question);
        return Promise.resolve({ answered: true, value });
      })
    );
    return asked;
  }

  it('should take the given value and ask nobody, remote or not', async () => {
    const asked = answering('us');
    const state = await deployState(['--region', 'eu']);

    expect(
      await select({
        choices: ['us', 'eu'],
        message: 'Region?',
        option: '--region',
        state,
        terminal: piped().terminal,
      })
    ).toBe('eu');
    expect(asked).toEqual([]);
  });

  it('should ask the remote asker where nothing answered it, rather than refusing', async () => {
    const asked = answering('eu');
    const state = await deployState([]);

    expect(
      await select({
        choices: ['us', 'eu'],
        message: 'Region?',
        option: '--region',
        state,
        terminal: piped().terminal,
      })
    ).toBe('eu');
    expect(asked).toHaveLength(1);
  });

  it('should say what to pass where the asker cannot ask this question', async () => {
    stops.push(askRemotely(() => undefined));
    const state = await deployState([]);

    await expect(
      confirm({ message: 'Sure?', option: '--yes', state, terminal: piped().terminal })
    ).rejects.toThrow('Cannot ask "Sure?" without a terminal; pass --yes');
  });

  it("should take a flag a call's input passed without asking, as an MCP tool call passes it", async () => {
    const asked = answering(true);
    const state = await deployState([], { yes: false });

    expect(
      await confirm({ message: 'Sure?', option: '--yes', state, terminal: piped().terminal })
    ).toBe(false);
    expect(asked).toEqual([]);
  });
});
