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
import type * as Components from '../../src/components/index.js';
import { commandPalette } from '../../src/components/palette.js';
import { box, text as textNode } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { parse } from '../../src/parser/parse.js';
import { type PromptName, type ScreenHarness, screenSetup, tick } from './helpers.js';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

/** Asks one prompt the smallest question it will take, under `signal`. */
type Ask = (ui: ScreenHarness, signal: AbortSignal) => Promise<unknown>;

/** What answers with a promise and takes a signal and is still not a prompt, and why. */
const EXEMPT = {
  decrypt:
    'an animation rather than a question: an abort erases it and resolves, which ' +
    'decrypt.test.ts pins, where a prompt rejects with the reason',
  runLinePrompt:
    'the line engine, which takes no `accessible` and is always lines, so it fits ' +
    'neither run as a row; it is every line-form row below, asked through its prompt',
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
  // read only, and a directory of the suite's own is there on every platform --
  // a small one, since a line form lists it before it asks and the timeout row
  // has 20ms for that read to land in
  directoryTree: (ui, signal) =>
    directoryTree({
      ansi: ui.ansi,
      message: 'Q?',
      root: join(import.meta.dirname, '..', 'debug'),
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
      root: join(import.meta.dirname, '..', 'debug'),
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

/** Whether an argument is an options object that takes `accessible`. */
type TakesAccessible<P> = P extends object ? ('accessible' extends keyof P ? true : never) : never;

/**
 * Every prompt with a line form, read off its options rather than written down.
 *
 * `accessible` is on `AccessibleOptions`, which only the options of a prompt with
 * a line form extend, so the types already say which prompts these are -- the
 * same way `PromptName` reads which exports are prompts off the barrel.
 */
type LineName = {
  [K in PromptName]: [
    TakesAccessible<NonNullable<Parameters<(typeof Components)[K]>[number]>>,
  ] extends [never]
    ? never
    : K;
}[PromptName];

/**
 * The rows that are drawn even with accessible mode on, and why.
 *
 * Keyed by everything in the table that does not take `accessible`, so a prompt
 * that gains the option without leaving this list is a type error, and so is one
 * added to the table without a line form and without a reason here. An exception
 * is an entry with a reason, never an omission -- `EXEMPT`'s rule, one table on.
 */
const DRAWN_ONLY = {
  // its follow-on questions are text(), select() and multiline() and do go as
  // lines; the list of commands it opens on is a runPrompt() of its own
  commandPalette: 'the command list is drawn; only the questions after a pick are lines',
  editor:
    'its question is drawn, and what it is for is handing the terminal to another ' +
    'program, which no line form can stand in for',
  runPrompt:
    'the engine of the drawn path; its line twin is runLinePrompt(), exempt above, ' +
    'and every row below is the line path asked through its prompt',
} satisfies Record<Exclude<keyof typeof prompts, LineName>, string>;

/** How a prompt settled, with the handler attached before anything can reject. */
function settle(promise: Promise<unknown>): Promise<{ error?: unknown; value?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

/** The escape sequences written, less the paste markers the router writes in either mode. */
function sequences(ui: ScreenHarness): string[] {
  const rest = ui.output.replaceAll('\u001b[?2004h', '').replaceAll('\u001b[?2004l', '');
  // eslint-disable-next-line no-control-regex
  return rest.match(/\u001b[^\u001b]{0,8}/g) ?? [];
}

/** A signal that counts the listeners put on it and taken off it. */
function counted(): { added: () => number; controller: AbortController; removed: () => number } {
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
  return { added: () => added, controller, removed: () => removed };
}

/**
 * Waits for a prompt to have asked, which is a tick for most and a directory read
 * for a line form that lists one -- `filePicker()`, `directoryTree()` -- whose
 * question is written once the read lands. Waiting on the output to stop moving
 * rather than on a tick count is what keeps an abort and the Ctrl-C it is held to
 * landing on the same transcript, however long the read takes.
 */
async function asked(ui: ScreenHarness, lines: boolean): Promise<void> {
  await tick();
  if (!lines) {
    return;
  }
  let seen = ui.output;
  for (let still = 0, round = 0; still < 4 && round < 100; round++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    still = ui.output === seen ? still + 1 : 0;
    seen = ui.output;
  }
}

/** What a Ctrl-C leaves, which is what an abort and a timeout are held to. */
async function cancelled(ask: Ask, lines: boolean): Promise<ScreenHarness> {
  const ui = screenSetup({ rows: 12 });
  const answer = settle(ask(ui, new AbortController().signal));
  await asked(ui, lines);
  ui.stdin.send('\u0003');
  await answer;
  return ui;
}

/**
 * The two ways a prompt can be put, and the rows each is asked about.
 *
 * One table and two runs, so a row added for the drawn run is in the line run
 * too unless `DRAWN_ONLY` says why not. The line run is switched on with
 * `SIGIL_ACCESSIBLE`, which is how a person turns it on for every app they run,
 * rather than with the option, which would mean a second set of rows to keep.
 */
const MODES = [
  { lines: false, mode: 'drawn', rows: Object.entries(prompts) as [string, Ask][] },
  {
    lines: true,
    mode: 'as lines, with SIGIL_ACCESSIBLE=1',
    rows: (Object.entries(prompts) as [string, Ask][]).filter(([name]) => !(name in DRAWN_ONLY)),
  },
];

describe('the table of prompts', () => {
  it('should hold a row or an exemption for every prompt the barrel exports', () => {
    // the `satisfies` on `prompts` is what names a missing row. This is the
    // other direction, and it is not the same check: every object satisfies an
    // empty record, so a `PromptName` that came out empty -- a predicate that
    // stopped matching -- would pass the `satisfies` with every row in place
    expectTypeOf<keyof typeof prompts | keyof typeof EXEMPT>().toEqualTypeOf<PromptName>();
  });

  describe('with SIGIL_ACCESSIBLE=1', () => {
    beforeEach(() => {
      vi.stubEnv('SIGIL_ACCESSIBLE', '1');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // what the types say is a line form has to be one at runtime, or the second
    // run is the drawn path asked twice and proves nothing; and an exception has
    // to really be drawn, or it is a line form the second run is missing
    it.each(Object.keys(prompts))('should ask %s() the way its row says', async (name) => {
      const ui = screenSetup({ rows: 12 });
      const controller = new AbortController();
      const answer = settle(prompts[name as keyof typeof prompts](ui, controller.signal));

      await asked(ui, true);
      const drawn = sequences(ui).length > 0;
      controller.abort();
      await answer;

      expect(
        drawn,
        drawn ? 'drawn, so it belongs in DRAWN_ONLY' : 'lines, so not in DRAWN_ONLY'
      ).to.equal(name in DRAWN_ONLY);
    });
  });
});

describe.each(MODES)('a prompt given an AbortSignal, $mode', ({ lines, rows }) => {
  beforeEach(() => {
    if (lines) {
      vi.stubEnv('SIGIL_ACCESSIBLE', '1');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Holds the terminal to what a cancel left it as.
   *
   * A drawn prompt takes itself off the screen; a line form takes nothing back,
   * so what it leaves is the transcript and a fresh line under it -- byte for
   * byte what a Ctrl-C writes, since both are the same `fail()`.
   */
  function expectLeftAsCancelled(ui: ScreenHarness, cancel: ScreenHarness): void {
    expect(ui.log).to.deep.equal(cancel.log);
    if (lines) {
      expect(ui.output).to.equal(cancel.output);
      expect(ui.output.endsWith('\r\n'), 'the next output starts on a line of its own').to.equal(
        true
      );
    } else {
      expect(ui.log).to.deep.equal([]);
    }
    expect(ui.stdin.rawMode).to.equal(false);
    expect(ui.stdin.listenerCount('data'), 'stdin is handed back unread').to.equal(0);
    expect(ui.screen.cursorHidden).to.equal(false);
    expect(ui.screen.cursorHidden).to.equal(cancel.screen.cursorHidden);
  }

  describe.each(rows)('%s()', (_name, ask) => {
    it('should reject with the signal reason when it aborts', async () => {
      const ui = screenSetup({ rows: 12 });
      const controller = new AbortController();
      const reason = new Error('the build finished');
      const answer = settle(ask(ui, controller.signal));

      await asked(ui, lines);
      controller.abort(reason);

      expect((await answer).error).to.equal(reason);
    });

    it('should put the terminal back exactly as a cancel does', async () => {
      const ui = screenSetup({ rows: 12 });
      const controller = new AbortController();
      const answer = settle(ask(ui, controller.signal));

      await asked(ui, lines);
      expect(ui.log, 'the question should be on screen first').not.to.deep.equal([]);
      controller.abort();
      await answer;

      expectLeftAsCancelled(ui, await cancelled(ask, lines));
    });

    it('should draw nothing when the signal is already aborted', async () => {
      const ui = screenSetup();
      const reason = new Error('too late');

      const { error } = await settle(ask(ui, AbortSignal.abort(reason)));

      expect(error).to.equal(reason);
      expect(ui.output).to.equal('');
      expect(ui.stdin.rawMode).to.equal(false);
    });

    // a timer has no idea how far the prompt has got, so this is held to what
    // must be true **whenever** it fires rather than to a Ctrl-C at one moment.
    // `cancelled()` presses Ctrl-C once the prompt has finished asking, and a
    // line `filePicker()` asks in two writes with a directory read between them:
    // a read slower than the timer put the abort between the two, and the
    // transcript was the question alone where the Ctrl-C's had the listing too
    it('should reject with a TimeoutError from AbortSignal.timeout', async () => {
      const ui = screenSetup({ rows: 12 });

      const { error } = await settle(ask(ui, AbortSignal.timeout(20)));

      expect((error as Error).name).to.equal('TimeoutError');
      const cancel = await cancelled(ask, lines);
      if (lines) {
        // what it printed is the start of what a whole ask prints, however much
        // of the ask it got through, and the next output starts a line
        expect(cancel.log.slice(0, ui.log.length)).to.deep.equal(ui.log);
        expect(ui.output.endsWith('\r\n'), 'the next output starts on a line of its own').to.equal(
          true
        );
      } else {
        expect(ui.log).to.deep.equal([]);
      }
      expect(ui.stdin.rawMode).to.equal(false);
      expect(ui.stdin.listenerCount('data'), 'stdin is handed back unread').to.equal(0);
      expect(ui.screen.cursorHidden).to.equal(false);
    });

    it('should take its listener off the signal when cancelled', async () => {
      // an abort's listener is `once`, so it comes off by itself; a cancel is the
      // ending that has to take it off by hand, and a signal that outlives many
      // prompts collects one per prompt that forgot
      const ui = screenSetup({ rows: 12 });
      const { added, controller, removed } = counted();
      const answer = settle(ask(ui, controller.signal));

      await asked(ui, lines);
      ui.stdin.send('\u0003');
      await answer;

      expect(added()).to.be.greaterThan(0);
      expect(removed()).to.equal(added());
    });
  });
});

describe('a prompt given an AbortSignal', () => {
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
    const { added, controller, removed } = counted();

    const answer = text({
      ansi: ui.ansi,
      message: 'Q?',
      signal: controller.signal,
      terminal: ui.terminal,
    });
    await tick();
    ui.stdin.send('\r');
    await answer;

    expect(added()).to.equal(1);
    expect(removed()).to.equal(1);
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
