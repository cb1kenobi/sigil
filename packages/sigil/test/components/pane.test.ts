import { strip } from '../../src/ansi/index.js';
import type { Key } from '../../src/components/keys.js';
import { Pane, type PaneProps, paneControl } from '../../src/components/pane.js';
import { Panel } from '../../src/components/panel.js';
import { ScrollBox } from '../../src/components/scroll-box.js';
import {
  box,
  type Element,
  hitTest,
  renderToLines,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import { createInput, type KeyEvent, type MouseEvent } from '../../src/input/index.js';
import type { MouseButton, MouseEventKind } from '../../src/input/mouse.js';
import { flush, State } from '../../src/signals/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A pane: a size in cells, and the edge that moves it.
 *
 * Driven through the handlers the router would call, for the reason
 * `scroll-box.test.ts` gives, with the last block going through a real router --
 * whether a press focuses the edge and a Tab walks past it are questions about the
 * ring and the capture, which a handler called by hand cannot ask.
 *
 * The edge reads its neighbour and its size off the tree a layout placed, so every
 * test lays the tree out before it presses anything, exactly as an app has by the
 * time the pointer is over it.
 */

const ESC = String.fromCharCode(0x1b);

afterEach(() => {
  vi.useRealTimers();
});

/** The tree as it is drawn, as rows: no colour and no trailing blanks. */
function picture(root: Element, width: number, height = 4): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel: 0, height, width }).map(
    (line) => strip(line).trimEnd()
  );
}

/** A mouse event as the router builds one. */
function mouse(
  kind: MouseEventKind,
  x: number,
  y = 0,
  button: MouseButton | undefined = 'left'
): MouseEvent {
  return {
    button,
    ctrl: false,
    current: undefined,
    kind,
    meta: false,
    shift: false,
    stop(): void {},
    stopped: false,
    target: undefined,
    wheel: undefined,
    x,
    y,
  };
}

