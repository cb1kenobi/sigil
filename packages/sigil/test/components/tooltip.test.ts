import { strip } from '../../src/ansi/index.js';
import {
  attachTooltip,
  placeTooltip,
  type TooltipOptions,
  type TooltipSide,
} from '../../src/components/tooltip.js';
import { box, type Element, renderToLines, text } from '../../src/element/index.js';
import { createInput, ESCAPE_TIMEOUT, type InputRouter } from '../../src/input/index.js';
import { createRoot } from '../../src/renderer/index.js';
import { flush } from '../../src/signals/index.js';
import { setQuiet } from '../../src/style/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A tooltip: where it goes, what shows it, and what it never takes.
 *
 * Driven through a real router over a test terminal, with mouse reports fed as
 * the bytes a terminal sends, because the claims are about the router's order --
 * the hover state written before anything is told, the focus signal, a binding
 * that sees Escape first -- and a handler called by hand would be in none of them.
 * The clock is faked for the show delay and the Escape deadline, and nothing else:
 * the test terminal settles on `setImmediate`.
 */

const WIDTH = 40;
const HEIGHT = 12;
const ESC = String.fromCharCode(0x1b);

/** Pointer motion with nothing held, at a one-based screen cell. */
const move = (column: number, row: number) => `${ESC}[<35;${column};${row}M`;
/** A left press and its release. */
const click = (column: number, row: number) => [
  `${ESC}[<0;${column};${row}M`,
  `${ESC}[<0;${column};${row}m`,
];

/** A canvas at the screen's origin, which is all the router asks of one. */
function surface() {
  return {
    height: HEIGHT,
    locate: async () => true,
    origin: { x: 0, y: 0 },
    toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
    width: WIDTH,
  };
}

/** The screen as a person would read it, trailing space trimmed. Also lays the tree out. */
function picture(root: Element): string[] {
  return renderToLines(root, {
    cascade: themedCascade(),
    colorLevel: 0,
    height: HEIGHT,
    width: WIDTH,
  }).map((line) => strip(line).trimEnd());
}

/**
 * An app with an anchor somewhere on it, and a router over it.
 *
 * `at` puts the anchor's top-left corner on a cell, which is how a test reaches an
 * edge or a corner of the screen.
 */
function scene(
  opts: { at?: { x: number; y: number }; mouse?: boolean; offset?: { x: number; y: number } } = {}
) {
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const anchor = text('Save', { focusable: true, id: 'anchor' });
  const other = text('Other', { focusable: true, id: 'other' });
  const at = opts.at ?? { x: 2, y: 2 };
  const root = box(
    {
      height: HEIGHT,
      left: opts.offset?.x,
      position: 'relative',
      top: opts.offset?.y,
      width: WIDTH,
    },
    box({ left: at.x, position: 'absolute', top: at.y }, anchor),
    box({ left: 30, position: 'absolute', top: 0 }, other)
  );
  const input = createInput({
    ...(opts.mouse === false ? {} : { mouse: { motion: true, surface: surface() } }),
    root,
    terminal: term.terminal,
  });
  routers.push(input);
  picture(root);
  return { anchor, at, input, other, root, term };
}

const routers: InputRouter[] = [];
const handles: Array<{ dispose(): void }> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  setQuiet(undefined);
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
  for (const input of routers.splice(0)) {
    input.stop();
  }
  vi.useRealTimers();
});

/** Attaches a tooltip and registers it for cleanup. */
function tipOn(s: ReturnType<typeof scene>, opts: Partial<TooltipOptions> = {}) {
  const handle = attachTooltip(s.anchor, {
    ascii: true,
    input: s.input,
    text: 'Writes it',
    ...opts,
  });
  handles.push(handle);
  return handle;
}

/** Moves the pointer onto the anchor's first cell, wherever the layout put it. */
async function hover(s: ReturnType<typeof scene>): Promise<void> {
  const at = s.anchor.box ?? { x: 0, y: 0 };
  await s.term.press(move(at.x + 1, at.y + 1));
}

/** Lets the delay run out, and the effects it caused. */
function wait(ms = 500): void {
  vi.advanceTimersByTime(ms);
  flush();
}

