import { strip } from '../../src/ansi/index.js';
import { CellBuffer, DEFAULT_COLOR, Painter, palette, StyleTable } from '../../src/canvas/index.js';
import { confirmModal, type ModalOptions, openModal } from '../../src/components/modal.js';
import { TextField } from '../../src/components/text-field.js';
import {
  arrange,
  box,
  type Element,
  hitTest,
  paint,
  renderToLines,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import { createInput, ESCAPE_TIMEOUT, type MouseEvent } from '../../src/input/index.js';
import {
  createEffect,
  createRoot,
  onCleanup,
  render,
  runWithOwner,
} from '../../src/renderer/index.js';
import { Computed, flush, sinkCount, State } from '../../src/signals/index.js';
import { Restyler, setQuiet } from '../../src/style/index.js';
import { alt, createTestTerminal, ctrl, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A modal: what it draws, who has the keys and the mouse while it is open, and
 * where the focus goes when it is not.
 *
 * Driven through a real router over a test terminal, because the claims are about
 * the router's order -- a binding, the sequence trie, the focused element, the
 * Tab default -- and a handler called by hand would not be in any of them.
 */

const WIDTH = 40;
const HEIGHT = 12;

/** Lets a key act, and the effect that draws its consequence run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  flush();
}

/** A lone Escape is held for the key deadline, so it needs the clock to pass. */
async function escape(term: { press(...chunks: string[]): Promise<void> }): Promise<void> {
  await term.press(KEYS.escape);
  await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
  await settle();
}

/** An app with two focusable rows, a router over it, and a modal's worth of room. */
function scene() {
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const seen: string[] = [];
  const one = text('first row', { class: 'row', focusable: true });
  const two = text('second row', { class: 'row', focusable: true });
  one.onKey = (event) => {
    seen.push(`one:${event.key.name}`);
  };
  two.onKey = (event) => {
    seen.push(`two:${event.key.name}`);
  };
  const root = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH }, one, two);
  root.onKey = (event) => {
    seen.push(`root:${event.key.name}`);
  };
  const input = createInput({ root, terminal: term.terminal });
  return { input, one, root, seen, term, two };
}

/** The screen as a person would read it, trailing space trimmed. */
function picture(root: Element): string[] {
  return renderToLines(root, {
    cascade: themedCascade(),
    colorLevel: 0,
    height: HEIGHT,
    width: WIDTH,
  }).map((line) => strip(line).trimEnd());
}

/** The picture as one string. */
const screen = (root: Element): string => picture(root).join('\n');

/** A click or a press as the router builds one, with a record of whether it was stopped. */
function mouseEvent(
  kind: MouseEvent['kind'],
  target: Element | undefined
): MouseEvent & { claimed: () => boolean } {
  let stopped = false;
  return {
    button: 'left',
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
    target,
    wheel: undefined,
    x: 0,
    y: 0,
  };
}

const handles: Array<{ dispose(): void }> = [];
afterEach(() => {
  setQuiet(undefined);
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
});

/** Opens a modal and registers it for cleanup. */
function modalOn<T = undefined>(s: ReturnType<typeof scene>, opts: Partial<ModalOptions<T>> = {}) {
  const handle = openModal<T>(s.root, { input: s.input, ...opts });
  handles.push(handle, { dispose: () => s.input.stop() });
  return handle;
}

