import { type ColorLevel, strip } from '../../src/ansi/index.js';
import {
  ATTR,
  CellBuffer,
  DEFAULT_COLOR,
  Painter,
  palette,
  type Style,
  StyleTable,
} from '../../src/canvas/index.js';
import { openModal } from '../../src/components/modal.js';
import { TextField } from '../../src/components/text-field.js';
import {
  arrange,
  box,
  type Element,
  paint,
  renderToLines,
  renderToString,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import { createInput, ESCAPE_TIMEOUT, type KeyEvent } from '../../src/input/index.js';
import { flush, State } from '../../src/signals/index.js';
import { type ColorScheme, Restyler } from '../../src/style/index.js';
import { alt, createTestTerminal, ctrl, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A text field: the prompt's editor as an element.
 *
 * Driven through a real router over a test terminal, because most of what the
 * field promises is about where a key goes -- to the field, or on past it to a
 * form, a dialog or the root -- and a handler called by hand is in none of that.
 */

const ESC = String.fromCharCode(0x1b);
const WIDTH = 40;
const HEIGHT = 10;

/** Lets a key act, and the effect that draws its consequence run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  flush();
}

/** The tree as a person would read it, colour taken off and the right edge trimmed. */
function picture(root: Element, width = WIDTH): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel: 0, width }).map((line) =>
    strip(line).trimEnd()
  );
}

/** The tree with its attributes, at the lowest level that keeps one. */
function coloured(root: Element, width = WIDTH): string {
  return renderToString(root, { cascade: themedCascade(), colorLevel: 1, width });
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
});

/** A field in a column, a router over it, and a record of what reached the root. */
function scene(field: Element, ...rest: Element[]) {
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const seen: string[] = [];
  const root = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH }, field, ...rest);
  root.onKey = (event) => {
    const k = event.key;
    seen.push(`${k.ctrl ? 'ctrl+' : ''}${k.shift ? 'shift+' : ''}${k.name}`);
  };
  const input = createInput({ root, terminal: term.terminal });
  stops.push(() => input.stop());
  input.focus.focus(field);
  return { input, root, seen, term };
}

describe('TextField()', () => {
  it('should draw the value, and the placeholder while it is empty', () => {
    expect(picture(TextField({ value: 'hello' }))[0]).toBe('hello');
    expect(picture(TextField({ placeholder: 'Search files' }))[0]).toBe('Search files');
  });

  it('should draw the placeholder in the muted role, the caret cell included', () => {
    // unfocused, a hint whose first letter alone is at full strength reads as
    // something typed. The field's own background is on every cell, so the dim is
    // opened with it and closed after the fourth letter, the caret's cell among them
    const out = coloured(TextField({ placeholder: 'Find' }));
    expect(out).toMatch(new RegExp(`^${ESC}\\[2;\\d+mFind${ESC}\\[22m`));
  });

  it('should draw the caret only while it has the focus', async () => {
    const one = TextField({ value: 'ab' });
    const two = TextField({ value: 'cd' });
    const s = scene(one, two);
    await settle();

    const out = coloured(s.root);
    // the caret is past the end of the focused field, a reversed blank there
    expect(out).toContain(`ab${ESC}[7m `);
    expect(out.split(`${ESC}[7m`)).toHaveLength(2);

    s.input.focus.focus(two);
    const moved = coloured(s.root);
    expect(moved).toContain(`cd${ESC}[7m `);
    expect(moved).not.toContain(`ab${ESC}[7m`);
  });

  it('should refuse props it cannot use', () => {
    expect(() => TextField({ value: 3 as never })).toThrow(/value to be a string or a State/);
    expect(() => TextField({ disabled: 'yes' as never })).toThrow(/boolean or a State/);
    expect(() => TextField({ mask: '' })).toThrow(/mask to be a non-empty string/);
    expect(() => TextField({ placeholder: 1 as never })).toThrow(/placeholder to be a string/);
    expect(() => TextField({ width: 0 })).toThrow(/positive whole number/);
    expect(() => TextField({ width: 2.5 })).toThrow(/positive whole number/);
  });

  it('should keep a class the caller gave it', () => {
    const field = TextField({ props: { class: 'name' } });
    expect(field.classes).toEqual(['name', 'sigil-text-field']);
  });
});

