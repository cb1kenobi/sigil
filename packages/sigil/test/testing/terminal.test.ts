import { decodeKeys, type Key } from '../../src/components/keys.js';
import {
  confirm,
  multiselect,
  type PromptError,
  select,
  text,
} from '../../src/components/prompt.js';
import { formatKey } from '../../src/input/sequence.js';
import { alt, createTestTerminal, ctrl, KEYS, tick } from '../../src/testing/terminal.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

/**
 * `createTestTerminal()`, which is how a prompt is driven with no pty.
 *
 * A prompt rejects outright when either end is not a terminal -- that is
 * `PromptError`'s whole purpose, and it is what makes a prompt untestable from a
 * test runner, whose streams are pipes. What it reads about its terminal is
 * `isTTY` on both ends and bytes on an `InputStream`, both of which an object
 * can answer, so the fixture is objects and `press()` is the keyboard.
 *
 * The frames are replayed against a screen rather than read as bytes, because a
 * canvas frame is a diff against the frame before it: the last write is a
 * handful of changed cells and says nothing about what is on screen.
 */

/** Built rather than written, so no raw control character sits in source. */
const ESC = String.fromCharCode(0x1b);

describe('a prompt over a test terminal', () => {
  it('should answer with what was typed', async () => {
    const ui = createTestTerminal();
    const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

    await ui.press('chris', KEYS.enter);

    expect(await answer).toBe('chris');
  });

  it('should read each argument as its own keystroke', async () => {
    const ui = createTestTerminal();
    const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

    // one argument is one read, which is the distinction a prompt acts on: this
    // is five keystrokes and a backspace, where `press('chris')` is one read
    await ui.press('a', 'b', KEYS.backspace, 'c', KEYS.enter);

    expect(await answer).toBe('ac');
  });

  it('should move a list with the arrow keys it names', async () => {
    const ui = createTestTerminal();
    const answer = select({
      ansi: ui.ansi,
      choices: ['one', 'two', 'three'],
      message: 'Pick',
      terminal: ui.terminal,
    });

    await ui.press(KEYS.down, KEYS.down, KEYS.up, KEYS.enter);

    expect(await answer).toBe('two');
  });

  it('should tick a box with space, which is a key with a name here', async () => {
    const ui = createTestTerminal();
    const answer = multiselect({
      ansi: ui.ansi,
      choices: ['one', 'two'],
      message: 'Pick',
      terminal: ui.terminal,
    });

    await ui.press(KEYS.space, KEYS.down, KEYS.space, KEYS.enter);

    expect(await answer).toEqual(['one', 'two']);
  });

  it('should show what is on screen rather than what the last frame changed', async () => {
    const ui = createTestTerminal({ columns: 30 });
    const answer = select({
      ansi: ui.ansi,
      choices: ['alpha', 'bravo'],
      message: 'Pick one',
      terminal: ui.terminal,
    });
    // a key **after** the first paint, which is what makes this say anything:
    // the first frame is a full one, so every byte of the prompt is in the last
    // write and asserting `output` -- or the last chunk -- would pass too. It is
    // the *second* frame that is a diff, and the discrimination is that `lines`
    // still shows the whole prompt where the chunk that caused it does not
    await ui.press(KEYS.down);

    const screen = ui.lines.join('\n');
    const chunk = ui.output.slice(ui.output.lastIndexOf('\r'));

    expect(screen).toContain('Pick one');
    expect(screen).toContain('alpha');
    expect(screen).toContain('bravo');
    // the frame that moved the pointer is a handful of cells, so the message is
    // not in it -- which is the whole reason a test reads the replay
    expect(chunk).not.toContain('Pick one');

    await ui.press(KEYS.enter);
    await answer;
  });

  it('should let a ctrl chord abort, which is what ctrl() is for', async () => {
    const ui = createTestTerminal();
    // the handler goes on before any key is sent, which is not fussiness: a
    // prompt can reject while `press()` is still awaiting, and a promise that
    // rejects with nothing listening is an unhandled rejection -- which vitest
    // reports as an error even when every test passed
    const settled: Promise<{ error?: PromptError; value?: string }> = text({
      ansi: ui.ansi,
      message: 'Name?',
      terminal: ui.terminal,
    }).then(
      (value) => ({ value }),
      (error: PromptError) => ({ error })
    );

    await ui.press(ctrl('c'));

    expect((await settled).error?.aborted).toBe(true);
  });

  it('should keep a paste whole rather than reading its newline as Enter', async () => {
    const ui = createTestTerminal();
    const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

    // a one-line field flattens the break, which is the point of bracketing: a
    // newline inside a paste is content, and a pasted address must not submit
    // half of itself
    await ui.paste('one\ntwo');
    await ui.press(KEYS.enter);

    expect(await answer).toBe('one two');
  });

  it('should answer a confirm with the key its own hint names', async () => {
    const ui = createTestTerminal();
    const answer = confirm({ ansi: ui.ansi, message: 'Sure?', terminal: ui.terminal });

    await ui.press('n');

    expect(await answer).toBe(false);
  });

  it('should settle what a key set off, not merely deliver it', async () => {
    const ui = createTestTerminal({ columns: 40 });
    const answer = text({
      ansi: ui.ansi,
      message: 'Name?',
      terminal: ui.terminal,
      // a prompt queues each key through a promise chain and a `validate` may
      // be async -- a `validate` that asks a server is the case `run()`'s queue
      // exists for -- so a fixed number of microtask turns stops part way
      // through. Measured: two `await Promise.resolve()`s leave this message
      // off the screen where `press()` puts it there
      validate: async (value) => {
        await Promise.resolve();
        return value === 'ok' ? undefined : 'nope';
      },
    });

    await ui.press('x', KEYS.enter);

    expect(ui.lines.join('\n')).toContain('nope');

    await ui.press(KEYS.backspace, 'o', 'k', KEYS.enter);

    expect(await answer).toBe('ok');
  });

  it('should put raw mode back once the prompt is answered', async () => {
    const ui = createTestTerminal();
    const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });
    await tick();

    expect(ui.stdin.rawMode).toBe(true);

    await ui.press(KEYS.enter);
    await answer;

    expect(ui.stdin.rawMode).toBe(false);
  });

  it('should refuse a prompt where stdin is not a terminal', async () => {
    // the one thing the fixture must be able to say *no* to: a prompt with
    // nobody to answer it fails loudly rather than hanging, and a test that
    // could not reach that branch could not pin it
    const ui = createTestTerminal({ inputTTY: false });

    await expect(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal })).rejects.toThrow(
      /not a terminal/
    );
  });
});

