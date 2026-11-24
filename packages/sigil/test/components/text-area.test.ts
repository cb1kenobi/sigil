import { strip } from '../../src/ansi/index.js';
import type { HighlightSpan } from '../../src/components/prompt.js';
import {
  TextArea,
  type TextAreaCaret,
  type TextAreaProps,
} from '../../src/components/text-area.js';
import {
  arrange,
  box,
  type Element,
  renderToLines,
  renderToString,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import { selectableAt } from '../../src/element/selection.js';
import { createInput, ESCAPE_TIMEOUT, type MouseEvent } from '../../src/input/index.js';
import { flush, State } from '../../src/signals/index.js';
import { alt, createTestTerminal, ctrl, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { DERIVED } from './form-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A text area: the multiline prompt's editor as an element.
 *
 * Driven through a real router over a test terminal, for `TextField`'s reason:
 * most of what the area promises is about where a key goes -- to the area, or on
 * past it to a form, a dialog or the root.
 */

const ESC = String.fromCharCode(0x1b);
const WIDTH = 30;
const HEIGHT = 6;

/** Lets a key act, and the effect that draws its consequence run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  flush();
}

/** The tree as a person would read it, colour taken off and the right edge trimmed. */
function picture(root: Element, width = WIDTH, height = HEIGHT): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel: 0, height, width }).map(
    (line) => strip(line).trimEnd()
  );
}

/** The tree with its attributes, at the lowest level that keeps one. */
function coloured(root: Element, width = WIDTH, height = HEIGHT, colorLevel: 0 | 1 = 1): string {
  return renderToString(root, { cascade: themedCascade(), colorLevel, height, width });
}

/** An SGR sequence, kept by a split. */
const SGR = new RegExp(`(${ESC}\\[[\\d;]*m)`, 'u');

/** The cells drawn reversed, as the text they hold, row by row. */
function reversed(root: Element, width = WIDTH, height = HEIGHT): string[] {
  const rows: string[] = [];
  for (const line of coloured(root, width, height).split('\n')) {
    let inverse = false;
    let found = '';
    for (const part of line.split(SGR)) {
      if (part.startsWith(`${ESC}[`)) {
        const codes = part.slice(2, -1).split(';');
        if (codes.includes('7')) {
          inverse = true;
        }
        if (codes.includes('27') || codes.includes('0') || part === `${ESC}[m`) {
          inverse = false;
        }
      } else if (inverse) {
        found += part;
      }
    }
    rows.push(found);
  }
  return rows;
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
});

/** An area in a column, a router over it, and a record of what reached the root. */
function scene(props: TextAreaProps, height = HEIGHT, ...rest: Element[]) {
  const area = TextArea({ props: { 'flex-grow': 1 }, ...props });
  const term = createTestTerminal({ columns: WIDTH, rows: height });
  const seen: string[] = [];
  const root = box({ 'flex-direction': 'column', height, width: WIDTH }, area, ...rest);
  root.onKey = (event) => {
    const k = event.key;
    seen.push(`${k.ctrl ? 'ctrl+' : ''}${k.shift ? 'shift+' : ''}${k.name}`);
  };
  const pasted: string[] = [];
  root.onPaste = (event) => {
    pasted.push(event.text);
  };
  const input = createInput({ root, terminal: term.terminal });
  stops.push(() => input.stop());
  input.focus.focus(area);
  // a frame has to have run for the area to know its room
  picture(root, WIDTH, height);
  return { area, input, pasted, root, seen, term };
}

/** A mouse event as the router builds one. */
function mouse(
  kind: MouseEvent['kind'],
  x: number,
  y: number,
  extra: Partial<Pick<MouseEvent, 'shift' | 'wheel'>> = {}
): MouseEvent & { stopped: boolean } {
  const event = {
    button: kind === 'wheel' || kind === 'mousemove' ? undefined : ('left' as const),
    ctrl: false,
    current: undefined,
    kind,
    meta: false,
    shift: false,
    stop(): void {
      event.stopped = true;
    },
    stopped: false,
    target: undefined,
    wheel: undefined,
    x,
    y,
    ...extra,
  };
  return event;
}

const SHIFT_LEFT = `${ESC}[1;2D`;
const SHIFT_RIGHT = `${ESC}[1;2C`;
const SHIFT_DOWN = `${ESC}[1;2B`;
const CTRL_LEFT = `${ESC}[1;5D`;
const CTRL_RIGHT = `${ESC}[1;5C`;
const CTRL_HOME = `${ESC}[1;5H`;
const CTRL_END = `${ESC}[1;5F`;

