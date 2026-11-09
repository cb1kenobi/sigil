import { strip } from '../../src/ansi/index.js';
import { keyHelp } from '../../src/components/key-help.js';
import type { Key } from '../../src/components/keys.js';
import { describeSlider, Slider, type SliderDescriber } from '../../src/components/slider.js';
import {
  arrange,
  box,
  type Element,
  renderToLines,
  renderToString,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import {
  createInput,
  type DescribeOptions,
  type KeyEvent,
  type MouseEvent,
} from '../../src/input/index.js';
import type { MouseButton, MouseEventKind } from '../../src/input/mouse.js';
import { flush, State } from '../../src/signals/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A slider: the track, the keys, the pointer and the readout.
 *
 * Most of it is driven through the handlers the router would call, for the
 * reason `scroll-box.test.ts` gives; the last block goes through a real router,
 * because whether a press focuses the slider and a drag that leaves the canvas
 * still ends are questions about the ring and the capture rather than about the
 * component.
 */

const ESC = String.fromCharCode(0x1b);

/** The tree as it would be drawn, with colour taken off and the right edge trimmed. */
function picture(root: Element, width = 30): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel: 0, height: 1, width }).map(
    (line) => strip(line).trimEnd()
  );
}

/** A part of a slider, by its class. */
function part(host: Element, name: string): Element {
  const walk = (it: Element): Element | undefined =>
    it.classes.includes(name)
      ? it
      : it.children.reduce<Element | undefined>((hit, child) => hit ?? walk(child), undefined);
  const found = walk(host);
  if (!found) {
    throw new Error(`no ${name}`);
  }
  return found;
}

const trackOf = (host: Element): Element => part(host, 'sigil-slider-track');