/**
 * A field at rest: what says it is a field before anything focuses it.
 *
 * Read off the cell grid rather than off a string, because the question is the
 * background of each cell -- including the room to the right of the value, which a
 * string with its trailing blanks trimmed cannot see -- and both schemes are asked,
 * because the pair is different in each and a light terminal is the half nobody
 * looks at.
 */
describe('a field at rest', () => {
  const W = 16;

  /** A label over the field, painted, and the cells of both rows read back. */
  function cells(
    field: Element,
    colorScheme: ColorScheme,
    opts: { colorLevel?: ColorLevel; sheets?: string[]; theme?: string } = {}
  ) {
    const cascade = themedCascade({ colorScheme, sheets: opts.sheets, theme: opts.theme });
    if (opts.colorLevel !== undefined) {
      cascade.media = { ...cascade.media, colorLevel: opts.colorLevel };
    }
    const styles = new StyleTable();
    const buffer = new CellBuffer(W, 2);
    const root = box({ 'flex-direction': 'column', width: W }, text('Name'), field);
    resolveStyles(root, new Restyler(cascade));
    arrange(root, { height: 2, width: W });
    paint(root, new Painter(buffer, styles));

    const row = (y: number): Style[] =>
      Array.from({ length: W }, (_, x) => styles.get(buffer.styleAt(x, y)));
    return { field: row(1), label: row(0), line: buffer.toLines()[1] ?? '' };
  }

  const PAIR = { dark: palette(8), light: palette(7) } as const;
  const SCHEMES = ['dark', 'light'] as const;

  it('should not be the same bytes as a label', () => {
    // the defect as filed: an unfocused field was its value and nothing else
    expect(coloured(TextField({ value: 'parser.ts' }))).not.toBe(coloured(text('parser.ts')));
  });

  it('should paint gray behind a field on a dark terminal and white on a light one', () => {
    for (const scheme of SCHEMES) {
      const g = cells(TextField({ value: 'parser.ts' }), scheme);

      expect(g.line, scheme).toBe('parser.ts       ');
      // every cell of the row, the room to the right of the value included, which
      // is where the typing goes and what an underline would have left unmarked
      expect(
        g.field.map((cell) => cell.bg),
        scheme
      ).toEqual(Array(W).fill(PAIR[scheme]));
      // and the label above it is on the terminal's own background
      expect(
        g.label.map((cell) => cell.bg),
        scheme
      ).toEqual(Array(W).fill(DEFAULT_COLOR));
    }
  });

  it('should keep the background when the field takes the focus', () => {
    // the caret already says which field the keys go to, so the focus adds the
    // caret and nothing else
    for (const scheme of SCHEMES) {
      const field = TextField({ value: 'parser.ts' });
      field.setState('focus', true);
      flush();
      const g = cells(field, scheme);

      expect(
        g.field.map((cell) => cell.bg),
        scheme
      ).toEqual(Array(W).fill(PAIR[scheme]));
      expect(g.field[9]?.attrs, scheme).toBe(ATTR.inverse);
      expect(g.field[8]?.attrs, scheme).toBe(ATTR.none);
    }
  });

  it('should keep the placeholder muted on the background', () => {
    // dim on a dark terminal and gray on a light one, which is the muted role's
    // own pair -- on white, gray is a different index from the background, so the
    // hint is not drawn in the colour it sits on
    const dark = cells(TextField({ placeholder: 'name' }), 'dark').field.slice(0, 4);
    expect(dark.map((cell) => [cell.bg, cell.attrs])).toEqual(
      Array(4).fill([palette(8), ATTR.dim])
    );

    const light = cells(TextField({ placeholder: 'name' }), 'light').field.slice(0, 4);
    expect(light.map((cell) => [cell.bg, cell.fg, cell.attrs])).toEqual(
      Array(4).fill([palette(7), palette(8), ATTR.none])
    );
  });

  it('should keep the background on a disabled field, and mute its value', () => {
    // a field that cannot be edited now is still a field; the muted value is what
    // says not now
    for (const scheme of SCHEMES) {
      const g = cells(TextField({ disabled: true, value: 'parser.ts' }), scheme);

      expect(
        g.field.map((cell) => cell.bg),
        scheme
      ).toEqual(Array(W).fill(PAIR[scheme]));
      expect(g.field[0], scheme).toMatchObject(
        scheme === 'dark' ? { attrs: ATTR.dim } : { attrs: ATTR.none, fg: palette(8) }
      );
    }
  });

  it('should drop the background at colour level 0, where a field at rest is its value again', () => {
    // the known cost: degradation drops every colour there, the caret's inverse
    // with it, and nothing in the sheet can say otherwise
    for (const scheme of SCHEMES) {
      const g = cells(TextField({ value: 'parser.ts' }), scheme, { colorLevel: 0 });
      expect(
        g.field.map((cell) => cell.bg),
        scheme
      ).toEqual(Array(W).fill(DEFAULT_COLOR));
    }
    const plain = { cascade: themedCascade(), colorLevel: 0 as const, width: W };
    expect(renderToString(TextField({ value: 'parser.ts' }), plain)).toBe(
      renderToString(text('parser.ts'), plain)
    );
  });

  it('should let a theme restyle the background and an app take it away', () => {
    for (const scheme of SCHEMES) {
      const themed = cells(TextField({ value: 'ab' }), scheme, {
        theme: '.sigil-text-field { background-color: blue }',
      });
      expect(themed.field[0]?.bg, scheme).toBe(palette(4));

      // an ordinary one-class rule at origin app, with no specificity contest
      const bare = cells(TextField({ value: 'ab' }), scheme, {
        sheets: ['.sigil-text-field { background-color: default }'],
      });
      expect(
        bare.field.map((cell) => cell.bg),
        scheme
      ).toEqual(Array(W).fill(DEFAULT_COLOR));
    }
  });
});