describe('placeTooltip()', () => {
  const screen = { height: 10, width: 20, x: 0, y: 0 };
  const size = { height: 3, width: 8 };
  const at = (x: number, y: number, width = 4) => ({ height: 1, width, x, y });

  it.each<[string, ReturnType<typeof at>, TooltipSide, TooltipSide, number, number]>([
    // the preferred side, where it fits, starting where the anchor starts
    ['below, with room', at(5, 2), 'bottom', 'bottom', 5, 3],
    ['above, with room', at(5, 5), 'top', 'top', 5, 2],
    ['right, with room', at(2, 2), 'right', 'right', 6, 2],
    ['left, with room', at(12, 2), 'left', 'left', 4, 2],
    // each edge flips the main axis to the other side
    ['the bottom edge', at(5, 8), 'bottom', 'top', 5, 5],
    ['the top edge', at(5, 1), 'top', 'bottom', 5, 2],
    ['the right edge', at(14, 2), 'right', 'left', 6, 2],
    ['the left edge', at(3, 2), 'left', 'right', 7, 2],
    // the far edge of the cross axis ends the bubble where the anchor ends
    ['the right edge, below', at(14, 2), 'bottom', 'bottom', 10, 3],
    ['the bottom edge, beside', at(2, 8, 2), 'right', 'right', 4, 6],
    // a corner is both at once
    ['the bottom-right corner', at(16, 9), 'bottom', 'top', 12, 6],
    ['the top-right corner', at(16, 0), 'top', 'bottom', 12, 1],
    ['the bottom-left corner', at(0, 9, 2), 'left', 'right', 2, 7],
    ['the top-right corner, beside', at(18, 0, 2), 'right', 'left', 10, 0],
  ])('should place it at %s', (_, anchor, side, landed, x, y) => {
    expect(placeTooltip(anchor, size, screen, side)).toEqual({ side: landed, x, y });
  });

  it('should take the side with more room where neither fits, and cover the anchor', () => {
    // two rows below, one above, and three needed: below has more, and the clamp
    // pulls the bubble up over the anchor rather than off the screen
    const short = { height: 4, width: 20, x: 0, y: 0 };
    expect(placeTooltip(at(5, 1), size, short, 'top')).toEqual({ side: 'bottom', x: 5, y: 1 });
  });

  it('should keep the preferred side on a tie', () => {
    const short = { height: 3, width: 20, x: 0, y: 0 };
    expect(placeTooltip(at(5, 1), size, short, 'top').side).toBe('top');
    expect(placeTooltip(at(5, 1), size, short, 'bottom').side).toBe('bottom');
  });

  it('should start a bubble wider than the screen at its left edge', () => {
    expect(placeTooltip(at(5, 2), { height: 3, width: 30 }, screen, 'bottom')).toEqual({
      side: 'bottom',
      x: 0,
      y: 3,
    });
  });

  it('should place against a screen that is not at the origin', () => {
    const offset = { height: 10, width: 20, x: 10, y: 5 };
    expect(placeTooltip(at(26, 14), size, offset, 'bottom')).toEqual({
      side: 'top',
      x: 22,
      y: 11,
    });
  });
});