describe('openModal()', () => {
  it('should draw a titled dialog over the app without moving it', async () => {
    const s = scene();
    const before = picture(s.root);
    modalOn(s, { body: 'Really do it?', title: 'Careful' });
    await settle();

    const after = screen(s.root);
    expect(after).to.include('Careful');
    expect(after).to.include('Really do it?');
    expect(after).to.include('[ OK ]');
    // out of flow: the app's own rows are where they were
    expect(picture(s.root)[0]).to.equal(before[0]);
    expect(picture(s.root)[1]).to.equal(before[1]);
  });

  // `ascii` is passed rather than left to `unicodeSupported()`, which reads the
  // platform: a Windows runner draws the ASCII set, so a test that only knew the
  // round one found no border there. Both sets are what somebody sees.
  it.each([
    { ascii: false, edge: '│', top: '╭', bottom: '╰', end: ['│', '╮', '╯'] },
    { ascii: true, edge: '|', top: '+', bottom: '+', end: ['|', '+'] },
  ])(
    'should draw above the app, hiding what is under the panel even with no colour (ascii: $ascii)',
    async ({ ascii, bottom: lower, edge, end, top: upper }) => {
      const s = scene();
      // a wall of the app under where the panel will sit
      for (let row = 0; row < 8; row++) {
        s.root.append(text('#'.repeat(WIDTH)));
      }
      modalOn(s, { ascii, body: 'x', title: 'T', width: 20 });
      await settle();

      // colour level 0, so a background colour would have been dropped: it is the
      // blank cells the panel fills itself with that keep the wall from showing
      const lines = picture(s.root);
      const top = lines.findIndex((line) => line.includes(upper));
      const bottom = lines.findLastIndex((line) => line.includes(lower));
      expect(top).to.be.greaterThan(-1);
      expect(bottom).to.be.greaterThan(top);
      for (const line of lines.slice(top, bottom + 1)) {
        const left = Math.min(
          ...[edge, upper, lower].map((glyph) => line.indexOf(glyph)).filter((at) => at >= 0)
        );
        const right = Math.max(...end.map((glyph) => line.lastIndexOf(glyph)));
        const inside = line.slice(left + 1, right);
        expect(inside).to.not.include('#');
      }
      // and the wall outside the panel is still there
      expect(lines[top]?.startsWith('#')).to.equal(true);
      expect(lines[0]).to.include('first row');
    }
  );

  it('should not take on the colour of an app panel under it', async () => {
    // text lets the background under it show through, and a fill does not: the
    // fill is what the dialog hides the app with, so a grey app stays out of it
    // in colour as well as in characters
    const s = scene();
    s.root.setProp('background-color', 'gray');
    modalOn(s, { body: 'x', title: 'T', width: 20 });
    await settle();

    const styles = new StyleTable();
    const buffer = new CellBuffer(WIDTH, HEIGHT);
    resolveStyles(s.root, new Restyler(themedCascade()));
    arrange(s.root, { height: HEIGHT, width: WIDTH });
    paint(s.root, new Painter(buffer, styles));
    const bg = (x: number, y: number): number => styles.get(buffer.styleAt(x, y)).bg;

    const y = buffer.toLines().findIndex((line) => line.includes(' T '));
    const x = buffer.toLines()[y]?.indexOf(' T ') ?? -1;
    expect(x).to.be.greaterThan(0);
    // the title, and the blank beside it, are the terminal's own
    expect(bg(x + 1, y)).to.equal(DEFAULT_COLOR);
    expect(bg(x + 3, y)).to.equal(DEFAULT_COLOR);
    // and the app beside the panel is still grey
    expect(bg(0, y)).to.equal(palette(8));
  });

  // the fill covers the padding box and the border is drawn outside it, as a
  // glyph that keeps the background under it -- so every border cell took the
  // app's colour, and over half blocks some did and some did not
  it('should draw its border on its own background, not the colour of the app under it', async () => {
    const s = scene();
    s.root.setProp('background-color', 'gray');
    const handle = modalOn(s, { body: 'x', title: 'T', width: 20 });
    await settle();

    const styles = new StyleTable();
    const buffer = new CellBuffer(WIDTH, HEIGHT);
    resolveStyles(s.root, new Restyler(themedCascade()));
    arrange(s.root, { height: HEIGHT, width: WIDTH });
    paint(s.root, new Painter(buffer, styles));

    const find = (at: Element): Element | undefined =>
      at.classes.includes('sigil-modal') ? at : at.children.map(find).find(Boolean);
    const box = find(handle.element)?.box;
    expect(box).toBeDefined();
    const { height, width, x, y } = box as NonNullable<typeof box>;
    const lines = buffer.toLines();
    let ring = 0;
    for (let row = y; row < y + height; row++) {
      for (let col = x; col < x + width; col++) {
        if (row > y && row < y + height - 1 && col > x && col < x + width - 1) {
          continue;
        }
        ring++;
        // still the border, and on the terminal's own background
        expect(lines[row]?.[col], `${col},${row}`).not.toBe(' ');
        expect(styles.get(buffer.styleAt(col, row)).bg, `${col},${row}`).toBe(DEFAULT_COLOR);
      }
    }
    expect(ring).toBe(2 * width + 2 * (height - 2));
    // and the app beside the panel is still grey
    expect(styles.get(buffer.styleAt(x - 1, y)).bg).toBe(palette(8));

    // a panel with a background of its own already has it under its border, and
    // the fill leaves that alone: the box's own background is the one that wins
    find(handle.element)?.setProp('background-color', 'blue');
    const again = new CellBuffer(WIDTH, HEIGHT);
    resolveStyles(s.root, new Restyler(themedCascade()));
    arrange(s.root, { height: HEIGHT, width: WIDTH });
    paint(s.root, new Painter(again, styles));
    expect(styles.get(again.styleAt(x, y)).bg).toBe(palette(4));
    expect(styles.get(again.styleAt(x + width - 1, y + height - 1)).bg).toBe(palette(4));
  });

  it('should bracket the button that has the focus, so it reads without colour', async () => {
    const s = scene();
    modalOn(s, {
      actions: [{ label: 'Save' }, { label: 'Discard' }],
      title: 'Unsaved',
    });
    await settle();

    expect(screen(s.root)).to.match(/\[ Save \]\s+Discard/);
    await s.term.press(KEYS.tab);
    await settle();
    expect(screen(s.root)).to.match(/Save\s+\[ Discard \]/);
  });

  it('should move the focus into the dialog when it opens', () => {
    const s = scene();
    s.input.focus.focus(s.one);
    const handle = modalOn(s, { actions: [{ label: 'A' }, { label: 'B' }], initial: 1 });
    expect(handle.element.contains(s.input.focus.current.get() as Element)).to.equal(true);
    // a button is a box of its brackets and its label since SIG-199, so its words
    // are read off its parts -- bracketed, because it has the focus
    const focused = s.input.focus.current.get() as Element;
    expect(focused.children.map((part) => part.text).join('')).to.equal('[ B ]');
  });

  it('should refuse input that is not a router, and bad options', () => {
    const s = scene();
    expect(() => openModal(s.root, { input: {} as never })).to.throw(TypeError, 'router');
    expect(() => openModal({} as never, { input: s.input })).to.throw(TypeError, 'host');
    expect(() => openModal(s.root, { actions: [{ label: '' }], input: s.input })).to.throw(
      TypeError,
      'label'
    );
    expect(() =>
      openModal(s.root, { actions: [{ label: 'a' }], initial: 3, input: s.input })
    ).to.throw(TypeError, 'initial');
    expect(() => openModal(s.root, { body: 5 as never, input: s.input })).to.throw(
      TypeError,
      'body'
    );
    s.input.stop();
  });
});

describe('the focus trap', () => {
  it('should cycle Tab and Shift-Tab through the dialog and nothing under it', async () => {
    const s = scene();
    s.input.focus.focus(s.one);
    const handle = modalOn(s, { actions: [{ label: 'Yes' }, { label: 'No' }] });
    const buttons = [...(handle.element.children[0]?.children.at(-1)?.children ?? [])];
    const [yes, no] = buttons;

    expect(s.input.focus.current.get()).to.equal(yes);
    await s.term.press(KEYS.tab);
    expect(s.input.focus.current.get()).to.equal(no);
    // wraps inside the dialog rather than walking out to the rows
    await s.term.press(KEYS.tab);
    expect(s.input.focus.current.get()).to.equal(yes);
    await s.term.press(KEYS.shiftTab);
    expect(s.input.focus.current.get()).to.equal(no);
    await s.term.press(KEYS.shiftTab);
    expect(s.input.focus.current.get()).to.equal(yes);
  });

  it('should pull the focus back in when something outside took it', async () => {
    const s = scene();
    const handle = modalOn(s, { actions: [{ label: 'Yes' }] });
    s.input.focus.focus(s.two);

    await s.term.press('x');
    expect(handle.element.contains(s.input.focus.current.get() as Element)).to.equal(true);
    // and the key was not delivered to the row it had escaped to
    expect(s.seen).to.deep.equal([]);
  });

  it('should hold the focus itself when there is nothing to press', async () => {
    const s = scene();
    const handle = modalOn(s, { actions: [], body: 'Wait', dismissible: true });
    const panel = handle.element.children[0] as Element;

    expect(s.input.focus.current.get()).to.equal(panel);
    await s.term.press(KEYS.tab);
    expect(s.input.focus.current.get()).to.equal(panel);
    await escape(s.term);
    expect(handle.open).to.equal(false);
  });

  it('should trap what a body element brings with it', async () => {
    const s = scene();
    const field = text('field', { focusable: true });
    const handle = modalOn(s, { actions: [{ label: 'Done' }], body: box({}, field) });
    const ring = [field, handle.element.children[0]?.children.at(-1)?.children[0] as Element];

    // initial focus is the button, Tab reaches the field, Tab again wraps
    expect(s.input.focus.current.get()).to.equal(ring[1]);
    await s.term.press(KEYS.tab);
    expect(s.input.focus.current.get()).to.equal(field);
    await s.term.press(KEYS.tab);
    expect(s.input.focus.current.get()).to.equal(ring[1]);
  });
});

