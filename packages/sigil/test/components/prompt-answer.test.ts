import {
  autocomplete,
  autocompleteMultiselect,
  groupMultiselect,
  list,
  maskedText,
  multiline,
  multiselect,
  number,
  password,
  path,
  promptAnswerFits,
  select,
  selectKey,
  selectRow,
  selectTree,
  sort,
  text,
} from '../../src/components/index.js';
import { commandPalette } from '../../src/components/palette.js';
import { parse } from '../../src/parser/parse.js';
import { type PromptName, type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, expectTypeOf, it } from 'vitest';

const ENTER = '\r';
const SPACE = ' ';
const CTRL_D = '\u0004';

/** One prompt, asked `message` and answered by `keys` with `answer` on screen. */
interface Row {
  /** What the settled line shows. */
  answer: string;
  ask(ui: ScreenHarness, message: string): Promise<unknown>;
  keys: string[];
}

/**
 * The prompts that do not settle through `promptAnswerSlot()`'s picture here, and
 * why. Each is a prompt that has a settled answer line all the same, so each
 * reason says where that line is pinned instead.
 */
const EXEMPT = {
  confirm:
    'reserves its hint and answers in its place, so `yes` is beside a question the ' +
    'head wraps to keep it there -- prompt.test.ts pins that',
  date:
    'its field is the answer and is reserved, so the question wraps to keep it beside, ' +
    'and under the question where the cap would cut it -- SIG-210, in date.test.ts',
  decrypt: 'an animation rather than a question, as in prompt-signal.test.ts',
  directoryTree: 'answers with an absolute path, so its picture is in tree.test.ts',
  editor: 'spawns an editor before it settles, so its picture is in editor.test.ts',
  filePicker: 'answers with an absolute path, so its picture is in file-picker.test.ts',
  pickDate: "the same as date()'s, in calendar.test.ts",
  runPrompt: 'the engine, which draws whatever view it is handed',
  toggle:
    'reserves its longer state, so the answer is beside a question the head wraps ' +
    'to keep it there -- toggle.test.ts pins that',
} satisfies Partial<Record<PromptName, string>>;

/** Every other prompt, asked a question and answered with something worth reading. */
const prompts = {
  autocomplete: {
    answer: 'Show the diff',
    ask: (ui, message) =>
      autocomplete({
        ansi: ui.ansi,
        choices: ['Show the diff', 'Apply'],
        message,
        terminal: ui.terminal,
      }),
    keys: [ENTER],
  },
  autocompleteMultiselect: {
    answer: 'Show the diff',
    ask: (ui, message) =>
      autocompleteMultiselect({
        ansi: ui.ansi,
        choices: ['Show the diff', 'Apply'],
        message,
        terminal: ui.terminal,
      }),
    keys: [SPACE, ENTER],
  },
  commandPalette: {
    answer: 'build',
    ask: async (ui, message) => {
      const state = await parse({
        argv: [],
        env: {},
        schema: { commands: { build: { run(): void {} } }, completion: false, help: false },
      });
      return commandPalette(state, { ansi: ui.ansi, message, terminal: ui.terminal });
    },
    keys: [ENTER],
  },
  groupMultiselect: {
    answer: 'Show the diff',
    ask: (ui, message) =>
      groupMultiselect({
        ansi: ui.ansi,
        choices: { Changes: ['Show the diff'] },
        message,
        terminal: ui.terminal,
      }),
    keys: [SPACE, ENTER],
  },
  list: {
    answer: 'Show the diff',
    ask: (ui, message) => list({ ansi: ui.ansi, message, terminal: ui.terminal }),
    keys: ['Show the diff', ENTER],
  },
  maskedText: {
    answer: '(555) 123-4567',
    ask: (ui, message) =>
      maskedText({ ansi: ui.ansi, message, template: '(###) ###-####', terminal: ui.terminal }),
    keys: ['5551234567', ENTER],
  },
  multiline: {
    answer: 'Show the diff',
    ask: (ui, message) => multiline({ ansi: ui.ansi, message, terminal: ui.terminal }),
    keys: ['Show the diff', CTRL_D],
  },
  multiselect: {
    answer: 'Show the diff',
    ask: (ui, message) =>
      multiselect({
        ansi: ui.ansi,
        choices: ['Show the diff', 'Apply'],
        message,
        terminal: ui.terminal,
      }),
    keys: [SPACE, ENTER],
  },
  number: {
    answer: '1234567890123',
    ask: (ui, message) => number({ ansi: ui.ansi, message, terminal: ui.terminal }),
    keys: ['1234567890123', ENTER],
  },
  password: {
    answer: '•'.repeat(13),
    ask: (ui, message) => password({ ansi: ui.ansi, message, terminal: ui.terminal }),
    keys: ['Show the diff', ENTER],
  },
  path: {
    answer: 'Show the diff',
    ask: (ui, message) => path({ ansi: ui.ansi, message, terminal: ui.terminal }),
    keys: ['Show the diff', ENTER],
  },
  select: {
    answer: 'Show the diff',
    ask: (ui, message) =>
      select({
        ansi: ui.ansi,
        choices: ['Show the diff', 'Apply'],
        message,
        terminal: ui.terminal,
      }),
    keys: [ENTER],
  },
  selectKey: {
    answer: 'Show the diff',
    ask: (ui, message) =>
      selectKey({
        ansi: ui.ansi,
        choices: [
          { key: 'a', label: 'Apply' },
          { key: 'd', label: 'Show the diff' },
        ],
        message,
        terminal: ui.terminal,
      }),
    keys: ['d'],
  },
  selectRow: {
    answer: 'Show the diff',
    ask: (ui, message) =>
      selectRow({
        ansi: ui.ansi,
        columns: [{ header: 'Name', key: 'name' }],
        message,
        rows: [{ name: 'Show the diff' }, { name: 'Apply' }],
        terminal: ui.terminal,
      }),
    keys: [ENTER],
  },
  selectTree: {
    answer: 'Show the diff',
    ask: (ui, message) =>
      selectTree({
        ansi: ui.ansi,
        items: ['Show the diff', 'Apply'],
        message,
        terminal: ui.terminal,
      }),
    keys: [ENTER],
  },
  // the whole order is the answer, so this is the longest one here
  sort: {
    answer: 'Show the diff, Apply, Skip',
    ask: (ui, message) =>
      sort({
        ansi: ui.ansi,
        choices: ['Show the diff', 'Apply', 'Skip'],
        message,
        terminal: ui.terminal,
      }),
    keys: [ENTER],
  },
  text: {
    answer: 'Show the diff',
    ask: (ui, message) => text({ ansi: ui.ansi, message, terminal: ui.terminal }),
    keys: ['Show the diff', ENTER],
  },
} satisfies Record<Exclude<PromptName, keyof typeof EXEMPT>, Row>;

