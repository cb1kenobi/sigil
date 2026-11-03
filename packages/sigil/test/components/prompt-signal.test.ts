import {
  autocomplete,
  autocompleteMultiselect,
  confirm,
  date,
  directoryTree,
  editor,
  filePicker,
  groupMultiselect,
  list,
  maskedText,
  multiline,
  multiselect,
  number,
  password,
  path,
  pickDate,
  PromptError,
  runPrompt,
  select,
  selectKey,
  selectRow,
  selectTree,
  sort,
  text,
  toggle,
} from '../../src/components/index.js';
import { commandPalette } from '../../src/components/palette.js';
import { box, text as textNode } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { parse } from '../../src/parser/parse.js';
import { type PromptName, type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, expectTypeOf, it } from 'vitest';

/** Asks one prompt the smallest question it will take, under `signal`. */
type Ask = (ui: ScreenHarness, signal: AbortSignal) => Promise<unknown>;

/** What answers with a promise and takes a signal and is still not a prompt, and why. */
const EXEMPT = {
  decrypt:
    'an animation rather than a question: an abort erases it and resolves, which ' +
    'decrypt.test.ts pins, where a prompt rejects with the reason',
} satisfies Partial<Record<PromptName, string>>;

/** Every prompt, asked the smallest question it will take. */
const prompts = {
  autocomplete: (ui, signal) =>
    autocomplete({
      ansi: ui.ansi,
      choices: ['a', 'b'],
      message: 'Q?',
      signal,
      terminal: ui.terminal,
    }),
  autocompleteMultiselect: (ui, signal) =>
    autocompleteMultiselect({
      ansi: ui.ansi,
      choices: ['a', 'b'],
      message: 'Q?',
      signal,
      terminal: ui.terminal,
    }),
  commandPalette: async (ui, signal) => {
    const state = await parse({
      argv: [],
      env: {},
      schema: { commands: { build: { run(): void {} } }, completion: false, help: false },
    });
    return commandPalette(state, { ansi: ui.ansi, signal, terminal: ui.terminal });
  },
  confirm: (ui, signal) => confirm({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  date: (ui, signal) => date({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  // read only, and the directory this file is in is there on every platform
  directoryTree: (ui, signal) =>
    directoryTree({
      ansi: ui.ansi,
      message: 'Q?',
      root: import.meta.dirname,
      signal,
      terminal: ui.terminal,
    }),
  // the signal is asked about while the question is up, which is before
  // anything is spawned -- so the command is one that must never run, and none
  // does. An abort while an editor is open is `editor.test.ts`'s
  editor: (ui, signal) =>
    editor({
      ansi: ui.ansi,
      editor: 'sigil-test-never-spawned',
      message: 'Q?',
      signal,
      terminal: ui.terminal,
    }),
  filePicker: (ui, signal) =>
    filePicker({
      ansi: ui.ansi,
      message: 'Q?',
      root: import.meta.dirname,
      signal,
      terminal: ui.terminal,
    }),
  groupMultiselect: (ui, signal) =>
    groupMultiselect({
      ansi: ui.ansi,
      choices: { G: ['a', 'b'] },
      message: 'Q?',
      signal,
      terminal: ui.terminal,
    }),
  list: (ui, signal) => list({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  maskedText: (ui, signal) =>
    maskedText({
      ansi: ui.ansi,
      message: 'Q?',
      signal,
      template: '###',
      terminal: ui.terminal,
    }),
  multiline: (ui, signal) =>
    multiline({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  multiselect: (ui, signal) =>
    multiselect({
      ansi: ui.ansi,
      choices: ['a', 'b'],
      message: 'Q?',
      signal,
      terminal: ui.terminal,
    }),
  number: (ui, signal) => number({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  password: (ui, signal) =>
    password({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  path: (ui, signal) => path({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  pickDate: (ui, signal) =>
    pickDate({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  // the engine every other row is built on, asked directly as well
  runPrompt: (ui, signal) =>
    runPrompt({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }, () => ({
      key(): void {},
      settle(): void {},
      view: box({}, textNode('Q?')),
    })),
  select: (ui, signal) =>
    select({ ansi: ui.ansi, choices: ['a', 'b'], message: 'Q?', signal, terminal: ui.terminal }),
  selectKey: (ui, signal) =>
    selectKey({
      ansi: ui.ansi,
      choices: [{ key: 'a', label: 'All' }],
      message: 'Q?',
      signal,
      terminal: ui.terminal,
    }),
  selectRow: (ui, signal) =>
    selectRow({
      ansi: ui.ansi,
      columns: [{ header: 'Name', key: 'name' }],
      message: 'Q?',
      rows: [{ name: 'a' }, { name: 'b' }],
      signal,
      terminal: ui.terminal,
    }),
  selectTree: (ui, signal) =>
    selectTree({
      ansi: ui.ansi,
      items: [{ items: ['a'], text: 'g' }],
      message: 'Q?',
      signal,
      terminal: ui.terminal,
    }),
  sort: (ui, signal) =>
    sort({ ansi: ui.ansi, choices: ['a', 'b'], message: 'Q?', signal, terminal: ui.terminal }),
  text: (ui, signal) => text({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
  toggle: (ui, signal) => toggle({ ansi: ui.ansi, message: 'Q?', signal, terminal: ui.terminal }),
} satisfies Record<Exclude<PromptName, keyof typeof EXEMPT>, Ask>;

/** How a prompt settled, with the handler attached before anything can reject. */
function settle(promise: Promise<unknown>): Promise<{ error?: unknown; value?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

describe('the table of prompts', () => {
  it('should hold a row or an exemption for every prompt the barrel exports', () => {
    // the `satisfies` on `prompts` is what names a missing row. This is the
    // other direction, and it is not the same check: every object satisfies an
    // empty record, so a `PromptName` that came out empty -- a predicate that
    // stopped matching -- would pass the `satisfies` with every row in place
    expectTypeOf<keyof typeof prompts | keyof typeof EXEMPT>().toEqualTypeOf<PromptName>();
  });
});

describe('a prompt given an AbortSignal', () => {
  describe.each(Object.entries(prompts) as [string, Ask][])('%s()', (_name, ask) => {
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

    it('should reject with a TimeoutError from AbortSignal.timeout', async () => {
      const ui = screenSetup({ rows: 12 });

      const { error } = await settle(ask(ui, AbortSignal.timeout(20)));

      expect((error as Error).name).to.equal('TimeoutError');
      expect(ui.log).to.deep.equal([]);
      expect(ui.stdin.rawMode).to.equal(false);
      expect(ui.screen.cursorHidden).to.equal(false);
    });
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