describe('dismissal', () => {
  it('should close on Escape, leave no trace and settle with nothing', async () => {
    const s = scene();
    const handle = modalOn(s, { title: 'Hi' });
    await settle();
    expect(screen(s.root)).to.include('Hi');

    await escape(s.term);
    expect(handle.open).to.equal(false);
    expect(handle.element.parent).to.equal(undefined);
    expect(screen(s.root)).to.not.include('Hi');
    expect(await handle.result).to.equal(undefined);
  });

  it('should not close on Escape when it must be answered', async () => {
    const s = scene();
    const handle = modalOn(s, { dismissible: false });
    await escape(s.term);

    expect(handle.open).to.equal(true);
    handle.close();
    expect(handle.open).to.equal(false);
  });

  it('should settle with the value of the button pressed', async () => {
    const s = scene();
    const handle = modalOn<string>(s, {
      actions: [
        { label: 'Save', value: 'save' },
        { label: 'Drop', value: 'drop' },
      ],
    });

    await s.term.press(KEYS.tab, KEYS.enter);
    expect(await handle.result).to.equal('drop');
    expect(handle.open).to.equal(false);
  });

  it('should press a button with a click and with Space', async () => {
    const s = scene();
    const clicked = modalOn<number>(s, { actions: [{ label: 'One', value: 1 }] });
    const button = clicked.element.children[0]?.children.at(-1)?.children[0] as Element;
    button.onMouse?.(mouseEvent('click', button));
    expect(await clicked.result).to.equal(1);

    const spaced = modalOn<number>(s, { actions: [{ label: 'Two', value: 2 }] });
    await s.term.press(KEYS.space);
    expect(await spaced.result).to.equal(2);
  });

  it('should settle once when a button and Escape arrive together', async () => {
    const s = scene();
    const handle = modalOn<string>(s, { actions: [{ label: 'Ok', value: 'ok' }] });
    handle.close('ok');
    handle.close('late');
    handle.dispose();
    expect(await handle.result).to.equal('ok');
  });
});

describe('returning the focus', () => {
  it('should give the focus back to the element that had it', async () => {
    const s = scene();
    s.input.focus.focus(s.two);
    const handle = modalOn(s);
    expect(s.input.focus.current.get()).to.not.equal(s.two);

    await escape(s.term);
    expect(handle.open).to.equal(false);
    expect(s.input.focus.current.get()).to.equal(s.two);
  });

  it('should give the focus back to an element that is not in the ring, if it is still there', async () => {
    // a pane's edge, which a click focused and a Tab never stops on: the ring does
    // not contain it, so the dialog could not find it there and took the focus to
    // the top of the app instead
    const s = scene();
    const handle = box({ tabindex: -1 }, text('handle'));
    s.root.insertBefore(handle, s.two);
    s.input.focus.focus(handle);
    expect(s.input.focus.ring()).to.not.include(handle);

    const dialog = modalOn(s);
    expect(dialog.element.contains(s.input.focus.current.get() as Element)).to.equal(true);
    await escape(s.term);

    expect(s.input.focus.current.get()).to.equal(handle);
  });

  it('should not give a lower dialog’s focus back to something outside it', () => {
    // reachable: a dialog can hold a pane's edge, and an app can `focus()` an element
    // outside the open dialog -- which the trap pulls back at the next key, not at once.
    // A second dialog opened in that window remembers the outsider as its `previous`,
    // and closing it must land inside the dialog still open, because that one is a trap
    const s = scene();
    const handle = box({ tabindex: -1 }, text('handle'));
    s.root.insertBefore(handle, s.two);
    const lower = modalOn(s, { actions: [{ label: 'Yes' }] });
    s.input.focus.focus(handle);

    const upper = modalOn(s, { actions: [{ label: 'No' }] });
    upper.close();

    expect(lower.element.contains(s.input.focus.current.get() as Element)).to.equal(true);
    expect(s.input.focus.current.get()).to.not.equal(handle);
  });

  it('should not give the focus back to an element that left the tree', async () => {
    const s = scene();
    const handle = box({ tabindex: -1 }, text('handle'));
    s.root.insertBefore(handle, s.two);
    s.input.focus.focus(handle);

    modalOn(s);
    handle.remove();
    await escape(s.term);

    expect(s.input.focus.current.get()).to.equal(s.one);
  });

  it('should leave nothing focused when nothing had been', async () => {
    const s = scene();
    modalOn(s);
    await escape(s.term);
    expect(s.input.focus.current.get()).to.equal(undefined);
  });

  it('should fall back to the first focusable element when that one is gone', async () => {
    const s = scene();
    s.input.focus.focus(s.two);
    const handle = modalOn(s);
    s.root.removeChild(s.two);

    handle.close();
    expect(s.input.focus.current.get()).to.equal(s.one);
  });

  it('should not take the focus back from somewhere it already moved on to', () => {
    const s = scene();
    s.input.focus.focus(s.one);
    const handle = modalOn(s);
    // the app deliberately sends the focus elsewhere before closing the dialog
    s.input.focus.focus(s.two);
    handle.close();
    expect(s.input.focus.current.get()).to.equal(s.two);
  });
});

describe('keys', () => {
  it('should keep keys from the rows, the root and a sequence bound under them', async () => {
    const s = scene();
    const fired: string[] = [];
    s.input.bind('q', () => fired.push('q'));
    s.input.focus.focus(s.one);
    modalOn(s);

    await s.term.press('q', 'x', KEYS.down);
    expect(fired).to.deep.equal([]);
    expect(s.seen).to.deep.equal([]);
  });

  it('should keep a binding registered after it from seeing the keys', async () => {
    const s = scene();
    modalOn(s);
    const seen: string[] = [];
    s.input.bind((event) => {
      seen.push(event.key.name);
    });

    await s.term.press('x');
    expect(seen).to.deep.equal([]);
  });

  it('should never swallow the abort', async () => {
    const s = scene();
    modalOn(s);
    const seen: string[] = [];
    s.input.bind((event) => {
      if (event.key.ctrl) {
        seen.push(event.key.name);
      }
    });

    await s.term.press(ctrl('c'));
    expect(seen).to.deep.equal(['c']);
  });

  it('should deliver a key to the focused element inside the dialog, and no higher than it', async () => {
    const s = scene();
    const got: string[] = [];
    const field = text('field', { focusable: true });
    field.onKey = (event) => {
      got.push(`field:${event.key.name}`);
    };
    const body = box({});
    body.onKey = (event) => {
      got.push(`body:${event.key.name}`);
    };
    body.append(field);
    modalOn(s, { actions: [], body });
    s.input.focus.focus(field);

    await s.term.press('z');
    expect(got).to.deep.equal(['field:z', 'body:z']);
    // and the root the dialog was added to never heard it
    expect(s.seen).to.deep.equal([]);
  });

  it('should let the element inside stop a key from reaching the dialog itself', async () => {
    const s = scene();
    const got: string[] = [];
    const field = text('field', { focusable: true });
    field.onKey = (event) => {
      event.stop();
    };
    const body = box({});
    body.onKey = (event) => {
      got.push(event.key.name);
    };
    body.append(field);
    modalOn(s, { actions: [], body });
    s.input.focus.focus(field);

    await s.term.press('z');
    expect(got).to.deep.equal([]);
  });

  it('should give the keys back to the app once it is closed', async () => {
    const s = scene();
    s.input.focus.focus(s.one);
    const handle = modalOn(s);
    handle.close();
    s.input.focus.focus(s.one);

    await s.term.press('a');
    expect(s.seen).to.include('one:a');
  });
});

