import { autocomplete, autocompleteMultiselect } from '../../src/components/autocomplete.js';
import { pickDate } from '../../src/components/calendar.js';
import { date } from '../../src/components/date.js';
import { filePicker } from '../../src/components/file-picker.js';
import { groupMultiselect } from '../../src/components/group-multiselect.js';
import { list } from '../../src/components/list.js';
import { maskedText } from '../../src/components/masked-text.js';
import { number } from '../../src/components/number.js';
import type { PaletteOptions } from '../../src/components/palette.js';
import { path } from '../../src/components/path.js';
import {
  confirm,
  ESCAPE_TIMEOUT,
  multiline,
  multiselect,
  password,
  PromptBack,
  PromptError,
  type PromptOptions,
  select,
  type SelectOptions,
  text,
} from '../../src/components/prompt.js';
import { selectKey } from '../../src/components/select-key.js';
import { selectRow } from '../../src/components/select-row.js';
import { sort } from '../../src/components/sort.js';
import { toggle } from '../../src/components/toggle.js';
import { directoryTree, selectTree } from '../../src/components/tree.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

const ENTER = '\r';
const CTRL_D = '\u0004';
const ESC = '\u001b';

/** A directory for the two prompts that answer with a path, made once for the file. */
let root = '';
let file = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sigil-prompt-value-'));
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'first.txt'), '');
  await writeFile(join(root, 'sub', 'aaa.txt'), '');
  file = join(root, 'sub', 'zzz.txt');
  await writeFile(file, '');
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