describe('attachTooltip()', () => {
  it('should show after the delay while the anchor is hovered, and not before', async () => {
    const s = scene();
    const tip = tipOn(s);
    await hover(s);

    wait(499);
    expect(tip.shown).toBe(false);
    wait(1);
    expect(tip.shown).toBe(true);

    // below the anchor, starting where it starts, and the anchor where it was
    const lines = picture(s.root);
    expect(tip.side).toBe('bottom');
    expect(lines[2]?.slice(2, 6)).toBe('Save');
    expect(lines[3]?.slice(2)).toMatch(/^\+-+\+$/);
    expect(lines[4]?.slice(2)).toBe('| Writes it |');
  });

  it('should hide the moment the pointer leaves', async () => {
    const s = scene();
    const tip = tipOn(s);
    await hover(s);
    wait();
    picture(s.root);

    await s.term.press(move(20, 10));
    expect(tip.shown).toBe(false);
    expect(picture(s.root).join('\n')).not.toContain('Writes it');
  });

  it('should not show for a pointer that passed over before the delay ran out', async () => {
    const s = scene();
    const tip = tipOn(s);
    await hover(s);
    wait(200);
    await s.term.press(move(20, 10));
    wait(1000);
    expect(tip.shown).toBe(false);
  });

  it('should stay while the pointer moves from the anchor onto the bubble', async () => {
    // content shown on hover has to be hoverable, or it cannot be read by
    // anybody who needs the pointer to follow the words
    const s = scene();
    const tip = tipOn(s);
    await hover(s);
    wait();
    picture(s.root);

    await s.term.press(move(s.at.x + 6, s.at.y + 3));
    expect(tip.element?.states).toContain('hover');
    expect(tip.shown).toBe(true);
  });

  it('should not show for a hover that ended in reports the tree stopped', async () => {
    // the state is the answer and an event only the reminder, so the timer asks
    // the state again rather than trusting that a leave would have reached it
    const s = scene();
    const tip = tipOn(s);
    await hover(s);
    // the anchor stops its own leave, and the root every motion after it
    s.anchor.onMouse = (event) => event.stop();
    s.root.onMouse = (event) => event.stop();
    await s.term.press(move(20, 10));
    expect(s.anchor.states).toEqual([]);

    wait(1000);
    expect(tip.shown).toBe(false);
  });

  it('should not show for an anchor taken out of the tree while it waited', async () => {
    const s = scene();
    const tip = tipOn(s);
    await hover(s);
    s.anchor.remove();

    wait(1000);
    expect(tip.shown).toBe(false);
  });

  it('should leave the anchor its own mouse handler', async () => {
    const s = scene();
    const seen: string[] = [];
    s.anchor.onMouse = (event) => void seen.push(event.kind);
    const tip = tipOn(s);
    await hover(s);
    wait();

    expect(seen).toContain('mouseenter');
    expect(tip.shown).toBe(true);
  });

  it('should flip above an anchor on the bottom row', async () => {
    const s = scene({ at: { x: 2, y: HEIGHT - 1 } });
    const tip = tipOn(s);
    await hover(s);
    wait();

    const lines = picture(s.root);
    expect(tip.side).toBe('top');
    expect(lines[HEIGHT - 2]?.slice(2)).toMatch(/^\+-+\+$/);
    expect(lines[HEIGHT - 3]?.slice(2)).toBe('| Writes it |');
    expect(lines[HEIGHT - 1]?.slice(2)).toBe('Save');
  });

  it('should end where the anchor ends against the right edge', async () => {
    const s = scene({ at: { x: WIDTH - 4, y: 2 } });
    const tip = tipOn(s);
    await hover(s);
    wait();

    const lines = picture(s.root);
    expect(lines[4]?.endsWith('| Writes it |')).toBe(true);
    expect(lines[4]?.length).toBe(WIDTH);
    expect(tip.side).toBe('bottom');
  });

  it('should flip both ways in the bottom-right corner', async () => {
    const s = scene({ at: { x: WIDTH - 4, y: HEIGHT - 1 } });
    const tip = tipOn(s, { side: 'right' });
    await hover(s);
    wait();

    // no room on the right, so it goes on the left -- and no room below its start,
    // so it ends on the anchor's row instead of starting there
    const lines = picture(s.root);
    expect(tip.side).toBe('left');
    expect(lines[HEIGHT - 1]).toMatch(/\+-+\+Save$/);
    expect(lines[HEIGHT - 2]).toMatch(/\| Writes it \|$/);
  });

  it('should place against a root the layout moved off the origin', async () => {
    // `left` and `top` resolve against the root's box, so the placement has to be
    // handed back in the root's terms rather than the screen's
    const s = scene({ offset: { x: 3, y: 1 } });
    const tip = tipOn(s);
    await hover(s);
    wait();
    picture(s.root);

    const anchor = s.anchor.box;
    expect(anchor).toMatchObject({ x: 5, y: 3 });
    expect(tip.element?.box).toMatchObject({ x: 5, y: 4 });
  });

  it('should hide what is under the bubble, with no colour, over a raised box', async () => {
    const s = scene();
    // raised, so it is the z-index and not the order of appending that puts the
    // bubble over it
    s.root.append(
      box(
        { left: 0, position: 'absolute', top: 4, 'z-index': 10 },
        text('#'.repeat(WIDTH), { id: 'wall' })
      )
    );
    picture(s.root);
    const tip = tipOn(s);
    await hover(s);
    wait();

    const row = picture(s.root)[4] ?? '';
    expect(tip.shown).toBe(true);
    expect(row.slice(2, 15)).toBe('| Writes it |');
    expect(row.slice(0, 2)).toBe('##');
  });

  describe('the keyboard', () => {
    it('should show on focus, with no mouse tracked at all', () => {
      const s = scene({ mouse: false });
      const tip = tipOn(s);

      s.input.focus.focus(s.anchor);
      flush();
      wait();
      expect(tip.shown).toBe(true);
      expect(picture(s.root)[4]?.slice(2)).toBe('| Writes it |');

      s.input.focus.focus(s.other);
      flush();
      expect(tip.shown).toBe(false);
    });

    it('should show on Tab, after the same delay', async () => {
      const s = scene({ mouse: false });
      const tip = tipOn(s);

      await s.term.press(KEYS.tab);
      flush();
      expect(s.input.focus.current.get()).toBe(s.anchor);
      wait(499);
      expect(tip.shown).toBe(false);
      wait(1);
      expect(tip.shown).toBe(true);
    });

    it('should show for the focus anywhere inside the anchor', () => {
      const s = scene({ mouse: false });
      const inner = text('inner', { focusable: true });
      const holder = box({}, inner);
      s.root.append(holder);
      picture(s.root);
      const tip = attachTooltip(holder, { input: s.input, text: 'Holds one' });
      handles.push(tip);

      s.input.focus.focus(inner);
      flush();
      wait();
      expect(tip.shown).toBe(true);
    });

    it('should hide on Escape without taking it from the app', async () => {
      const s = scene();
      const tip = tipOn(s);
      const heard: string[] = [];
      // bound after the tooltip, so a tooltip that stopped Escape would starve it
      s.input.bind((event) => void heard.push(event.key.name));
      s.anchor.onKey = (event) => void heard.push(`anchor:${event.key.name}`);

      s.input.focus.focus(s.anchor);
      flush();
      wait();
      expect(tip.shown).toBe(true);

      await s.term.press(KEYS.escape);
      wait(ESCAPE_TIMEOUT + 1);
      expect(tip.shown).toBe(false);
      expect(heard).toEqual(['escape', 'anchor:escape']);
    });

    it('should not carry an Escape pressed over nothing to the next hover', async () => {
      const s = scene();
      const tip = tipOn(s);
      await s.term.press(KEYS.escape);
      wait(ESCAPE_TIMEOUT + 1);

      await hover(s);
      wait();
      expect(tip.shown).toBe(true);
    });

    it('should stay dismissed until the focus leaves and comes back', async () => {
      const s = scene({ mouse: false });
      const tip = tipOn(s);

      s.input.focus.focus(s.anchor);
      flush();
      wait();
      await s.term.press(KEYS.escape);
      wait(ESCAPE_TIMEOUT + 1);
      wait(1000);
      expect(tip.shown).toBe(false);

      s.input.focus.focus(s.other);
      flush();
      s.input.focus.focus(s.anchor);
      flush();
      wait();
      expect(tip.shown).toBe(true);
    });
  });

  describe('the focus', () => {
    it('should never take it, whether the bubble is shown on hover or on focus', async () => {
      const s = scene();
      const tip = tipOn(s);
      s.input.focus.focus(s.other);
      flush();

      await hover(s);
      wait();
      picture(s.root);
      expect(tip.shown).toBe(true);
      expect(s.input.focus.current.get()).toBe(s.other);
      expect(s.input.focus.ring()).toEqual([s.anchor, s.other]);
    });

    it('should leave the focus alone when the bubble is clicked', async () => {
      const s = scene();
      const tip = tipOn(s);
      s.input.focus.focus(s.other);
      flush();
      await hover(s);
      wait();
      picture(s.root);

      await s.term.press(...click(s.at.x + 6, s.at.y + 3));
      expect(tip.shown).toBe(true);
      expect(s.input.focus.current.get()).toBe(s.other);
    });
  });

  describe('the quiet axis', () => {
    it('should not show under --quiet', async () => {
      const s = scene();
      setQuiet(true);
      const tip = tipOn(s);
      await hover(s);
      wait();
      expect(tip.shown).toBe(false);
    });

    it('should read --quiet when it shows, not when it was attached', async () => {
      const s = scene();
      const tip = tipOn(s);
      setQuiet(true);
      await hover(s);
      wait();
      expect(tip.shown).toBe(false);
    });

    it('should show under --quiet where it says it is not chrome', async () => {
      const s = scene();
      setQuiet(true);
      const tip = tipOn(s, { quiet: false });
      await hover(s);
      wait();
      expect(tip.shown).toBe(true);
    });
  });

  describe('the timer', () => {
    it('should be cleared by dispose(), with the bubble', async () => {
      const s = scene();
      const tip = tipOn(s);
      await hover(s);
      expect(vi.getTimerCount()).toBe(1);

      tip.dispose();
      expect(vi.getTimerCount()).toBe(0);
      wait(1000);
      expect(tip.shown).toBe(false);
    });

    it('should be cleared when the component it was attached in unmounts', async () => {
      const s = scene();
      let tip: ReturnType<typeof attachTooltip> | undefined;
      const unmount = createRoot((dispose) => {
        tip = attachTooltip(s.anchor, { input: s.input, text: 'Writes it' });
        return dispose;
      });
      await hover(s);
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
      wait(1000);
      expect(tip?.shown).toBe(false);
    });

    it('should take a shown bubble out of the tree on unmount', async () => {
      const s = scene();
      let tip: ReturnType<typeof attachTooltip> | undefined;
      const unmount = createRoot((dispose) => {
        tip = attachTooltip(s.anchor, { delay: 0, input: s.input, text: 'Writes it' });
        return dispose;
      });
      await hover(s);
      const bubble = tip?.element;
      expect(bubble?.parent).toBe(s.root);

      unmount();
      expect(bubble?.parent).toBeUndefined();
    });
  });

  it('should re-place what it says when the words change', async () => {
    const s = scene();
    const tip = tipOn(s, { delay: 0 });
    await hover(s);
    picture(s.root);

    tip.setText('Writes it to disk');
    expect(picture(s.root)[4]?.slice(2)).toBe('| Writes it to disk |');
  });

  it('should wrap at maxWidth', async () => {
    const s = scene();
    tipOn(s, { delay: 0, maxWidth: 12, text: 'Writes the file' });
    await hover(s);

    const lines = picture(s.root);
    expect(lines[4]?.slice(2)).toBe('| Writes   |');
    expect(lines[5]?.slice(2)).toBe('| the file |');
  });

  it('should place a fresh bubble after a resize', async () => {
    const s = scene();
    const tip = tipOn(s, { delay: 0 });
    await hover(s);
    picture(s.root);
    const before = tip.element;

    s.term.resize(WIDTH, HEIGHT);
    expect(tip.shown).toBe(true);
    expect(tip.element).not.toBe(before);
  });

  it('should refuse what it cannot use', () => {
    const s = scene();
    const ok = { input: s.input, text: 'x' };
    expect(() => attachTooltip({} as never, ok)).toThrow(TypeError);
    expect(() => attachTooltip(s.anchor, { ...ok, input: {} as never })).toThrow('router');
    expect(() => attachTooltip(s.anchor, { ...ok, text: 5 as never })).toThrow('text');
    expect(() => attachTooltip(s.anchor, { ...ok, side: 'up' as never })).toThrow('side');
    expect(() => attachTooltip(s.anchor, { ...ok, delay: -1 })).toThrow('delay');
    expect(() => attachTooltip(s.anchor, { ...ok, maxWidth: 2 })).toThrow('maxWidth');
    expect(() => attachTooltip(s.anchor, { ...ok, quiet: 'no' as never })).toThrow('quiet');
  });
});
