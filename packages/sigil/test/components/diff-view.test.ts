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
  hunkLinesPatch,
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

    it('should not scroll on a click where the content is drawn again in the same flush', () => {
      const content = new State<DiffViewContent>({ patch: PATCH });
      const current = new State(0);
      const { host, root } = mount({ content, current }, 7);
      picture(root, 30, 7);
      press(host, 'down');
      const before = picture(root, 30, 7);

      // the click, and an app's content that changes with the cursor, before a flush
      rowWith(root, '@@ -20,3 +20,3 @@').onMouse?.(mouse());
      content.set({ patch: PATCH });
      flush();
      expect(current.get()).toBe(1);
      expect(picture(root, 30, 7)[0]).toBe(before[0]);
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

/** One hunk with two edits and a context line between them, and a second hunk after. */
const LINES_PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,4 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '-four',
  '+FOUR',
  '@@ -20,3 +20,3 @@',
  ' twenty',
  '-twenty-one',
  '+TWENTY-ONE',
  ' twenty-two',
  '',
].join('\n');

/** A view with a line cursor, and the states it writes. */
function mountLines(
  props: Partial<DiffViewProps> = {},
  height = 14
): {
  current: State<number>;
  cursor: State<number | undefined>;
  host: Element;
  root: Element;
  selected: State<ReadonlySet<number>>;
} {
  const cursor = new State<number | undefined>(undefined);
  const selected = new State<ReadonlySet<number>>(new Set());
  const current = new State(0);
  const view = mount(
    { content: { patch: LINES_PATCH }, current, lines: { cursor, selected }, ...props },
    height
  );
  // laid out once, which is what gives the view a width to draw at
  picture(view.root, 30, height);
  return { current, cursor, selected, ...view };
}

describe('DiffView lines', () => {
  it('should draw a second column of marks, and take no key until Enter', () => {
    const { cursor, host, root } = mountLines();

    expect(picture(root, 30, 14).slice(2, 9)).toEqual([
      '▌ @@ -1,4 +1,4 @@',
      '▌  one',
      '▌ -two',
      '▌ +TWO',
      '▌  three',
      '▌ -four',
      '▌ +FOUR',
    ]);
    // none of the line keys is claimed outside the lines
    for (const name of ['x', 'a', 'escape']) {
      expect(press(host, name)).toBe(false);
    }
    expect(cursor.get()).toBeUndefined();
  });

  it('should put the cursor on the first changed line with Enter, and mark it', () => {
    const { cursor, host, root } = mountLines();

    expect(press(host, 'enter')).toBe(true);
    expect(cursor.get()).toBe(1);
    expect(picture(root, 30, 14).slice(3, 9)).toEqual([
      '▌  one',
      '▌▶-two',
      '▌ +TWO',
      '▌  three',
      '▌ -four',
      '▌ +FOUR',
    ]);
  });

  it('should step the cursor over changed lines only, and claim the key at an end', () => {
    const { cursor, host } = mountLines();
    press(host, 'enter');

    const seen: (number | undefined)[] = [];
    for (const name of ['down', 'down', 'down', 'down', 'down', 'up', 'up', 'up', 'up', 'up']) {
      expect(press(host, name)).toBe(true);
      seen.push(cursor.get());
    }
    // line 3 is context and is stepped over, both ways, and the ends hold
    expect(seen).toEqual([2, 4, 5, 5, 5, 4, 2, 1, 1, 1]);
  });

  it('should pick lines with x, all of them with a, and show both with the cursor', () => {
    const { cursor, host, root, selected } = mountLines();
    press(host, 'enter');

    press(host, 'x');
    expect([...selected.get()]).toEqual([1]);
    expect(picture(root, 30, 14).slice(4, 6)).toEqual(['▌◉-two', '▌ +TWO']);

    press(host, 'down');
    expect(picture(root, 30, 14).slice(4, 6)).toEqual(['▌●-two', '▌▶+TWO']);

    press(host, 'x');
    press(host, 'x');
    expect([...selected.get()]).toEqual([1]);

    press(host, 'a');
    expect([...selected.get()].sort()).toEqual([1, 2, 4, 5]);
    press(host, 'a');
    expect([...selected.get()]).toEqual([]);
    expect(cursor.get()).toBe(2);
  });

  it('should pick a range of added and removed lines with v and the arrows', () => {
    const { cursor, host, root, selected } = mountLines();
    press(host, 'enter');

    // the range is the line it began on to begin with
    expect(press(host, 'v')).toBe(true);
    expect([...selected.get()]).toEqual([1]);
    press(host, 'down');
    expect([...selected.get()].sort()).toEqual([1, 2]);
    expect(picture(root, 30, 14).slice(4, 6)).toEqual(['▌●-two', '▌◉+TWO']);

    // back up past the end of it, which takes the line off again
    press(host, 'up');
    expect([...selected.get()]).toEqual([1]);
    expect(cursor.get()).toBe(1);
  });

  it('should pick a range across an unchanged line, without picking the line', () => {
    const { cursor, host, selected } = mountLines();
    press(host, 'enter');
    press(host, 'v');
    for (const _ of [1, 2, 3, 4]) {
      press(host, 'down');
    }

    // `three` is line 3 of the hunk and has nothing to pick
    expect(cursor.get()).toBe(5);
    expect([...selected.get()].sort()).toEqual([1, 2, 4, 5]);

    // and upward from an anchor below the cursor, the same range the other way
    const up = mountLines();
    press(up.host, 'enter');
    for (const _ of [1, 2, 3]) {
      press(up.host, 'down');
    }
    press(up.host, 'v');
    press(up.host, 'up');
    press(up.host, 'up');
    press(up.host, 'up');
    expect([...up.selected.get()].sort()).toEqual([1, 2, 4, 5]);
    expect(up.cursor.get()).toBe(1);
  });

  it('should keep what was picked before a range, and what a closed range picked', () => {
    const { cursor, host, selected } = mountLines();
    press(host, 'enter');
    press(host, 'x');
    press(host, 'down');
    press(host, 'down');
    expect(cursor.get()).toBe(4);
    // a range from the line after, over the line already picked
    press(host, 'v');
    press(host, 'down');
    expect([...selected.get()].sort()).toEqual([1, 4, 5]);

    // v again closes it: moving no longer picks, and the picks stay
    press(host, 'v');
    press(host, 'up');
    expect(cursor.get()).toBe(4);
    expect([...selected.get()].sort()).toEqual([1, 4, 5]);
  });

  it('should end a range with x, a or leaving the lines, and extend nothing after', () => {
    for (const end of ['x', 'a', 'escape']) {
      const { cursor, host, selected } = mountLines();
      press(host, 'enter');
      press(host, 'v');
      press(host, 'down');
      press(host, end);
      if (end === 'escape') {
        press(host, 'enter');
      }
      const before = [...selected.get()].sort();
      press(host, 'down');
      expect(cursor.get()).toBe(end === 'escape' ? 2 : 4);
      expect([...selected.get()].sort()).toEqual(before);
    }
  });

  it('should end a range an app wrote the cursor or the picks out from under', () => {
    const moved = mountLines();
    press(moved.host, 'enter');
    press(moved.host, 'v');
    moved.cursor.set(5);
    flush();
    press(moved.host, 'up');
    // no anchor: the cursor moved on its own and nothing was picked from the old one
    expect([...moved.selected.get()]).toEqual([1]);

    const cleared = mountLines();
    press(cleared.host, 'enter');
    press(cleared.host, 'x');
    press(cleared.host, 'down');
    press(cleared.host, 'down');
    press(cleared.host, 'v');
    cleared.selected.set(new Set());
    flush();
    press(cleared.host, 'down');
    // what the app emptied stays empty
    expect([...cleared.selected.get()]).toEqual([]);
  });

  it('should end a range with a click on another line of the hunk', () => {
    const { cursor, host, root, selected } = mountLines();
    press(host, 'enter');
    press(host, 'v');
    // a click on `+FOUR`, which is the cursor's from then on and picks nothing more
    clickRow(root, '+FOUR');
    expect(cursor.get()).toBe(5);
    const before = [...selected.get()].sort();
    press(host, 'up');
    expect([...selected.get()].sort()).toEqual(before);
  });

  it('should leave the lines with Enter or Escape, dropping the picks', () => {
    for (const name of ['enter', 'escape']) {
      const { cursor, host, root, selected } = mountLines();
      press(host, 'enter');
      press(host, 'x');

      expect(press(host, name)).toBe(true);
      expect(cursor.get()).toBeUndefined();
      expect(selected.get().size).toBe(0);
      expect(picture(root, 30, 14).slice(3, 6)).toEqual(['▌  one', '▌ -two', '▌ +TWO']);
    }
  });

  it('should leave the lines on a move to another hunk, which the picks belong to', () => {
    const { current, cursor, host, selected } = mountLines();
    press(host, 'enter');
    press(host, 'x');

    expect(press(host, ']')).toBe(true);
    expect(current.get()).toBe(1);
    expect(cursor.get()).toBeUndefined();
    expect(selected.get().size).toBe(0);
  });

  it('should start on the new hunk with Enter, with picks of its own', () => {
    const { current, cursor, host, selected } = mountLines();
    press(host, ']');
    press(host, 'enter');
    press(host, 'x');

    expect(current.get()).toBe(1);
    expect(cursor.get()).toBe(1);
    expect([...selected.get()]).toEqual([1]);
  });

  it('should drop the picks when the content changes, for the hunks are others', () => {
    const content = new State<DiffViewContent>({ patch: LINES_PATCH });
    const { cursor, host, selected } = mountLines({ content });
    press(host, 'enter');
    press(host, 'x');

    content.set({ patch: LINES_PATCH });
    flush();
    expect(cursor.get()).toBeUndefined();
    expect(selected.get().size).toBe(0);
  });

  it('should keep the lines through a redraw of the same content, a width or a wrap switch', () => {
    const { cursor, host, root, selected } = mountLines();
    picture(root, 30, 14);
    press(host, 'enter');
    press(host, 'x');

    picture(root, 24, 14);
    press(host, 'w');
    picture(root, 40, 14);
    expect(cursor.get()).toBe(1);
    expect([...selected.get()]).toEqual([1]);
    expect(picture(root, 40, 14).slice(4, 5)).toEqual(['▌◉-two']);
  });

  it('should bring a cursor an app wrote to the nearest changed line, or to none', () => {
    const { cursor, host, root } = mountLines();
    press(host, 'enter');

    cursor.set(3);
    flush();
    expect(cursor.get()).toBe(2);
    cursor.set(99);
    flush();
    expect(cursor.get()).toBe(5);
    cursor.set(-4);
    flush();
    expect(cursor.get()).toBe(1);
    expect(picture(root, 30, 14).filter((row) => row.includes('▶'))).toEqual(['▌▶-two']);
  });

  it('should give a cursor on prose or a hunk with no changes nowhere to be', () => {
    const blocks: DiffBlock[] = [
      { stop: true, text: 'logo.png: binary' },
      { diff: { patch: LINES_PATCH } },
    ];
    const { cursor, host, selected } = mountLines({ content: blocks });

    // the first stop is prose, and Enter is not the cursor's there
    expect(press(host, 'enter')).toBe(false);
    cursor.set(1);
    flush();
    expect(cursor.get()).toBeUndefined();
    expect(selected.get().size).toBe(0);
  });

  it('should move the cursor with a click on a line of the current hunk, in the lines', () => {
    const { current, cursor, host, root } = mountLines();

    // not in the lines: the click is the hunk's, as it was
    clickRow(root, '+TWO');
    expect(cursor.get()).toBeUndefined();

    press(host, 'enter');
    clickRow(root, '+FOUR');
    expect(cursor.get()).toBe(5);
    clickRow(root, ' one');
    // a context line is no place for it
    expect(cursor.get()).toBe(5);

    // another hunk is made current, and the lines are left
    clickRow(root, '-twenty-one');
    expect(current.get()).toBe(1);
    expect(cursor.get()).toBeUndefined();
  });

  it('should scroll the cursor into view as it steps', () => {
    const many = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,12 +1,12 @@',
      ...Array.from({ length: 6 }, (_, at) => ` c${at}`),
      '-last',
      '+LAST',
      ...Array.from({ length: 4 }, (_, at) => ` d${at}`),
      '',
    ].join('\n');
    // two changed lines at the bottom of a hunk taller than the view
    const { cursor, host, root } = mountLines({ content: { patch: many } }, 6);
    picture(root, 30, 6);

    press(host, 'enter');
    expect(cursor.get()).toBe(6);
    expect(picture(root, 30, 6).some((row) => row.includes('▶-last'))).toBe(true);
    press(host, 'down');
    expect(picture(root, 30, 6).some((row) => row.includes('▶+LAST'))).toBe(true);
  });

  it('should draw unified whatever layout it is asked for, since a cursor is on one line', () => {
    const { host, root } = mountLines({ layout: 'side-by-side' });
    press(host, 'enter');

    const rows = picture(root, 100, 14);
    expect(rows.some((row) => row.includes('│'))).toBe(false);
    expect(rows).toContain('▌▶-two');
  });

  it('should mark the lines in ASCII, which colour level 0 is left with', () => {
    const { host, root } = mountLines({ ascii: true });
    press(host, 'enter');
    press(host, 'x');
    press(host, 'down');
    expect(picture(root, 30, 14).slice(4, 6)).toEqual(['>*-two', '>>+TWO']);

    press(host, 'up');
    expect(picture(root, 30, 14).slice(4, 5)).toEqual(['>@-two']);
  });

  it('should leave Enter, x and a alone in a view with no lines', () => {
    const { host } = mount({ content: { patch: LINES_PATCH } }, 14);

    for (const name of ['enter', 'x', 'a', 'escape']) {
      expect(press(host, name)).toBe(false);
    }
  });

  it('should stage what was picked, through the stop under the cursor', () => {
    const content: DiffViewContent = { patch: LINES_PATCH };
    const { current, host, selected } = mountLines({ content });
    press(host, 'enter');
    press(host, 'x');
    press(host, 'down');
    press(host, 'down');
    press(host, 'down');
    press(host, 'x');

    const stop = diffStops(content)[current.get()]!;
    // the first replacement's removed line and the second's added line
    expect([...selected.get()]).toEqual([1, 5]);
    expect(hunkLinesPatch(stop.file!, stop.hunk!, selected.get())).toContain(
      '@@ -1,4 +1,4 @@\n one\n-two\n three\n four\n+FOUR\n'
    );
  });

  it('should settle a cursor written before the first drawing, once there are lines', () => {
    const cursor = new State<number | undefined>(0);
    const selected = new State<ReadonlySet<number>>(new Set());
    const { root } = mount({ content: { patch: LINES_PATCH }, lines: { cursor, selected } }, 14);

    picture(root, 30, 14);
    flush();
    // line 0 is context, so the first changed line is the nearest
    expect(cursor.get()).toBe(1);
    expect(picture(root, 30, 14).some((row) => row.includes('▶-two'))).toBe(true);
  });

  it('should drop the picks when the cursor leaves the lines any way at all', () => {
    const { cursor, host, root, selected } = mountLines();
    press(host, 'enter');
    press(host, 'x');

    cursor.set(undefined);
    flush();
    expect(selected.get().size).toBe(0);
    expect(picture(root, 30, 14).some((row) => row.includes('●'))).toBe(false);
  });

  it('should leave a key with Shift to the app, as the arrows are left', () => {
    const { host, selected } = mountLines();
    press(host, 'enter');

    expect(press(host, 'x', { shift: true })).toBe(false);
    expect(selected.get().size).toBe(0);
  });

  it('should take the room for two marks off every row, wrapping a line one cell sooner', () => {
    const patch = ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', `+${'y'.repeat(28)}`, ''].join('\n');
    const rows = (props: Partial<DiffViewProps>): number =>
      picture(mount({ content: { patch }, ...props }, 8).root, 30, 8).filter((row) =>
        row.includes('y')
      ).length;

    expect(rows({})).toBe(1);
    expect(
      rows({
        lines: {
          cursor: new State<number | undefined>(undefined),
          selected: new State<ReadonlySet<number>>(new Set()),
        },
      })
    ).toBe(2);
  });

  it('should keep the cursor in view when a redraw reveals the hunk, which is taller than the view', () => {
    const body = Array.from({ length: 30 }, (_, at) => [`-old${at}`, `+new${at}`]).flat();
    const patch = ['--- a/f', '+++ b/f', '@@ -1,30 +1,30 @@', ...body, ''].join('\n');
    const { host, root } = mountLines({ content: { patch } }, 8);
    press(host, 'enter');
    for (let at = 0; at < 20; at++) {
      press(host, 'down');
    }
    expect(picture(root, 30, 8).some((row) => row.includes('▶'))).toBe(true);

    // another width draws every row again, and the hunk is shown from its start
    expect(picture(root, 24, 8).some((row) => row.includes('▶'))).toBe(true);
    press(host, 'w');
    expect(picture(root, 30, 8).some((row) => row.includes('▶'))).toBe(true);
  });

  it('should refuse lines that are not two States', () => {
    expect(() => DiffView({ content: { patch: LINES_PATCH }, lines: {} as never })).toThrow(
      TypeError
    );
  });
});
