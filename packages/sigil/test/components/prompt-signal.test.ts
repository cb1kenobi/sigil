import { autocomplete } from '../../src/components/autocomplete.js';
import { date } from '../../src/components/date.js';
import { number } from '../../src/components/number.js';
import { commandPalette } from '../../src/components/palette.js';
import { path } from '../../src/components/path.js';
import {
  confirm,
  multiline,
  multiselect,
  password,
  PromptError,
  select,
  text,
} from '../../src/components/prompt.js';
import { createInput } from '../../src/input/index.js';
import { parse } from '../../src/parser/parse.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/** Every prompt, asked the smallest question it will take. */
const prompts: [string, (ui: ScreenHarness, signal: AbortSignal) => Promise<unknown>][] = [
  ['text', (ui, signal) => text({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal })],
  [
    'password',
    (ui, signal) => password({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  ],
  [
    'multiline',
    (ui, signal) => multiline({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  ],
  [
    'confirm',
    (ui, signal) => confirm({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  ],
  [
    'select',
    (ui, signal) =>
      select({ ansi: ui.ansi, choices: ['a', 'b'], message: 'Q?', signal, terminal: ui.terminal }),
  ],
  [
    'multiselect',
    (ui, signal) =>
      multiselect({
        ansi: ui.ansi,
        choices: ['a', 'b'],
        message: 'Q?',
        signal,
        terminal: ui.terminal,
      }),
  ],
  [
    'number',
    (ui, signal) => number({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  ],
  ['date', (ui, signal) => date({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal })],
  [
    'autocomplete',
    (ui, signal) =>
      autocomplete({
        ansi: ui.ansi,
        choices: ['a', 'b'],
        message: 'Q?',
        signal,
        terminal: ui.terminal,
      }),
  ],
  ['path', (ui, signal) => path({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal })],
  [
    'commandPalette',
    async (ui, signal) => {
      const state = await parse({
        argv: [],
        env: {},
        schema: { commands: { build: { run(): void {} } }, completion: false, help: false },
      });
      return commandPalette(state, { ansi: ui.ansi, signal, terminal: ui.terminal });
    },
  ],
];

/** How a prompt settled, with the handler attached before anything can reject. */
function settle(promise: Promise<unknown>): Promise<{ error?: unknown; value?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

describe('a prompt given an AbortSignal', () => {
  describe.each(prompts)('%s()', (_name, ask) => {
    it('should reject with the signal reason when it aborts', async () => {
      const ui = screenSetup({ rows: 12 });
      const controller = new AbortController();
      const reason = new Error('the build finished');
      const answer = settle(ask(ui, controller.signal));

      await tick();
      controller.abort(reason);

      expect((await answer).error).to.equal(reason);
    });

    it('should put the terminal back exactly as a cancel does', async () => {
      const ui = screenSetup({ rows: 12 });
      const controller = new AbortController();
      const answer = settle(ask(ui, controller.signal));

      await tick();
      expect(ui.log, 'the question should be on screen first').not.to.deep.equal([]);
      controller.abort();
      await answer;

      expect(ui.log).to.deep.equal([]);
      expect(ui.stdin.rawMode).to.equal(false);
      expect(ui.screen.cursorHidden).to.equal(false);

      // and the cancel it is compared with leaves the same screen
      const cancelled = screenSetup({ rows: 12 });
      const other = settle(ask(cancelled, new AbortController().signal));
      await tick();
      cancelled.stdin.send('\u0003');
      await other;
      expect(cancelled.log).to.deep.equal(ui.log);
      expect(cancelled.screen.cursorHidden).to.equal(ui.screen.cursorHidden);
    });

    it('should draw nothing when the signal is already aborted', async () => {
      const ui = screenSetup();
      const reason = new Error('too late');

      const { error } = await settle(ask(ui, AbortSignal.abort(reason)));

      expect(error).to.equal(reason);
      expect(ui.output).to.equal('');
      expect(ui.stdin.rawMode).to.equal(false);
    });
  });

  it('should reject with a TimeoutError from AbortSignal.timeout', async () => {
    const ui = screenSetup();
    const answer = settle(
      confirm({
        ansi: ui.ansi,
        message: 'Continue?',
        signal: AbortSignal.timeout(20),
        terminal: ui.terminal,
      })
    );

    const { error } = await answer;
    expect((error as Error).name).to.equal('TimeoutError');
    expect(ui.log).to.deep.equal([]);
  });

  it('should reject with an AbortError when aborted with no reason', async () => {
    const ui = screenSetup();
    const controller = new AbortController();
    const answer = settle(
      text({ ansi: ui.ansi, message: 'Q?', signal: controller.signal, terminal: ui.terminal })
    );

    await tick();
    controller.abort();

    expect(((await answer).error as Error).name).to.equal('AbortError');
  });

  it('should not report an abort as a cancel', async () => {
    const ui = screenSetup();
    const controller = new AbortController();
    const answer = settle(
      text({ ansi: ui.ansi, message: 'Q?', signal: controller.signal, terminal: ui.terminal })
    );

    await tick();
    controller.abort();

    // a timeout is the program's decision and a cancel is the person's, so a
    // caller that catches `PromptError` for the second does not swallow the first
    expect((await answer).error).not.toBeInstanceOf(PromptError);
  });

  it('should still answer when the signal aborts afterwards', async () => {
    const ui = screenSetup();
    const controller = new AbortController();
    const answer = settle(
      text({ ansi: ui.ansi, message: 'Q?', signal: controller.signal, terminal: ui.terminal })
    );

    await tick();
    ui.stdin.send('hi');
    await tick();
    ui.stdin.send('\r');
    expect((await answer).value).to.equal('hi');

    controller.abort();
    await tick();
    expect(ui.stdin.rawMode).to.equal(false);
  });

  it('should take its listener off the signal once answered', async () => {
    const ui = screenSetup();
    let added = 0;
    let removed = 0;
    const controller = new AbortController();
    const { signal } = controller;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      added++;
      add(...args);
    }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed++;
      remove(...args);
    }) as typeof remove;

    const answer = text({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal });
    await tick();
    ui.stdin.send('\r');
    await answer;

    expect(added).to.equal(1);
    expect(removed).to.equal(1);
  });

  it('should leave the other prompt alone when one aborts', async () => {
    const first = screenSetup();
    const second = screenSetup();
    const controller = new AbortController();
    const aborted = settle(
      text({
        ansi: first.ansi,
        message: 'One?',
        signal: controller.signal,
        terminal: first.terminal,
      })
    );
    const answer = text({ ansi: second.ansi, message: 'Two?', terminal: second.terminal });

    await tick();
    controller.abort();
    await aborted;
    second.stdin.send('x');
    await tick();
    second.stdin.send('\r');

    expect(await answer).to.equal('x');
  });

  it('should leave a router the app handed in running', async () => {
    const ui = screenSetup();
    const router = createInput({ terminal: ui.terminal });
    const controller = new AbortController();
    const answer = settle(
      text({
        ansi: ui.ansi,
        message: 'Q?',
        router,
        signal: controller.signal,
        terminal: ui.terminal,
      })
    );

    await tick();
    controller.abort();
    await answer;

    expect(ui.stdin.rawMode, 'the app still owns stdin').to.equal(true);
    router.stop();
  });
});