describe('pastes', () => {
  /** The scene, with an app-wide paste handler made at startup and the root's own. */
  function pasting() {
    const s = scene();
    const pasted: string[] = [];
    s.input.onPaste((event) => {
      pasted.push(`app:${event.text}`);
      event.stop();
    });
    s.root.onPaste = (event) => {
      pasted.push(`root:${event.text}`);
    };
    return { ...s, pasted };
  }

  it('should keep a paste aimed at a button from the app behind the dialog', async () => {
    const s = pasting();
    s.input.focus.focus(s.one);
    const handle = modalOn(s);

    await s.term.paste('list.txt\r');
    expect(s.pasted).to.deep.equal([]);
    // nor typed in to the rows or the root; and a pasted Enter is content, so the
    // button it landed on was not pressed
    expect(s.seen).to.deep.equal([]);
    expect(handle.open).to.equal(true);
  });

  it('should give a text field inside the dialog the paste, and the app none of it', async () => {
    const s = pasting();
    const value = new State('a');
    const field = TextField({ value });
    modalOn(s, { body: field });
    s.input.focus.focus(field);

    await s.term.paste('bc');
    expect(value.get()).to.equal('abc');
    expect(s.pasted).to.deep.equal([]);
  });

  it('should type a paste nothing claimed in to the element inside, and no higher than the dialog', async () => {
    const s = pasting();
    const got: string[] = [];
    const field = text('field', { focusable: true });
    field.onKey = (event) => {
      got.push(`field:${event.key.name}:${event.paste}`);
    };
    const body = box({}, field);
    body.onKey = (event) => {
      got.push(`body:${event.key.name}`);
    };
    modalOn(s, { actions: [], body });
    s.input.focus.focus(field);

    await s.term.paste('xy');
    expect(got).to.deep.equal(['field:x:true', 'body:x', 'field:y:true', 'body:y']);
    expect(s.pasted).to.deep.equal([]);
    expect(s.seen).to.deep.equal([]);
  });

  it('should drop the rest of a paste once a pasted key closes the dialog', async () => {
    const s = pasting();
    s.input.focus.focus(s.one);
    const field = text('field', { focusable: true });
    const handle = modalOn(s, { actions: [], body: field });
    field.onKey = (event) => {
      if (event.key.name === 'q') {
        handle.close();
      }
    };
    s.input.focus.focus(field);

    await s.term.paste('qz');
    expect(handle.open).to.equal(false);
    // the focus went back to the row, and the `z` after the `q` is not the row's
    expect(s.input.focus.current.get()).to.equal(s.one);
    expect(s.seen).to.deep.equal([]);
    expect(s.pasted).to.deep.equal([]);
  });

  it('should keep pastes from the app through a stack, and give them back when it is empty', async () => {
    const s = pasting();
    s.input.focus.focus(s.one);
    const lower = modalOn(s, { title: 'Lower' });
    const upper = modalOn(s, { title: 'Upper' });

    await s.term.paste('one');
    upper.close();
    expect(lower.element.contains(s.input.focus.current.get() as Element)).to.equal(true);
    await s.term.paste('two');
    expect(s.pasted).to.deep.equal([]);

    lower.close();
    expect(s.input.focus.current.get()).to.equal(s.one);
    await s.term.paste('three');
    expect(s.pasted).to.deep.equal(['root:three', 'app:three']);
  });

  it('should type nothing in to a dialog below the top one, even with the focus moved there', async () => {
    const s = pasting();
    const got: string[] = [];
    const field = text('field', { focusable: true });
    field.onKey = (event) => {
      got.push(event.key.name);
    };
    modalOn(s, { actions: [], body: field });
    modalOn(s, { title: 'Upper' });
    // an app moving the focus by hand, which is the one way into a lower dialog
    s.input.focus.focus(field);

    await s.term.paste('x');
    expect(got).to.deep.equal([]);
    expect(s.pasted).to.deep.equal([]);
  });
});

describe('the mouse', () => {
  it('should put the dialog, or the box under it, where a report lands instead of the app', async () => {
    const s = scene();
    const handle = modalOn(s, { title: 'Hi' });
    await settle();
    picture(s.root);

    // over the first row of the app, which is covered by the backdrop
    const hit = hitTest(s.root, 0, 0);
    expect(hit).to.equal(handle.element);
    expect(hit).to.not.equal(s.one);
  });

  it('should stop what lands on the backdrop, and not a press inside the panel', () => {
    const s = scene();
    const handle = modalOn(s);
    const panel = handle.element.children[0] as Element;

    const wheel = mouseEvent('wheel', handle.element);
    handle.element.onMouse?.(wheel);
    expect(wheel.claimed()).to.equal(true);

    // a press on the panel is left to bubble so that it can focus a button
    const press = mouseEvent('mousedown', panel);
    handle.element.onMouse?.(press);
    expect(press.claimed()).to.equal(false);

    // and anything else that came through the panel ends there
    const up = mouseEvent('mouseup', panel);
    handle.element.onMouse?.(up);
    expect(up.claimed()).to.equal(true);
  });

  it('should dismiss on a click outside the panel only when asked to', () => {
    const s = scene();
    const stays = modalOn(s);
    stays.element.onMouse?.(mouseEvent('click', stays.element));
    expect(stays.open).to.equal(true);

    const goes = modalOn(s, { closeOnClickOutside: true });
    const panel = goes.element.children[0] as Element;
    // a click inside the panel is not outside it
    goes.element.onMouse?.(mouseEvent('click', panel));
    expect(goes.open).to.equal(true);
    goes.element.onMouse?.(mouseEvent('click', goes.element));
    expect(goes.open).to.equal(false);
  });
});

describe('stacking', () => {
  it('should give the input to the topmost and return it when that closes', async () => {
    const s = scene();
    s.input.focus.focus(s.one);
    const lower = modalOn<string>(s, {
      actions: [
        { label: 'L1', value: 'l1' },
        { label: 'L2', value: 'l2' },
      ],
      title: 'Lower',
    });
    const lowerFocus = s.input.focus.current.get() as Element;
    const upper = modalOn<string>(s, { actions: [{ label: 'U1', value: 'u1' }], title: 'Upper' });
    await settle();

    expect(screen(s.root)).to.include('Upper');
    expect(upper.element.contains(s.input.focus.current.get() as Element)).to.equal(true);

    // Tab cycles the upper dialog, whose only button is the one it started on
    const start = s.input.focus.current.get();
    await s.term.press(KEYS.tab);
    expect(s.input.focus.current.get()).to.equal(start);

    // Escape closes the upper one only
    await escape(s.term);
    expect(upper.open).to.equal(false);
    expect(lower.open).to.equal(true);
    // and the focus is back inside the lower one, on what it had
    expect(s.input.focus.current.get()).to.equal(lowerFocus);

    // which now has the keys and still traps
    await s.term.press(KEYS.tab);
    expect(lower.element.contains(s.input.focus.current.get() as Element)).to.equal(true);
    expect(s.input.focus.current.get()).to.not.equal(lowerFocus);
    await s.term.press(KEYS.enter);
    expect(await lower.result).to.equal('l2');
    expect(s.input.focus.current.get()).to.equal(s.one);
  });

  it('should let only the topmost answer a key', async () => {
    const s = scene();
    const lower = modalOn<string>(s, { actions: [{ label: 'L', value: 'l' }] });
    const upper = modalOn<string>(s, { actions: [{ label: 'U', value: 'u' }] });

    await s.term.press(KEYS.enter);
    expect(await upper.result).to.equal('u');
    expect(lower.open).to.equal(true);
  });

  it('should not move the focus when a lower one is closed under an upper one', async () => {
    const s = scene();
    const lower = modalOn(s, { title: 'Lower' });
    const upper = modalOn(s, { title: 'Upper' });
    const at = s.input.focus.current.get();

    lower.dispose();
    expect(s.input.focus.current.get()).to.equal(at);
    expect(upper.open).to.equal(true);

    // and the upper one still returns to what it was opened over: the lower's
    // button is gone, so it falls back to the app's first element
    upper.dispose();
    expect(s.input.focus.current.get()).to.equal(s.one);
  });
});