describe('editing', () => {
  it('should type at the caret and move by a character', async () => {
    const value = new State('');
    const s = scene(TextField({ value }));

    await s.term.press('hllo');
    await s.term.press(KEYS.home, KEYS.right, 'e');
    expect(value.get()).toBe('hello');
    await s.term.press(KEYS.end, '!');
    expect(value.get()).toBe('hello!');
    await s.term.press(ctrl('a'), '>');
    await s.term.press(ctrl('e'), '<');
    expect(value.get()).toBe('>hello!<');
  });

  it('should take a character either side of the caret', async () => {
    const value = new State('abc');
    const s = scene(TextField({ value }));

    await s.term.press(KEYS.backspace);
    expect(value.get()).toBe('ab');
    await s.term.press(KEYS.home, KEYS.delete);
    expect(value.get()).toBe('b');
  });

  it('should move and delete by whole graphemes', async () => {
    const value = new State('a👍🏽b');
    const s = scene(TextField({ value }));

    await s.term.press(KEYS.left, KEYS.backspace);
    expect(value.get()).toBe('ab');
  });

  it('should move by a word with Ctrl and Alt', async () => {
    const value = new State('one two three');
    const s = scene(TextField({ value }));

    await s.term.press(`${ESC}[1;5D`, '_');
    expect(value.get()).toBe('one two _three');
    await s.term.press(alt('b'), alt('b'), '^');
    expect(value.get()).toBe('one ^two _three');
    await s.term.press(alt('f'), '$');
    expect(value.get()).toBe('one ^two$ _three');
    await s.term.press(`${ESC}[1;5C`, '#');
    expect(value.get()).toBe('one ^two$ _three#');
  });

  it('should delete by a word, and to either end', async () => {
    const value = new State('one two three');
    const s = scene(TextField({ value }));

    await s.term.press(ctrl('w'));
    expect(value.get()).toBe('one two ');
    await s.term.press(KEYS.home, alt('d'));
    expect(value.get()).toBe(' two ');
    await s.term.press(KEYS.right, ctrl('k'));
    expect(value.get()).toBe(' ');
    await s.term.press(KEYS.end, 'x', ctrl('u'));
    expect(value.get()).toBe('');
  });

  it('should delete a word with a modified Backspace and Delete', () => {
    const value = new State('one two');
    const field = TextField({ value });
    const send = (name: string, mods: Partial<KeyEvent['key']> = {}) =>
      field.onKey?.(
        keyEvent({ ctrl: false, meta: false, name, sequence: '', shift: false, ...mods })
      );

    send('backspace', { meta: true });
    expect(value.get()).toBe('one ');
    send('home');
    send('delete', { ctrl: true });
    expect(value.get()).toBe(' ');
  });

  it('should tell the app after an edit and not after a move', async () => {
    const changes: string[] = [];
    const s = scene(TextField({ onChange: (next) => changes.push(next), value: 'a' }));

    await s.term.press('b', KEYS.left, KEYS.backspace, KEYS.backspace);
    expect(changes).toEqual(['ab', 'b']);
  });

  it('should follow a write the app made, with the caret at the end', async () => {
    const value = new State('abc');
    const s = scene(TextField({ value }));

    await s.term.press(KEYS.home);
    value.set('wxyz');
    await settle();
    expect(picture(s.root)[0]).toBe('wxyz');
    await s.term.press('!');
    expect(value.get()).toBe('wxyz!');
  });

  it('should draw nothing for a control character the app wrote', () => {
    expect(picture(TextField({ value: 'a\nb\tc' }))[0]).toBe('abc');
  });

  it('should mask the value a column at a time', async () => {
    const value = new State('');
    const s = scene(TextField({ mask: '*', value }));

    await s.term.press('pa語');
    expect(value.get()).toBe('pa語');
    expect(picture(s.root)[0]).toBe('****');
  });
});