/** A key event as the router builds one, with a record of whether it was stopped. */
function key(
  name: string,
  mods: Partial<Pick<Key, 'ctrl' | 'meta' | 'shift'>> = {}
): KeyEvent & { claimed: () => boolean } {
  let stopped = false;
  return {
    claimed: () => stopped,
    current: undefined,
    key: {
      ctrl: mods.ctrl ?? false,
      meta: mods.meta ?? false,
      name,
      sequence: '',
      shift: mods.shift ?? false,
    },
    paste: false,
    stop(): void {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    target: undefined,
  };
}

/** The edge of a pane. */
function edgeOf(host: Element): Element {
  const control = paneControl(host);
  if (!control) {
    throw new Error('not a pane');
  }
  return control.edge;
}

/** A pane over a panel, titled so that the edge has a border to sit on. */
function pane(title: string, props: Partial<PaneProps> & { size: PaneProps['size'] }): Element {
  return Pane({ ascii: false, ...props }, Panel({ ascii: false, title }, text(title.slice(0, 1))));
}

/** What fills the room the panes leave. */
function main(): Element {
  return box({ 'flex-grow': 1, 'min-width': 0 }, text('main'));
}

const row = (...children: Element[]): Element => box({ 'flex-direction': 'row' }, ...children);
const column = (...children: Element[]): Element =>
  box({ 'flex-direction': 'column' }, ...children);

/** Presses the edge, moves the pointer to each x in turn, and leaves the button down. */
function dragTo(host: Element, from: number, ...to: number[]): void {
  const edge = edgeOf(host);
  edge.onMouse?.(mouse('mousedown', from));
  for (const x of to) {
    edge.onMouse?.(mouse('mousemove', x));
  }
  flush();
}

function release(host: Element, x: number): void {
  edgeOf(host).onMouse?.(mouse('mouseup', x));
  flush();
}

describe('Pane', () => {
  describe('the size', () => {
    it('should take its size in cells along a row, beside what is left over', () => {
      const root = row(pane('files', { size: 8 }), main(), pane('log', { edge: 'start', size: 8 }));

      expect(picture(root, 30)).toEqual([
        '╭─ f… ─╮main          ╭─ l… ─╮',
        '│ f    │              │ l    │',
        '│      │              │      │',
        '╰──────╯              ╰──────╯',
      ]);
    });

    it('should take its size along a column as a height', () => {
      const top = pane('top', { size: 4 });
      const root = column(top, box({ 'flex-grow': 1 }, text('rest')));

      expect(picture(root, 12, 8)).toEqual([
        '╭─ top ────╮',
        '│ t        │',
        '│          │',
        '╰──────────╯',
        'rest',
        '',
        '',
        '',
      ]);
    });

    it('should read its size from a state, which is where an app keeps it', () => {
      const size = new State(8);
      const files = pane('files', { size });
      const root = row(files, main());

      expect(picture(root, 24)[0]).toBe('╭─ f… ─╮main');

      size.set(14);
      flush();
      expect(picture(root, 24)[0]).toBe('╭─ files ────╮main');
    });

    it('should clamp a size to its limits where it draws and leave the state as it was', () => {
      const size = new State(40);
      const files = pane('files', { max: 12, min: 6, size });
      const root = row(files, main());

      expect(picture(root, 30)[0]).toBe('╭─ files ──╮main');
      expect(size.get()).toBe(40);

      size.set(2);
      flush();
      // six cells is a border with no room for a word, which is plain
      expect(picture(root, 30)[0]).toBe('╭────╮main');
    });

    it('should keep its size when the terminal is resized, and no more than the room there is', () => {
      const files = pane('files', { size: 14 });
      const root = row(files, main());

      expect(picture(root, 40)[0]).toBe('╭─ files ────╮main');
      expect(picture(root, 24)[0]).toBe('╭─ files ────╮main');
      // a pane larger than the whole row has only the row
      expect(picture(root, 10)[0]?.slice(0, 10)).toBe('╭─ fil… ─╮');
      // and is its size again when the room comes back
      expect(picture(root, 40)[0]).toBe('╭─ files ────╮main');
    });

    it('should lay two panes in a column inside a row pane', () => {
      const stack = Pane(
        { ascii: false, size: 12 },
        column(pane('one', { size: 3 }), pane('two', { size: 3 }))
      );
      const root = row(stack, main());

      expect(picture(root, 24, 6)).toEqual([
        '╭─ one ────╮main',
        '│ o        │',
        '╰──────────╯',
        '╭─ two ────╮',
        '│ t        │',
        '╰──────────╯',
      ]);
    });

    it('should grow a pane in an auto-height column, which is as tall as the sizes it holds', () => {
      // the column here is not given a height: it is as tall as its children ask, and
      // a child sized by `flex-basis` is asked about by its content unless the layout
      // reads the basis. The old test passed because each panel's content was
      // exactly three rows, and it never resized anything
      const top = pane('top', { size: 3 });
      const root = row(
        Pane({ ascii: false, size: 12 }, column(top, box({ 'flex-grow': 1 }, text('rest')))),
        main()
      );
      expect(picture(root, 24, 10).slice(0, 5)).toEqual([
        '╭─ top ────╮main',
        '│ t        │',
        '╰──────────╯',
        'rest',
        '',
      ]);

      expect(paneControl(top)?.resize(5)).toBe(5);
      flush();
      expect(picture(root, 24, 10).slice(0, 7)).toEqual([
        '╭─ top ────╮main',
        '│ t        │',
        '│          │',
        '│          │',
        '╰──────────╯',
        'rest',
        '',
      ]);

      // and by the keys, one cell at a time, each laid out before the next
      const down = key('down');
      edgeOf(top).onKey?.(down);
      flush();
      picture(root, 24, 10);
      expect(top.box?.height).toBe(6);
    });

    it('should grow a pane beside a pane in an auto-height column', () => {
      const one = pane('one', { size: 3 });
      const two = pane('two', { size: 3 });
      const root = row(Pane({ ascii: false, size: 12 }, column(one, two)), main());
      picture(root, 24, 10);

      expect(paneControl(one)?.resize(5)).toBe(5);
      flush();
      expect(picture(root, 24, 10).slice(0, 7)).toEqual([
        '╭─ one ────╮main',
        '│ o        │',
        '│          │',
        '│          │',
        '╰──────────╯',
        '╰─ two ────╯',
        '',
      ]);
      expect(paneControl(two)?.size.get()).toBe(1);
    });

    it('should refuse what is not a size', () => {
      expect(() => Pane({ size: '12' as never })).toThrow(
        /size to be a number of cells or a State/
      );
      expect(() => Pane({ size: -1 })).toThrow(/size/);
      expect(() => Pane({ min: -1, size: 5 })).toThrow(/min to be a number of cells/);
      expect(() => Pane({ max: Number.NaN, size: 5 })).toThrow(/max to be a number of cells/);
      expect(() => Pane({ max: 3, min: 5, size: 5 })).toThrow(/max to be at least min/);
      expect(() => Pane({ edge: 'top' as never, size: 5 })).toThrow(/edge to be end or start/);
      expect(() => Pane({ collapsed: 'yes' as never, size: 5 })).toThrow(/collapsed/);
    });
  });

  describe('the edge', () => {
    it('should take no room, and sit on the pane’s own last column', () => {
      const files = pane('files', { size: 12 });
      const root = row(files, main());
      picture(root, 30);

      // the same width with and without it, and one cell, on the pane's last column
      const edge = edgeOf(files).box;
      expect(files.box?.width).toBe(12);
      expect(edge).toMatchObject({ height: 4, width: 1, x: 11, y: 0 });
    });

    it('should sit on the first column of a pane whose edge is its start', () => {
      const log = pane('log', { edge: 'start', size: 8 });
      const root = row(main(), log);
      picture(root, 30);

      expect(edgeOf(log).box).toMatchObject({ height: 4, width: 1, x: log.box?.x });
    });

    it('should be a row of cells on a pane in a column', () => {
      const top = pane('top', { size: 4 });
      const root = column(top, box({ 'flex-grow': 1 }));
      picture(root, 12, 8);

      expect(edgeOf(top).box).toMatchObject({ height: 1, width: 12, y: 3 });
    });

    it('should follow the parent when it turns from a row into a column', () => {
      const files = pane('files', { size: 4 });
      const parent = box({ 'flex-direction': 'row' }, files, main());
      picture(parent, 20, 8);
      expect(edgeOf(files).box).toMatchObject({ height: files.box?.height, width: 1 });

      parent.setProp('flex-direction', 'column');
      picture(parent, 20, 8);
      expect(edgeOf(files).box).toMatchObject({ height: 1, width: 20 });
    });

    it('should draw nothing at rest, so the panel’s own border shows', () => {
      const root = row(pane('files', { size: 12 }), main());

      expect(picture(root, 30)).toEqual([
        '╭─ files ──╮main',
        '│ f        │',
        '│          │',
        '╰──────────╯',
      ]);
    });

    it('should light up under the pointer, over the border it sits on', () => {
      const files = pane('files', { size: 12 });
      const root = row(files, main());
      picture(root, 30);

      edgeOf(files).onMouse?.(mouse('mouseenter', 11, 1, undefined));
      expect(picture(root, 30)).toEqual([
        '╭─ files ──┃main',
        '│ f        ┃',
        '│          ┃',
        '╰──────────┃',
      ]);

      edgeOf(files).onMouse?.(mouse('mouseleave', 12, 1, undefined));
      expect(picture(root, 30)[1]).toBe('│ f        │');
    });

    it('should light up in the accent while it is hot, so a theme can restyle it', () => {
      const files = pane('files', { size: 12 });
      const root = row(files, main());
      picture(root, 30);
      const edge = edgeOf(files);

      expect(edge.classes).not.toContain('sigil-accent');
      edge.onMouse?.(mouse('mouseenter', 11, 1, undefined));
      expect(edge.classes).toContain('sigil-accent');
      expect(edge.classes).toContain('sigil-pane-edge');

      const lines = renderToLines(root, { cascade: themedCascade(), colorLevel: 1, width: 30 });
      expect(lines[1]).toContain(`${ESC}[36m┃`);
    });

    it('should draw a heavy line across a pane in a column, and plain ASCII where it must', () => {
      const top = pane('top', { size: 4 });
      const root = column(top, box({ 'flex-grow': 1 }));
      picture(root, 12, 8);
      edgeOf(top).onMouse?.(mouse('mouseenter', 3, 3, undefined));
      expect(picture(root, 12, 8)[3]).toBe('━━━━━━━━━━━━');

      const flat = Pane({ ascii: true, size: 4 }, text('x'));
      const host = row(flat, main());
      picture(host, 12);
      edgeOf(flat).onMouse?.(mouse('mouseenter', 3, 1, undefined));
      expect(picture(host, 12)).toEqual(['x  |main', '   |', '   |', '   |']);
    });
  });

  describe('a drag', () => {
    it('should resize the pane and let a plain box beside it absorb the difference', () => {
      const files = pane('files', { size: 8 });
      const root = row(files, main());
      picture(root, 30);

      dragTo(files, 7, 9, 11);
      expect(picture(root, 30)).toEqual([
        '╭─ files ──┃main',
        '│ f        ┃',
        '│          ┃',
        '╰──────────┃',
      ]);
      expect(paneControl(files)?.size.get()).toBe(12);

      release(files, 11);
      expect(picture(root, 30)[0]).toBe('╭─ files ──╮main');
    });

    it('should move by how far the pointer went and not to where it is', () => {
      // a press anywhere on a vertical edge is the same column, so what is
      // measured is the distance from the press: a pointer that has not moved has
      // not resized anything, and one that goes and comes back has not either
      const files = pane('files', { size: 8 });
      const root = row(files, main());
      picture(root, 30);

      dragTo(files, 7, 7);
      expect(paneControl(files)?.size.get()).toBe(8);

      dragTo(files, 7, 12, 7);
      expect(paneControl(files)?.size.get()).toBe(8);
    });

    it('should shrink the pane when the pointer goes back', () => {
      const files = pane('files', { min: 4, size: 12 });
      const root = row(files, main());
      picture(root, 30);

      dragTo(files, 11, 9);
      expect(paneControl(files)?.size.get()).toBe(10);

      edgeOf(files).onMouse?.(mouse('mousemove', 5));
      flush();
      expect(paneControl(files)?.size.get()).toBe(6);
    });

    it('should resize a start edge the other way round', () => {
      const log = pane('log', { edge: 'start', min: 4, size: 8 });
      const root = row(main(), log);
      picture(root, 30);
      const from = log.box?.x ?? 0;

      // dragging a start edge to the left makes the pane bigger
      dragTo(log, from, from - 4);
      expect(paneControl(log)?.size.get()).toBe(12);
      expect(picture(root, 30)[0]).toBe('main              ┃─ log ────╮');
    });

    it('should move cells between the pane and a pane beside it', () => {
      const left = pane('files', { size: 10 });
      const right = pane('log', { min: 4, size: 10 });
      const root = row(left, right, main());
      picture(root, 40);

      dragTo(left, 9, 12);
      expect(paneControl(left)?.size.get()).toBe(13);
      expect(paneControl(right)?.size.get()).toBe(7);
      // and the pane that gave them up is too narrow to say its name
      expect(picture(root, 40)[0]).toBe('╭─ files ───┃╭─────╮main');
    });

    it('should stop where the neighbouring pane reaches its minimum', () => {
      const left = pane('files', { size: 10 });
      const right = pane('log', { min: 6, size: 10 });
      const root = row(left, right, main());
      picture(root, 40);

      dragTo(left, 9, 100);
      expect(paneControl(left)?.size.get()).toBe(14);
      expect(paneControl(right)?.size.get()).toBe(6);
    });

    it('should stop where the neighbouring pane reaches its maximum', () => {
      const left = pane('files', { min: 4, size: 10 });
      const right = pane('log', { max: 12, size: 10 });
      const root = row(left, right, main());
      picture(root, 40);

      dragTo(left, 9, -100);
      expect(paneControl(left)?.size.get()).toBe(8);
      expect(paneControl(right)?.size.get()).toBe(12);
    });

    it('should stop where the pane’s own limits are, before the neighbour has to say', () => {
      const files = pane('files', { max: 14, min: 6, size: 10 });
      const root = row(files, main());
      picture(root, 40);

      dragTo(files, 9, 100);
      expect(paneControl(files)?.size.get()).toBe(14);
      dragTo(files, 13, -100);
      expect(paneControl(files)?.size.get()).toBe(6);
    });

    it('should stop where a plain box beside it has nothing left to give', () => {
      const files = pane('files', { size: 10 });
      const rest = box({ 'flex-grow': 1, 'min-width': 0 }, text('main'));
      const root = row(files, rest);
      picture(root, 24);

      // 14 cells are left over, and not one more
      dragTo(files, 9, 500);
      expect(paneControl(files)?.size.get()).toBe(24);
    });

    it('should let a drag go outside the canvas and still end it', () => {
      // the pointer is captured by the press, so x may be anywhere
      const files = pane('files', { size: 8 });
      const root = row(files, main());
      picture(root, 30);

      dragTo(files, 7, 200);
      release(files, 200);
      expect(paneControl(files)?.size.get()).toBe(30);

      // and a move after the release is not a drag
      edgeOf(files).onMouse?.(mouse('mousemove', 3));
      flush();
      expect(paneControl(files)?.size.get()).toBe(30);
    });

    it('should look its neighbour up when the press lands rather than keep the one it had', () => {
      const left = pane('files', { size: 10 });
      const right = pane('log', { min: 4, size: 10 });
      const parent = row(left, main());
      picture(parent, 40);

      // beside a plain box: nothing else moves
      dragTo(left, 9, 11);
      release(left, 11);
      expect(paneControl(left)?.size.get()).toBe(12);
      expect(paneControl(right)?.size.get()).toBe(10);

      // and once a pane is beside it, the next press finds that one
      parent.insertBefore(right, parent.children[1]);
      picture(parent, 40);
      dragTo(left, 11, 13);
      release(left, 13);
      expect(paneControl(left)?.size.get()).toBe(14);
      expect(paneControl(right)?.size.get()).toBe(8);
    });

    it('should skip a sibling that takes no part in the flow', () => {
      const left = pane('files', { size: 10 });
      const overlay = box({ position: 'absolute', top: 0 }, text('!'));
      const right = pane('log', { min: 4, size: 10 });
      const root = row(left, overlay, right, main());
      picture(root, 40);

      dragTo(left, 9, 12);
      expect(paneControl(right)?.size.get()).toBe(7);
    });

    it('should take only the left button', () => {
      const files = pane('files', { size: 8 });
      const root = row(files, main());
      picture(root, 30);

      edgeOf(files).onMouse?.(mouse('mousedown', 7, 0, 'right'));
      edgeOf(files).onMouse?.(mouse('mousemove', 12));
      flush();
      expect(paneControl(files)?.size.get()).toBe(8);
    });

    it('should write the state an app handed it', () => {
      const size = new State(8);
      const files = pane('files', { size });
      const root = row(files, main());
      picture(root, 30);

      dragTo(files, 7, 10);
      expect(size.get()).toBe(11);
    });
  });

  describe('the keys', () => {
    function arrows(props: Partial<PaneProps> = {}) {
      const files = pane('files', { min: 4, size: 12, ...props });
      const root = row(files, main());
      picture(root, 40);
      const press = (name: string, mods: Parameters<typeof key>[1] = {}) => {
        const event = key(name, mods);
        edgeOf(files).onKey?.(event);
        flush();
        picture(root, 40);
        return event.claimed();
      };
      return { files, press, size: () => paneControl(files)?.size.get() };
    }

    it('should move the edge a cell with an arrow', () => {
      const { press, size } = arrows();

      expect(press('right')).toBe(true);
      expect(size()).toBe(13);
      expect(press('left')).toBe(true);
      expect(press('left')).toBe(true);
      expect(size()).toBe(11);
    });

    it('should move it five with Shift', () => {
      const { press, size } = arrows();

      press('right', { shift: true });
      expect(size()).toBe(17);
      press('left', { shift: true });
      press('left', { shift: true });
      expect(size()).toBe(7);
    });

    it('should move the edge, not the pane, on a start edge', () => {
      const log = pane('log', { edge: 'start', min: 4, size: 12 });
      const root = row(main(), log);
      picture(root, 40);

      // the edge is the pane's left, so moving it left makes the pane larger
      edgeOf(log).onKey?.(key('left'));
      expect(paneControl(log)?.size.get()).toBe(13);
      edgeOf(log).onKey?.(key('right', { shift: true }));
      expect(paneControl(log)?.size.get()).toBe(8);
    });

    it('should use the vertical arrows on a pane in a column', () => {
      const top = pane('top', { min: 2, size: 4 });
      const root = column(top, box({ 'flex-grow': 1 }));
      picture(root, 12, 12);

      const left = key('left');
      edgeOf(top).onKey?.(left);
      expect(left.claimed()).toBe(false);

      edgeOf(top).onKey?.(key('down'));
      expect(paneControl(top)?.size.get()).toBe(5);
      edgeOf(top).onKey?.(key('up', { shift: true }));
      expect(paneControl(top)?.size.get()).toBe(2);
    });

    it('should clamp to the limits like a drag', () => {
      const { press, size } = arrows({ max: 14, min: 10 });

      press('right', { shift: true });
      expect(size()).toBe(14);
      press('left', { shift: true });
      press('left', { shift: true });
      expect(size()).toBe(10);
    });

    it('should leave a key that is not for it, and a modified arrow, to whatever is around', () => {
      const { press, size } = arrows();

      expect(press('up')).toBe(false);
      expect(press('a')).toBe(false);
      expect(press('right', { ctrl: true })).toBe(false);
      expect(press('left', { meta: true })).toBe(false);
      expect(size()).toBe(12);
    });

    it('should give a pane beside it the cells it takes', () => {
      const left = pane('files', { size: 10 });
      const right = pane('log', { min: 4, size: 10 });
      const root = row(left, right, main());
      picture(root, 40);

      edgeOf(left).onKey?.(key('right', { shift: true }));
      expect(paneControl(left)?.size.get()).toBe(15);
      expect(paneControl(right)?.size.get()).toBe(5);
    });
  });

  describe('collapsing', () => {
    function collapsing(props: Partial<PaneProps> = {}) {
      const left = pane('files', { collapsible: true, min: 8, size: 12, ...props });
      const root = row(left, main());
      picture(root, 30);
      return { control: paneControl(left)!, left, root };
    }

    it('should take a collapsible pane to zero cells and keep its edge', () => {
      const { control, root } = collapsing();

      control.collapse();
      flush();
      // the edge is on the cell beside the boundary, muted, so it can be found
      expect(picture(root, 30)).toEqual(['│ain', '│', '│', '│']);
      expect(control.collapsed.get()).toBe(true);
      // and the size it had is kept
      expect(control.size.get()).toBe(12);
    });

    it('should open as it was', () => {
      const { control, root } = collapsing();

      control.collapse();
      flush();
      picture(root, 30);
      control.expand();
      flush();
      expect(picture(root, 30)[0]).toBe('╭─ files ──╮main');
    });

    it('should toggle', () => {
      const { control } = collapsing();

      control.toggle();
      expect(control.collapsed.get()).toBe(true);
      control.toggle();
      expect(control.collapsed.get()).toBe(false);
    });

    it('should collapse on a double-click on the edge and open on the next', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const { control, left, root } = collapsing();
      const edge = edgeOf(left);

      edge.onMouse?.(mouse('click', 11));
      expect(control.collapsed.get()).toBe(false);
      vi.advanceTimersByTime(150);
      edge.onMouse?.(mouse('click', 11));
      flush();
      expect(control.collapsed.get()).toBe(true);

      // and the pair is spent: a third click is the first of the next
      picture(root, 30);
      vi.advanceTimersByTime(150);
      edge.onMouse?.(mouse('click', 0));
      expect(control.collapsed.get()).toBe(true);
      vi.advanceTimersByTime(150);
      edge.onMouse?.(mouse('click', 0));
      flush();
      expect(control.collapsed.get()).toBe(false);
    });

    it('should not take two slow clicks for a double-click', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const { control, left } = collapsing();

      edgeOf(left).onMouse?.(mouse('click', 11));
      vi.advanceTimersByTime(600);
      edgeOf(left).onMouse?.(mouse('click', 11));
      expect(control.collapsed.get()).toBe(false);
    });

    it('should not take the click that ends a drag for half of a double-click', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const { control, left } = collapsing();

      // a drag that comes back to the edge it started on is a release on the edge,
      // which is a click on it
      dragTo(left, 11, 13, 11);
      release(left, 11);
      edgeOf(left).onMouse?.(mouse('click', 11));
      vi.advanceTimersByTime(100);
      edgeOf(left).onMouse?.(mouse('click', 11));
      expect(control.collapsed.get()).toBe(false);
    });

    it('should toggle on Enter and Space', () => {
      const { control, left } = collapsing();

      const enter = key('enter');
      edgeOf(left).onKey?.(enter);
      expect(enter.claimed()).toBe(true);
      expect(control.collapsed.get()).toBe(true);
      edgeOf(left).onKey?.(key('space'));
      expect(control.collapsed.get()).toBe(false);
    });

    it('should open a collapsed pane with the arrow that makes it bigger', () => {
      const { control, left } = collapsing();

      control.collapse();
      edgeOf(left).onKey?.(key('left'));
      expect(control.collapsed.get()).toBe(true);
      edgeOf(left).onKey?.(key('right'));
      expect(control.collapsed.get()).toBe(false);
      expect(control.size.get()).toBe(12);
    });

    it('should collapse when a drag takes it below half its minimum', () => {
      const { control, left, root } = collapsing();

      dragTo(left, 11, 8);
      expect(control.collapsed.get()).toBe(false);
      expect(control.size.get()).toBe(9);

      // min is 8, so under 4 is shut and 4 to 8 is the minimum
      edgeOf(left).onMouse?.(mouse('mousemove', 4));
      flush();
      expect(control.size.get()).toBe(8);
      expect(control.collapsed.get()).toBe(false);
      edgeOf(left).onMouse?.(mouse('mousemove', 2));
      flush();
      expect(control.collapsed.get()).toBe(true);
      // lit while it is held, and at rest once it is let go
      expect(picture(root, 30)[0]).toBe('┃ain');
      release(left, 2);
      expect(picture(root, 30)[0]).toBe('│ain');
    });

    it('should be dragged back open from its edge', () => {
      const { control, left, root } = collapsing();
      control.collapse();
      flush();
      picture(root, 30);

      // the edge is on the neighbour's first cell
      dragTo(left, 0, 3);
      expect(control.collapsed.get()).toBe(true);
      edgeOf(left).onMouse?.(mouse('mousemove', 10));
      flush();
      expect(control.collapsed.get()).toBe(false);
      expect(control.size.get()).toBe(10);
      expect(picture(root, 30)[0]).toBe('╭─ fil… ─┃main');
    });

    it('should hand a collapsed pane’s cells to a pane beside it, and take them back', () => {
      const left = pane('files', { collapsible: true, min: 4, size: 12 });
      const right = pane('log', { min: 4, size: 10 });
      const root = row(left, right, main());
      picture(root, 40);

      paneControl(left)?.collapse();
      flush();
      expect(paneControl(right)?.size.get()).toBe(22);

      picture(root, 40);
      paneControl(left)?.expand();
      flush();
      expect(paneControl(left)?.size.get()).toBe(12);
      expect(paneControl(right)?.size.get()).toBe(10);
    });

    it('should leave a pane that is not collapsible as it is', () => {
      const files = pane('files', { size: 12 });
      const root = row(files, main());
      picture(root, 30);

      paneControl(files)?.collapse();
      paneControl(files)?.toggle();
      edgeOf(files).onKey?.(key('enter'));
      expect(paneControl(files)?.collapsed.get()).toBe(false);
      expect(picture(root, 30)[0]).toBe('╭─ files ──╮main');
    });

    it('should start collapsed, from a state an app keeps', () => {
      const shut = new State(true);
      const files = pane('files', { collapsed: shut, collapsible: true, size: 12 });
      const root = row(files, main());

      expect(picture(root, 30)[0]).toBe('│ain');
      shut.set(false);
      flush();
      expect(picture(root, 30)[0]).toBe('╭─ files ──╮main');
    });

    it('should put the edge on the other side of a collapsed start pane', () => {
      const log = pane('log', { collapsible: true, edge: 'start', size: 8 });
      const root = row(main(), log);
      picture(root, 30);

      paneControl(log)?.collapse();
      flush();
      // on the last cell of what is beside it, and not off the screen
      expect(picture(root, 30)).toEqual([
        `main${' '.repeat(25)}│`,
        `${' '.repeat(29)}│`,
        `${' '.repeat(29)}│`,
        `${' '.repeat(29)}│`,
      ]);
    });
  });

  describe('resize()', () => {
    it('should take the pane to a size and answer what it took', () => {
      const files = pane('files', { max: 20, min: 6, size: 10 });
      const root = row(files, main());
      picture(root, 40);
      const control = paneControl(files)!;

      expect(control.resize(14)).toBe(14);
      expect(control.size.get()).toBe(14);
      expect(control.resize(99)).toBe(20);
      expect(control.resize(2)).toBe(6);
    });

    it('should work before anything has been laid out', () => {
      const control = paneControl(pane('files', { max: 20, min: 6, size: 10 }))!;

      expect(control.resize(15)).toBe(15);
      expect(control.resize(1)).toBe(6);
    });

    it('should give a pane beside it what it takes, and stop where that pane stops', () => {
      const left = pane('files', { size: 10 });
      const right = pane('log', { min: 4, size: 10 });
      const root = row(left, right, main());
      picture(root, 40);

      expect(paneControl(left)?.resize(13)).toBe(13);
      expect(paneControl(right)?.size.get()).toBe(7);
      picture(root, 40);
      expect(paneControl(left)?.resize(40)).toBe(16);
      expect(paneControl(right)?.size.get()).toBe(4);
    });

    it('should refuse what is not a number', () => {
      const control = paneControl(pane('files', { size: 10 }))!;

      expect(() => control.resize('12' as never)).toThrow(/number of cells/);
      expect(() => control.resize(Number.NaN)).toThrow(/number of cells/);
    });
  });

  describe('as a component', () => {
    it('should be reached through paneControl() by the element it returned', () => {
      const files = pane('files', { size: 8 });

      expect(paneControl(files)).toBeDefined();
      expect(paneControl(text('x'))).toBeUndefined();
      expect(paneControl(edgeOf(files))).toBeUndefined();
    });

    it('should take its content as arguments or as children, which is how a template hands it over', () => {
      const asChildren = Pane({ ascii: false, children: text('a'), size: 6 });
      const asArguments = Pane({ ascii: false, size: 6 }, text('a'));

      expect(picture(row(asChildren, main()), 12)).toEqual(picture(row(asArguments, main()), 12));
      expect(picture(row(asChildren, main()), 12)[0]).toBe('a     main');
    });

    it('should clip its content at its own size', () => {
      const files = Pane(
        { ascii: false, size: 6 },
        text('abcdefghij', { 'white-space': 'nowrap' })
      );

      expect(picture(row(files, main()), 20)[0]).toBe('abcdefmain');
    });

    it('should carry the classes a theme writes against', () => {
      const files = Pane({ class: 'sidebar', size: 6 }, text('a'));

      expect(files.classes).toEqual(expect.arrayContaining(['sidebar', 'sigil-pane']));
      expect(files.children.map((child) => child.classes[0])).toEqual([
        'sigil-pane-body',
        'sigil-pane-edge',
      ]);
    });
  });

  describe('through a router', () => {
    /** A terminal whose stdin is a TTY nothing is typing on. */
    function harness(): { feed: (chunk: string) => void; terminal: Terminal } {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const stdin = {
        isTTY: true,
        off(event: string, fn: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(fn);
          return this;
        },
        on(event: string, fn: (...args: unknown[]) => void) {
          listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
          return this;
        },
        pause() {
          return this;
        },
        resume() {
          return this;
        },
        setEncoding() {
          return this;
        },
        setRawMode() {
          return this;
        },
      };
      const sink = { isTTY: true, write: () => true };
      const terminal = createTerminal({
        env: {},
        isTTY: true,
        proc: { on() {}, pid: 1, removeListener() {} } as never,
        stderr: sink as never,
        stdin: stdin as never,
        stdout: sink as never,
      });

      return {
        feed(chunk: string) {
          for (const fn of listeners.get('data') ?? []) {
            fn(chunk);
          }
        },
        terminal,
      };
    }

    const sgr = (cb: number, column: number, final = 'M') => `${ESC}[<${cb};${column};1${final}`;

    function app() {
      const { feed, terminal } = harness();
      const files = pane('files', { size: 8 });
      const field = box({ focusable: true }, text('field'));
      const root = row(field, files, main());
      picture(root, 30);
      const input = createInput({
        mouse: {
          motion: true,
          surface: {
            height: 4,
            async locate() {
              return true;
            },
            origin: { x: 0, y: 0 },
            toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
            width: 30,
          },
        },
        root,
        terminal,
      });
      return { feed, field, files, input, root };
    }

    it('should resize from a press, a drag and a release', () => {
      const { feed, files, input, root } = app();
      // the edge is on column 7 of the canvas
      const at = (files.box?.x ?? 0) + 7;

      feed(sgr(0, at + 1));
      feed(sgr(32, at + 4));
      feed(sgr(32, at + 6));
      expect(paneControl(files)?.size.get()).toBe(13);
      flush();
      expect(picture(root, 30)[0]).toContain('┃');

      // and the release ends it: a pointer that goes on moving resizes nothing
      feed(sgr(0, at + 6, 'm'));
      feed(sgr(35, at + 10));
      expect(paneControl(files)?.size.get()).toBe(13);
      input.stop();
    });

    it('should focus the edge on a press, and keep it out of the ring a Tab walks', () => {
      const { feed, field, files, input } = app();
      const edge = edgeOf(files);
      const at = (files.box?.x ?? 0) + 7;

      expect(input.focus.ring()).toEqual([field]);

      feed(sgr(0, at + 1));
      feed(sgr(0, at + 1, 'm'));
      expect(input.focus.current.get()).toBe(edge);

      // a Tab from the edge carries on from where the edge sits, which is the web's
      // rule: the edge is after the field in the document, so the next stop wraps to
      // the field and the previous one is the field too
      input.focus.next();
      expect(input.focus.current.get()).toBe(field);
      input.stop();
    });

    it('should carry a Tab on from the edge to the stop after it, and a Shift-Tab to the one before', () => {
      const { feed, terminal } = harness();
      const tree = box({ focusable: true }, text('tree'));
      const side = Pane({ ascii: false, size: 8 }, tree);
      const editor = box({ focusable: true, 'flex-grow': 1, 'min-width': 0 }, text('editor'));
      const log = box({ focusable: true }, text('log'));
      const root = row(side, editor, log);
      picture(root, 30);
      const input = createInput({ root, terminal });

      expect(input.focus.ring()).toEqual([tree, editor, log]);
      input.focus.focus(edgeOf(side));
      feed('\t');
      expect(input.focus.current.get()).toBe(editor);

      input.focus.focus(edgeOf(side));
      feed(`${ESC}[Z`);
      expect(input.focus.current.get()).toBe(tree);
      input.stop();
    });

    it('should move the focus out of a pane that collapses around it', () => {
      // `display: none` on the body left the focus on a tree nobody could see, and the
      // next arrow went to it
      const { feed, terminal } = harness();
      const list = box({ focusable: true }, text('list'));
      const side = Pane({ ascii: false, collapsible: true, size: 8 }, list);
      const editor = box({ focusable: true, 'flex-grow': 1, 'min-width': 0 }, text('editor'));
      const root = row(side, editor);
      picture(root, 30);
      const input = createInput({ root, terminal });
      const seen: string[] = [];
      list.onKey = (event) => void seen.push(event.key.name);

      input.focus.focus(list);
      feed(`${ESC}[B`);
      expect(seen).toEqual(['down']);

      paneControl(side)?.collapse();
      flush();
      picture(root, 30);
      feed(`${ESC}[B`);

      expect(input.focus.current.get()).toBe(editor);
      expect(seen).toEqual(['down']);
      input.stop();
    });

    it('should keep the focus on the edge when the pane it is on collapses', () => {
      // the edge is outside the body, so it is still drawn: a key after a collapse
      // is the one that opens the pane again
      const { feed, terminal } = harness();
      const side = Pane({ ascii: false, collapsible: true, size: 8 }, box({ focusable: true }));
      const root = row(side, main());
      picture(root, 30);
      const input = createInput({ root, terminal });

      input.focus.focus(edgeOf(side));
      feed('\r');
      flush();
      picture(root, 30);
      feed(`${ESC}[C`);

      expect(input.focus.current.get()).toBe(edgeOf(side));
      expect(paneControl(side)?.collapsed.get()).toBe(false);
      input.stop();
    });

    it('should be moved by the arrows once a press has focused it', () => {
      const { feed, files, input } = app();
      const at = (files.box?.x ?? 0) + 7;

      feed(sgr(0, at + 1));
      feed(sgr(0, at + 1, 'm'));
      feed(`${ESC}[C`);
      feed(`${ESC}[1;2C`);
      expect(paneControl(files)?.size.get()).toBe(14);
      input.stop();
    });

    it('should light up while the pointer is over it, and go out when it leaves', () => {
      const { feed, files, input } = app();
      const edge = edgeOf(files);
      const at = (files.box?.x ?? 0) + 7;

      feed(sgr(35, at + 1));
      expect(edge.classes).toContain('sigil-accent');
      feed(sgr(35, at + 10));
      expect(edge.classes).not.toContain('sigil-accent');
      input.stop();
    });
  });

  describe('in a real layout', () => {
    it('should keep a scroll box’s bar clear of the edge, and hand the press to the bar', () => {
      // the edge is on the pane's last column and a scroll box that fills the pane has
      // its bar there. The edge is on top, so it took every press the bar should have
      const bar = ScrollBox({
        children: () =>
          box(
            { 'flex-direction': 'column' },
            ...Array.from({ length: 20 }, (_, i) => text(`line ${i}`))
          ),
      });
      const side = Pane({ ascii: false, size: 12 }, bar);
      const root = row(side, main());
      picture(root, 30, 5);
      picture(root, 30, 5);

      const edge = edgeOf(side);
      expect(hitTest(root, 11, 2)).toBe(edge);
      expect(hitTest(root, 10, 2)?.classes.join(' ')).toMatch(/sigil-scroll-(thumb|track)/);
      expect(picture(root, 30, 5)[0]).toBe('line 0    █ main');
    });

    it('should leave a bordered panel alone, because its border is between', () => {
      const side = Pane(
        { ascii: false, size: 12 },
        Panel({ ascii: false }, ScrollBox({ children: () => text('x') }))
      );
      const root = row(side, main());
      picture(root, 30, 5);
      picture(root, 30, 5);

      expect(side.children[0]?.style.paddingRight).toBe(0);
    });

    it('should keep every edge on the screen when the panes ask for more than there is', () => {
      const a = pane('aaaa', { min: 12, size: 15 });
      const b = pane('bbbb', { edge: 'start', min: 12, size: 15 });
      const root = row(a, main(), b);

      for (const width of [40, 30, 20, 12]) {
        picture(root, width, 3);
        picture(root, width, 3);
        for (const host of [a, b]) {
          const at = edgeOf(host).box;
          expect(at?.x, `edge x at ${width}`).toBeGreaterThanOrEqual(0);
          expect((at?.x ?? 0) + 1, `edge right at ${width}`).toBeLessThanOrEqual(width);
        }
      }
    });

    it('should share the room by minimums, and in order, when it is short', () => {
      const a = pane('aaaa', { min: 4, size: 30 });
      const b = pane('bbbb', { min: 4, size: 30 });
      const root = row(a, b);
      picture(root, 20, 3);
      picture(root, 20, 3);

      // the first keeps what is left after the second's minimum
      expect([a.box?.width, b.box?.width]).toEqual([16, 4]);
    });

    it('should take a plain neighbour down to its minimum and no further', () => {
      // a nowrap word cannot shrink, so the cells past it are not the neighbour's to
      // give: the pane that took them pushed the box after it off the screen
      const a = pane('aaaa', { size: 10 });
      const word = box({ 'flex-grow': 1 }, text('nowrapcontent', { 'white-space': 'nowrap' }));
      const tail = box({}, text('Z'));
      const root = row(a, word, tail);
      picture(root, 30, 3);

      dragTo(a, 9, 25);
      release(a, 25);
      picture(root, 30, 3);

      expect(a.box?.width).toBe(16);
      expect(word.box?.width).toBe(13);
      expect(picture(root, 30, 3)[0]?.endsWith('nowrapcontentZ')).toBe(true);
    });

    it('should let a plain neighbour with min-width 0 go to nothing', () => {
      const a = pane('aaaa', { size: 10 });
      const word = box(
        { 'flex-grow': 1, 'min-width': 0 },
        text('nowrapcontent', { 'white-space': 'nowrap' })
      );
      const root = row(a, word);
      picture(root, 30, 3);

      dragTo(a, 9, 100);
      expect(paneControl(a)?.size.get()).toBe(30);
    });

    it('should not take more of a neighbour than it has in several steps before a frame', () => {
      // three presses in one chunk, with no layout between them: each asked the stale
      // box how much was left and was told one cell
      const a = pane('aaaa', { size: 10 });
      const nb = box({ 'flex-grow': 1, 'min-width': 0 }, text('m'));
      const tail = box({ 'flex-shrink': 0 }, text('Z'));
      const root = row(a, nb, tail);
      picture(root, 12, 3);
      expect(nb.box?.width).toBe(1);

      for (let i = 0; i < 3; i++) {
        edgeOf(a).onKey?.(key('right'));
      }
      flush();
      expect(paneControl(a)?.size.get()).toBe(11);
      expect(picture(root, 12, 3)[0]?.endsWith('Z')).toBe(true);
    });

    it('should put the edge of a pane with no cells where it can be reached', () => {
      // not collapsible, `min: 0`, taken to nothing: the edge is not at column -1
      const side = Pane({ ascii: false, min: 0, size: 5 }, text('side'));
      const root = row(side, main());
      picture(root, 20, 2);

      expect(paneControl(side)?.resize(0)).toBe(0);
      flush();
      picture(root, 20, 2);

      expect(side.box?.width).toBe(0);
      expect(edgeOf(side).box?.x).toBe(0);
      expect(hitTest(root, 0, 0)).toBe(edgeOf(side));
      // and it can be pulled open again from there
      dragTo(side, 0, 4);
      expect(paneControl(side)?.size.get()).toBe(4);
    });

    it('should leave an app’s own z-index alone, and put it back after a collapse', () => {
      const side = Pane(
        { ascii: false, collapsible: true, props: { 'z-index': 3 }, size: 8 },
        text('side')
      );
      const plain = Pane({ ascii: false, collapsible: true, size: 8 }, text('plain'));
      const root = row(side, plain, main());
      const z = (host: Element) => {
        resolveStyles(root);
        return host.style.zIndex;
      };
      picture(root, 30, 2);
      expect(z(side)).toBe(3);
      expect(z(plain)).toBe(0);

      paneControl(side)?.collapse();
      paneControl(plain)?.collapse();
      flush();
      expect(z(side)).toBe(3);
      expect(z(plain)).toBe(1);

      paneControl(side)?.expand();
      paneControl(plain)?.expand();
      flush();
      expect(z(side)).toBe(3);
      expect(z(plain)).toBe(0);
    });
  });
});