describe('the fallback focus', () => {
  it('should stay inside the dialog below when the element it came from is gone', () => {
    const s = scene();
    const lower = modalOn(s, { actions: [{ label: 'L1' }, { label: 'L2' }] });
    const buttons = [...(lower.element.children[0]?.children.at(-1)?.children ?? [])];
    const upper = modalOn(s, { title: 'Upper' });

    // the button the upper one was opened over goes away while it is open
    (buttons[0] as Element).remove();
    upper.close();

    // and the fallback is another thing in the lower dialog, not the app's
    // first row, which the lower dialog is still holding the keys against
    expect(s.input.focus.current.get()).to.equal(buttons[1]);
  });
});

describe('what it attaches', () => {
  it('should take its key binding off the router when it closes', () => {
    const s = scene();
    let bound = 0;
    let unbound = 0;
    const bind = s.input.bind.bind(s.input) as (...args: unknown[]) => () => void;
    (s.input as { bind: unknown }).bind = (...args: unknown[]) => {
      bound++;
      const off = bind(...args);
      return () => {
        unbound++;
        off();
      };
    };

    const handle = modalOn(s);
    expect(bound).to.equal(1);
    handle.close();
    expect(unbound).to.equal(1);
  });
});

describe('dispose()', () => {
  it('should put back everything it attached while it is open', async () => {
    const s = scene();
    s.input.focus.focus(s.two);
    const handle = modalOn(s, { title: 'Gone' });
    await settle();

    handle.dispose();
    await settle();
    expect(handle.open).to.equal(false);
    expect(handle.element.parent).to.equal(undefined);
    expect(screen(s.root)).to.not.include('Gone');
    expect(s.input.focus.current.get()).to.equal(s.two);
    expect(await handle.result).to.equal(undefined);

    // the binding is gone: a key reaches the focused row again
    await s.term.press('k');
    expect(s.seen).to.include('two:k');
  });

  /**
   * Its binding stops every key it is given, so a dialog left open after the
   * renderer went would swallow the keys of a router the app goes on owning,
   * and an `await` on `result` would never return.
   */
  it('should close with no answer when the renderer it was opened over goes', async () => {
    const s = scene();
    s.input.focus.focus(s.two);
    const view = render(() => s.root, { terminal: s.term.terminal });
    const handle = openModal(view, { input: s.input, title: 'Gone' });
    handles.push({ dispose: () => s.input.stop() });

    view.dispose();
    expect(handle.open).to.equal(false);
    expect(handle.element.parent).to.equal(undefined);
    expect(s.input.focus.current.get()).to.equal(s.two);
    expect(await handle.result).to.equal(undefined);

    await s.term.press('k');
    expect(s.seen).to.include('two:k');
  });

  it('should be safe to call twice, and after the dialog was answered', async () => {
    const s = scene();
    const handle = modalOn(s);
    handle.dispose();
    handle.dispose();
    const answered = modalOn(s);
    await s.term.press(KEYS.enter);
    answered.dispose();
    expect(answered.open).to.equal(false);
  });
});

describe('a modal and the key-help footer', () => {
  const described = (s: ReturnType<typeof scene>): string[] =>
    s.input.bindings().map((b) => `${b.keys} ${b.description}`);

  it("should list the keys it answers, and none of the app's that it swallows", async () => {
    const s = scene();
    s.input.bind('c', () => {}, { description: 'commit' });
    s.input.fallback('q', () => {}, { description: 'quit' });
    modalOn(s, { actions: [{ label: 'Yes' }, { label: 'No' }], title: 'Sure?' });
    await settle();

    expect(described(s)).toEqual([
      'tab next',
      'shift+tab previous',
      'enter select',
      'escape close',
    ]);
  });

  it('should not list Tab when there is nowhere for it to go', async () => {
    const s = scene();
    modalOn(s, { title: 'Sure?' });
    await settle();

    expect(described(s)).toEqual(['enter select', 'escape close']);
  });

  it("should list the app's keys again once it is closed", async () => {
    const s = scene();
    s.input.bind('c', () => {}, { description: 'commit' });
    const handle = modalOn(s);
    handle.close();
    expect(described(s)).toEqual(['c commit']);
  });

  it('should leave Escape out when it cannot be dismissed, and Enter out over a field', async () => {
    const s = scene();
    const field = TextField({ value: new State('') });
    modalOn(s, { body: field, dismissible: false });
    await settle();

    expect(described(s)).toEqual(['tab next', 'shift+tab previous']);
  });

  it('should list a key an element inside it declares, and not one outside', async () => {
    const s = scene();
    const field = text('field', { focusable: true });
    s.input.describe('x', { description: 'outside', scope: s.root });
    modalOn(s, { body: field });
    s.input.describe('ctrl+s', { description: 'commit', scope: field });
    s.input.focus.focus(field);
    await settle();

    expect(described(s)).toContain('ctrl+s commit');
    expect(described(s)).not.toContain('x outside');
  });
});

describe('confirmModal()', () => {
  it('should answer true for Yes and false for No', async () => {
    const s = scene();
    const yes = confirmModal(s.root, { input: s.input, message: 'Sure?', title: 'Delete' });
    await settle();
    expect(screen(s.root)).to.match(/\[ Yes \]\s+No/);
    await s.term.press(KEYS.enter);
    expect(await yes).to.equal(true);

    const no = confirmModal(s.root, { input: s.input, message: 'Sure?' });
    await s.term.press(KEYS.tab, KEYS.enter);
    expect(await no).to.equal(false);
    s.input.stop();
  });

  it('should answer false when it is dismissed', async () => {
    const s = scene();
    const answer = confirmModal(s.root, { input: s.input, message: 'Sure?' });
    await escape(s.term);
    expect(await answer).to.equal(false);
    s.input.stop();
  });

  it('should start on No when asked to, and take other labels', async () => {
    const s = scene();
    const answer = confirmModal(s.root, {
      initial: 'no',
      input: s.input,
      message: 'Sure?',
      no: 'Keep',
      yes: 'Remove',
    });
    await settle();
    expect(screen(s.root)).to.match(/Remove\s+\[ Keep \]/);
    await s.term.press(KEYS.enter);
    expect(await answer).to.equal(false);
    s.input.stop();
  });
});