describe('the sideways scroll', () => {
  it('should keep the caret in view when the value is wider than the field', async () => {
    const value = new State('');
    const s = scene(TextField({ value, width: 6 }));

    await s.term.press('abcdefghij');
    // five characters and the caret's own column
    expect(picture(s.root)[0]).toBe('fghij');
    await s.term.press(KEYS.home);
    expect(picture(s.root)[0]).toBe('abcdef');
  });

  it('should cut the window to the room the layout gave it, with no width declared', () => {
    // in a column the field is stretched, so its room is the parent's, learned
    // through `onResize` rather than declared
    const field = TextField({ value: 'abcdefghijklmnop' });
    const host = box({ 'flex-direction': 'column', width: 8 }, field);
    expect(picture(host)[0]).toBe('jklmnop');
  });

  it('should shrink to its share of a row rather than to its content', () => {
    // a box's automatic minimum is its content's, and a field's content is the
    // whole value -- so without `min-width: 0` it could not be narrower than what
    // was typed, and the window would never be cut
    const field = TextField({ props: { 'flex-grow': 1 }, value: 'abcdefghijklmnop' });
    const host = box({ 'flex-direction': 'row', width: 10 }, text('>'), field);
    expect(picture(host)[0]).toBe('>ijklmnop');
  });

  it('should grow with what is typed in a row, not show only the last letter', async () => {
    // SIG-318: content-sized in a row, the field was as wide as what it drew and
    // drew what fitted the width it was laid out at -- so one key per frame left
    // it the caret and the last letter wide, whatever had been typed
    const value = new State('');
    const field = TextField({ placeholder: 'press / to filter', value });
    const row = box({ 'flex-direction': 'row', 'column-gap': 1 }, text('filter'), field);
    const s = scene(row);
    s.input.focus.focus(field);

    for (const key of 'proc') {
      await s.term.press(key);
      // a frame per key, which is what a person typing gets
      picture(s.root);
    }
    expect(value.get()).toBe('proc');
    expect(picture(s.root)[0]).toBe('filter proc');
  });

  it('should still cut a content-sized field in a row to the room the row has', () => {
    // the other half: as wide as its value where there is room, and windowed
    // around the caret where there is not
    const field = TextField({ value: 'abcdefghijklmnop' });
    const row = box({ 'flex-direction': 'row', width: 10 }, text('>'), field);
    expect(picture(row)[0]).toBe('>ijklmnop');
  });

  it('should cut the value at its right edge rather than draw over what follows it', async () => {
    // the pieces hold the whole value, so the part right of the window is still
    // there to be drawn -- and `overflow` is what keeps it inside the field
    const field = TextField({ props: { 'flex-grow': 1 }, value: 'abcdefghijkl' });
    const row = box({ 'flex-direction': 'row', width: 8 }, field, text('|'));
    const s = scene(row);
    s.input.focus.focus(field);

    await s.term.press(KEYS.home);
    expect(picture(s.root)[0]).toBe('abcdefg|');
  });

  it('should scroll whole wide characters off the left, never half of one', () => {
    // the scroll is the columns the prompt's window drops, which are whole
    // clusters: a scroll of the bare overflow would leave half of the first
    // wide character on screen, which the grid draws as a blank
    const field = TextField({ value: '漢字漢字漢', width: 6 });
    const host = box({ 'flex-direction': 'column', width: 10 }, field);
    expect(picture(host)[0]).toBe('字漢');
  });

  it('should say whether a new size changed what it draws', () => {
    const field = TextField({ value: 'abcdefghij' });
    const resize = (width: number): boolean =>
      field.onResize?.(
        Object.assign(field, { content: { height: 1, width, x: 0, y: 0 } }) as Element
      ) ?? false;

    expect(resize(4)).toBe(true);
    // the same room is nothing to do, and a frame is owed no second layout
    expect(resize(4)).toBe(false);
    // a wider room with the caret still at the end moves the window
    expect(resize(6)).toBe(true);
  });
});

