import { strip } from '../../src/ansi/index.js';
import {
  describeDiffView,
  DiffView,
  type DiffViewPosition,
  type DiffViewProps,
} from '../../src/components/diff-view.js';
import {
  type DiffBlock,
  type DiffViewContent,
  diffHunks,
  diffStops,
  diffView,
  hunkPatch,
  parsePatch,
} from '../../src/components/diff.js';
import type { Key } from '../../src/components/keys.js';
import { box, type Element, renderToLines } from '../../src/element/index.js';
import {
  createInput,
  type DescribeOptions,
  type KeyEvent,
  type MouseEvent,
} from '../../src/input/index.js';
import { flush, State } from '../../src/signals/index.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The diff view: `diffView()` in a scroll box, sized by it, with a cursor on the
 * hunks. Driven through the handlers a router would call, and drawn with
 * `renderToLines()`, which lays out and dispatches the resize the view draws from.
 * `ascii: false` everywhere, so the machine running this cannot choose the mark.
 */

/** The view as it is drawn, as rows: no colour and no trailing blanks. */
function picture(root: Element, width: number, height: number): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel: 0, height, width }).map(
    (line) => strip(line).trimEnd()
  );
}

/** A view in a box of a fixed height, which is what a pane gives it. */
function mount<T>(props: DiffViewProps<T>, height: number): { host: Element; root: Element } {
  const host = DiffView({
    ascii: false,
    lineNumbers: false,
    scrollbar: false,
    ...props,
    props: { 'flex-grow': 1, 'min-height': 0 },
  });
  return { host, root: box({ 'flex-direction': 'column', height }, host) };
}

/** A key event as the router builds one, with a record of whether it was stopped. */
function press(host: Element, name: string, mods: Partial<Key> = {}, paste = false): boolean {
  let stopped = false;
  const key: Key = { ctrl: false, meta: false, name, sequence: '', shift: false, ...mods };
  const event: KeyEvent = {
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
  host.onKey?.(event);
  flush();
  return stopped;
}

/** Two hunks in one file, far enough apart to stay two. */
const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -20,3 +20,3 @@',
  ' twenty',
  '-twenty-one',
  '+TWENTY-ONE',
  ' twenty-two',
  '',
].join('\n');