/** As wide as a 40-column head lets a message be, and more, so it wraps. */
const FILLS = 'Which of these changes should we apply first?';
/** Short enough to be one line beside an answer, at the widths below. */
const SHORT = 'Which change should we apply first?';

/**
 * Asks, answers, and hands back what the screen is left showing.
 *
 * @param row - The prompt.
 * @param message - What it asks.
 * @param columns - How wide the screen is.
 * @returns The settled screen, one row per entry, trailing spaces trimmed.
 */
async function settled(row: Row, message: string, columns: number): Promise<string[]> {
  const ui = screenSetup({ columns, rows: 16 });
  const answer = row.ask(ui, message);
  await tick();
  for (const key of row.keys) {
    ui.stdin.send(key);
    await tick();
  }
  await answer;
  return ui.log.map((line) => line.trimEnd());
}

describe('the table of prompts with an answer line', () => {
  it('should hold a row or an exemption for every prompt the barrel exports', () => {
    // the other direction from the `satisfies`, for prompt-signal.test.ts's reason
    expectTypeOf<keyof typeof prompts | keyof typeof EXEMPT>().toEqualTypeOf<PromptName>();
  });
});

describe('promptAnswerFits()', () => {
  it('should say an answer fits only where it is one line in the room', () => {
    expect(promptAnswerFits(13, 'Show the diff')).toBe(true);
    expect(promptAnswerFits(12, 'Show the diff')).toBe(false);
    // wide characters are counted as the columns they take
    expect(promptAnswerFits(3, '日本')).toBe(false);
  });
});

describe('a settled answer', () => {
  describe.each(Object.entries(prompts) as [string, Row][])('%s()', (_name, row) => {
    // the question takes every column the head has, which left one: a list's
    // answer went down the right edge a character a row, and a field's was cut
    // to its first character
    it('should go under a question that fills the line', async () => {
      expect(await settled(row, FILLS, 40)).toEqual([
        '? Which of these changes should we',
        '  apply first?',
        `  ${row.answer}`,
      ]);
    });

    it('should stay beside a question that leaves it room', async () => {
      expect(await settled(row, FILLS, 80)).toEqual([`? ${FILLS} ${row.answer}`]);
    });

    // one column short: it used to wrap at its spaces into what the question left
    it('should go under, whole, where it would wrap beside the question', async () => {
      const columns = 3 + SHORT.length + row.answer.length - 1;

      expect(await settled(row, SHORT, columns)).toEqual([`? ${SHORT}`, `  ${row.answer}`]);
    });

    it('should stay beside where it is exactly as wide as the room', async () => {
      const columns = 3 + SHORT.length + row.answer.length;

      expect(await settled(row, SHORT, columns)).toEqual([`? ${SHORT} ${row.answer}`]);
    });
  });
});