/** How a prompt settled, with the handler attached before anything can reject. */
function settle(promise: Promise<unknown>): Promise<{ error?: unknown; value?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

/** The options every case is asked with: the harness's terminal, and `back` when wanted. */
type Base = Pick<PromptOptions, 'ansi' | 'back' | 'terminal'>;

interface Case {
  /** Asks the prompt with an answer to start from. */
  ask: (base: Base) => Promise<unknown>;
  /** What it should answer with, given nothing but its submit key. */
  answer: () => unknown;
  /** The key that submits it. Enter if omitted. */
  submit?: string;
}

const day = new Date(2024, 5, 15);
const rows = [{ name: 'one' }, { name: 'two' }, { name: 'three' }];

/**
 * Every prompt that answers with a value, each handed an answer to start from
 * that is not the one it would have opened on -- so answering with it is the
 * prompt honouring `value`, not happening to land there.
 */
const cases: [string, Case][] = [
  ['text', { answer: () => 'ada', ask: (b) => text({ ...b, message: 'Q?', value: 'ada' }) }],
  [
    'password',
    { answer: () => 'hunter2', ask: (b) => password({ ...b, message: 'Q?', value: 'hunter2' }) },
  ],
  [
    'multiline',
    {
      answer: () => 'one\ntwo',
      ask: (b) => multiline({ ...b, initial: 'no', message: 'Q?', value: 'one\ntwo' }),
      submit: CTRL_D,
    },
  ],
  [
    'confirm',
    {
      answer: () => false,
      ask: (b) => confirm({ ...b, default: true, message: 'Q?', value: false }),
    },
  ],
  [
    'select',
    {
      answer: () => 'c',
      ask: (b) => select({ ...b, choices: ['a', 'b', 'c'], initial: 1, message: 'Q?', value: 'c' }),
    },
  ],
  [
    'multiselect',
    {
      answer: () => ['a', 'c'],
      ask: (b) =>
        multiselect({
          ...b,
          choices: ['a', { label: 'b', selected: true }, 'c'],
          message: 'Q?',
          value: ['c', 'a'],
        }),
    },
  ],
  [
    'autocomplete',
    {
      answer: () => 'c',
      ask: (b) => autocomplete({ ...b, choices: ['a', 'b', 'c'], message: 'Q?', value: 'c' }),
    },
  ],
  [
    'autocompleteMultiselect',
    {
      answer: () => ['a', 'c'],
      ask: (b) =>
        autocompleteMultiselect({
          ...b,
          choices: ['a', { label: 'b', selected: true }, 'c'],
          message: 'Q?',
          value: ['c', 'a'],
        }),
    },
  ],
  [
    'groupMultiselect',
    {
      answer: () => ['c'],
      ask: (b) =>
        groupMultiselect({
          ...b,
          choices: { g: [{ label: 'a', selected: true }, 'b'], h: ['c'] },
          message: 'Q?',
          value: ['c'],
        }),
    },
  ],
  [
    'number',
    { answer: () => 42, ask: (b) => number({ ...b, initial: 1, message: 'Q?', value: 42 }) },
  ],
  [
    'date',
    {
      answer: () => day,
      ask: (b) => date({ ...b, initial: new Date(2020, 0, 1), message: 'Q?', value: day }),
    },
  ],
  [
    'pickDate',
    {
      answer: () => day,
      ask: (b) => pickDate({ ...b, initial: new Date(2020, 0, 1), message: 'Q?', value: day }),
    },
  ],
  [
    'list',
    {
      answer: () => ['a', 'b'],
      ask: (b) => list({ ...b, initial: 'x', message: 'Q?', value: ['a', 'b'] }),
    },
  ],
  [
    'maskedText',
    {
      answer: () => '123-456',
      ask: (b) => maskedText({ ...b, message: 'Q?', template: '###-###', value: '123456' }),
    },
  ],
  [
    'path',
    { answer: () => 'notes.txt', ask: (b) => path({ ...b, message: 'Q?', value: 'notes.txt' }) },
  ],
  [
    'toggle',
    {
      answer: () => true,
      ask: (b) => toggle({ ...b, initial: false, message: 'Q?', value: true }),
    },
  ],
  [
    'sort',
    {
      answer: () => ['c', 'a', 'b'],
      ask: (b) => sort({ ...b, choices: ['a', 'b', 'c'], message: 'Q?', value: ['c', 'a', 'b'] }),
    },
  ],
  [
    'selectKey',
    {
      answer: () => 'no',
      ask: (b) =>
        selectKey({
          ...b,
          choices: [
            { key: 'y', label: 'Yes', value: 'yes' },
            { key: 'n', label: 'No', value: 'no' },
          ],
          initial: 'y',
          message: 'Q?',
          value: 'no',
        }),
    },
  ],
  [
    'selectRow',
    { answer: () => rows[2], ask: (b) => selectRow({ ...b, message: 'Q?', rows, value: rows[2] }) },
  ],
  [
    'selectTree',
    {
      answer: () => 'y',
      ask: (b) =>
        selectTree({
          ...b,
          items: [{ items: ['x', 'y'], text: 'a' }, 'b'],
          message: 'Q?',
          value: 'y',
        }),
    },
  ],
  [
    'filePicker',
    { answer: () => file, ask: (b) => filePicker({ ...b, message: 'Q?', root, value: file }) },
  ],
  [
    'directoryTree',
    { answer: () => file, ask: (b) => directoryTree({ ...b, message: 'Q?', root, value: file }) },
  ],
];

/** Lets a prompt that reads the file system or a source catch up. */
async function settleDown(): Promise<void> {
  await tick(6);
}

function base(ui: ScreenHarness, back?: boolean): Base {
  return { ansi: ui.ansi, terminal: ui.terminal, ...(back === undefined ? {} : { back }) };
}

describe('a prompt given a value', () => {
  describe.each(cases)('%s()', (_name, { answer, ask, submit }) => {
    it('should answer with the value on its submit key alone', async () => {
      const ui = screenSetup({ columns: 60, rows: 16 });
      const settled = settle(ask(base(ui)));

      await settleDown();
      ui.stdin.send(submit ?? ENTER);
      await settleDown();

      expect(await settled).to.deep.equal({ value: answer() });
    });
  });
});

describe('a prompt given a value it cannot show', () => {
  /** Each prompt asked with a value that is no longer an answer it has, and what it opens on instead. */
  const dropped: [string, (b: Base) => Promise<unknown>, unknown][] = [
    [
      'select, for a value no choice holds',
      (b) => select({ ...b, choices: ['a', 'b'], initial: 1, message: 'Q?', value: 'gone' }),
      'b',
    ],
    [
      'select, for a value only a disabled choice holds',
      (b) =>
        select({
          ...b,
          choices: ['a', { disabled: true, label: 'b' }, 'c'],
          message: 'Q?',
          value: 'b',
        }),
      'a',
    ],
    [
      'confirm, for a value that is not a boolean',
      (b) => confirm({ ...b, default: false, message: 'Q?', value: 'yes' as never }),
      false,
    ],
    [
      'multiselect, for values no choice holds',
      (b) =>
        multiselect({
          ...b,
          choices: [{ label: 'a', selected: true }, 'b'],
          message: 'Q?',
          value: ['gone'],
        }),
      [],
    ],
    [
      'multiselect, which takes an empty answer as one rather than reading `selected`',
      (b) =>
        multiselect({
          ...b,
          choices: [{ label: 'a', selected: true }, 'b'],
          message: 'Q?',
          value: [],
        }),
      [],
    ],
    [
      'groupMultiselect, for a value only a disabled choice holds',
      (b) =>
        groupMultiselect({
          ...b,
          choices: { g: [{ disabled: true, label: 'a' }, 'b'] },
          message: 'Q?',
          value: ['a'],
        }),
      [],
    ],
    [
      'autocomplete, for a value not in the list',
      (b) => autocomplete({ ...b, choices: ['a', 'b'], message: 'Q?', value: 'gone' }),
      'a',
    ],
    [
      'autocompleteMultiselect, for a value not in the list',
      (b) => autocompleteMultiselect({ ...b, choices: ['a', 'b'], message: 'Q?', value: ['gone'] }),
      [],
    ],
    [
      'number, for a fraction without float',
      (b) => number({ ...b, initial: 7, message: 'Q?', value: 1.5 }),
      7,
    ],
    [
      'number, for a value that is not finite',
      (b) => number({ ...b, initial: 7, message: 'Q?', value: Number.NaN }),
      7,
    ],
    [
      'date, for an invalid date',
      (b) => date({ ...b, initial: day, message: 'Q?', value: new Date(Number.NaN) }),
      day,
    ],
    [
      'pickDate, for an invalid date',
      (b) => pickDate({ ...b, initial: day, message: 'Q?', value: new Date(Number.NaN) }),
      day,
    ],
    [
      'list, for an answer that would not survive the separator',
      (b) => list({ ...b, initial: 'x', message: 'Q?', value: ['a,b'] }),
      ['x'],
    ],
    [
      'maskedText, for an answer to a template that has changed',
      (b) => maskedText({ ...b, initial: '123', message: 'Q?', template: '###', value: 'ABC' }),
      '123',
    ],
    [
      'toggle, for a value that is not a boolean',
      (b) => toggle({ ...b, initial: true, message: 'Q?', value: 'on' as never }),
      true,
    ],
    [
      'sort, putting what it names first and a row it does not know about last',
      (b) => sort({ ...b, choices: ['a', 'b', 'c'], message: 'Q?', value: ['gone', 'c'] }),
      ['c', 'a', 'b'],
    ],
    [
      'sort, keeping a pinned row in its place',
      (b) =>
        sort({
          ...b,
          choices: ['a', { disabled: true, label: 'pin' }, 'b'],
          message: 'Q?',
          value: ['b', 'a'],
        }),
      ['b', 'pin', 'a'],
    ],
    [
      'selectKey, for a value no choice holds',
      (b) =>
        selectKey({
          ...b,
          choices: [
            { key: 'y', label: 'Yes', value: 'yes' },
            { key: 'n', label: 'No', value: 'no' },
          ],
          initial: 'n',
          message: 'Q?',
          value: 'gone',
        }),
      'no',
    ],
    [
      'selectRow, for a row that is not one of these',
      (b) => selectRow({ ...b, initial: 1, message: 'Q?', rows, value: { name: 'three' } }),
      rows[1],
    ],
    [
      'selectTree, for a value no node holds',
      (b) => selectTree({ ...b, items: ['a', 'b'], message: 'Q?', value: 'gone' }),
      'a',
    ],
  ];

  it.each(dropped)('%s', async (_name, ask, expected) => {
    const ui = screenSetup({ columns: 60, rows: 16 });
    const settled = settle(ask(base(ui)));

    await settleDown();
    ui.stdin.send(ENTER);
    await settleDown();

    expect(await settled).to.deep.equal({ value: expected });
  });

  it('should still refuse an initial that names nothing, beside a value that does', async () => {
    const ui = screenSetup();
    const { error } = await settle(
      selectKey({
        ...base(ui),
        choices: [{ key: 'y', label: 'Yes', value: 'yes' }],
        initial: 'q',
        message: 'Q?',
        value: 'yes',
      })
    );
    expect(error).toBeInstanceOf(PromptError);
  });

  it('should keep a source-backed tick it has not been shown, and take the label when it is', async () => {
    const ui = screenSetup({ columns: 60, rows: 16 });
    const settled = settle(
      autocompleteMultiselect({
        ...base(ui),
        message: 'Q?',
        source: () => [{ label: 'Alpha', value: 'a' }],
        value: ['a', 'z'],
      })
    );

    await settleDown();
    ui.stdin.send(ENTER);
    await settleDown();

    expect(await settled).to.deep.equal({ value: ['a', 'z'] });
    expect(ui.log.join('\n')).to.contain('Alpha, z');
  });

  it('should open a filePicker at its root when the file is not there any more', async () => {
    const ui = screenSetup({ columns: 200, rows: 16 });
    const settled = settle(
      filePicker({ ...base(ui), message: 'Q?', root, value: join(root, 'sub', 'gone.txt') })
    );

    // the directory it is looking at is on the question's line, and the list is
    // the root's: `sub/` and `first.txt`, rather than what `sub` holds
    await vi.waitFor(() => expect(ui.log.join('\n')).to.contain('first.txt'));
    expect(ui.log[0]).not.to.contain('sub');
    ui.stdin.send('\u0003');
    await settled;
  });

  it('should open a filePicker in the directory holding its value', async () => {
    const ui = screenSetup({ columns: 200, rows: 16 });
    const settled = settle(filePicker({ ...base(ui), message: 'Q?', root, value: file }));

    await vi.waitFor(() => expect(ui.log.join('\n')).to.contain('zzz.txt'));
    expect(ui.log[0]).to.contain('sub');
    expect(ui.log.join('\n')).not.to.contain('first.txt');
    ui.stdin.send('\u0003');
    await settled;
  });

  it('should leave a filePicker value outside root alone when confined', async () => {
    const ui = screenSetup({ columns: 60, rows: 16 });
    const settled = settle(
      filePicker({
        ...base(ui),
        confine: true,
        message: 'Q?',
        root: join(root, 'sub'),
        value: join(root, 'first.txt'),
      })
    );

    await settleDown();
    ui.stdin.send(ENTER);
    await settleDown();

    expect(await settled).to.deep.equal({ value: join(root, 'sub', 'aaa.txt') });
  });

  // SIG-204: an Enter typed before the reads landed closed the root instead,
  // because the key cancelled the jump and acted on the row it arrived on
  it('should answer a directoryTree with its value on an Enter typed before the reads landed', async () => {
    const ui = screenSetup({ columns: 60, rows: 16 });
    const settled = settle(directoryTree({ ...base(ui), message: 'Q?', root, value: file }));

    ui.stdin.send(ENTER);

    expect(await settled).to.deep.equal({ value: file });
  });

  it('should move a directoryTree from its value on a key typed before the reads landed', async () => {
    const ui = screenSetup({ columns: 60, rows: 16 });
    const settled = settle(directoryTree({ ...base(ui), message: 'Q?', root, value: file }));

    ui.stdin.send('\u001b[A');
    await settleDown();
    ui.stdin.send(ENTER);

    expect(await settled).to.deep.equal({ value: join(root, 'sub', 'aaa.txt') });
  });

  it('should not jump a directoryTree to its value once Left moved before the reads landed', async () => {
    const ui = screenSetup({ columns: 60, rows: 16 });
    const settled = settle(directoryTree({ ...base(ui), message: 'Q?', root, value: file }));

    // Left closes the root without waiting, and Right opens it again with the
    // cursor on it -- so two Downs reach `aaa.txt`, where a jump to the value
    // when the reads land would have put them past `zzz.txt` onto `first.txt`
    for (const key of ['\u001b[D', '\u001b[C', '\u001b[B', '\u001b[B', ENTER]) {
      ui.stdin.send(key);
      await settleDown();
    }

    expect(await settled).to.deep.equal({ value: join(root, 'sub', 'aaa.txt') });
  });

  it('should not jump to a selectTree value a branch opened after a key turns up', async () => {
    const ui = screenSetup({ columns: 60, rows: 16 });
    const settled = settle(
      selectTree({
        ...base(ui),
        items: [{ items: () => Promise.resolve(['x', 'y']), text: 'a' }, 'b'],
        message: 'Q?',
        value: 'y',
      })
    );

    // Down and back puts the cursor on `a` by hand, and Right reads the branch
    // the value is in -- which must not take the cursor there once a key has acted
    ui.stdin.send('\u001b[B');
    await settleDown();
    ui.stdin.send('\u001b[A');
    await settleDown();
    ui.stdin.send('\u001b[C');
    await settleDown();
    ui.stdin.send(ENTER);

    expect(await settled).to.deep.equal({ value: 'a' });
  });
});

describe('a prompt given back', () => {
  describe.each(cases)('%s()', (_name, { ask }) => {
    it('should reject with a PromptBack on Escape and leave nothing on screen', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const ui = screenSetup({ columns: 60, rows: 16 });
        const settled = settle(ask(base(ui, true)));

        await settleDown();
        expect(ui.log, 'the question should be on screen first').not.to.deep.equal([]);
        ui.stdin.send(ESC);
        await vi.advanceTimersByTimeAsync(ESCAPE_TIMEOUT);
        await settleDown();

        const { error } = await settled;
        expect(error).toBeInstanceOf(PromptBack);
        expect(error).not.toBeInstanceOf(PromptError);
        expect(ui.log).to.deep.equal([]);
        expect(ui.stdin.rawMode).to.equal(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should do nothing on Escape without it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const ui = screenSetup({ columns: 60, rows: 16 });
        let done = false;
        const settled = settle(ask(base(ui))).finally(() => (done = true));

        await settleDown();
        ui.stdin.send(ESC);
        await vi.advanceTimersByTimeAsync(ESCAPE_TIMEOUT);
        await settleDown();

        expect(done).to.equal(false);
        ui.stdin.send('\u0003');
        await settleDown();
        expect((await settled).error).toBeInstanceOf(PromptError);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('should not read Alt and a key as Escape', async () => {
    const ui = screenSetup({ columns: 60 });
    const settled = settle(text({ ...base(ui, true), message: 'Q?' }));

    await settleDown();
    // one chunk, so it decodes as Alt-B rather than Escape then b
    ui.stdin.send(`${ESC}b`);
    await settleDown();
    ui.stdin.send(ENTER);
    await settleDown();

    expect(await settled).to.deep.equal({ value: '' });
  });

  it('should take Escape before a prompt that reads Shift-Tab, which is why it is Escape', async () => {
    // date() moves back a segment on Shift-Tab and toggle() flips on it, so a
    // back key there would have taken a key from both; Escape is read by neither
    const ui = screenSetup({ columns: 60 });
    const settled = settle(toggle({ ...base(ui, true), message: 'Q?' }));

    await settleDown();
    ui.stdin.send(`${ESC}[Z`);
    await settleDown();
    ui.stdin.send(ENTER);
    await settleDown();

    expect(await settled).to.deep.equal({ value: true });
  });

  it('should list esc back in the footer of a prompt that draws one, and only then', async () => {
    const shown = async (back?: boolean): Promise<string> => {
      const ui = screenSetup({ columns: 80, rows: 12 });
      const settled = settle(multiselect({ ...base(ui, back), choices: ['a'], message: 'Q?' }));
      await settleDown();
      const screen = ui.log.join('\n');
      ui.stdin.send('\u0003');
      await settled;
      return screen;
    };

    expect(await shown(true)).to.contain('esc back');
    expect(await shown()).not.to.contain('back');
  });
});

describe('types', () => {
  it('should type each value as the answer its prompt gives', () => {
    expectTypeOf<SelectOptions<'a' | 'b'>['value']>().toEqualTypeOf<'a' | 'b' | undefined>();
    expectTypeOf<Parameters<typeof multiselect<number>>[0]['value']>().toEqualTypeOf<
      readonly number[] | undefined
    >();
    expectTypeOf<Parameters<typeof toggle>[0]['value']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Parameters<typeof date>[0]['value']>().toEqualTypeOf<Date | undefined>();
  });

  it('should not offer the palette back, since Escape already dismisses it', () => {
    expectTypeOf<PaletteOptions>().not.toHaveProperty('back');
    expectTypeOf<PaletteOptions>().not.toHaveProperty('value');
  });
});