/** A mouse report as the router delivers one, with a record of whether it was stopped. */
function mouse(
  kind: MouseEvent['kind'] = 'click',
  button: MouseEvent['button'] = 'left'
): MouseEvent & { claimed: () => boolean } {
  let stopped = false;
  return {
    button,
    claimed: () => stopped,
    ctrl: false,
    current: undefined,
    kind,
    meta: false,
    shift: false,
    stop(): void {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    target: undefined,
    wheel: undefined,
    x: 0,
    y: 0,
  };
}

/** Every element under one, itself included. */
function every(at: Element, out: Element[] = []): Element[] {
  out.push(at);
  for (const child of at.children) {
    every(child, out);
  }
  return out;
}

/**
 * The first of the view's rows in view whose text holds a piece of text: the box
 * a click on that row lands on.
 */
function rowWith(root: Element, label: string): Element {
  const found = every(root)
    .filter((e) => e.classes.includes('sigil-diff-view-line'))
    .find((row) =>
      every(row)
        .map((e) => e.text ?? '')
        .join('')
        .includes(label)
    );
  if (!found) {
    throw new Error(`no row ${label}`);
  }
  return found;
}

/** Clicks a row, lets the effects run, and says whether the click was claimed. */
function clickRow(root: Element, label: string): boolean {
  const event = mouse();
  rowWith(root, label).onMouse?.(event);
  flush();
  return event.claimed();
}

/** The rows whose mark is lit. */
function lit(rows: string[]): string[] {
  return rows.filter((row) => row.startsWith('▌')).map((row) => row.slice(1));
}

describe('DiffView', () => {
  it('should draw the diff behind a mark column, with the current hunk marked', () => {
    const { root } = mount({ content: { patch: PATCH } }, 14);

    expect(picture(root, 30, 14)).toEqual([
      ' --- a/a.txt',
      ' +++ b/a.txt',
      '▌@@ -1,3 +1,3 @@',
      '▌ one',
      '▌-two',
      '▌+TWO',
      '▌ three',
      ' @@ -20,3 +20,3 @@',
      '  twenty',
      ' -twenty-one',
      ' +TWENTY-ONE',
      '  twenty-two',
      '',
      '',
    ]);
  });

  it('should mark the current hunk in ASCII as well, which is what colour level 0 is left with', () => {
    const host = DiffView({ ascii: true, content: { patch: PATCH }, lineNumbers: false });
    const rows = picture(box({ 'flex-direction': 'column', height: 14 }, host), 30, 14);

    expect(rows.filter((row) => row.startsWith('>'))).toHaveLength(5);
  });

  it('should draw again when the layout gives the same view another width', () => {
    const long = { new: `${'x'.repeat(40)}\n`, old: `${'y'.repeat(40)}\n` };
    const { root } = mount({ content: long }, 6);

    expect(picture(root, 20, 6).filter((row) => row.includes('y')).length).toBeGreaterThan(1);
    expect(picture(root, 50, 6).filter((row) => row.includes('y'))).toHaveLength(1);
  });

  it('should draw again at the width the layout gives it', () => {
    const long = { new: `${'x'.repeat(40)}\n`, old: `${'y'.repeat(40)}\n` };
    const narrow = picture(mount({ content: long }, 6).root, 20, 6);
    const wide = picture(mount({ content: long }, 6).root, 50, 6);

    // folded to the width less the mark, and not folded where there is room
    expect(narrow.filter((row) => row.includes('y')).length).toBeGreaterThan(1);
    expect(wide.filter((row) => row.includes('y'))).toHaveLength(1);
    expect(Math.max(...narrow.map((row) => row.length))).toBeLessThanOrEqual(20);
  });

  it('should move the cursor with ] and [, and stop at the ends with the key still claimed', () => {
    const current = new State(0);
    const { host, root } = mount({ content: { patch: PATCH }, current }, 14);
    picture(root, 30, 14);

    expect(press(host, ']')).toBe(true);
    expect(current.get()).toBe(1);
    expect(lit(picture(root, 30, 14))[0]).toBe('@@ -20,3 +20,3 @@');
    expect(press(host, ']')).toBe(true);
    expect(current.get()).toBe(1);
    expect(press(host, '[')).toBe(true);
    expect(current.get()).toBe(0);
    expect(press(host, '[')).toBe(true);
    expect(current.get()).toBe(0);
  });

  it('should leave ] and [ alone where there is nothing to move over', () => {
    const { host, root } = mount({ content: [{ text: 'nothing here' }] }, 4);
    picture(root, 30, 4);

    expect(press(host, ']')).toBe(false);
  });

  it('should move the mark when the app writes the cursor', () => {
    const current = new State(0);
    const { root } = mount({ content: { patch: PATCH }, current }, 14);
    picture(root, 30, 14);

    current.set(1);
    flush();
    expect(lit(picture(root, 30, 14))).toEqual([
      '@@ -20,3 +20,3 @@',
      ' twenty',
      '-twenty-one',
      '+TWENTY-ONE',
      ' twenty-two',
    ]);
  });

  describe('the mouse', () => {
    it('should make a clicked hunk current, from its @@ row or any line of it', () => {
      const current = new State(0);
      const { root } = mount({ content: { patch: PATCH }, current }, 14);
      picture(root, 30, 14);

      expect(clickRow(root, '@@ -20,3 +20,3 @@')).toBe(true);
      expect(current.get()).toBe(1);
      expect(lit(picture(root, 30, 14))[0]).toBe('@@ -20,3 +20,3 @@');

      expect(clickRow(root, '-two')).toBe(true);
      expect(current.get()).toBe(0);
      expect(clickRow(root, ' twenty-two')).toBe(true);
      expect(current.get()).toBe(1);
      // the current hunk clicked again is still the view's click
      expect(clickRow(root, '+TWENTY-ONE')).toBe(true);
      expect(current.get()).toBe(1);
    });

    it('should leave a click on a row no stop owns to the pane around it', () => {
      const blocks: DiffBlock[] = [
        { text: 'Unstaged' },
        { diff: { patch: PATCH } },
        { stop: true, text: 'logo.png: binary' },
      ];
      const current = new State(1);
      const { root } = mount({ content: blocks, current }, 20);
      picture(root, 30, 20);

      // a heading, and a file's header, lead into a stop and are not one
      expect(clickRow(root, 'Unstaged')).toBe(false);
      expect(clickRow(root, '+++ b/a.txt')).toBe(false);
      expect(current.get()).toBe(1);
      // prose marked as a stop is one
      expect(clickRow(root, 'logo.png: binary')).toBe(true);
      expect(current.get()).toBe(2);
    });

    it('should take only a left click, so the press still focuses the view', () => {
      const current = new State(0);
      const { root } = mount({ content: { patch: PATCH }, current }, 14);
      picture(root, 30, 14);
      const row = rowWith(root, '+TWENTY-ONE');

      for (const event of [mouse('mousedown'), mouse('mouseup'), mouse('click', 'right')]) {
        row.onMouse?.(event);
        flush();
        expect(event.claimed()).toBe(false);
      }
      expect(current.get()).toBe(0);
    });

    it('should not scroll to a hunk a click made current, which is on screen already', () => {
      const current = new State(0);
      const { host, root } = mount({ content: { patch: PATCH }, current }, 7);
      picture(root, 30, 7);
      // down a row, to where the second hunk's header is the last row in view
      press(host, 'down');
      const before = picture(root, 30, 7);
      expect(before.at(-1)).toBe(' @@ -20,3 +20,3 @@');

      clickRow(root, '@@ -20,3 +20,3 @@');
      expect(current.get()).toBe(1);
      // the same rows, the mark moved onto the one clicked
      expect(picture(root, 30, 7)).toEqual([
        ...before.slice(0, -1).map((row) => row.replace(/^▌/, ' ')),
        '▌@@ -20,3 +20,3 @@',
      ]);

      // where the app writes it, it is brought into view, as before
      current.set(0);
      flush();
      current.set(1);
      flush();
      expect(lit(picture(root, 30, 7))).toHaveLength(5);
    });

    it('should make a hunk current from a click on either half, side by side', () => {
      const current = new State(0);
      const { root } = mount({ content: { patch: PATCH }, current, layout: 'side-by-side' }, 14);
      const rows = picture(root, 80, 14);
      // one row holds both halves of a changed line
      expect(rows.some((row) => row.includes('twenty-one') && row.includes('TWENTY-ONE'))).toBe(
        true
      );

      expect(clickRow(root, 'TWENTY-ONE')).toBe(true);
      expect(current.get()).toBe(1);
      expect(clickRow(root, 'two')).toBe(true);
      expect(current.get()).toBe(0);
    });

    it('should make a hunk current from a click on a row a long line folded onto', () => {
      const long = `${'word '.repeat(12)}end`;
      const current = new State(1);
      const patch = PATCH.replace('-two', `-${long}`);
      const { root } = mount({ content: { patch }, current }, 20);
      const rows = picture(root, 30, 20);
      // the line's last word is on a row of its own, below its first
      expect(rows.find((row) => row.includes('end'))).not.toContain('-');

      expect(clickRow(root, 'end')).toBe(true);
      expect(current.get()).toBe(0);
    });

    it('should focus the view on a press and move the cursor on the click, scrolled', async () => {
      const term = createTestTerminal({ columns: 30, rows: 7 });
      const current = new State(0);
      const { host, root } = mount({ content: { patch: PATCH }, current }, 7);
      picture(root, 30, 7);
      const input = createInput({
        mouse: {
          surface: {
            height: 7,
            locate: async () => true,
            origin: { x: 0, y: 0 },
            toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
            width: 30,
          },
        },
        root,
        terminal: term.terminal,
      });
      // scrolled by four rows, so the screen's row 4 is the view's row 7, the
      // second hunk's header
      for (let i = 0; i < 4; i++) {
        press(host, 'down');
      }
      const rows = picture(root, 30, 7);
      expect(rows[3]).toBe(' @@ -20,3 +20,3 @@');

      await term.press('\x1b[<0;5;4M', '\x1b[<0;5;4m');
      flush();

      expect(input.focus.current.get()).toBe(host);
      expect(current.get()).toBe(1);
      expect(lit(picture(root, 30, 7))[0]).toBe('@@ -20,3 +20,3 @@');
      input.stop();
    });
  });

  it('should scroll the current hunk into view, with what leads into it where it fits', () => {
    const current = new State(0);
    const { root } = mount({ content: { patch: PATCH }, current }, 7);
    // the first hunk and the file's header above it fit, so nothing scrolls
    expect(picture(root, 30, 7)[0]).toBe(' --- a/a.txt');

    // by as little as shows the second
    current.set(1);
    flush();
    expect(picture(root, 30, 7)).toEqual([
      ' +TWO',
      '  three',
      '▌@@ -20,3 +20,3 @@',
      '▌ twenty',
      '▌-twenty-one',
      '▌+TWENTY-ONE',
      '▌ twenty-two',
    ]);

    // back to the first, and the file's header above it is in view again
    current.set(0);
    flush();
    expect(picture(root, 30, 7)[0]).toBe(' --- a/a.txt');
  });

  it('should show a hunk from its own first row where it does not fit with its lead', () => {
    const { root } = mount({ content: { patch: PATCH } }, 5);

    expect(picture(root, 30, 5)).toEqual([
      '▌@@ -1,3 +1,3 @@',
      '▌ one',
      '▌-two',
      '▌+TWO',
      '▌ three',
    ]);
  });

  it('should scroll with the arrows, which it hands to its scroll box', () => {
    const { host, root } = mount({ content: { patch: PATCH } }, 7);
    picture(root, 30, 7);

    expect(press(host, 'down')).toBe(true);
    expect(picture(root, 30, 7)[0]).toBe(' +++ b/a.txt');
  });

  it('should draw again when the content changes, and bring a cursor past the end back', () => {
    const content = new State<DiffViewContent>({ patch: PATCH });
    const current = new State(1);
    const { root } = mount({ content, current }, 14);
    picture(root, 30, 14);

    content.set({ new: 'b\n', old: 'a\n' });
    flush();
    expect(current.get()).toBe(0);
    expect(lit(picture(root, 30, 14))).toEqual(['@@ -1 +1 @@', '-a', '+b']);
  });

  it('should mark the stop diffStops() finds at the cursor, whichever it is', () => {
    const blocks: DiffBlock<string>[] = [
      { text: 'Unstaged' },
      { data: 'patch', diff: { patch: PATCH } },
      { data: 'binary', stop: true, text: 'logo.png: binary' },
      { data: 'texts', diff: { new: 'b\n', old: 'a\n' } },
    ];
    const current = new State(0);
    const { root } = mount({ content: blocks, current }, 30);
    const stops = diffStops(blocks);

    expect(stops).toHaveLength(4);
    for (const [at, stop] of stops.entries()) {
      current.set(at);
      flush();
      const first = lit(picture(root, 30, 30))[0] ?? '';
      // a hunk's own header row, or the prose that is the stop
      expect(first.startsWith(stop.hunk ? `@@ -${stop.hunk.oldStart}` : 'logo.png')).toBe(true);
    }
  });

  it('should bring a cursor that is not a stop to the nearest one', () => {
    for (const [given, settled] of [
      [-1, 0],
      [1.4, 1],
      [7, 1],
    ] as const) {
      const current = new State<number>(given);
      const { root } = mount({ content: { patch: PATCH }, current }, 14);
      picture(root, 30, 14);
      expect(current.get()).toBe(settled);
    }
  });

  it('should bring a cursor the app writes between stops to the nearest, and mark it', () => {
    const current = new State(0);
    const { host, root } = mount({ content: { patch: PATCH }, current }, 14);
    picture(root, 30, 14);

    current.set(-1);
    flush();
    expect(current.get()).toBe(0);
    expect(lit(picture(root, 30, 14))[0]).toBe('@@ -1,3 +1,3 @@');

    current.set(7);
    flush();
    expect(current.get()).toBe(1);
    expect(lit(picture(root, 30, 14))[0]).toBe('@@ -20,3 +20,3 @@');
    // and a key from there steps from the stop it was brought to
    press(host, '[');
    expect(current.get()).toBe(0);

    // a key that arrives before the write was settled goes to the nearest stop, not past it
    current.set(-1);
    press(host, ']');
    expect(current.get()).toBe(0);
  });

  it('should put is-current on the marks of the current stop, for a theme to reach', () => {
    const { host, root } = mount({ content: { patch: PATCH } }, 14);
    picture(root, 30, 14);
    const marks: Element[] = [];
    const walk = (at: Element): void => {
      if (at.classes.includes('sigil-diff-view-mark') && at.classes.includes('is-current')) {
        marks.push(at);
      }
      at.children.forEach(walk);
    };
    walk(host);

    expect(marks).toHaveLength(5);
  });

  it('should draw prose between diffs, and stop on prose marked as a stop', () => {
    const blocks: DiffBlock<string>[] = [
      { class: 'sigil-heading', data: 'heading', text: 'Unstaged' },
      { data: 'patch', diff: { patch: PATCH } },
      { data: 'binary', stop: true, text: 'logo.png: binary' },
    ];
    const current = new State(2);
    const { root } = mount({ content: blocks, current }, 18);
    const rows = picture(root, 30, 18);

    expect(rows[0]).toBe(' Unstaged');
    expect(lit(rows)).toEqual(['logo.png: binary']);
    expect(diffStops(blocks).map((stop) => stop.block.data)).toEqual(['patch', 'patch', 'binary']);
  });

  it('should cut a line of prose at the width rather than wrap it', () => {
    const { root } = mount({ content: [{ text: 'a line that is longer than the view' }] }, 2);

    expect(picture(root, 12, 2)[0]).toBe(' a line tha…');
  });

  describe('a line too long for the view', () => {
    /** 45 columns of words, against a view whose rows hold 18 of them. */
    const LONG = { new: 'alpha beta gamma delta epsilon zeta eta theta\n', old: 'a\n' };

    it('should wrap at words, and keep each line on one row once w is pressed', () => {
      const { host, root } = mount({ content: LONG }, 6);

      expect(picture(root, 20, 6)).toEqual([
        '▌@@ -1 +1 @@',
        '▌-a',
        '▌+alpha beta gamma',
        '▌ delta epsilon zeta',
        '▌ eta theta',
        '',
      ]);
      expect(press(host, 'w')).toBe(true);
      expect(picture(root, 20, 6).slice(0, 3)).toEqual([
        '▌@@ -1 +1 @@',
        '▌-a',
        '▌+alpha beta gamma …',
      ]);
      press(host, 'w');
      expect(picture(root, 20, 6)[4]).toBe('▌ eta theta');
    });

    it('should scroll every line sideways with the arrows, eight columns a press, to the end', () => {
      const { host, root } = mount({ content: LONG, wrap: false }, 4);
      picture(root, 20, 4);

      expect(press(host, 'right')).toBe(true);
      expect(picture(root, 20, 4)[2]).toBe('▌+ta gamma delta ep…');
      press(host, 'right');
      press(host, 'right');
      press(host, 'right');
      // as far as the end of the line, which is then drawn whole
      expect(picture(root, 20, 4)[2]).toBe('▌+lon zeta eta theta');
      // claimed at the end as well, as Home is at the top
      expect(press(host, 'right')).toBe(true);
      expect(picture(root, 20, 4)[2]).toBe('▌+lon zeta eta theta');
      press(host, 'left');
      press(host, 'left');
      press(host, 'left');
      expect(press(host, 'left')).toBe(true);
      expect(picture(root, 20, 4)[2]).toBe('▌+alpha beta gamma …');
    });

    it('should leave the left and right arrows alone while wrapping, and where every line fits', () => {
      const wrapped = mount({ content: LONG }, 4);
      picture(wrapped.root, 20, 4);
      expect(press(wrapped.host, 'right')).toBe(false);

      const short = mount({ content: { new: 'b\n', old: 'a\n' }, wrap: false }, 4);
      picture(short.root, 20, 4);
      expect(press(short.host, 'right')).toBe(false);
      expect(press(short.host, 'left')).toBe(false);
    });

    it('should scroll right as far as the widest line it has shown, and remember it', () => {
      // the long line is the last: not in view until the view has scrolled to it
      const content = { new: `${'short\n'.repeat(10)}${LONG.new}`, old: '' };
      const { host, root } = mount({ content, wrap: false }, 4);
      picture(root, 20, 4);

      // nothing seen runs past the edge: claimed, and nowhere to go
      expect(press(host, 'right')).toBe(true);
      expect(picture(root, 20, 4)[1]).toBe('▌+short');

      press(host, 'end');
      press(host, 'right');
      expect(picture(root, 20, 4)[3]).toBe('▌+ta gamma delta ep…');

      // back among the short lines, what was seen is remembered
      for (let at = 0; at < 8; at++) {
        press(host, 'up');
      }
      // so right goes on from 8 to 16, and one left back is still past the short line
      press(host, 'right');
      press(host, 'left');
      expect(picture(root, 20, 4)[1]).toBe('▌+');
      press(host, 'left');
      expect(picture(root, 20, 4)[1]).toBe('▌+short');
    });

    it('should write where it is scrolled to into a position State', () => {
      const content = { new: `${LONG.new}${'short\n'.repeat(10)}`, old: '' };
      const position = new State<DiffViewPosition>({ maxX: -1, width: -1, x: -1, y: -1 });
      const { host, root } = mount({ content, position, wrap: false }, 4);
      picture(root, 20, 4);
      // the long line is in view: 45 columns against a room of 18
      expect(position.get()).toEqual({ maxX: 27, width: 45, x: 0, y: 0 });

      press(host, 'right');
      picture(root, 20, 4);
      expect(position.get()).toEqual({ maxX: 27, width: 45, x: 8, y: 0 });

      for (let at = 0; at < 4; at++) {
        press(host, 'down');
      }
      picture(root, 20, 4);
      // scrolled past it, and still remembered
      expect(position.get()).toEqual({ maxX: 27, width: 45, x: 8, y: 4 });

      press(host, 'w');
      picture(root, 20, 4);
      expect(position.get()).toMatchObject({ maxX: 0, x: 0 });
    });

    it('should see the rows in view again when the content changes, and come back to them', () => {
      const lines = `${LONG.new}${'short\n'.repeat(10)}`;
      const content = new State<DiffViewContent>({ new: lines, old: '' });
      const position = new State<DiffViewPosition>({ maxX: -1, width: -1, x: -1, y: -1 });
      const { host, root } = mount({ content, position, wrap: false }, 4);
      picture(root, 20, 4);
      press(host, 'right');
      press(host, 'right');
      picture(root, 20, 4);
      expect(position.get()).toEqual({ maxX: 27, width: 45, x: 16, y: 0 });

      // the same lines again, as a refresh hands them, the long one in view: kept
      content.set({ new: lines, old: '' });
      flush();
      picture(root, 20, 4);
      expect(position.get()).toEqual({ maxX: 27, width: 45, x: 16, y: 0 });

      // other lines, the long one out of view: nothing in view has been seen past the
      // edge, so the view comes back to the start rather than carrying another
      // content's width over
      content.set({ new: `${'short\n'.repeat(10)}${LONG.new}`, old: '' });
      flush();
      picture(root, 20, 4);
      expect(position.get()).toEqual({ maxX: 0, width: 5, x: 0, y: 0 });
      expect(picture(root, 20, 4)[1]).toBe('▌+short');
    });

    it('should say how wide the widest line is whatever the width of the view', () => {
      const position = new State<DiffViewPosition>({ maxX: -1, width: -1, x: -1, y: -1 });
      const narrow = mount({ content: LONG, position, wrap: false }, 4);
      picture(narrow.root, 20, 4);
      expect(position.get()).toMatchObject({ maxX: 27, width: 45 });

      const wider = new State<DiffViewPosition>({ maxX: -1, width: -1, x: -1, y: -1 });
      const wide = mount({ content: LONG, position: wider, wrap: false }, 4);
      picture(wide.root, 30, 4);
      // the room is ten columns more, so the limit is ten less; the line is the line
      expect(wider.get()).toMatchObject({ maxX: 17, width: 45 });
    });

    it('should take in the rows a taller view shows, and keep them when it is shorter again', () => {
      const position = new State<DiffViewPosition>({ maxX: -1, width: -1, x: -1, y: -1 });
      const { root } = mount({ content: LONG, position, wrap: false }, 2);
      picture(root, 20, 4);
      // two rows tall: the hunk header and the removed line, and nothing past the edge
      expect(position.get()).toEqual({ maxX: 0, width: 1, x: 0, y: 0 });

      root.setProp('height', 4);
      picture(root, 20, 4);
      expect(position.get()).toEqual({ maxX: 27, width: 45, x: 0, y: 0 });
      root.setProp('height', 2);
      picture(root, 20, 4);
      expect(position.get()).toEqual({ maxX: 27, width: 45, x: 0, y: 0 });
    });

    it('should go back to the start of the lines with Home and End', () => {
      const content = { new: `${LONG.new}${'short\n'.repeat(10)}`, old: '' };
      const position = new State<DiffViewPosition>({ maxX: -1, width: -1, x: -1, y: -1 });
      const { host, root } = mount({ content, position, wrap: false }, 4);
      picture(root, 20, 4);
      press(host, 'right');
      press(host, 'right');

      expect(press(host, 'end')).toBe(true);
      picture(root, 20, 4);
      // twelve rows in a view of four: the bottom is row 8, and the lines from 0
      expect(position.get()).toMatchObject({ x: 0, y: 8 });
      press(host, 'right');
      expect(press(host, 'home')).toBe(true);
      picture(root, 20, 4);
      expect(position.get()).toMatchObject({ x: 0, y: 0 });
      // with no old side the long line is the row under the hunk header
      expect(picture(root, 20, 4)[1]).toBe('▌+alpha beta gamma …');

      // a Home or End inside a paste is the same key, as the scroll box reads it
      press(host, 'right');
      expect(press(host, 'end', {}, true)).toBe(true);
      expect(position.get()).toMatchObject({ x: 0, y: 8 });
    });

    it('should claim Home for the sideways move where there is no room up or down', () => {
      const { host, root } = mount({ content: LONG, wrap: false }, 6);
      picture(root, 20, 6);
      // everything fits: Home is not this view's with nothing to undo
      expect(press(host, 'home')).toBe(false);

      press(host, 'right');
      expect(press(host, 'home')).toBe(true);
      expect(picture(root, 20, 6)[2]).toBe('▌+alpha beta gamma …');
    });

    it('should not scroll sideways while no row is in view', () => {
      // laid out at a width with no height: a view that can see nothing has nowhere
      // to go, whatever the lines it is not showing run to
      const position = new State<DiffViewPosition>({ maxX: -1, width: -1, x: -1, y: -1 });
      const { host, root } = mount({ content: LONG, position, wrap: false }, 0);
      picture(root, 20, 2);

      expect(press(host, 'right')).toBe(true);
      picture(root, 20, 2);
      expect(position.get()).toEqual({ maxX: 0, width: 0, x: 0, y: 0 });
    });

    it('should refuse a position that is not a State', () => {
      expect(() => DiffView({ content: LONG, position: { x: 0 } as never })).toThrow(/State/);
    });

    it('should leave a modified arrow to whoever binds it', () => {
      const { host, root } = mount({ content: LONG, wrap: false }, 4);
      picture(root, 20, 4);

      for (const mods of [{ shift: true }, { ctrl: true }, { meta: true }]) {
        expect(press(host, 'right', mods)).toBe(false);
      }
      expect(picture(root, 20, 4)[2]).toBe('▌+alpha beta gamma …');

      // and Home and End, scrolled sideways, where the scroll box has nothing to do
      const fits = mount({ content: LONG, wrap: false }, 6);
      picture(fits.root, 20, 6);
      press(fits.host, 'right');
      for (const mods of [{ shift: true }, { ctrl: true }, { meta: true }]) {
        expect(press(fits.host, 'home', mods)).toBe(false);
      }
      expect(picture(fits.root, 20, 6)[2]).toBe('▌+ta gamma delta ep…');
    });

    it('should keep the rows where they are when it scrolls sideways', () => {
      const many = {
        new: Array.from({ length: 20 }, (_, at) => `${'x'.repeat(30)} ${at}`).join('\n'),
        old: '',
      };
      const { host, root } = mount({ content: many, lineNumbers: true, wrap: false }, 5);
      picture(root, 24, 5);
      for (let at = 0; at < 8; at++) {
        press(host, 'down');
      }
      const top = picture(root, 24, 5)[0]!.slice(0, 7);

      press(host, 'right');
      // the same line at the top, not the current hunk's header brought back
      expect(picture(root, 24, 5)[0]!.slice(0, 7)).toBe(top);
      expect(top).toMatch(/\d/);
    });

    it('should start the lines from their beginning again when wrapping is switched', () => {
      const { host, root } = mount({ content: LONG, wrap: false }, 4);
      picture(root, 20, 4);
      press(host, 'right');
      press(host, 'w');
      press(host, 'w');

      expect(picture(root, 20, 4)[2]).toBe('▌+alpha beta gamma …');
    });

    it('should take wrap as a State, which w writes and the app writes', () => {
      const wrap = new State(false);
      const { host, root } = mount({ content: LONG, wrap }, 6);
      expect(picture(root, 20, 6)[2]).toBe('▌+alpha beta gamma …');

      wrap.set(true);
      flush();
      expect(picture(root, 20, 6)[3]).toBe('▌ delta epsilon zeta');
      press(host, 'w');
      expect(wrap.get()).toBe(false);
    });

    it('should bring the sideways scroll back when the content narrows', () => {
      const content = new State<DiffViewContent>(LONG);
      const { host, root } = mount({ content, wrap: false }, 4);
      picture(root, 20, 4);
      press(host, 'right');
      press(host, 'right');
      press(host, 'right');

      content.set({ new: 'abcdefghijklmnopqrstuvwxyz\n', old: 'a\n' });
      flush();
      expect(picture(root, 20, 4)[2]).toBe('▌+ijklmnopqrstuvwxyz');
    });

    it('should refuse a wrap that is not a boolean or a State', () => {
      expect(() => DiffView({ content: LONG, wrap: 'yes' as never })).toThrow(/boolean or a State/);
    });
  });

  it('should refuse an onKey in its props, which is its own', () => {
    expect(() =>
      DiffView({ content: { patch: PATCH }, props: { onKey: () => {} } as never })
    ).toThrow(/onKey/);
  });

  it('should refuse a cursor that is not a whole number or a State', () => {
    expect(() => DiffView({ content: { patch: PATCH }, current: 1.5 })).toThrow(/whole number/);
  });
});

describe('diffStops()', () => {
  it('should find every hunk the view draws, in its order, as a patch of its own away', () => {
    const stops = diffStops({ patch: PATCH });

    expect(stops.map((stop) => stop.hunk?.oldStart)).toEqual([1, 20]);
    expect(hunkPatch(stops[1]!.file!, stops[1]!.hunk!)).toBe(
      [
        'diff --git a/a.txt b/a.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -20,3 +20,3 @@',
        ' twenty',
        '-twenty-one',
        '+TWENTY-ONE',
        ' twenty-two',
        '',
      ].join('\n')
    );
  });

  it('should count what diffView() draws, a file with no hunk not at all', () => {
    const patch = `${PATCH}diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n`;

    expect(diffStops({ files: parsePatch(patch) })).toHaveLength(
      diffView({ patch }, { width: 40 }).hunks.length
    );
    expect(diffStops({ patch })).toHaveLength(2);
  });

  it('should count two texts with the default context, as the view draws them', () => {
    const old = Array.from({ length: 20 }, (_, i) => `${i}`).join('\n');
    const next = old.replace('2', 'two').replace('17', 'seventeen');
    const stops = diffStops({ new: next, old });

    // two hunks at the default context, one at ten: the view draws the two
    expect(stops).toHaveLength(2);
    const current = new State(0);
    const { host, root } = mount({ content: { new: next, old }, current }, 30);
    picture(root, 30, 30);
    press(host, ']');
    expect(current.get()).toBe(1);
    const hunk = stops[1]!.hunk!;
    expect(lit(picture(root, 30, 30))[0]).toBe(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    );

    // another context is hunks handed over as files, which both count as they are
    const files = [{ hunks: diffHunks(old, next, { context: 10 }) }];
    expect(diffStops({ files })).toHaveLength(1);
  });
});

describe('describeDiffView()', () => {
  it('should describe the hunk keys and the scroll keys, scoped to the view', () => {
    const said: [string, DescribeOptions][] = [];
    const host = DiffView({ content: { patch: PATCH } });
    const off = describeDiffView(
      {
        describe: (keys, opts) => {
          said.push([keys, opts]);
          return () => {};
        },
      },
      host
    );

    expect(said.map(([keys, opts]) => [keys, opts.description])).toEqual([
      [']', 'next hunk'],
      ['[', 'previous hunk'],
      ['w', 'wrap'],
      ['up', 'scroll'],
      ['down', 'scroll'],
      ['left', 'scroll sideways'],
      ['right', 'scroll sideways'],
    ]);
    expect(said.every(([, opts]) => opts.scope === host)).toBe(true);
    off();
  });

  it('should refuse an element DiffView() did not build', () => {
    expect(() => describeDiffView({ describe: () => () => {} }, box())).toThrow(/DiffView/);
  });
});