describe('the quiet axis', () => {
  it('should draw and take keys under quiet, because a dialogue is not progress', async () => {
    setQuiet(true);
    const s = scene();
    const handle = modalOn(s, { title: 'Still here' });
    await settle();

    expect(screen(s.root)).to.include('Still here');
    await s.term.press(KEYS.enter);
    expect(handle.open).to.equal(false);
  });
});

/**
 * SIG-335. A dialog is opened from a key handler or an `onPress`, which run with
 * no owner, so an effect in a body the caller built first was created unowned and
 * never disposed: it went on following the app's state after the dialog had gone.
 * A body function is built under an owner the dialog disposes on close.
 */
describe('a body built by a function', () => {
  /** A scene mounted under a renderer, so that the host has a root owner. */
  function mounted() {
    const s = scene();
    const view = render(() => s.root, { terminal: s.term.terminal });
    handles.push({ dispose: () => s.input.stop() }, { dispose: () => view.dispose() });
    return { ...s, view };
  }

  /** The measured shape: an effect over an app `State`, made as the body is built. */
  function follower(app: State<number>, runs: number[]): () => Element {
    return () => {
      createEffect(() => {
        runs.push(app.get());
      });
      return text('body');
    };
  }

  it('should stop an effect in the body when the dialog closes', async () => {
    const s = mounted();
    const app = new State(0);
    const runs: number[] = [];
    const handle = openModal(s.view, { body: follower(app, runs), input: s.input });
    expect(runs).toEqual([0]);

    app.set(1);
    s.view.frame();
    expect(runs).toEqual([0, 1]);

    handle.close();
    app.set(2);
    s.view.frame();
    expect(runs).toEqual([0, 1]);
  });

  it('should leave an effect in a body built first running, which is what a function is for', () => {
    const s = mounted();
    const app = new State(0);
    const runs: number[] = [];
    const handle = openModal(s.view, { body: follower(app, runs)(), input: s.input });
    handle.close();
    app.set(1);
    flush();
    expect(runs).toEqual([0, 1]);
  });

  it('should stop it for every way a dialog ends', async () => {
    const ended: Array<(s: ReturnType<typeof mounted>, handle: { close(): void }) => unknown> = [
      (_, handle) => handle.close(),
      async (s) => escape(s.term),
      async (s) => s.term.press(KEYS.enter),
      (s) => s.view.dispose(),
    ];
    for (const end of ended) {
      const s = mounted();
      const app = new State(0);
      const runs: number[] = [];
      const handle = openModal(s.view, { body: follower(app, runs), input: s.input });
      await end(s, handle);
      expect(handle.open).to.equal(false);
      runs.length = 0;
      app.set(1);
      if (s.view.mounted) {
        s.view.frame();
      } else {
        flush();
      }
      expect(runs).toEqual([]);
    }
  });

  it('should run an onCleanup in the body once, as the dialog closes', () => {
    const s = mounted();
    const seen: string[] = [];
    const handle = openModal(s.view, {
      body: () => {
        onCleanup(() => seen.push(`cleanup, attached: ${handle.element.parent !== undefined}`));
        return text('body');
      },
      input: s.input,
    });
    expect(seen).toEqual([]);
    handle.close();
    handle.close();
    expect(seen).toEqual(['cleanup, attached: true']);
  });

  it('should build it once, whatever the body reads', () => {
    const s = mounted();
    const app = new State('a');
    let built = 0;
    const handle = openModal(s.view, {
      body: () => {
        built++;
        return text(app.get());
      },
      input: s.input,
    });
    app.set('b');
    s.view.frame();
    expect(built).toBe(1);
    handle.close();
  });

  it('should belong to the screen rather than to the component that opened it', () => {
    const s = mounted();
    const app = new State(0);
    const runs: number[] = [];
    let handle!: ReturnType<typeof openModal>;
    // a component that opens a dialog from its own body and then goes while the
    // dialog is up: the dialog is still on the screen holding the keys, so what it
    // built has to go on working, and go when the dialog does
    const unmount = createRoot((dispose) => {
      handle = openModal(s.view, { body: follower(app, runs), input: s.input });
      return dispose;
    });
    unmount();
    expect(handle.open).to.equal(true);
    app.set(1);
    s.view.frame();
    expect(runs).toEqual([0, 1]);

    handle.close();
    app.set(2);
    s.view.frame();
    expect(runs).toEqual([0, 1]);
  });

  it('should not make the effect that opened the dialog depend on what the body reads', () => {
    const s = mounted();
    const app = new State('a');
    let opened = false;
    const handles: Array<{ close(): void }> = [];
    runWithOwner(s.view.owner, () => {
      createEffect(() => {
        // once: opening moves the focus, which this effect reads and so re-runs on
        if (!opened) {
          opened = true;
          handles.push(openModal(s.view, { body: () => text(app.get()), input: s.input }));
        }
      });
    });
    // read before any frame, while the opener's first run is all there has been: a
    // later run sheds its sinks, which is what hid this from the first draft
    expect(sinkCount(app)).toBe(0);
    for (const handle of handles) {
      handle.close();
    }
  });

  it('should hand a cleanup that threw to the renderer when there is one', () => {
    const errors: unknown[] = [];
    const s = scene();
    const view = render(() => s.root, {
      onError: (e) => errors.push(e),
      terminal: s.term.terminal,
    });
    handles.push({ dispose: () => s.input.stop() }, { dispose: () => view.dispose() });
    const handle = openModal(view, {
      body: () => {
        onCleanup(() => {
          throw new Error('cleanup failed');
        });
        return text('body');
      },
      input: s.input,
    });
    handle.close();
    expect(handle.open).to.equal(false);
    expect(errors.map((e) => (e as Error).message)).toEqual(['cleanup failed']);
  });

  it('should leave nothing running when the function throws on a bare element too', () => {
    const s = scene();
    handles.push({ dispose: () => s.input.stop() });
    const app = new State(0);
    const runs: number[] = [];
    expect(() =>
      openModal(s.root, {
        body: () => {
          createEffect(() => {
            runs.push(app.get());
          });
          throw new Error('no body');
        },
        input: s.input,
      })
    ).toThrow('no body');
    app.set(1);
    flush();
    expect(runs).toEqual([0]);
  });

  it('should be built and disposed under a root of its own on a host that is a bare element', () => {
    const s = scene();
    handles.push({ dispose: () => s.input.stop() });
    const app = new State(0);
    const runs: number[] = [];
    const handle = openModal(s.root, { body: follower(app, runs), input: s.input });
    app.set(1);
    flush();
    expect(runs).toEqual([0, 1]);
    handle.close();
    app.set(2);
    flush();
    expect(runs).toEqual([0, 1]);
  });

  it('should keep a computed read in the body live while open and let go after', () => {
    const s = mounted();
    const app = new State(1);
    let doubled: Computed<number> | undefined;
    const seen: number[] = [];
    const handle = openModal(s.view, {
      body: () => {
        doubled = new Computed(() => app.get() * 2);
        createEffect(() => {
          seen.push(doubled!.get());
        });
        return text('body');
      },
      input: s.input,
    });
    app.set(2);
    s.view.frame();
    handle.close();
    app.set(3);
    s.view.frame();
    expect(seen).toEqual([2, 4]);
  });

  it('should draw what the function returned, in the body', async () => {
    const s = mounted();
    openModal(s.view, { body: () => text('built late'), input: s.input, title: 'T' });
    await settle();
    expect(screen(s.root)).to.include('built late');
  });

  it('should leave nothing open, and nothing running, when the function throws', () => {
    const s = mounted();
    const app = new State(0);
    const runs: number[] = [];
    expect(() =>
      openModal(s.view, {
        body: () => {
          createEffect(() => {
            runs.push(app.get());
          });
          throw new Error('no body');
        },
        input: s.input,
      })
    ).toThrow('no body');
    app.set(1);
    s.view.frame();
    expect(runs).toEqual([0]);
    // and no dialog took the keys
    expect(s.root.children.length).toBe(2);
  });

  it('should refuse an answer that is not an element, with nothing left running', () => {
    const s = mounted();
    const app = new State(0);
    const runs: number[] = [];
    expect(() =>
      openModal(s.view, {
        body: (() => {
          createEffect(() => {
            runs.push(app.get());
          });
          return 'words';
        }) as unknown as () => Element,
        input: s.input,
      })
    ).toThrow('Expected a modal body function to return an element');
    app.set(1);
    s.view.frame();
    expect(runs).toEqual([0]);
  });

  it('should still settle, and say so, when a cleanup in the body throws', async () => {
    const s = scene();
    handles.push({ dispose: () => s.input.stop() });
    const handle = openModal(s.root, {
      body: () => {
        onCleanup(() => {
          throw new Error('cleanup failed');
        });
        return text('body');
      },
      input: s.input,
    });
    expect(() => handle.close()).toThrow(/cleanup failed/);
    expect(handle.open).to.equal(false);
    expect(handle.element.parent).to.equal(undefined);
    expect(await handle.result).to.equal(undefined);
  });

  it('should refuse a body that is none of a string, an element or a function', () => {
    const s = scene();
    handles.push({ dispose: () => s.input.stop() });
    expect(() => openModal(s.root, { body: 42 as unknown as string, input: s.input })).toThrow(
      'Expected a modal body to be a string, an element or a function'
    );
  });
});