describe('the keys it claims', () => {
  it('should submit on Enter when it was given onSubmit, and stop there', async () => {
    const sent: string[] = [];
    const s = scene(TextField({ onSubmit: (value) => sent.push(value), value: 'go' }));

    await s.term.press(KEYS.enter);
    expect(sent).toEqual(['go']);
    expect(s.seen).toEqual([]);
  });

  it('should let Enter go on to what is around it without onSubmit', async () => {
    const s = scene(TextField({ value: 'go' }));

    await s.term.press(KEYS.enter);
    expect(s.seen).toEqual(['enter']);
  });

  it('should never keep Tab, Shift-Tab or Escape', async () => {
    const field = TextField({ onSubmit: () => {} });
    const other = text('other', { focusable: true });
    const s = scene(field, other);

    // the router's own default moves the focus on a Tab nobody stopped
    await s.term.press(KEYS.tab);
    expect(s.input.focus.current.get()).toBe(other);
    s.input.focus.focus(field);
    await s.term.press(KEYS.shiftTab);
    expect(s.input.focus.current.get()).toBe(other);

    s.input.focus.focus(field);
    await s.term.press(KEYS.escape);
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
    expect(s.seen).toContain('escape');
  });

  it('should leave Up, Down and the abort to what is around it', async () => {
    const value = new State('');
    const s = scene(TextField({ value }));

    await s.term.press(KEYS.up, KEYS.down, ctrl('c'), ctrl('d'), ctrl('x'));
    expect(s.seen).toEqual(['up', 'down', 'ctrl+c', 'ctrl+d', 'ctrl+x']);
    expect(value.get()).toBe('');
  });

  it('should never submit on a line break that was pasted', () => {
    const sent: string[] = [];
    const value = new State('a');
    const field = TextField({ onSubmit: (next) => sent.push(next), value });
    field.onKey?.(
      keyEvent({ ctrl: false, meta: false, name: 'enter', sequence: '\r', shift: false }, true)
    );

    expect(sent).toEqual([]);
    expect(value.get()).toBe('a ');
  });
});

describe('a paste', () => {
  it('should go in at the caret with its line breaks flattened', async () => {
    const value = new State('[]');
    const s = scene(TextField({ value }));

    await s.term.press(KEYS.left);
    await s.term.paste('one\ntwo\r\n  three');
    expect(value.get()).toBe('[one two three]');
  });

  it('should reach the focused field before a handler the app registered first', async () => {
    const value = new State('');
    const field = TextField({ value });
    const s = scene(field);
    const app: string[] = [];
    s.input.onPaste((event) => {
      app.push(event.text);
      event.stop();
    });

    await s.term.paste('pasted');
    expect(value.get()).toBe('pasted');
    expect(app).toEqual([]);

    // and the app's handler is what has it once the field is not focused
    s.input.focus.focus(undefined);
    await s.term.paste('again');
    expect(app).toEqual(['again']);
    expect(value.get()).toBe('pasted');
  });
});

