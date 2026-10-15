import { Screen, screenStream } from '../../src/testing/screen.js';
import { describe, expect, it } from 'vitest';

/**
 * The screen model, and the wide-cluster defect it used to have.
 *
 * This was `test/canvas/screen.ts` and advanced one column per **code unit**, so
 * a picture over a row holding a wide cluster was not to be trusted -- which is
 * a finding AGENTS.md records from a prompt test whose CJK row appeared to have
 * a character replaced when the frame had changed a style and nothing else.
 *
 * The existing suite is the regression suite for the fix and did not move: all
 * of it passes unchanged. What is here is the half it could not see, because
 * nothing in it asserted a wide row as cells.
 */

/** Built rather than written, so no raw control character sits in source. */
const ESC = String.fromCharCode(0x1b);

describe('a wide cluster on a screen', () => {
  it('should take two columns, with the far half addressable', () => {
    const screen = new Screen(10, 2);

    screen.write('日本語 ok');

    // the whole of the old defect in one assertion: three CJK characters are six
    // columns, so the space lands in column 6 and `ok` in 7 and 8. Read per cell
    // rather than as a row, because a row read as a string says what the user
    // sees and cannot say which column anything starts in
    expect(screen.cellAt(0, 0)).toBe('日');
    expect(screen.cellAt(1, 0)).toBe('');
    expect(screen.cellAt(2, 0)).toBe('本');
    expect(screen.cellAt(6, 0)).toBe(' ');
    expect(screen.cellAt(7, 0)).toBe('o');
    expect(screen.viewport[0]).toBe('日本語 ok');
    // and the cursor is where a terminal leaves it: nine columns consumed
    expect(screen.column).toBe(9);
  });

  it('should keep an astral cluster whole rather than writing two surrogates', () => {
    const screen = new Screen(6, 1);

    screen.write('😀ab');

    expect(screen.cellAt(0, 0)).toBe('😀');
    expect(screen.cellAt(1, 0)).toBe('');
    expect(screen.cellAt(2, 0)).toBe('a');
    expect(screen.viewport[0]).toBe('😀ab');
  });

  it('should give a lone zero-width cluster no cell at all', () => {
    const screen = new Screen(4, 1);

    // a cluster with no width is not a thing a cell can hold: written into one
    // it is a character in what a test reads as a picture, and the cursor does
    // not advance past it -- so a lone combining mark, or a control character a
    // terminal would act on rather than print, comes back inside the row.
    // Measured as exactly that: `viewport[0]` was the mark rather than empty
    screen.write('\u0301');

    expect(screen.cellAt(0, 0)).toBe(' ');
    expect(screen.viewport[0]).toBe('');
    expect(screen.column).toBe(0);
  });

  it('should give a combining mark no cell of its own', () => {
    const screen = new Screen(6, 1);

    // `e` then a combining acute is one cluster of one column, so what follows
    // is in column 1 -- where a per-code-unit walk put it in column 2
    screen.write('éx');

    expect(screen.cellAt(0, 0)).toBe('é');
    expect(screen.cellAt(1, 0)).toBe('x');
    expect(screen.column).toBe(2);
  });

  it('should take the other half of a cluster it overwrites', () => {
    const screen = new Screen(6, 1);

    screen.write('日本');
    // land on the continuation of the first cluster, which destroys it: half a
    // glyph is not a state a screen can be in, so the lead goes too. Without
    // this the row reads three columns wide where it holds two
    screen.write(`\r${ESC}[1Cx`);

    expect(screen.cellAt(0, 0)).toBe(' ');
    expect(screen.cellAt(1, 0)).toBe('x');
    expect(screen.viewport[0]).toBe(' x本');
  });

  it('should take the continuation of a lead it overwrites', () => {
    const screen = new Screen(6, 1);

    screen.write('日本');
    screen.write('\rx');

    expect(screen.cellAt(0, 0)).toBe('x');
    expect(screen.cellAt(1, 0)).toBe(' ');
    expect(screen.viewport[0]).toBe('x 本');
  });

  it('should repair a cluster an erase cuts into', () => {
    const screen = new Screen(6, 1);

    screen.write('日本');
    // erase from the continuation's column: the lead is as destroyed as the half
    // that was erased, and a row that kept it would be a column wide than itself
    screen.write(`\r${ESC}[1C${ESC}[K`);

    expect(screen.viewport[0]).toBe('');
    expect(screen.cellAt(0, 0)).toBe(' ');
  });

  it('should wrap a wide cluster that will not fit rather than splitting it', () => {
    const screen = new Screen(3, 2);

    // two columns left after `a`, then a cluster needing two: `ab` fits and `日`
    // does not, so a terminal puts it on the next row. `CellBuffer` refuses it
    // instead and lets a blank take the column, which is the right answer for a
    // grid an app owns and the wrong one for a screen with a next row
    screen.write('ab日');

    expect(screen.viewport[0]).toBe('ab');
    expect(screen.viewport[1]).toBe('日');
  });

  it('should drop a wide cluster on a screen too narrow to hold one', () => {
    const screen = new Screen(1, 2);

    // there is no row it fits on, so the only answer that leaves no half glyph
    // is not to draw it -- and it must not loop looking for one
    screen.write('a日b');

    expect(screen.viewport.join('|')).toBe('a|b');
  });

  it('should record the caret on a wide cluster at its lead', () => {
    const screen = new Screen(6, 1);

    screen.write(`${ESC}[7m日${ESC}[27m`);

    // the rule a caret already follows: it marks a cluster, and a cluster is
    // where its lead is
    expect(screen.lastInverse).toEqual({ column: 0, row: 0 });
  });

  it('should clear the recorded caret when either of its cells is painted over', () => {
    const screen = new Screen(6, 1);

    screen.write(`${ESC}[7m日${ESC}[27m`);
    // a plain write over the *continuation* destroys the cluster the caret was
    // marking, so the record has to go with it
    screen.write(`\r${ESC}[1Cx`);

    expect(screen.lastInverse).toBeUndefined();
  });

  it('should not leave a lead claiming a column a resize took away', () => {
    const screen = new Screen(4, 1);

    screen.write('a日b');
    screen.resize(2, 1);

    // the continuation is gone, so the lead is a cluster with nowhere to put its
    // other half -- and a row that kept it reads wider than the screen
    expect(screen.cellAt(1, 0)).toBe(' ');
    expect(screen.viewport[0]).toBe('a');
  });
});