/**
 * A dialog that is a form (SIG-337): its buttons can be disabled, it can open on
 * a field in its body, and Enter in a field can press a default action.
 */
describe('a dialog that is a form', () => {
  /** A scene mounted under a renderer, so that the host has a root owner. */
  function mounted() {
    const s = scene();
    const view = render(() => s.root, { terminal: s.term.terminal });
    handles.push({ dispose: () => s.input.stop() }, { dispose: () => view.dispose() });
    return { ...s, view };
  }

  /** The buttons of a dialog's action row, in order. */
  const buttonsOf = (handle: { element: Element }): readonly Element[] =>
    handle.element.children[0]?.children.at(-1)?.children ?? [];

  /** A name field, an email field, and the answers a form has. */
  function fields() {
    const name = TextField({ value: new State('') });
    const email = TextField({ value: new State('') });
    return { email, name };
  }

  describe('disabled', () => {
    it('should keep a disabled action from being pressed, tabbed to or clicked', async () => {
      const s = scene();
      const off = new State(true);
      const handle = modalOn<string>(s, {
        actions: [
          { disabled: off, label: 'Save', value: 'save' },
          { label: 'Cancel', value: 'cancel' },
        ],
      });
      await settle();

      // the first action is not what holds the focus: it cannot, and Tab wraps
      // from Cancel back to Cancel
      const [save, cancel] = buttonsOf(handle);
      expect(s.input.focus.current.get()).to.equal(cancel);
      await s.term.press(KEYS.tab);
      expect(s.input.focus.current.get()).to.equal(cancel);
      expect(save?.focusable).to.equal(false);
      expect(handle.open).to.equal(true);

      off.set(false);
      await settle();
      await s.term.press(KEYS.tab);
      expect(screen(s.root)).to.include('[ Save ]');
      await s.term.press(KEYS.enter);
      expect(await handle.result).to.equal('save');
    });

    it.each([
      ['a Computed', (state: State<boolean>) => new Computed(() => !state.get())],
      ['a function', (state: State<boolean>) => () => !state.get()],
    ])('should follow %s as it changes', async (_, derive) => {
      const s = scene();
      const valid = new State(false);
      const handle = modalOn<string>(s, {
        actions: [
          { disabled: derive(valid), label: 'Save', value: 'save' },
          { label: 'Cancel', value: 'cancel' },
        ],
        initial: 0,
      });
      await settle();
      await s.term.press(KEYS.enter);
      // Save is disabled, so the focus began on Cancel and Enter pressed that
      expect(await handle.result).to.equal('cancel');

      valid.set(true);
      const again = modalOn<string>(s, {
        actions: [{ disabled: derive(valid), label: 'Save', value: 'save' }],
      });
      await settle();
      await s.term.press(KEYS.enter);
      expect(await again.result).to.equal('save');
    });

    it('should open on the first thing that can take the focus when the chosen action is disabled', async () => {
      const s = scene();
      const handle = modalOn(s, {
        actions: [{ disabled: true, label: 'Save' }, { label: 'Cancel' }],
        initial: 0,
      });
      await settle();
      // Cancel holds it: Save is not in the ring
      expect(s.input.focus.current.get()).to.equal(buttonsOf(handle)[1]);
    });

    it('should stop the effect that reads it when the dialog closes', async () => {
      const s = mounted();
      const app = new State(false);
      const reads: boolean[] = [];
      const handle = openModal(s.view, {
        actions: [
          {
            disabled: () => {
              reads.push(app.get());
              return app.get();
            },
            label: 'Save',
          },
        ],
        input: s.input,
      });
      expect(reads).toEqual([false]);
      app.set(true);
      s.view.frame();
      expect(reads).toEqual([false, true]);

      handle.close();
      app.set(false);
      s.view.frame();
      expect(reads).toEqual([false, true]);
    });

    it('should refuse a disabled that is not a condition', () => {
      const s = scene();
      handles.push({ dispose: () => s.input.stop() });
      expect(() =>
        openModal(s.root, {
          actions: [{ disabled: 'yes' as unknown as boolean, label: 'Save' }],
          input: s.input,
        })
      ).toThrow(
        'Expected modal action disabled to be a boolean, a State, a Computed or a function'
      );
    });
  });

  describe('initial', () => {
    it("should open on the first field in the body with 'body', its buttons staying actions", async () => {
      const s = scene();
      const { email, name } = fields();
      modalOn(s, {
        actions: [{ label: 'Save' }, { label: 'Cancel' }],
        body: box({ 'flex-direction': 'column' }, name, email),
        initial: 'body',
      });
      await settle();
      expect(s.input.focus.current.get()).to.equal(name);
      // and the buttons are still in the ring, after the fields
      await s.term.press(KEYS.tab, KEYS.tab);
      expect(screen(s.root)).to.include('[ Save ]');
    });

    it("should open on the first field of a body function with 'body'", async () => {
      const s = scene();
      let name: Element | undefined;
      modalOn(s, {
        actions: [{ label: 'Save' }],
        body: () => {
          name = TextField({ value: new State('') });
          return box({}, name);
        },
        initial: 'body',
      });
      await settle();
      expect(s.input.focus.current.get()).to.equal(name);
    });

    it("should fall back to the first button when 'body' has nothing to focus", async () => {
      const s = scene();
      modalOn(s, {
        actions: [{ label: 'Save' }, { label: 'Cancel' }],
        body: 'Words',
        initial: 'body',
      });
      await settle();
      await s.term.press(KEYS.enter);
      expect(screen(s.root)).to.not.include('Words');
    });

    it('should open on an element in the body', async () => {
      const s = scene();
      const { email, name } = fields();
      modalOn(s, {
        actions: [{ label: 'Save' }],
        body: box({ 'flex-direction': 'column' }, name, email),
        initial: email,
      });
      await settle();
      expect(s.input.focus.current.get()).to.equal(email);
    });

    it('should refuse an element that is not in the body, with nothing attached', () => {
      const s = scene();
      handles.push({ dispose: () => s.input.stop() });
      const { email, name } = fields();
      const children = s.root.children.length;
      expect(() => openModal(s.root, { body: name, initial: email, input: s.input })).toThrow(
        'Expected modal initial to be an element in the body'
      );
      expect(s.root.children.length).to.equal(children);
    });

    it('should refuse an element when there is no body, and dispose what it built', () => {
      const s = mounted();
      const app = new State(0);
      const reads: number[] = [];
      expect(() =>
        openModal(s.view, {
          actions: [{ disabled: () => reads.push(app.get()) === 0, label: 'Save' }],
          initial: text('elsewhere'),
          input: s.input,
        })
      ).toThrow('Expected modal initial to be an element in the body');
      app.set(1);
      s.view.frame();
      expect(reads).toEqual([0]);
    });

    it.each([['footer'], [-1], [1.5], [2]])('should refuse %j', (initial) => {
      const s = scene();
      handles.push({ dispose: () => s.input.stop() });
      expect(() =>
        openModal(s.root, {
          actions: [{ label: 'A' }, { label: 'B' }],
          initial: initial as unknown as number,
          input: s.input,
        })
      ).toThrow(
        "Expected modal initial to be the position of an action, 'body' or an element in the body"
      );
    });
  });

  describe('the default action', () => {
    it('should press on Enter in a field that leaves it alone, once the action is enabled', async () => {
      const s = scene();
      const ok = new State(false);
      const { name } = fields();
      const handle = modalOn<string>(s, {
        actions: [
          { default: true, disabled: () => !ok.get(), label: 'Save', value: 'saved' },
          { label: 'Cancel', value: 'cancelled' },
        ],
        body: name,
        initial: 'body',
      });
      await settle();

      // disabled: Enter in the field does nothing, and does not reach the app
      await s.term.press('ada', KEYS.enter);
      expect(handle.open).to.equal(true);
      expect(s.seen).to.deep.equal([]);

      ok.set(true);
      await settle();
      await s.term.press(KEYS.enter);
      expect(await handle.result).to.equal('saved');
    });

    it('should leave Enter to a field with an onSubmit, and to the button that has the focus', async () => {
      const s = scene();
      const submitted: string[] = [];
      const field = TextField({
        onSubmit: () => submitted.push('field'),
        value: new State(''),
      });
      const handle = modalOn<string>(s, {
        actions: [
          { default: true, label: 'Save', value: 'saved' },
          { label: 'Cancel', value: 'cancelled' },
        ],
        body: field,
        initial: 'body',
      });
      await settle();
      await s.term.press(KEYS.enter);
      expect(submitted).to.deep.equal(['field']);
      expect(handle.open).to.equal(true);

      // on Cancel, Enter is Cancel's and not the default's
      await s.term.press(KEYS.tab, KEYS.tab);
      await s.term.press(KEYS.enter);
      expect(await handle.result).to.equal('cancelled');
    });

    it('should not press on an Enter with a modifier or a pasted one', async () => {
      const s = scene();
      const { name } = fields();
      const handle = modalOn<string>(s, {
        actions: [{ default: true, label: 'Save', value: 'saved' }],
        body: name,
        initial: 'body',
      });
      await settle();
      await s.term.press(alt(KEYS.enter));
      await s.term.paste('ada\r');
      expect(handle.open).to.equal(true);
      await s.term.press(KEYS.enter);
      expect(await handle.result).to.equal('saved');
    });

    it('should press a default that has an onPress, and leave the dialog open', async () => {
      const s = scene();
      const { name } = fields();
      const pressed: string[] = [];
      const handle = modalOn<string>(s, {
        actions: [{ default: true, label: 'Save', onPress: () => pressed.push('save') }],
        body: name,
        initial: 'body',
      });
      await settle();
      await s.term.press(KEYS.enter, KEYS.enter);
      expect(pressed).to.deep.equal(['save', 'save']);
      expect(handle.open).to.equal(true);
    });

    it('should refuse two defaults', () => {
      const s = scene();
      handles.push({ dispose: () => s.input.stop() });
      expect(() =>
        openModal(s.root, {
          actions: [
            { default: true, label: 'A' },
            { default: true, label: 'B' },
          ],
          input: s.input,
        })
      ).toThrow('Expected a modal to have one default action at most');
    });
  });

  describe('onPress', () => {
    it('should run in place of settling the dialog, which stays open until the handler closes it', async () => {
      const s = scene();
      let handle: ReturnType<typeof modalOn<string>> | undefined;
      const pressed: number[] = [];
      handle = modalOn<string>(s, {
        actions: [
          {
            label: 'Sign in',
            onPress: () => {
              pressed.push(pressed.length);
              if (pressed.length === 2) {
                handle?.close('in');
              }
            },
          },
        ],
      });
      await settle();
      await s.term.press(KEYS.enter);
      expect(handle.open).to.equal(true);
      await s.term.press(KEYS.enter);
      expect(await handle.result).to.equal('in');
    });

    it('should be pressed by a click too', async () => {
      const s = scene();
      const pressed: string[] = [];
      const handle = modalOn(s, {
        actions: [{ label: 'Go', onPress: () => pressed.push('go') }],
      });
      await settle();
      const [button] = buttonsOf(handle);
      const click = mouseEvent('click', button);
      button?.onMouse?.(click);
      expect(pressed).to.deep.equal(['go']);
    });

    it('should refuse a value and an onPress together, or an onPress that is not a function', () => {
      const s = scene();
      handles.push({ dispose: () => s.input.stop() });
      expect(() =>
        openModal<string>(s.root, {
          actions: [{ label: 'A', onPress: () => {}, value: 'a' }],
          input: s.input,
        })
      ).toThrow('Expected a modal action to have a value or an onPress, not both');
      expect(() =>
        openModal(s.root, {
          actions: [{ label: 'A', onPress: 'no' as unknown as () => void }],
          input: s.input,
        })
      ).toThrow('Expected a modal action onPress to be a function');
    });
  });
});