describe('disabled', () => {
  it('should be out of the ring, take no input, and be muted', async () => {
    const value = new State('x');
    const field = TextField({ disabled: true, value });
    const other = text('other', { focusable: true });
    const s = scene(field, other);

    expect(s.input.focus.ring()).toEqual([other]);
    expect(field.classes).toContain('is-disabled');
    expect(field.classes).toContain('sigil-muted');

    // even with the focus put on it by hand, it types nothing and keeps no paste
    s.input.focus.focus(field);
    await s.term.press('y');
    await s.term.paste('z');
    expect(value.get()).toBe('x');
  });

  it('should follow a State the app switches', async () => {
    const disabled = new State(false);
    const field = TextField({ disabled });
    const s = scene(field);

    expect(s.input.focus.ring()).toEqual([field]);
    disabled.set(true);
    await settle();
    expect(s.input.focus.ring()).toEqual([]);
    expect(field.classes).toContain('is-disabled');
    disabled.set(false);
    await settle();
    expect(s.input.focus.ring()).toEqual([field]);
    expect(field.classes).not.toContain('sigil-muted');
  });
});

describe('inside openModal()', () => {
  /** An app with a row, a router over it, and a dialog holding a field. */
  function dialog(opts: { onSubmit?: (value: string) => void } = {}) {
    const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
    const row = text('row', { focusable: true });
    const root = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH }, row);
    const reached: string[] = [];
    root.onKey = (event) => void reached.push(event.key.name);
    const input = createInput({ root, terminal: term.terminal });
    // registered before the dialog opens, which is the order an app's own is in
    const pastes: string[] = [];
    input.onPaste((event) => {
      pastes.push(event.text);
      event.stop();
    });

    const value = new State('');
    const field = TextField({ value, ...opts });
    const handle = openModal<string>(root, {
      actions: [
        { label: 'OK', value: 'ok' },
        { label: 'Cancel', value: 'cancel' },
      ],
      body: field,
      input,
      title: 'Rename',
    });
    input.focus.focus(field);
    stops.push(
      () => handle.dispose(),
      () => input.stop()
    );
    const buttons = [...(handle.element.children[0]?.children.at(-1)?.children ?? [])];
    return { buttons, field, handle, input, pastes, reached, root, term, value };
  }

  it('should cycle Tab through the field and the buttons, and Shift-Tab back', async () => {
    const d = dialog();
    const [ok, cancel] = d.buttons;

    await d.term.press(KEYS.tab);
    expect(d.input.focus.current.get()).toBe(ok);
    await d.term.press(KEYS.tab);
    expect(d.input.focus.current.get()).toBe(cancel);
    await d.term.press(KEYS.tab);
    expect(d.input.focus.current.get()).toBe(d.field);
    await d.term.press(KEYS.shiftTab);
    expect(d.input.focus.current.get()).toBe(cancel);
  });

  it('should type into the field and nothing under the dialog', async () => {
    const d = dialog();

    await d.term.press('draft.md');
    expect(d.value.get()).toBe('draft.md');
    expect(d.reached).toEqual([]);
    await settle();
    expect(picture(d.root, WIDTH).join('\n')).toContain('draft.md');
  });

  it('should submit on Enter with onSubmit, and leave Enter alone without it', async () => {
    let handle: ReturnType<typeof dialog>['handle'] | undefined;
    const d = dialog({ onSubmit: (value) => handle?.close(value) });
    handle = d.handle;

    await d.term.press('new name', KEYS.enter);
    expect(await d.handle.result).toBe('new name');

    const e = dialog();
    await e.term.press('x', KEYS.enter);
    // not the field's, and the dialog has no default button: still open, and the
    // key went no further than the panel
    expect(e.handle.open).toBe(true);
    expect(e.reached).toEqual([]);
  });

  it('should still dismiss on Escape with the field focused', async () => {
    const d = dialog({ onSubmit: () => {} });

    await d.term.press(KEYS.escape);
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
    expect(d.handle.open).toBe(false);
    expect(await d.handle.result).toBeUndefined();
  });

  it('should take a paste, and an app handler under the dialog should not see it', async () => {
    const d = dialog();

    await d.term.paste('pasted\nname');
    expect(d.value.get()).toBe('pasted name');
    expect(d.pastes).toEqual([]);
  });
});

/** A key event as the router builds one. */
function keyEvent(key: KeyEvent['key'], paste = false): KeyEvent {
  let stopped = false;
  return {
    current: undefined,
    key,
    paste,
    stop(): void {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    target: undefined,
  };
}