describe('the screen model as it was', () => {
  it('should still defer the wrap at the last column', () => {
    const screen = new Screen(3, 2);

    screen.write('abc');

    // a terminal writing the last column does not advance past it: it stays put
    // and arms the wrap, which the next character takes
    expect(screen.column).toBe(2);
    expect(screen.wrapPending).toBe(true);
    expect(screen.row).toBe(0);

    screen.write('d');

    expect(screen.row).toBe(1);
    expect(screen.column).toBe(1);
  });

  it('should scroll the main buffer and keep what went off the top', () => {
    const screen = new Screen(5, 2);

    // `\r\n` rather than `\n`: a bare newline moves down and does not return to
    // column zero, because ONLCR is off in raw mode -- which is the strict reading
    // a terminal in raw mode gives, and the reason a backend writes CRLF
    screen.write('one\r\ntwo\r\nthree');

    expect(screen.written).toEqual(['one', 'two', 'three']);
    expect(screen.viewport).toEqual(['two', 'three']);
  });

  it('should clamp a cursor position past the bottom, as the other moves do', () => {
    const screen = new Screen(4, 2);

    // `A`, `B` and `C` all clamp and this did not: `ESC[99999H` set the row to
    // 99998, every write after it landed on a row that does not exist and was
    // dropped, and the cursor never came back -- silently, with every later
    // frame lost
    screen.write(`${ESC}[99999Ha`);

    expect(screen.row).toBe(1);
    expect(screen.viewport[1]).toBe('a');
  });

  it('should read the column of a cursor position, not just the row', () => {
    const screen = new Screen(8, 3);

    // `ESC[2;4H` is row 2 column 4 and was taken as row 2 column 0. Nothing in
    // this library emits the two-parameter form, so this is for a caller
    // pointing the model at their own output -- which is what shipping it means
    screen.write(`${ESC}[2;4Hx`);

    expect([screen.row, screen.column]).toEqual([1, 4]);
    expect(screen.viewport[1]).toBe('   x');
  });

  it('should read a bare cursor position as the origin', () => {
    const screen = new Screen(4, 2);

    screen.write(`${ESC}[2Ha${ESC}[Hb`);

    expect(screen.viewport).toEqual(['b', 'a']);
  });

  it('should clamp a column past the right edge', () => {
    const screen = new Screen(4, 2);

    screen.write(`${ESC}[1;99Hx`);

    expect(screen.column).toBe(3);
    expect(screen.viewport[0]).toBe('   x');
  });

  it.each([
    ['the whole line, for ESC[2K, which the library publishes as ERASE_LINE', '2', ''],
    ['from the start to the cursor, for ESC[1K', '1', '   de'],
    ['from the cursor to the end, for ESC[K', '', 'ab'],
  ])('should erase %s', (_what, mode, expected) => {
    const screen = new Screen(5, 1);

    screen.write(`abcde\r${ESC}[2C${ESC}[${mode}K`);

    expect(screen.viewport[0]).toBe(expected);
  });

  it.each([
    ['ESC[2J', '2', ['', '', '']],
    ['ESC[1J', '1', ['', '   cc', 'ddd']],
    ['ESC[J', '', ['aaa', 'bb', '']],
  ])('should erase the display for %s', (_what, mode, expected) => {
    const screen = new Screen(5, 3);

    // the cursor ends on row 1 column 2, so `0` takes the rest of that row and
    // everything under it, `1` takes everything above plus up to the cursor,
    // and `2` takes the lot. Two of the three cleared nothing at all before
    screen.write(`aaa\r\nbbbcc\r\nddd\r${ESC}[2A${ESC}[1B${ESC}[2C${ESC}[${mode}J`);

    expect(screen.viewport).toEqual(expected);
  });

  it.each([
    ['an escape alone', [ESC, '[2;3Hx']],
    ['a CSI with no final byte', [`${ESC}[`, '2;3Hx']],
    ['a CSI cut after a parameter', [`${ESC}[2`, ';3Hx']],
  ])('should hold %s until the rest of it arrives', (_what, parts) => {
    const screen = new Screen(8, 3);

    // what a terminal does, and it matters because a caller replaying captured
    // output chunks it wherever the pipe did -- before this the first call threw
    for (const part of parts) {
      screen.write(part);
    }

    expect(screen.viewport[1]).toBe('  x');
  });

  it('should hold an unterminated control string too', () => {
    const screen = new Screen(8, 2);

    screen.write(`${ESC}]52;c;${Buffer.from('hi', 'utf8').toString('base64')}${ESC}`);
    screen.write('\\');

    expect(screen.clipboard).toEqual([{ selection: 'c', text: 'hi' }]);
  });

  it('should still refuse a complete sequence it has no answer for', () => {
    // which is the diagnostic the holding must not swallow: a model that guessed
    // past a sequence it does not know would quietly get a row wrong
    expect(() => new Screen(4, 1).write(`${ESC}[5Z`)).toThrow(/unmodelled sequence/);
  });

  it('should leave the deferred wrap alone for a mode change', () => {
    const screen = new Screen(3, 2);

    // `enableBracketedPaste()` writes this to stdout, so a full-width frame
    // followed by one had its next character overwrite the last column
    screen.write(`abc${ESC}[?2004h`);

    expect(screen.wrapPending).toBe(true);

    screen.write('d');

    expect(screen.viewport).toEqual(['abc', 'd']);
  });

  it('should move the cursor up with the content a resize scrolled off', () => {
    const screen = new Screen(6, 4);

    // the cursor is put on row 1 rather than left on the last one, which is the
    // only arrangement where the two readings differ: `min(row, height - 1)`
    // answers 1 as well whenever the cursor is at the bottom, so a fixture that
    // left it there agreed with the defect and said nothing. What it was on
    // scrolled off, so the answer is row 0
    screen.write(`one\r\ntwo\r\nthree\r\nfour${ESC}[2H`);
    screen.resize(6, 2);

    expect(screen.row).toBe(0);

    screen.write('!');

    expect(screen.viewport).toEqual(['!hree', 'four']);
  });

  it('should not leave a caret off the grid after a resize', () => {
    const screen = new Screen(8, 4);

    screen.write(`\r\n\r\n${ESC}[7mx`);
    expect(screen.lastInverse).toEqual({ column: 0, row: 2 });

    screen.resize(2, 2);

    expect(screen.lastInverse).toBeUndefined();
  });

  it('should move the caret with the rows a scroll took', () => {
    const screen = new Screen(4, 2);

    screen.write(`${ESC}[7mx${ESC}[27m`);
    expect(screen.lastInverse).toEqual({ column: 0, row: 0 });

    // one scroll moves it to a row that does not exist any more, where it used
    // to name a fresh blank row
    screen.write('\r\n\r\n');

    expect(screen.lastInverse).toBeUndefined();
  });

  it('should clear the caret an erase blanked', () => {
    const screen = new Screen(4, 1);

    screen.write(`${ESC}[7mx${ESC}[27m`);
    screen.write(`\r${ESC}[2K`);

    expect(screen.lastInverse).toBeUndefined();
  });

  it('should not keep a caret recorded behind the alternate screen', () => {
    const screen = new Screen(8, 3);

    screen.write(`${ESC}[7mx${ESC}[27m`);
    expect(screen.lastInverse).toEqual({ column: 0, row: 0 });

    // the alternate buffer is a different screen, so a caret on the one behind
    // it is not on screen at all -- and `lastInverse` is what a test asks about
    // where the caret *is*
    screen.write(`${ESC}[?1049h`);

    expect(screen.lastInverse).toBeUndefined();
  });

  it('should clamp a cursor the alternate screen saved across a resize', () => {
    const screen = new Screen(20, 10);

    screen.write(`${ESC}[8;15Ha${ESC}[?1049h`);
    screen.resize(4, 3);
    screen.write(`${ESC}[?1049lx`);

    // unclamped, the saved row is 7 on a three-row screen and every write after
    // it is dropped for ever -- the `ESC[H` defect by another route
    expect(screen.row).toBeLessThan(3);
    expect(screen.viewport.join('')).toContain('x');
  });

  it('should decode an OSC 52 payload rather than swallowing it', () => {
    const screen = new Screen(4, 1);

    screen.write(`${ESC}]52;c;${Buffer.from('copied', 'utf8').toString('base64')}${ESC}\\`);

    expect(screen.clipboard).toEqual([{ selection: 'c', text: 'copied' }]);
  });

  it('should not read an extended colour channel as reverse video', () => {
    const screen = new Screen(4, 1);

    // the canvas emits `38;2;7;7;7` for an `rgb(7, 7, 7)`, so a naive walk reads
    // a channel as reverse video and every cell after it is the caret
    screen.write(`${ESC}[38;2;7;7;7ma`);

    expect(screen.lastInverse).toBeUndefined();
  });

  it.each([
    ['zero columns', 0, 8],
    ['a negative width', -4, 8],
    ['a fractional width', 3.5, 8],
    ['a width that is not a number', Number.NaN, 8],
    ['an infinite width', Number.POSITIVE_INFINITY, 8],
    ['zero rows', 8, 0],
    ['a height that is not a number', 8, Number.NaN],
  ])('should refuse %s', (_what, width, height) => {
    // refused by *asking* rather than by comparing, which is the half a
    // `Math.max(1, …)` gets wrong: every comparison against `NaN` is false, so
    // a screen of `NaN` columns builds no rows, places a cluster into an array
    // that grows under it, and reports a column nothing is at. Reachable from a
    // test file, where somebody writes `columns: process.stdout.columns` --
    // which under a runner is `undefined`
    expect(() => new Screen(width, height)).toThrow(/whole number of cells/);
  });

  it('should refuse a resize to a size nothing can address', () => {
    const screen = new Screen(4, 2);

    expect(() => screen.resize(Number.NaN, 2)).toThrow(/whole number of cells/);
    // and it is refused before anything is changed, so the screen is still the
    // screen it was rather than half of a resize
    expect([screen.width, screen.height]).toEqual([4, 2]);
  });

  it('should tell a listener about a resize, as a TTY does', () => {
    const screen = new Screen(4, 2);
    const stream = screenStream(screen);
    let told = 0;
    stream.on('resize', () => void told++);

    stream.resize(10, 3);

    expect([stream.columns, stream.rows, told]).toEqual([10, 3, 1]);
    expect(screen.width).toBe(10);
  });
});