describe('TextArea()', () => {
  it('should draw the value a line to a row, and the placeholder while it is empty', () => {
    expect(picture(TextArea({ value: 'one\ntwo' })).slice(0, 2)).toEqual(['one', 'two']);
    expect(picture(TextArea({ placeholder: 'Commit message' }))[0]).toBe('Commit message');
  });

  it('should draw the placeholder in the muted role, the caret cell included', () => {
    const out = coloured(TextArea({ placeholder: 'Why' }), 10, 1);
    // dim from the first cell, which is where an unfocused caret sits
    expect(out).toMatch(new RegExp(`^${ESC}\\[2mWhy`));
  });

  it('should refuse props it cannot use', () => {
    expect(() => TextArea({ value: 3 as never })).toThrow(/value to be a string or a State/);
    expect(() => TextArea({ disabled: 'yes' as never })).toThrow(
      /boolean, a State, a Computed or a function/
    );
    expect(() => TextArea({ placeholder: 1 as never })).toThrow(/placeholder to be a string/);
    expect(() => TextArea({ gutter: '\u001b' })).toThrow(/gutter to be a string/);
    expect(() => TextArea({ tab: '' })).toThrow(/tab to be a non-empty string/);
    expect(() => TextArea({ tab: 'a\nb' })).toThrow(/no line break/);
    expect(() => TextArea({ tab: '\r' })).toThrow(/no line break/);
    expect(() => TextArea({ rows: 0 })).toThrow(/rows to be a positive whole number/);
    expect(() => TextArea({ width: 2.5 })).toThrow(/width to be a positive whole number/);
    expect(() => TextArea({ highlight: 'js' as never })).toThrow(/highlight to be a function/);
    expect(() => TextArea({ caret: 'top' as never })).toThrow(/caret to be a line and a column/);
    expect(() => TextArea({ caret: { col: 0, line: '1' } as never })).toThrow(
      /caret to be a line and a column/
    );
  });

  it('should grow into its rows and no further, and take more from a flex-grow', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    // the caret is at the end, so the last rows are the ones on screen
    const column = (area: Element): Element => box({ 'flex-direction': 'column' }, area);
    expect(picture(column(TextArea({ rows: 3, value: lines })), 20, 6)).toEqual([
      'line 18',
      'line 19',
      'line 20',
      '',
      '',
      '',
    ]);
    const grown = picture(
      column(TextArea({ props: { 'flex-grow': 1 }, rows: 2, value: lines })),
      20,
      6
    );
    expect(grown.at(-1)).toBe('line 20');
    expect(grown[0]).toBe('line 15');
  });

  it('should take fewer rows than it asks for where a column is short', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const short = box(
      { 'flex-direction': 'column', height: 3, width: 20 },
      text('Message'),
      TextArea({ rows: 5, value: lines }),
      text('footer')
    );
    expect(picture(short, 20, 3)).toEqual(['Message', 'line 20', 'footer']);
  });

  it('should draw the caret only while it has the focus', async () => {
    const one = TextArea({ value: 'ab' });
    const two = TextArea({ value: 'cd' });
    const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
    const root = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH }, one, two);
    const input = createInput({ root, terminal: term.terminal });
    stops.push(() => input.stop());
    input.focus.focus(one);
    await settle();

    const out = coloured(root);
    expect(out).toContain(`ab${ESC}[7m `);
    expect(out.split(`${ESC}[7m`)).toHaveLength(2);

    input.focus.focus(two);
    const moved = coloured(root);
    expect(moved).toContain(`cd${ESC}[7m `);
    expect(moved).not.toContain(`ab${ESC}[7m`);
  });

  describe('editing', () => {
    it('should make Enter a newline and a backspace at the start of a line join it to the one above', async () => {
      const value = new State('ab');
      const s = scene({ value });
      await s.term.press(KEYS.enter, 'cd', KEYS.enter);
      expect(value.get()).toBe('ab\ncd\n');
      await s.term.press(KEYS.backspace, KEYS.backspace);
      expect(value.get()).toBe('ab\nc');
      await s.term.press(KEYS.home, KEYS.backspace);
      expect(value.get()).toBe('abc');
      await settle();
      expect(picture(s.root)[0]).toBe('abc');
    });

    it('should make a delete at the end of a line join the next one to it', async () => {
      const value = new State('ab\ncd');
      const s = scene({ value });
      await s.term.press(KEYS.up, KEYS.end, KEYS.delete);
      expect(value.get()).toBe('abcd');
    });

    it('should move by lines and keep the column it aims for through a short line and a wide one', async () => {
      const value = new State('abcdef\nab\n漢字漢字\nabcdef');
      const s = scene({ value });
      // to column four of the first line, then down through the short line,
      // which puts the caret at its end, to the CJK line, where column four is
      // the start of the third character
      await s.term.press(CTRL_HOME, KEYS.right, KEYS.right, KEYS.right, KEYS.right);
      await s.term.press(KEYS.down, KEYS.down, '|');
      expect(value.get().split('\n')[2]).toBe('漢字|漢字');
      // and a column that lands on the far half of a wide character lands on it
      await s.term.press(KEYS.backspace, KEYS.down, KEYS.home, KEYS.right, KEYS.right, KEYS.right);
      await s.term.press(KEYS.up, '|');
      expect(value.get().split('\n')[2]).toBe('漢|字漢字');
    });

    it('should go to the ends of the value from the first and last lines', async () => {
      const value = new State('abc\ndef');
      const s = scene({ value });
      await s.term.press(KEYS.down, '>');
      expect(value.get()).toBe('abc\ndef>');
      await s.term.press(KEYS.up, KEYS.up, '<');
      expect(value.get()).toBe('<abc\ndef>');
    });

    it('should make Home and End the line, and with Ctrl the value', async () => {
      const value = new State('abc\ndef\nghi');
      const s = scene({ value });
      await s.term.press(KEYS.up, KEYS.home, '[', KEYS.end, ']');
      expect(value.get()).toBe('abc\n[def]\nghi');
      await s.term.press(ctrl('a'), '(', ctrl('e'), ')');
      expect(value.get()).toBe('abc\n([def])\nghi');
      await s.term.press(CTRL_HOME, '^', CTRL_END, '$');
      expect(value.get()).toBe('^abc\n([def])\nghi$');
    });

    it('should move and delete by words across a line break', async () => {
      const value = new State('one two\n\n  three');
      const s = scene({ value });
      await s.term.press(KEYS.home, CTRL_LEFT, '|');
      // over the indent, the blank line and the break, to the last word above
      expect(value.get()).toBe('one |two\n\n  three');
      await s.term.press(KEYS.backspace, CTRL_RIGHT, CTRL_RIGHT, '|');
      expect(value.get()).toBe('one two\n\n  three|');
      await s.term.press(KEYS.backspace, CTRL_HOME, alt('f'), alt('f'), alt('f'), '|');
      expect(value.get()).toBe('one two\n\n  three|');
      await s.term.press(KEYS.backspace, KEYS.home, ctrl('w'));
      expect(value.get()).toBe('one   three');
    });

    it('should make Ctrl-U and Ctrl-K the line on either side of the caret and never its break', async () => {
      const value = new State('abc\ndef\nghi');
      const s = scene({ value });
      await s.term.press(KEYS.up, KEYS.home, KEYS.right, ctrl('k'));
      expect(value.get()).toBe('abc\nd\nghi');
      await s.term.press(ctrl('k'));
      expect(value.get()).toBe('abc\nd\nghi');
      await s.term.press(ctrl('u'));
      expect(value.get()).toBe('abc\n\nghi');
    });

    it('should never split a cluster, at a line break or inside one', async () => {
      const value = new State('👨\u200D👩\u200D👧\ne\u0301');
      const s = scene({ value });
      await s.term.press(KEYS.backspace);
      expect(value.get()).toBe('👨\u200D👩\u200D👧\n');
      await s.term.press(KEYS.left, KEYS.backspace);
      expect(value.get()).toBe('\n');
    });

    it('should call onChange after an edit and never after a write the app made', async () => {
      const value = new State('a');
      const changes: string[] = [];
      const s = scene({ onChange: (v) => changes.push(v), value });
      await s.term.press('b', KEYS.left);
      expect(changes).toEqual(['ab']);
      value.set('x\ny');
      await settle();
      expect(changes).toEqual(['ab']);
      // and the caret is at the end of what the app wrote
      await s.term.press('!');
      expect(value.get()).toBe('x\ny!');
      expect(picture(s.root).slice(0, 2)).toEqual(['x', 'y!']);
    });

    it('should normalize the line endings of a value the app wrote', async () => {
      const value = new State('a\r\nb\rc');
      const s = scene({ value });
      await s.term.press('!');
      expect(value.get()).toBe('a\nb\nc!');
    });

    it('should take an edit with no State and no onChange, and draw it', async () => {
      const s = scene({ value: 'ab' });
      await s.term.press(KEYS.enter, 'cd');
      await settle();
      expect(picture(s.root).slice(0, 2)).toEqual(['ab', 'cd']);
    });
  });

  describe('the caret', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const at = (line: number, col: number): TextAreaCaret => ({ col, line });

    it('should start where `caret` says rather than at the end, in view', async () => {
      const s = scene({ caret: at(0, 0), value: many }, 4);
      expect(picture(s.root, WIDTH, 4)).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
      const value = new State('abc');
      const t = scene({ caret: at(0, 1), value });
      await t.term.press('!');
      expect(value.get()).toBe('a!bc');
    });

    it('should write the state on every move and every edit, and start it at the end', async () => {
      const caret = new State(at(0, 0));
      const s = scene({ caret, value: 'ab\ncd' });
      expect(caret.get()).toEqual(at(0, 0));
      await s.term.press(KEYS.right);
      expect(caret.get()).toEqual(at(0, 1));
      await s.term.press(KEYS.down, 'x');
      expect(caret.get()).toEqual(at(1, 2));
      await s.term.press(KEYS.enter);
      expect(caret.get()).toEqual(at(2, 0));
      await s.term.press(CTRL_HOME);
      expect(caret.get()).toEqual(at(0, 0));
      s.area.onMouse?.(mouse('mousedown', 1, 1));
      expect(caret.get()).toEqual(at(1, 1));

      // a place past the end, handed in, starts at the end and is written back
      const bare = new State(at(9, 9));
      scene({ caret: bare, value: 'one\ntwo' });
      expect(bare.get()).toEqual(at(1, 3));
    });

    it('should move when the app writes it, with nothing selected, and scroll it into view', async () => {
      const caret = new State(at(0, 0));
      const value = new State(many);
      const s = scene({ caret, value }, 4);
      await s.term.press(SHIFT_RIGHT, SHIFT_RIGHT);
      await settle();
      expect(reversed(s.root, WIDTH, 4).join('')).toBe('li');
      caret.set(at(30, 2));
      await settle();
      expect(picture(s.root, WIDTH, 4)).toContain('line 31');
      // the caret's own cell, and no selection: the caret is not drawn inside one
      expect(reversed(s.root, WIDTH, 4).join('')).toBe('n');
      await s.term.press('!');
      expect(value.get().split('\n')[30]).toBe('li!ne 31');
      expect(value.get().split('\n')[0]).toBe('line 1');
    });

    it('should read a place out of range as the nearest one, and say where it went', async () => {
      const caret = new State(at(0, 0));
      scene({ caret, value: '👨\u200D👩\u200D👧x\nab' });
      caret.set(at(99, 99));
      await settle();
      expect(caret.get()).toEqual(at(1, 2));
      // inside the family is the end of it, never a lone surrogate or a joiner
      caret.set(at(0, 3));
      await settle();
      expect(caret.get()).toEqual(at(0, '👨\u200D👩\u200D👧'.length));
      caret.set({ col: -4, line: Number.NaN });
      await settle();
      expect(caret.get()).toEqual(at(0, 0));
      caret.set(null as never);
      await settle();
      expect(caret.get()).toEqual(at(0, 0));
    });

    it('should keep a write that already says where the caret went, rather than write it again', async () => {
      const caret = new State(at(0, 0));
      scene({ caret, value: 'ab\ncd' });
      const written = at(1, 1);
      caret.set(written);
      await settle();
      expect(caret.get()).toBe(written);
    });

    it('should go to the end of a value the app wrote, or where a caret written with it says', async () => {
      const caret = new State(at(0, 0));
      const value = new State('a');
      const s = scene({ caret, value });
      value.set('one\ntwo');
      await settle();
      expect(caret.get()).toEqual(at(1, 3));

      // in one turn, in either order, the caret wins over the end
      value.set('three\nfour');
      caret.set(at(0, 1));
      await settle();
      expect(caret.get()).toEqual(at(0, 1));
      caret.set(at(1, 2));
      value.set('five\nsix');
      await settle();
      expect(caret.get()).toEqual(at(1, 2));
      await s.term.press('!');
      expect(value.get()).toBe('five\nsi!x');
    });

    it('should take in a write the app made in the same read as a key, before the key', async () => {
      const caret = new State(at(0, 0));
      const value = new State('abc\ndef');
      const s = scene({ caret, value });
      // no frame between the write and the key, so the effect has not run
      caret.set(at(1, 1));
      await s.term.press('!');
      expect(value.get()).toBe('abc\nd!ef');
      expect(caret.get()).toEqual(at(1, 2));
      value.set('xyz');
      await s.term.press('?');
      expect(value.get()).toBe('xyz?');
      // a paste, and a press, are input like a key
      caret.set(at(0, 0));
      await s.term.paste('<');
      expect(value.get()).toBe('<xyz?');
      value.set('x\ny\nz');
      s.area.onMouse?.(mouse('mousedown', 0, 1));
      await settle();
      await s.term.press('!');
      expect(value.get()).toBe('x\n!y\nz');
    });

    it('should keep a caret the app wrote from onChange, rather than write over it', async () => {
      const caret = new State(at(0, 0));
      const value = new State('abc\ndef');
      const s = scene({ caret, onChange: () => caret.set(at(1, 0)), value });
      await s.term.press('!');
      expect(caret.get()).toEqual(at(1, 0));
      await s.term.press('?');
      expect(value.get()).toBe('!abc\n?def');

      // and with a value written beside it, the caret lands in the new value
      const other = new State(at(0, 0));
      const text = new State('abcdef');
      const t = scene({
        caret: other,
        onChange: (now) => {
          text.set(`${now.toUpperCase()}\nmore`);
          other.set(at(1, 2));
        },
        value: text,
      });
      await t.term.press('!');
      expect(text.get()).toBe('!ABCDEF\nmore');
      expect(other.get()).toEqual(at(1, 2));
    });

    it('should end a drag when the app writes the caret in the middle of it', async () => {
      const caret = new State(at(0, 0));
      const s = scene({ caret, value: 'abcdef\nghijkl\nmnopqr' });
      s.area.onMouse?.(mouse('mousedown', 1, 0));
      s.area.onMouse?.(mouse('mousemove', 3, 1));
      caret.set(at(2, 2));
      await settle();
      s.area.onMouse?.(mouse('mousemove', 4, 1));
      expect(caret.get()).toEqual(at(2, 2));
    });
  });

  describe('the selection', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const at = (line: number, col: number): TextAreaCaret => ({ col, line });
    const range = (
      anchor: TextAreaCaret,
      caret: TextAreaCaret
    ): { anchor: TextAreaCaret; caret: TextAreaCaret } => ({ anchor, caret });

    it('should write the state on every move that selects and every one that does not', async () => {
      const selection = new State(range(at(0, 0), at(0, 0)));
      const s = scene({ caret: at(0, 0), selection, value: 'ab\ncd' });
      expect(selection.get()).toEqual(range(at(0, 0), at(0, 0)));
      await s.term.press(SHIFT_RIGHT, SHIFT_RIGHT);
      expect(selection.get()).toEqual(range(at(0, 0), at(0, 2)));
      // a selection made leftwards has its caret before its anchor
      await s.term.press(KEYS.right);
      await s.term.press(SHIFT_LEFT);
      expect(selection.get()).toEqual(range(at(0, 2), at(0, 1)));
      await s.term.press(SHIFT_DOWN);
      expect(selection.get()).toEqual(range(at(0, 2), at(1, 1)));
      // a key that collapses it, and an edit, say so
      await s.term.press(KEYS.left);
      expect(selection.get()).toEqual(range(at(0, 2), at(0, 2)));
      await s.term.press(SHIFT_RIGHT, 'x');
      expect(selection.get()).toEqual(range(at(0, 3), at(0, 3)));
      s.area.onMouse?.(mouse('mousedown', 0, 0));
      s.area.onMouse?.(mouse('mousemove', 3, 0));
      expect(selection.get()).toEqual(range(at(0, 0), at(0, 3)));
      s.area.onMouse?.(mouse('mouseup', 3, 0));
      expect(selection.get()).toEqual(range(at(0, 0), at(0, 3)));
    });

    it('should start collapsed on the caret, and say so when nothing is selected', async () => {
      const selection = new State(range(at(9, 9), at(9, 9)));
      scene({ selection, value: 'one\ntwo' });
      // a plain place past the end is the end, and the state says what the area made of it
      expect(selection.get()).toEqual(range(at(1, 3), at(1, 3)));
    });

    it('should select where the app writes it, in either direction, and scroll it into view', async () => {
      const selection = new State(range(at(0, 0), at(0, 0)));
      const caret = new State(at(0, 0));
      const value = new State(many);
      const s = scene({ caret, selection, value }, 4);
      selection.set(range(at(30, 0), at(30, 4)));
      await settle();
      expect(picture(s.root, WIDTH, 4)).toContain('line 31');
      expect(reversed(s.root, WIDTH, 4).join('')).toBe('line');
      // the caret is the selection's own end, and says so
      expect(caret.get()).toEqual(at(30, 4));
      selection.set(range(at(30, 4), at(30, 0)));
      await settle();
      expect(caret.get()).toEqual(at(30, 0));
      expect(reversed(s.root, WIDTH, 4).join('')).toBe('line');
      // typing replaces what the app selected
      await s.term.press('!');
      expect(value.get().split('\n')[30]).toBe('! 31');
      expect(selection.get()).toEqual(range(at(30, 1), at(30, 1)));
    });

    it('should take a selection from a plain prop as where it starts', async () => {
      const value = new State('hello world');
      const s = scene({ selection: range(at(0, 6), at(0, 11)), value });
      await settle();
      expect(reversed(s.root).join('')).toBe('world');
      await s.term.press('X');
      expect(value.get()).toBe('hello X');
    });

    it('should read a place out of range as the nearest one, and say where it went', async () => {
      const selection = new State(range(at(0, 0), at(0, 0)));
      const s = scene({ selection, value: '👨\u200D👩\u200D👧x\nab' });
      selection.set(range(at(0, 3), at(99, 99)));
      await settle();
      // inside the family is the end of it, past the end is the end
      expect(selection.get()).toEqual(range(at(0, '👨\u200D👩\u200D👧'.length), at(1, 2)));
      selection.set({ anchor: null, caret: { col: -4, line: Number.NaN } } as never);
      await settle();
      expect(selection.get()).toEqual(range(at(0, 0), at(0, 0)));
      selection.set(null as never);
      await settle();
      expect(selection.get()).toEqual(range(at(0, 0), at(0, 0)));
      expect(reversed(s.root)).not.toContain('x');
    });

    it('should keep a write that already says what was selected, rather than write it again', async () => {
      const selection = new State(range(at(0, 0), at(0, 0)));
      scene({ selection, value: 'ab\ncd' });
      const written = range(at(0, 1), at(1, 1));
      selection.set(written);
      await settle();
      expect(selection.get()).toBe(written);
    });

    it('should collapse the selection when the app writes the caret, and say so', async () => {
      const caret = new State(at(0, 0));
      const selection = new State(range(at(0, 0), at(0, 0)));
      const value = new State('abcdef');
      const s = scene({ caret, selection, value });
      await s.term.press(SHIFT_RIGHT, SHIFT_RIGHT);
      expect(selection.get()).toEqual(range(at(0, 0), at(0, 2)));
      // even onto the place it was
      caret.set(at(0, 2));
      await settle();
      expect(selection.get()).toEqual(range(at(0, 2), at(0, 2)));
      expect(reversed(s.root).join('')).toBe('c');
      await s.term.press('!');
      expect(value.get()).toBe('ab!cdef');
    });

    it('should select when the app writes the caret and the selection in one turn', async () => {
      const caret = new State(at(0, 0));
      const selection = new State(range(at(0, 0), at(0, 0)));
      const s = scene({ caret, selection, value: 'abcdef' });
      caret.set(at(0, 5));
      selection.set(range(at(0, 1), at(0, 3)));
      await settle();
      expect(selection.get()).toEqual(range(at(0, 1), at(0, 3)));
      expect(caret.get()).toEqual(at(0, 3));
      expect(reversed(s.root).join('')).toBe('bc');
    });

    it('should clear it when the app writes the value, or select in the new text when it writes both', async () => {
      const selection = new State(range(at(0, 6), at(0, 6)));
      const value = new State('abcdef');
      const s = scene({ selection, value });
      await s.term.press(SHIFT_LEFT, SHIFT_LEFT);
      expect(selection.get()).toEqual(range(at(0, 6), at(0, 4)));
      value.set('one\ntwo');
      await settle();
      expect(selection.get()).toEqual(range(at(1, 3), at(1, 3)));

      value.set('three\nfour');
      selection.set(range(at(0, 1), at(1, 2)));
      await settle();
      expect(selection.get()).toEqual(range(at(0, 1), at(1, 2)));
      selection.set(range(at(0, 0), at(0, 5)));
      value.set('five\nsix');
      await settle();
      expect(selection.get()).toEqual(range(at(0, 0), at(0, 4)));
      await s.term.press('!');
      expect(value.get()).toBe('!\nsix');
    });

    it('should take in a selection the app wrote in the same read as a key, before the key', async () => {
      const selection = new State(range(at(0, 0), at(0, 0)));
      const value = new State('abc\ndef');
      const s = scene({ selection, value });
      // no frame between the write and the key, so the effect has not run
      selection.set(range(at(0, 1), at(1, 1)));
      await s.term.press('!');
      expect(value.get()).toBe('a!ef');
    });

    it('should wrap what is selected, the way an app acts on it', async () => {
      const selection = new State(range(at(0, 0), at(0, 0)));
      const value = new State('say hello now');
      const s = scene({ selection, value });
      selection.set(range(at(0, 4), at(0, 9)));
      await settle();
      const { anchor, caret } = selection.get();
      const text = value.get();
      expect(text.slice(anchor.col, caret.col)).toBe('hello');
      value.set(
        `${text.slice(0, anchor.col)}(${text.slice(anchor.col, caret.col)})${text.slice(caret.col)}`
      );
      selection.set(range(at(0, 5), at(0, 10)));
      await settle();
      expect(value.get()).toBe('say (hello) now');
      expect(reversed(s.root).join('')).toBe('hello');
    });

    it('should keep a selection the app wrote from onChange, rather than write over it', async () => {
      const selection = new State(range(at(0, 0), at(0, 0)));
      const value = new State('abc\ndef');
      const s = scene({
        onChange: () => selection.set(range(at(1, 0), at(1, 3))),
        selection,
        value,
      });
      await s.term.press('!');
      expect(selection.get()).toEqual(range(at(1, 0), at(1, 3)));
      expect(reversed(s.root).join('')).toBe('def');
    });

    it('should end a drag when the app writes the selection in the middle of it', async () => {
      const selection = new State(range(at(0, 0), at(0, 0)));
      const s = scene({ selection, value: 'abcdef\nghijkl\nmnopqr' });
      s.area.onMouse?.(mouse('mousedown', 1, 0));
      s.area.onMouse?.(mouse('mousemove', 3, 1));
      selection.set(range(at(2, 1), at(2, 3)));
      await settle();
      const move = mouse('mousemove', 4, 1);
      s.area.onMouse?.(move);
      expect(move.stopped).toBe(false);
      expect(selection.get()).toEqual(range(at(2, 1), at(2, 3)));
    });

    it('should refuse a selection that is not two places, at construction', () => {
      expect(() => TextArea({ selection: { anchor: at(0, 0) } as never })).toThrow(TypeError);
      expect(() => TextArea({ selection: 3 as never })).toThrow(/selection/u);
    });
  });

  describe('which keys are the area’s', () => {
    it('should hand Escape, Tab, Shift-Tab and an unbound chord on to what holds it', async () => {
      const s = scene({ value: 'ab' });
      await s.term.press(KEYS.tab, KEYS.shiftTab, ctrl('g'), ctrl('x'), ctrl('y'), KEYS.escape);
      await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
      expect(s.seen).toEqual(['tab', 'shift+tab', 'ctrl+g', 'ctrl+x', 'ctrl+y', 'escape']);
    });

    it('should claim the editing keys even at an end', async () => {
      const s = scene({ value: 'ab' });
      await s.term.press(KEYS.right, KEYS.down, KEYS.pageDown, KEYS.enter, 'x', KEYS.backspace);
      expect(s.seen).toEqual([]);
    });

    it('should type `tab` for Tab when it is given one, and still hand Shift-Tab on', async () => {
      const value = new State('');
      const s = scene({ tab: '  ', value });
      await s.term.press(KEYS.tab, 'x', KEYS.shiftTab);
      expect(value.get()).toBe('  x');
      expect(s.seen).toEqual(['shift+tab']);
    });

    it('should take no key and no paste while disabled, and leave the ring', async () => {
      const value = new State('ab');
      const disabled = new State(false);
      const s = scene({ disabled, value });
      disabled.set(true);
      await settle();
      // with the focus put on it by hand, it types nothing and keeps no paste
      await s.term.press('x', KEYS.left);
      await s.term.paste('pasted');
      expect(value.get()).toBe('ab');
      expect(s.seen.slice(0, 2)).toEqual(['x', 'left']);
      expect(s.input.focus.ring()).toEqual([]);
    });

    it.each(DERIVED)('should follow %s, off and on again', async (_, derive) => {
      const valid = new State(true);
      const value = new State('');
      const s = scene({ disabled: derive(valid), value });
      await s.term.press('a');
      expect(value.get()).toBe('a');
      valid.set(false);
      await settle();
      expect(s.input.focus.ring()).toEqual([]);
      expect(s.area.classes).toContain('is-disabled');
      // it kept the focus, and types and pastes nothing with it
      await s.term.press('b');
      await s.term.paste('pasted');
      expect(value.get()).toBe('a');
      valid.set(true);
      await settle();
      expect(s.input.focus.ring()).toEqual([s.area]);
      await s.term.press('c');
      expect(value.get()).toBe('ac');
    });
  });

  describe('a paste', () => {
    it('should keep its line breaks, in one spelling', async () => {
      const value = new State('');
      const s = scene({ value });
      await s.term.paste('one\r\ntwo\rthree\n');
      expect(value.get()).toBe('one\ntwo\nthree\n');
      expect(s.pasted).toEqual([]);
      await s.term.press('!');
      expect(value.get()).toBe('one\ntwo\nthree\n!');
    });

    it('should type a tab that came in a paste the terminal did not bracket', () => {
      // such a paste arrives as keys flagged `paste`, and a Tab among them is
      // indentation somebody copied, not a move through the ring
      const value = new State('');
      const area = TextArea({ value });
      let stopped = false;
      area.onKey?.({
        current: area,
        key: { ctrl: false, meta: false, name: 'tab', sequence: '\t', shift: false },
        paste: true,
        stop() {
          stopped = true;
        },
        stopped: false,
        target: area,
      });
      expect(value.get()).toBe('\t');
      expect(stopped).toBe(true);
    });

    // 600,000 lines, because a spread into `splice()` fails at about 110,000 to
    // 124,000 on a main thread, by node version, and at about 494,000 in the
    // vitest worker this runs in -- a worker's 4 MB of stack less the 192 KiB
    // node reserves, over eight bytes an argument. Measured on darwin arm64 for
    // node 22, 24 and 26, and expected to match elsewhere because node sets a
    // worker's stack limit itself. That is 20 percent past the worker's limit,
    // which is the margin a slightly larger stack would need to eat; it was a
    // million, which on the Windows node 22 job took 10,121ms of a 10,000ms
    // timeout, twice in one day (SIG-444). What a long paste costs beyond that is
    // counted rather than timed, in `editing-snap.test.ts`
    it('should take a long file without overflowing the stack', async () => {
      const value = new State('');
      const s = scene({ value });
      const long = Array.from({ length: 600_000 }, (_, i) => `${i}`).join('\n');
      await s.term.paste(long);
      expect(value.get()).toBe(long);
      await settle();
      expect(picture(s.root).at(-1)).toBe('599999');
    });
  });

  describe('a selection', () => {
    it('should select with Shift and an arrow, and replace it with what is typed', async () => {
      const value = new State('hello\nworld');
      const s = scene({ value });
      await s.term.press(SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT);
      await settle();
      expect(reversed(s.root).slice(0, 2)).toEqual(['', 'rld']);
      await s.term.press('X');
      expect(value.get()).toBe('hello\nwoX');
    });

    it('should select across a line break, and draw the break as a column', async () => {
      const value = new State('ab\ncd');
      const s = scene({ value });
      await s.term.press(CTRL_HOME, KEYS.right, SHIFT_DOWN);
      await settle();
      // `b`, the break after it, and `c`
      expect(reversed(s.root).slice(0, 2)).toEqual(['b ', 'c']);
      await s.term.press(KEYS.backspace);
      expect(value.get()).toBe('ad');
    });

    it('should collapse onto the end an arrow points at', async () => {
      const value = new State('abcdef');
      const s = scene({ value });
      await s.term.press(KEYS.home, KEYS.right, SHIFT_RIGHT, SHIFT_RIGHT, KEYS.left, '<');
      expect(value.get()).toBe('a<bcdef');
      await s.term.press(SHIFT_RIGHT, SHIFT_RIGHT, KEYS.right, '>');
      expect(value.get()).toBe('a<bc>def');
    });

    it('should let a deleting key take the selection and nothing else', async () => {
      const value = new State('one two three');
      const s = scene({ value });
      await s.term.press(SHIFT_LEFT, SHIFT_LEFT, ctrl('w'));
      expect(value.get()).toBe('one two thr');
    });

    it('should copy with Ctrl-Y and cut with Ctrl-X when it has somewhere to put the text', async () => {
      const value = new State('ab\ncd');
      const copied: string[] = [];
      const s = scene({ onCopy: (t) => copied.push(t), value });
      await s.term.press(SHIFT_LEFT, `${ESC}[1;2A`, ctrl('y'));
      expect(copied).toEqual(['b\ncd']);
      expect(value.get()).toBe('ab\ncd');
      await s.term.press(ctrl('x'));
      expect(copied).toEqual(['b\ncd', 'b\ncd']);
      expect(value.get()).toBe('a');
      // and with nothing selected the keys are still the area's, doing nothing
      await s.term.press(ctrl('x'), ctrl('y'));
      expect(copied).toHaveLength(2);
      expect(s.seen).toEqual([]);
    });

    it('should draw nothing for a selection at colour level 0, and still copy it', async () => {
      const copied: string[] = [];
      const s = scene({ onCopy: (t) => copied.push(t), value: 'abc' });
      await s.term.press(SHIFT_LEFT);
      await settle();
      expect(coloured(s.root, WIDTH, HEIGHT, 0)).not.toContain(`${ESC}[`);
      await s.term.press(ctrl('y'));
      expect(copied).toEqual(['c']);
    });

    it('should select with a drag, and extend with a shift-press', async () => {
      const copied: string[] = [];
      const s = scene({ onCopy: (t) => copied.push(t), value: 'hello world\nsecond' });
      const down = mouse('mousedown', 2, 0);
      s.area.onMouse?.(down);
      // the press is not stopped, which is what lets it give the area the focus
      expect(down.stopped).toBe(false);
      s.area.onMouse?.(mouse('mousemove', 7, 0));
      s.area.onMouse?.(mouse('mouseup', 7, 0));
      await s.term.press(ctrl('y'));
      expect(copied).toEqual(['llo w']);

      s.area.onMouse?.(mouse('mousedown', 3, 1, { shift: true }));
      s.area.onMouse?.(mouse('mouseup', 3, 1));
      await s.term.press(ctrl('y'));
      expect(copied.at(-1)).toBe('llo world\nsec');
    });

    it('should place the caret with a press and select nothing', async () => {
      const value = new State('hello\nworld');
      const s = scene({ value });
      s.area.onMouse?.(mouse('mousedown', 2, 0));
      s.area.onMouse?.(mouse('mouseup', 2, 0));
      await s.term.press('|');
      expect(value.get()).toBe('he|llo\nworld');
      // past the end of a line is the end of it
      s.area.onMouse?.(mouse('mousedown', 20, 1));
      s.area.onMouse?.(mouse('mouseup', 20, 1));
      await s.term.press('|');
      expect(value.get()).toBe('he|llo\nworld|');
    });

    it('should leave the gutter out of what a screen selection copies', () => {
      const area = TextArea({ gutter: '│', lineNumbers: true, value: 'ab' });
      resolveStyles(area);
      arrange(area, { height: 1, width: 10 });
      // render once so the layers have a frame to read
      picture(area, 10, 1);
      const selectable = selectableAt(area, 10, 1);
      // ` 1 │` and then the text
      expect(selectable?.(1, 0), 'a number can be copied').toBe(false);
      expect(selectable?.(3, 0), 'the mark can be copied').toBe(false);
      expect(selectable?.(4, 0), 'the text cannot be copied').toBe(true);
    });
  });

  describe('scrolling', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');

    it('should keep the caret in view as it moves down and back up', async () => {
      const s = scene({ value: many }, 4);
      expect(picture(s.root, WIDTH, 4)).toEqual(['line 47', 'line 48', 'line 49', 'line 50']);
      await s.term.press(CTRL_HOME);
      await settle();
      expect(picture(s.root, WIDTH, 4)[0]).toBe('line 1');
      await s.term.press(KEYS.pageDown);
      await settle();
      expect(picture(s.root, WIDTH, 4)[0]).toBe('line 5');
    });

    it('should scroll sideways to keep the caret in view', async () => {
      const value = new State(`${'x'.repeat(40)}end`);
      const s = scene({ value }, 2);
      // the end of the line, and the caret's own column after it
      expect(picture(s.root, WIDTH, 2)[0]).toBe(`${'x'.repeat(26)}end`);
      await s.term.press(KEYS.home);
      await settle();
      expect(picture(s.root, WIDTH, 2)[0]).toBe('x'.repeat(WIDTH));
    });

    it('should leave out a wide character the left edge cuts, rather than draw half of it', () => {
      // twenty-eight columns of text in the twenty-eight the mark leaves, and the
      // caret's column after them: the view is one column along, which is through
      // the middle of the 漢. Drawn anyway, its far half would be in the first
      // column and its near half over the mark
      const area = TextArea({ gutter: '> ', value: `漢${'x'.repeat(26)}` });
      const row = picture(box({ width: WIDTH }, area), WIDTH, 1);
      expect(row[0]).toBe(`>  ${'x'.repeat(26)}`);
    });

    it('should scroll with the wheel and leave the caret where it was', async () => {
      const value = new State(many);
      const s = scene({ value }, 4);
      await s.term.press(CTRL_HOME);
      const wheel = mouse('wheel', 1, 1, { wheel: 'down' });
      s.area.onMouse?.(wheel);
      expect(wheel.stopped).toBe(true);
      await settle();
      expect(picture(s.root, WIDTH, 4)[0]).toBe('line 4');
      await s.term.press('!');
      expect(value.get().startsWith('!line 1')).toBe(true);
      await settle();
      // and the edit brings the caret back into view
      expect(picture(s.root, WIDTH, 4)[0]).toBe('!line 1');
    });

    it('should hand the wheel on when its lines fit', () => {
      const s = scene({ value: 'a\nb' }, 4);
      const wheel = mouse('wheel', 1, 1, { wheel: 'down' });
      s.area.onMouse?.(wheel);
      expect(wheel.stopped).toBe(false);
    });
  });

  describe('line numbers and the gutter', () => {
    it('should number each line in two digits at least, after which the mark goes', () => {
      expect(picture(TextArea({ gutter: '│ ', lineNumbers: true, value: 'a\nb' }), 20, 2)).toEqual([
        ' 1 │ a',
        ' 2 │ b',
      ]);
      const hundred = Array.from({ length: 100 }, () => 'x').join('\n');
      expect(picture(TextArea({ lineNumbers: true, value: hundred }), 20, 2)[1]).toBe('100 x');
    });

    it('should leave the caret’s line number unmuted and every other one muted', async () => {
      const s = scene({ lineNumbers: true, value: 'a\nb\nc' });
      await s.term.press(KEYS.up);
      await settle();
      const rows = coloured(s.root).split('\n');
      expect(rows[0]).toContain(`${ESC}[2m1`);
      expect(rows[1]).toMatch(/^ 2 b/u);
      expect(rows[2]).toContain(`${ESC}[2m3`);
    });

    it('should number the rows that are on screen, not the ones scrolled past', async () => {
      const many = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n');
      const s = scene({ lineNumbers: true, value: many }, 3);
      expect(picture(s.root, WIDTH, 3)).toEqual(['28 l28', '29 l29', '30 l30']);
    });
  });

  describe('highlight', () => {
    const keywords = (value: string): HighlightSpan[] =>
      [...value.matchAll(/\b(?:let|const)\b/gu)].map((m) => ({
        end: (m.index ?? 0) + m[0].length,
        start: m.index ?? 0,
        token: 'keyword',
      }));

    it('should draw a token in its role and leave the rest alone', () => {
      const out = coloured(TextArea({ highlight: keywords, value: 'let x\nconst y' }), 20, 2);
      // the accent is cyan, which is what a keyword draws in
      // a space takes no colour, so the close may come before it or after
      expect(out).toMatch(new RegExp(`${ESC}\\[36mlet ?${ESC}\\[39m ?x`));
      expect(out).toMatch(new RegExp(`${ESC}\\[36mconst ?${ESC}\\[39m ?y`));
    });

    it('should carry one span over a line break', () => {
      const comment = (value: string): HighlightSpan[] => [
        { end: value.length, start: value.indexOf('/*'), token: 'comment' },
      ];
      const out = coloured(TextArea({ highlight: comment, value: 'a /* b\nc */' }), 20, 2);
      const rows = out.split('\n');
      expect(rows[0]).toContain(`${ESC}[2m/* b`);
      expect(rows[1]).toMatch(new RegExp(`^${ESC}\\[2mc \\*/`));
    });

    it('should ask again when the value changes and never when only the caret moves', async () => {
      const asked: string[] = [];
      const value = new State('let');
      const s = scene({
        highlight: (v) => {
          asked.push(v);
          return keywords(v);
        },
        value,
      });
      expect(asked).toEqual(['let']);
      await s.term.press(KEYS.left, KEYS.home, KEYS.end);
      expect(asked).toEqual(['let']);
      await s.term.press('s');
      expect(asked).toEqual(['let', 'lets']);
      value.set('const');
      await settle();
      expect(asked.at(-1)).toBe('const');
    });

    it('should clip a span past the end and refuse a token no class can carry', () => {
      const past = (): HighlightSpan[] => [{ end: 99, start: 2, token: 'string' }];
      expect(coloured(TextArea({ highlight: past, value: 'abcd' }), 10, 1)).toContain(
        `ab${ESC}[32mcd`
      );
      expect(() =>
        TextArea({ highlight: () => [{ end: 1, start: 0, token: 'a b' }], value: 'x' })
      ).toThrow(/no class can carry/);
    });
  });

  it('should be told its focus through the element, with no router at build time', () => {
    const area = TextArea({ value: 'ab' });
    area.onFocusChange?.(area, true);
    expect(coloured(area, 10, 1)).toContain(`ab${ESC}[7m `);
    area.onFocusChange?.(area, false);
    expect(coloured(area, 10, 1)).not.toContain(`${ESC}[7m`);
  });

  it('should sit beside other things in a row, taking its share', () => {
    const row = box(
      { 'flex-direction': 'row', width: 30 },
      text('Note', { 'margin-right': 1 }),
      TextArea({ value: 'a very long line of text that does not fit' })
    );
    // the caret is at the end, so the end of the line is what is on screen
    expect(picture(row, 30, 1)[0]).toMatch(/^Note .*not fit$/u);
  });
});