/** A key event as the router builds one, with a record of whether it was stopped. */
function keyEvent(
  name: string,
  mods: Partial<Pick<Key, 'ctrl' | 'meta' | 'shift'>> = {},
  paste = false
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

/** A mouse event as the router builds one, with a record of whether it was stopped. */
function mouseEvent(
  kind: MouseEventKind,
  x: number,
  button: MouseButton | null = 'left'
): MouseEvent & { claimed: () => boolean } {
  let stopped = false;
  return {
    button: button ?? undefined,
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
    wheel: kind === 'wheel' ? 'down' : undefined,
    x,
    y: 0,
  };
}

/** Presses a key on the slider, then lets the effects that draw it run. */
function press(host: Element, name: string, mods: Parameters<typeof keyEvent>[1] = {}): boolean {
  const event = keyEvent(name, mods);
  host.onKey?.(event);
  flush();
  return event.claimed();
}

/** Sends the track a mouse event, then lets the effects run. */
function pointer(
  host: Element,
  kind: MouseEventKind,
  x: number,
  button?: MouseButton | null
): boolean {
  const event = mouseEvent(kind, x, button);
  trackOf(host).onMouse?.(event);
  flush();
  return event.claimed();
}

/** Lays a tree out, which is what the pointer's columns are read against. */
function lay(root: Element, width = 30): void {
  resolveStyles(root);
  arrange(root, { height: 1, width });
}

/** A slider alone in a column, `width` wide, with the track as wide as the column. */
function column(host: Element, width = 30): Element {
  const root = box({ 'flex-direction': 'column', width }, host);
  lay(root, width);
  return root;
}

describe('Slider', () => {
  describe('the track', () => {
    it('should put the thumb at the bottom, the middle and the top of the range', () => {
      const value = new State(0);
      const root = column(Slider({ ascii: false, value, width: 11 }));

      expect(picture(root)).toEqual(['○──────────']);
      value.set(50);
      flush();
      expect(picture(root)).toEqual(['━━━━━○─────']);
      value.set(100);
      flush();
      expect(picture(root)).toEqual(['━━━━━━━━━━○']);
    });

    it('should draw with ASCII when asked', () => {
      const root = column(Slider({ ascii: true, value: 30, width: 11 }));

      expect(picture(root)).toEqual(['===o-------']);
    });

    it('should take the width the layout gives it, and redraw when that changes', () => {
      const host = Slider({ ascii: false, value: 50 });
      const root = box({ 'flex-direction': 'column' }, host);

      expect(picture(root, 21)).toEqual(['━━━━━━━━━━○──────────']);
      expect(picture(root, 11)).toEqual(['━━━━━○─────']);
    });

    it('should be twenty columns in a row that gives it no width', () => {
      const root = box({ 'flex-direction': 'row' }, text('Vol'), Slider({ ascii: true, value: 0 }));

      expect(picture(root, 40)).toEqual([`Volo${'-'.repeat(19)}`]);
    });

    it('should grow back to twenty columns when a row that was short is wide again', () => {
      // a track sized by what it last drew could only ever stay that size
      const root = box({ 'flex-direction': 'row' }, text('Vol'), Slider({ ascii: true, value: 0 }));

      expect(picture(root, 10)).toEqual(['Volo------']);
      expect(picture(root, 40)).toEqual([`Volo${'-'.repeat(19)}`]);
    });

    it('should shrink to its share of a row that is short', () => {
      const root = box(
        { 'flex-direction': 'row', width: 12 },
        text('Vol', { 'flex-shrink': 0 }),
        Slider({ ascii: true, value: 100 })
      );

      expect(picture(root, 12)).toEqual(['Vol========o']);
    });

    it('should draw a value between two steps, or outside the range, at the nearest step, and leave it as written', () => {
      const value = new State(-40);
      const root = column(Slider({ ascii: true, max: 10, value, width: 11 }));

      expect(picture(root)).toEqual(['o----------']);
      value.set(3.4);
      flush();
      expect(picture(root)).toEqual(['===o-------']);
      value.set(Number.NaN);
      flush();
      expect(picture(root)).toEqual(['o----------']);
      value.set(400);
      flush();
      expect(picture(root)).toEqual(['==========o']);
      expect(value.get()).toBe(400);
    });

    it('should start at min when given no value', () => {
      const host = Slider({ ascii: true, max: 10, min: 4, width: 7 });
      const root = column(host);

      expect(picture(root)).toEqual(['o------']);
      press(host, 'right');
      expect(picture(root)).toEqual(['=o-----']);
    });
  });

  describe('the readout', () => {
    it('should draw what format returns after the track', () => {
      const root = column(Slider({ ascii: true, format: (v) => `${v}%`, value: 40, width: 10 }));

      expect(picture(root)).toEqual(['====o-----  40%']);
    });

    it('should be as wide as the widest value, so the track never moves as the value does', () => {
      // the trap `05-drag.js` walked into: a readout as wide as what it says took a
      // column off its neighbours at exactly 100% and nowhere else
      const value = new State(5);
      const host = Slider({ ascii: true, format: (v) => `${v}%`, value });
      const root = box({ 'flex-direction': 'row', width: 30 }, text('Volume', { width: 7 }), host);

      const places: string[] = [];
      for (const v of [5, 50, 99, 100, 0]) {
        value.set(v);
        flush();
        picture(root);
        const track = trackOf(host).box;
        places.push(`${track?.x},${track?.width}`);
      }
      expect(new Set(places).size).toBe(1);
    });

    it('should measure the readout over every step, not only the ends', () => {
      // -0.5 is wider than either end
      const root = column(
        Slider({ ascii: true, format: String, max: 1, min: -1, step: 0.5, value: 1, width: 5 })
      );

      expect(picture(root)).toEqual(['====o    1']);
    });

    it('should widen rather than cut a readout that comes back wider than it measured', () => {
      let wide = false;
      const value = new State(1);
      const root = column(
        Slider({ ascii: true, format: (v) => (wide ? `${v} items` : `${v}`), value, width: 3 })
      );
      expect(picture(root)).toEqual(['o--   1']);

      wide = true;
      value.set(2);
      flush();
      expect(picture(root)).toEqual(['o-- 2 items']);
    });

    it('should have no readout without format', () => {
      const host = Slider({ value: 1 });
      expect(host.children.map((child) => child.classes[0])).toEqual(['sigil-slider-track']);
    });
  });

  describe('the keys', () => {
    it('should move a step on Left and Right, and tell onChange the value', () => {
      const changed: number[] = [];
      const value = new State(50);
      const host = Slider({ onChange: (v) => changed.push(v), value });

      expect(press(host, 'right')).toBe(true);
      expect(press(host, 'right')).toBe(true);
      expect(press(host, 'left')).toBe(true);
      expect(value.get()).toBe(51);
      expect(changed).toEqual([51, 52, 51]);
    });

    it('should move a tenth of the range on Page Up and Page Down', () => {
      const value = new State(50);
      const host = Slider({ value });

      press(host, 'pageup');
      expect(value.get()).toBe(60);
      press(host, 'pagedown');
      press(host, 'pagedown');
      expect(value.get()).toBe(40);
    });

    it('should move a page of the size it was given, in whole steps', () => {
      const value = new State(0);
      const host = Slider({ page: 7, step: 5, value });

      // seven is a step and two fifths, which is one step
      press(host, 'pageup');
      expect(value.get()).toBe(5);
    });

    it('should never move a page less than one step', () => {
      const value = new State(0);
      const host = Slider({ max: 4, value });

      press(host, 'pageup');
      expect(value.get()).toBe(1);
    });

    it('should go to the ends on Home and End', () => {
      const value = new State(37);
      const host = Slider({ value });

      press(host, 'end');
      expect(value.get()).toBe(100);
      press(host, 'home');
      expect(value.get()).toBe(0);
    });

    it('should stop at the last step at or under max', () => {
      const value = new State(0);
      const host = Slider({ max: 10, step: 3, value });

      press(host, 'end');
      expect(value.get()).toBe(9);
      press(host, 'right');
      expect(value.get()).toBe(9);
    });

    it('should land on whole steps of a fractional step, with no rounding error', () => {
      const value = new State(0);
      const host = Slider({ max: 1, step: 0.1, value });

      for (let i = 0; i < 3; i++) {
        press(host, 'right');
      }
      expect(value.get()).toBe(0.3);
      press(host, 'end');
      press(host, 'left');
      expect(value.get()).toBe(0.9);
    });

    it('should count steps from min, not from zero', () => {
      const value = new State(1);
      const host = Slider({ max: 21, min: 1, step: 5, value });

      press(host, 'right');
      expect(value.get()).toBe(6);
    });

    it('should claim a key at the end it cannot go past, and not call onChange for it', () => {
      // a held key overshoots, and the repeats belong to the slider rather than to
      // whatever is around it
      const changed: number[] = [];
      const host = Slider({ onChange: (v) => changed.push(v), value: 0 });

      expect(press(host, 'left')).toBe(true);
      expect(press(host, 'pagedown')).toBe(true);
      expect(press(host, 'home')).toBe(true);
      expect(changed).toEqual([]);
    });

    it('should move from the nearest step to a value the app wrote between two', () => {
      const value = new State(4.6);
      const host = Slider({ value });

      press(host, 'right');
      expect(value.get()).toBe(6);
    });

    it('should leave Up, Down, Enter, a modifier and a paste alone', () => {
      const value = new State(50);
      const host = Slider({ value });

      for (const name of ['up', 'down', 'enter', 'space', 'tab', 'escape']) {
        expect(press(host, name), name).toBe(false);
      }
      expect(press(host, 'right', { shift: true })).toBe(false);
      expect(press(host, 'right', { ctrl: true })).toBe(false);
      expect(press(host, 'right', { meta: true })).toBe(false);
      const paste = keyEvent('right', {}, true);
      host.onKey?.(paste);
      expect(paste.claimed()).toBe(false);
      expect(value.get()).toBe(50);
    });

    it('should not call onChange for a write the app made', () => {
      const changed: number[] = [];
      const value = new State(50);
      const root = column(Slider({ onChange: (v) => changed.push(v), value }));

      value.set(20);
      flush();
      picture(root);
      expect(changed).toEqual([]);
    });
  });

  describe('the pointer', () => {
    /** A slider whose track runs from column 0 to column 10, valued 0 to 10. */
    function laid(props: Parameters<typeof Slider>[0] = {}) {
      const value = new State(props?.value instanceof State ? props.value.get() : 0);
      const changed: number[] = [];
      const host = Slider({
        ascii: true,
        max: 10,
        onChange: (v) => changed.push(v),
        value,
        width: 11,
        ...props,
      });
      const root = column(host);
      return { changed, host, root, value };
    }

    it('should put the thumb under a press on the track, and leave the press to focus it', () => {
      const { changed, host, root, value } = laid();

      expect(pointer(host, 'mousedown', 7)).toBe(false);
      expect(value.get()).toBe(7);
      expect(changed).toEqual([7]);
      expect(picture(root)).toEqual(['=======o---']);
    });

    it('should follow a drag, and clamp it past either end of the track', () => {
      const { host, value } = laid();

      pointer(host, 'mousedown', 2);
      expect(pointer(host, 'mousemove', 5)).toBe(true);
      expect(value.get()).toBe(5);
      // a captured drag reports columns off the track, and off the canvas
      pointer(host, 'mousemove', 40);
      expect(value.get()).toBe(10);
      pointer(host, 'mousemove', -12);
      expect(value.get()).toBe(0);
    });

    it('should end the drag on the release, wherever it lands', () => {
      const { host, value } = laid();

      pointer(host, 'mousedown', 2);
      pointer(host, 'mousemove', 60);
      expect(pointer(host, 'mouseup', 60)).toBe(true);
      expect(pointer(host, 'mousemove', 3)).toBe(false);
      expect(value.get()).toBe(10);
    });

    it('should end a drag on a release whose button was lost', () => {
      const { host, value } = laid();

      pointer(host, 'mousedown', 2);
      pointer(host, 'mouseup', 2, null);
      pointer(host, 'mousemove', 8);
      expect(value.get()).toBe(2);
    });

    it('should move nothing for a pointer that only passes over', () => {
      const { changed, host } = laid();

      expect(pointer(host, 'mousemove', 6)).toBe(false);
      expect(pointer(host, 'mouseup', 6)).toBe(false);
      expect(changed).toEqual([]);
    });

    it('should take the click after a press, and leave the wheel and the other buttons alone', () => {
      const { host, value } = laid();

      expect(pointer(host, 'click', 4)).toBe(true);
      expect(pointer(host, 'wheel', 4)).toBe(false);
      expect(pointer(host, 'mousedown', 4, 'right')).toBe(false);
      expect(pointer(host, 'mousemove', 9, 'right')).toBe(false);
      expect(value.get()).toBe(0);
    });

    it('should read the column against where the track was laid, not the canvas edge', () => {
      const value = new State(0);
      const host = Slider({ ascii: true, max: 10, value, width: 11 });
      const root = box({ 'flex-direction': 'row' }, text('Volume', { width: 7 }), host);
      lay(root);

      pointer(host, 'mousedown', 7 + 3);
      expect(value.get()).toBe(3);
    });

    it('should do nothing before the track has been laid out', () => {
      const value = new State(0);
      const host = Slider({ value });

      expect(pointer(host, 'mousedown', 4)).toBe(false);
      expect(pointer(host, 'mousemove', 9)).toBe(false);
      expect(value.get()).toBe(0);
    });
  });

  describe('disabled', () => {
    it('should be out of the ring, muted, and take no key and no press', () => {
      const changed: number[] = [];
      const value = new State(5);
      const host = Slider({
        disabled: true,
        max: 10,
        onChange: (v) => changed.push(v),
        value,
        width: 11,
      });
      column(host);

      expect(host.focusable).toBe(false);
      expect(host.classes).toContain('is-disabled');
      expect(part(host, 'sigil-slider-thumb').classes).toContain('sigil-muted');
      expect(part(host, 'sigil-slider-thumb').classes).not.toContain('sigil-accent');
      expect(press(host, 'right')).toBe(false);
      expect(pointer(host, 'mousedown', 9)).toBe(false);
      expect(pointer(host, 'click', 9)).toBe(false);
      expect(value.get()).toBe(5);
      expect(changed).toEqual([]);
    });

    it('should follow a State, and stop a drag it was switched off in the middle of', () => {
      const disabled = new State(false);
      const value = new State(0);
      const host = Slider({ disabled, max: 10, value, width: 11 });
      column(host);

      pointer(host, 'mousedown', 3);
      disabled.set(true);
      flush();
      expect(host.focusable).toBe(false);
      pointer(host, 'mousemove', 8);
      expect(value.get()).toBe(3);

      disabled.set(false);
      flush();
      expect(host.focusable).toBe(true);
      // the drag ended with the disabling, so moving again needs a press
      pointer(host, 'mousemove', 8);
      expect(value.get()).toBe(3);
    });
  });

  describe('the focus', () => {
    it('should put the focus role on the thumb, and fill the thumb in, only while focused', () => {
      const host = Slider({ ascii: false, value: 0, width: 5 });
      const root = column(host);
      const thumb = part(host, 'sigil-slider-thumb');

      expect(thumb.classes).not.toContain('sigil-focus');
      host.onFocusChange?.(host, true);
      flush();
      expect(thumb.classes).toContain('sigil-focus');
      // the glyph, because colour level 0 drops the role's inverse
      expect(picture(root)).toEqual(['●────']);

      host.onFocusChange?.(host, false);
      flush();
      expect(thumb.classes).not.toContain('sigil-focus');
      expect(picture(root)).toEqual(['○────']);
    });

    it('should show no focus on a disabled slider that kept it', () => {
      const disabled = new State(false);
      const host = Slider({ ascii: true, disabled, value: 0, width: 5 });
      const root = column(host);

      host.onFocusChange?.(host, true);
      disabled.set(true);
      flush();
      expect(part(host, 'sigil-slider-thumb').classes).not.toContain('sigil-focus');
      expect(picture(root)).toEqual(['o----']);
    });
  });

  describe('its props', () => {
    it('should keep the app class and take geometry', () => {
      const host = Slider({ props: { class: 'volume', 'margin-left': 2 } });

      expect(host.classes).toEqual(['volume', 'sigil-slider']);
      expect(host.props['margin-left']).toBe(2);
    });

    it.each([
      [{ value: '5' }, 'Expected a slider value to be a number or a State'],
      [{ disabled: 'yes' }, 'Expected slider disabled to be a boolean or a State'],
      [{ min: 5, max: 5 }, 'Expected a slider min and max to be finite numbers, min below max'],
      [{ min: 10, max: 0 }, 'Expected a slider min and max to be finite numbers, min below max'],
      [{ max: Number.POSITIVE_INFINITY }, 'min below max'],
      [{ min: '0' }, 'min below max'],
      [{ step: 0 }, 'Expected a slider step to be a positive number'],
      [{ step: Number.NaN }, 'Expected a slider step to be a positive number'],
      [{ page: -1 }, 'Expected a slider page to be a positive number'],
      [{ format: '%' }, 'Expected a slider format to be a function'],
      [{ width: 2.5 }, 'Expected a slider width to be a positive whole number'],
      [{ width: 0 }, 'Expected a slider width to be a positive whole number'],
    ])('should refuse %o', (props, message) => {
      expect(() => Slider(props as never)).toThrow(TypeError);
      expect(() => Slider(props as never)).toThrow(message);
    });
  });
});

describe('describeSlider', () => {
  /** A router that records what it was told. */
  function recorder() {
    const live: Array<{ keys: string; opts: DescribeOptions }> = [];
    const router: SliderDescriber = {
      describe(keys, opts) {
        const entry = { keys, opts };
        live.push(entry);
        return () => void live.splice(live.indexOf(entry), 1);
      },
    };
    return { live, router };
  }

  it('should describe the six keys, scoped to the slider, the arrows first', () => {
    const { live, router } = recorder();
    const host = Slider();
    describeSlider(router, host);

    expect(live.map((e) => `${e.keys} ${e.opts.description} ${e.opts.priority ?? 0}`)).toEqual([
      'left less 1',
      'right more 1',
      'pagedown much less 0',
      'pageup much more 0',
      'home minimum 0',
      'end maximum 0',
    ]);
    expect(live.every((e) => e.opts.scope === host)).toBe(true);
  });

  it('should take every description back off', () => {
    const { live, router } = recorder();
    const off = describeSlider(router, Slider(), Slider());
    expect(live).toHaveLength(12);
    off();
    expect(live).toHaveLength(0);
  });

  it('should refuse an element that is not a slider, and describe nothing', () => {
    const { live, router } = recorder();
    expect(() => describeSlider(router, Slider(), box())).toThrow(
      'Expected an element that Slider() returned'
    );
    expect(live).toHaveLength(0);
  });
});

interface Harness {
  feed: (chunk: string) => void;
  terminal: Terminal;
}

/** A terminal whose stdin is a TTY nothing is typing on, as `mouse-router.test.ts` builds one. */
function harness(): Harness {
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
  const terminal = createTerminal({
    env: {},
    isTTY: true,
    proc: { on() {}, pid: 1, removeListener() {} } as never,
    stderr: { isTTY: true, write: () => true } as never,
    stdin: stdin as never,
    stdout: { isTTY: true, write: () => true } as never,
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

describe('a slider under a real router', () => {
  /** An SGR mouse report: `cb` is the button and motion bits, the column one-based. */
  const sgr = (cb: number, column: number, final = 'M') => `${ESC}[<${cb};${column};1${final}`;

  function app(disabled = false) {
    const { feed, terminal } = harness();
    const field = text('field', { focusable: true });
    const value = new State(0);
    // the track starts at column 6 of the canvas, after the label and its gap
    const host = Slider({ ascii: true, disabled, max: 10, value, width: 11 });
    const root = box({ 'flex-direction': 'row' }, field, text(' ', { width: 1 }), host);
    lay(root);
    const input = createInput({
      mouse: {
        motion: true,
        surface: {
          height: 1,
          locate: async () => true,
          origin: { x: 0, y: 0 },
          toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
          width: 30,
        },
      },
      root,
      terminal,
    });
    return { feed, field, host, input, root, value };
  }

  it('should be in the ring a Tab walks, and move on the arrows once focused', () => {
    const { feed, field, host, input, value } = app();

    expect(input.focus.ring()).toEqual([field, host]);
    feed('\t');
    feed('\t');
    expect(input.focus.current.get()).toBe(host);
    feed(`${ESC}[C`);
    feed(`${ESC}[C`);
    expect(value.get()).toBe(2);
    input.stop();
  });

  it('should focus on a press, follow the drag off the canvas, and end on the release out there', () => {
    const { feed, host, input, value } = app();
    const at = trackOf(host).box?.x ?? 0;

    feed(sgr(0, at + 4 + 1));
    expect(input.focus.current.get()).toBe(host);
    expect(value.get()).toBe(4);
    feed(sgr(32, at + 7 + 1));
    expect(value.get()).toBe(7);
    feed(sgr(32, 200));
    expect(value.get()).toBe(10);
    feed(sgr(0, 200, 'm'));
    // a pointer that goes on moving after the release moves nothing
    feed(sgr(35, at + 1 + 1));
    expect(value.get()).toBe(10);
    input.stop();
  });

  it('should leave a disabled slider out of the ring and unfocused by a press', () => {
    const { feed, field, host, input, value } = app(true);
    const at = trackOf(host).box?.x ?? 0;

    expect(input.focus.ring()).toEqual([field]);
    feed(sgr(0, at + 4 + 1));
    feed(sgr(0, at + 4 + 1, 'm'));
    expect(input.focus.current.get()).not.toBe(host);
    expect(value.get()).toBe(0);
    input.stop();
  });

  it('should list its keys in a key-help footer while it has the focus', () => {
    const { host, input } = app();
    describeSlider(input, host);
    const footer = keyHelp(input, { width: 80 });
    const line = () =>
      renderToString(footer, { cascade: themedCascade(), colorLevel: 0, width: 80 }).trimEnd();

    expect(line()).toBe('');
    input.focus.focus(host);
    flush();
    expect(line()).toBe(
      '← less · → more · pgdn much less · pgup much more · home minimum · end maximum'
    );
    input.stop();
  });
});