describe('the keys', () => {
  it.each(Object.entries(KEYS))('should send bytes the decoder reads back as %s', (name, bytes) => {
    // asserted against the **decoder** rather than against literals, which is
    // the rule the sequence grammar already keeps: a pair of literals could
    // agree while both were wrong about the bytes. What has to hold is that
    // what this sends is what the router reads as the key it is filed under
    // -- and a wrong byte is not a failure, it is an unrecognised CSI whose
    // *name is its own sequence*, so a prompt types nothing for it and the
    // test presses nothing and passes
    const keys = decodeKeys(bytes);
    // `shiftTab` is the one entry whose name carries a modifier, and the
    // canonical spelling separates it -- so the expectation is derived from the
    // entry's own name rather than written out beside it
    const matched = /^(shift)?(.*)$/.exec(name) as RegExpExecArray;
    const held = matched[1] ?? '';
    const base = matched[2] ?? '';

    expect(keys).toHaveLength(1);
    expect(formatKey(keys[0] as Key)).toBe(
      held ? `${held}+${base.toLowerCase()}` : base.toLowerCase()
    );
  });

  it('should build chords the decoder reads as held modifiers', () => {
    expect(decodeKeys(ctrl('c'))[0]).toMatchObject({ ctrl: true, name: 'c' });
    expect(decodeKeys(alt('x'))[0]).toMatchObject({ meta: true, name: 'x' });
  });

  it.each(['up', 'enter', 'tab'] as const)('should hold alt with %s, as its doc says', (name) => {
    // `alt()` is documented as taking "a character or one of `KEYS`", and the
    // second half is the one that could have been an overclaim: `ESC` followed
    // by a whole sequence is a different shape from `ESC` followed by a letter.
    // It decodes as one key with the modifier held
    const keys = decodeKeys(alt(KEYS[name]));

    expect(keys).toHaveLength(1);
    expect(formatKey(keys[0] as Key)).toBe(`alt+${name}`);
  });

  it('should send the bytes a terminal sends', () => {
    // written down because the bytes are not guessable, and an unrecognised CSI
    // decodes to a key whose name is its own sequence -- so a wrong one is a
    // test that presses nothing and passes
    expect(KEYS.up).toBe(`${ESC}[A`);
    expect(KEYS.enter).toBe('\r');
    expect(KEYS.backspace).toBe(String.fromCharCode(0x7f));
    expect(KEYS.escape).toBe(ESC);
  });

  it('should be frozen, because it is one object every test presses', () => {
    expect(Object.isFrozen(KEYS)).toBe(true);
  });

  it('should build a ctrl chord arithmetically', () => {
    expect(ctrl('a')).toBe(String.fromCharCode(1));
    expect(ctrl('C')).toBe(String.fromCharCode(3));
    expect(ctrl('d')).toBe(String.fromCharCode(4));
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 0],
  ])('should refuse %s as a ctrl letter, with the error it documents', (_what, bad) => {
    // the type is asked about before the string is, or `ctrl(undefined)` throws
    // a `TypeError` out of `toLowerCase()` rather than this -- and a test file
    // is untyped JavaScript as often as not
    expect(() => ctrl(bad as unknown as string)).toThrow(/one ASCII letter/);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
  ])('should refuse %s as the key alt holds', (_what, bad) => {
    // `alt(undefined)` is `ESC` and then the **word** `undefined`, which a
    // prompt types in a character at a time -- an assertion failing on
    // `nundefined` names nothing
    expect(() => alt(bad as unknown as string)).toThrow(/takes a key/);
  });

  it('should refuse a ctrl chord there is no byte for', () => {
    // there is no byte for Ctrl with a digit or with two characters, so a
    // `ctrl('1')` that answered something would be a key nothing can press
    expect(() => ctrl('1')).toThrow(/one ASCII letter/);
    expect(() => ctrl('ab')).toThrow(/one ASCII letter/);
    expect(() => ctrl('')).toThrow(/one ASCII letter/);
  });

  it('should send Alt as an escape and then the key', () => {
    expect(alt('x')).toBe(`${ESC}x`);
    expect(alt(KEYS.enter)).toBe(`${ESC}\r`);
  });
});

