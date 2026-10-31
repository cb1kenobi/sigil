import { PromptError } from '../../src/components/prompt.js';
import { toggle, type ToggleOptions } from '../../src/components/toggle.js';
import { loadCatalog } from '../../src/i18n/index.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

const ENTER = '\r';
const SPACE = ' ';
const TAB = '\t';
const SHIFT_TAB = '\u001b[Z';
const CTRL_C = '\u0003';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const UP = '\u001b[A';
const CTRL_RIGHT = '\u001b[1;5C';
const ALT_SPACE = '\u001b ';
const ALT_TAB = '\u001b\t';
const SHIFT_RIGHT = '\u001b[1;2C';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Starts the prompt and reports how it settled, for `prompt.test.ts`'s reason. */
function settle<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

/** A prompt over a screen, with no theme and no colour. */
function open(ui: ScreenHarness, opts: Partial<ToggleOptions> = {}) {
  return toggle({ ansi: ui.ansi, message: 'Notifications', terminal: ui.terminal, ...opts });
}

/** What the screen shows now, blank rows dropped. */
function rows(ui: ScreenHarness): string[] {
  return ui.log.map((line) => line.trimEnd()).filter((line) => line !== '');
}

afterEach(async () => {
  await loadCatalog(undefined, {});
});

describe('toggle()', () => {
  it('should draw both states with the current one marked, off by default', async () => {
    const ui = screenSetup({ rows: 6 });
    const answer = settle(open(ui));

    await tick();

    expect(rows(ui)).toEqual(['? Notifications ◉ off  ◯ on']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should start on the active state when initial is true', async () => {
    const ui = screenSetup({ rows: 6 });
    const answer = settle(open(ui, { initial: true }));

    await tick();

    expect(rows(ui)).toEqual(['? Notifications ◯ off  ◉ on']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe(true);
  });

  it('should answer false on Enter when nothing was pressed', async () => {
    const ui = screenSetup({ rows: 6 });
    const answer = settle(open(ui));

    await tick();
    await type(ui.stdin, ENTER);

    expect((await answer).value).toBe(false);
  });

  it('should use the labels it was given, inactive on the left', async () => {
    const ui = screenSetup({ rows: 6 });
    const answer = settle(open(ui, { active: 'enabled', inactive: 'disabled', initial: true }));

    await tick();

    expect(rows(ui)).toEqual(['? Notifications ◯ disabled  ◉ enabled']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  describe('keys', () => {
    it('should flip to the other state on Tab', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui));

      await tick();
      await type(ui.stdin, TAB);
      expect(rows(ui)).toEqual(['? Notifications ◯ off  ◉ on']);

      await type(ui.stdin, TAB);
      expect(rows(ui)).toEqual(['? Notifications ◉ off  ◯ on']);

      await type(ui.stdin, TAB, ENTER);
      expect((await answer).value).toBe(true);
    });

    it('should flip on Shift-Tab, which with two states goes back to the same place', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui));

      await tick();
      await type(ui.stdin, SHIFT_TAB, ENTER);

      expect((await answer).value).toBe(true);
    });

    it('should flip on Space', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui));

      await tick();
      await type(ui.stdin, SPACE);
      expect(rows(ui)).toEqual(['? Notifications ◯ off  ◉ on']);

      await type(ui.stdin, SPACE, SPACE, ENTER);
      expect((await answer).value).toBe(true);
    });

    it('should choose the active state on Right and the inactive one on Left', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui));

      await tick();
      await type(ui.stdin, RIGHT);
      expect(rows(ui)).toEqual(['? Notifications ◯ off  ◉ on']);

      // pressing it again does not flip it back: an arrow says where to go, not to switch
      await type(ui.stdin, RIGHT);
      expect(rows(ui)).toEqual(['? Notifications ◯ off  ◉ on']);

      await type(ui.stdin, LEFT);
      expect(rows(ui)).toEqual(['? Notifications ◉ off  ◯ on']);

      await type(ui.stdin, LEFT, ENTER);
      expect((await answer).value).toBe(false);
    });

    it('should leave Up and a letter alone', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui));

      await tick();
      await type(ui.stdin, UP, 'y', 't');
      expect(rows(ui)).toEqual(['? Notifications ◉ off  ◯ on']);

      await type(ui.stdin, ENTER);
      expect((await answer).value).toBe(false);
    });

    it.each([
      ['Ctrl-Right', CTRL_RIGHT],
      ['Alt-Space', ALT_SPACE],
      ['Alt-Tab', ALT_TAB],
      ['Shift-Right', SHIFT_RIGHT],
    ])('should not read %s as a move', async (_name, key) => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui));

      await tick();
      await type(ui.stdin, key);
      expect(rows(ui)).toEqual(['? Notifications ◉ off  ◯ on']);

      await type(ui.stdin, ENTER);
      expect((await answer).value).toBe(false);
    });
  });

  describe('colour', () => {
    it('should draw the current state in the accent and the other muted', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui, { colorLevel: 1 }));

      await tick();
      expect(ui.output).toContain('\u001b[36m◉ off\u001b[39m');
      expect(ui.output).toContain('\u001b[2m◯ on');

      await type(ui.stdin, TAB);
      expect(ui.output).toContain('\u001b[36m◉ on');
      expect(ui.output).toContain('\u001b[2m◯ off');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should turn the mark to success once answered, and not before', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui, { colorLevel: 1 }));

      await tick();
      expect(ui.output).not.toContain('\u001b[32m?');

      await type(ui.stdin, ENTER);
      await answer;
      expect(ui.output).toContain('\u001b[32m?');
    });
  });

  describe('answering', () => {
    it('should leave the question and the name of the state chosen', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui, { active: 'enabled', inactive: 'disabled' }));

      await tick();
      await type(ui.stdin, TAB, ENTER);
      await answer;

      expect(rows(ui)).toEqual(['? Notifications enabled']);
    });

    it('should leave the inactive name when that is what was chosen', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui, { active: 'enabled', inactive: 'disabled', initial: true }));

      await tick();
      await type(ui.stdin, LEFT, ENTER);
      await answer;

      expect(rows(ui)).toEqual(['? Notifications disabled']);
    });

    it('should reject with a PromptError on Ctrl-C and leave the terminal as it was', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui));

      await tick();
      await type(ui.stdin, TAB, CTRL_C);

      const { error } = await answer;
      expect(error).toBeInstanceOf(PromptError);
      expect((error as PromptError).aborted).toBe(true);
      expect(ui.stdin.rawMode).toBe(false);
      expect(ui.screen.cursorHidden).toBe(false);
    });
  });

  describe('signal', () => {
    it('should reject with the reason when the signal aborts', async () => {
      const ui = screenSetup({ rows: 6 });
      const controller = new AbortController();
      const reason = new Error('the build finished');
      const answer = settle(open(ui, { signal: controller.signal }));

      await tick();
      controller.abort(reason);

      expect((await answer).error).toBe(reason);
      expect(ui.stdin.rawMode).toBe(false);
      expect(ui.screen.cursorHidden).toBe(false);
    });

    it('should draw nothing when the signal is already aborted', async () => {
      const ui = screenSetup({ rows: 6 });
      const reason = new Error('too late');

      const { error } = await settle(open(ui, { signal: AbortSignal.abort(reason) }));

      expect(error).toBe(reason);
      expect(ui.output).toBe('');
    });

    it('should reject with a TimeoutError from AbortSignal.timeout', async () => {
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui, { signal: AbortSignal.timeout(20) }));

      const { error } = await answer;

      expect((error as Error).name).toBe('TimeoutError');
    });
  });

  describe('labels', () => {
    it('should say the default names in the active language', async () => {
      await loadCatalog({ de: async () => ({ off: 'aus', on: 'an' }) }, {}, 'de');
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui));

      await tick();
      expect(rows(ui)).toEqual(['? Notifications ◉ aus  ◯ an']);

      await type(ui.stdin, TAB, ENTER);
      await answer;
      expect(rows(ui)).toEqual(['? Notifications an']);
    });

    it('should leave a name the caller gave alone when the language changes', async () => {
      await loadCatalog({ de: async () => ({ off: 'aus', on: 'an' }) }, {}, 'de');
      const ui = screenSetup({ rows: 6 });
      const answer = settle(open(ui, { active: 'on', inactive: 'off' }));

      await tick();
      expect(rows(ui)).toEqual(['? Notifications ◉ off  ◯ on']);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should keep both states whole at a width that cannot hold the question beside them', async () => {
      const ui = screenSetup({ columns: 28, rows: 6 });
      const answer = settle(open(ui, { message: 'Enable notifications' }));

      await tick();

      // under the question rather than clipped beside it, which is how a state
      // came to read `o`
      expect(rows(ui)).toEqual(['? Enable notifications', '  ◉ off  ◯ on']);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should not clip the answer when the question takes the whole line', async () => {
      const ui = screenSetup({ columns: 24, rows: 6 });
      const answer = settle(open(ui, { message: 'Enable notifications' }));

      await tick();
      await type(ui.stdin, TAB, ENTER);
      await answer;

      expect(rows(ui).join(' ')).toMatch(/\bon\b/);
    });

    it('should settle to the question and the answer when the states were under it', async () => {
      const ui = screenSetup({ columns: 28, rows: 6 });
      const answer = settle(open(ui, { message: 'Enable notifications' }));

      await tick();
      await type(ui.stdin, TAB, ENTER);
      await answer;

      expect(rows(ui)).toEqual(['? Enable notifications on']);
    });
  });

  describe('options it refuses', () => {
    it.each([
      ['an empty active label', { active: '' }, /`active` is empty/],
      ['a blank inactive label', { inactive: '   ' }, /`inactive` is empty/],
      ['a label with a line break', { active: 'on\noff' }, /control character/],
      ['an initial that is not a boolean', { initial: 'on' as never }, /not a boolean/],
      ['two states with one name', { active: 'on', inactive: ' on ' }, /both "on"/],
    ] as const)('should refuse %s', async (_name, opts, pattern) => {
      const ui = screenSetup({ rows: 6 });

      const { error } = await settle(open(ui, opts));

      expect(error).toBeInstanceOf(PromptError);
      expect((error as PromptError).message).toMatch(pattern);
      expect(ui.output).toBe('');
    });
  });

  it('should reject when there is nobody to answer it', async () => {
    const ui = screenSetup({ isTTY: false, rows: 6 });

    const { error } = await settle(open(ui));

    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).aborted).toBe(false);
  });
});