describe('the fixture itself', () => {
  it('should not attach anything to the real process', () => {
    // a terminal installs `exit` and signal handlers so that it can put back
    // whatever it changed, and a suite builds a great many of them -- which is
    // how a prompt suite came to leave eleven listeners on the real
    // `process.stderr` and trip node's ten-listener warning over streams those
    // tests never meant to touch.
    //
    // `hideCursor()` is what makes this a test rather than a vacuous one:
    // `attachRestore()` is lazy, so a terminal nothing asked anything of
    // attaches nothing to *either* process and the count would match whatever
    // `proc` was. Twelve, because ten is where node starts warning
    const before = process.listenerCount('exit');

    for (let i = 0; i < 12; i++) {
      expect(createTestTerminal().terminal.hideCursor()).toBe(true);
    }

    expect(process.listenerCount('exit')).toBe(before);
  });

  it.each([
    ['a count of zero', 0],
    ['a count that is not a number', Number.NaN],
    ['an infinite count', Number.POSITIVE_INFINITY],
    ['a negative count', -1],
  ])('should take the default number of turns over %s', async (_what, times) => {
    // `tick(Infinity)` is a loop with no end in a helper a test awaits, and the
    // other three settle **nothing** while looking like they settled something
    // -- which is worse, because the assertion after one fails for a reason
    // nobody would guess
    const ui = createTestTerminal();
    const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

    ui.stdin.write('a');
    await tick(times as number);

    expect(ui.lines.join('')).toContain('a');

    await ui.press(KEYS.enter);
    await answer;
  });

  it('should refuse something that is not text to paste or press', async () => {
    // rejections rather than synchronous throws, which is the rule
    // `runOnTerminal()` records: a function that returns a promise and
    // *sometimes* throws synchronously is one a caller has to guard twice
    const ui = createTestTerminal();

    await expect(ui.paste(undefined as unknown as string)).rejects.toThrow(/takes the text/);
    await expect(ui.press(42 as unknown as string)).rejects.toThrow(/takes the reads/);
  });

  it.each([
    ['a width of null', { columns: null }],
    ['a height of null', { rows: null }],
  ])('should refuse %s rather than using the default', (_what, over) => {
    // `opts.columns ?? 40` silently used 40 for a `null`, which is the mistake
    // the guard exists to name rather than hide
    expect(() => createTestTerminal(over as unknown as { columns: number })).toThrow(
      /whole number of cells/
    );
  });

  it('should report the size it was asked for', () => {
    const ui = createTestTerminal({ columns: 100, rows: 30 });

    expect([ui.terminal.width, ui.terminal.height]).toEqual([100, 30]);
  });

  it('should tell the terminal about a resize', () => {
    const ui = createTestTerminal({ columns: 40 });
    let told = 0;
    ui.terminal.onResize(() => void told++);

    ui.resize(60, 10);

    expect([ui.terminal.width, told]).toEqual([60, 1]);
  });

  it('should read a wide row at the width it really takes', () => {
    const ui = createTestTerminal({ columns: 24, rows: 4 });

    // the screen model's own fix, read through the fixture. Everything that
    // measures text in this library measures it with `stringWidth()`, so a CJK
    // character is two columns -- and a model that advanced one column per
    // character disagreed with every one of them: the row came back the right
    // text at the wrong columns, which is a picture nothing can be asserted on
    const row = '日本  ok';
    ui.terminal.write(row);

    expect(ui.lines[0]).toBe(row);
    expect(ui.screen.column).toBe(stringWidth(row));
    expect(ui.screen.cellAt(1, 0)).toBe('');
    expect(ui.screen.cellAt(4, 0)).toBe(' ');
  });
});
