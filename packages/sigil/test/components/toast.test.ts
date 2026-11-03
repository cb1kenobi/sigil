import { strip } from '../../src/ansi/index.js';
import { openModal } from '../../src/components/modal.js';
import { showToast, type ToastCloseReason, type ToastOptions } from '../../src/components/toast.js';
import { box, type Element, hitTest, renderToLines, text } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { createEffect, createRoot, render } from '../../src/renderer/index.js';
import { flush, State } from '../../src/signals/index.js';
import { setQuiet } from '../../src/style/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A toast: where it goes, how long it stays, and that it never has the keys,
 * the focus or a click meant for something else.
 *
 * The clock is faked -- `setTimeout` and `clearTimeout` only, so the router's
 * `setImmediate` turns still run -- and the focus claims go through a real
 * router over a test terminal, because "never takes the focus" is a claim about
 * the router's Tab default and its click-to-focus, neither of which a handler
 * called by hand is inside.
 */

const WIDTH = 40;
const HEIGHT = 12;

/** An app with two focusable rows and a router over it. */
function scene() {
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const seen: string[] = [];
  const one = text('first row', { focusable: true });
  const two = text('second row', { focusable: true });
  one.onKey = (event) => {
    seen.push(`one:${event.key.name}`);
  };
  two.onKey = (event) => {
    seen.push(`two:${event.key.name}`);
  };
  const root = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH }, one, two);
  const input = createInput({ root, terminal: term.terminal });
  routers.push(input);
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

const screen = (root: Element): string => picture(root).join('\n');

const routers: Array<{ stop(): void }> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  setQuiet(undefined);
  vi.useRealTimers();
  for (const router of routers.splice(0)) {
    router.stop();
  }
});

/** Raises a toast over a scene, with the scene's terminal and ASCII borders. */
function toastOn(s: ReturnType<typeof scene>, opts: Partial<ToastOptions> = {}) {
  return showToast(s.root, {
    ascii: true,
    message: 'Saved',
    terminal: s.term.terminal,
    width: 16,
    ...opts,
  });
}

describe('showToast()', () => {
  it('should draw in the bottom-right corner by default, without moving the app', () => {
    const s = scene();
    const before = picture(s.root);
    toastOn(s, { message: 'Saved it', title: 'Done' });

    const lines = picture(s.root);
    // out of flow: the app's own rows are where they were
    expect(lines[0]).to.equal(before[0]);
    expect(lines[1]).to.equal(before[1]);
    // the last row is the toast's bottom edge, flush with the right of the screen
    expect(lines.at(-1)).to.equal(`${' '.repeat(WIDTH - 16)}+${'-'.repeat(14)}+`);
    expect(lines.at(-2)).to.match(/\| Saved it\s+\|$/);
    expect(lines.at(-3)).to.match(/\| Done\s+\|$/);
  });

  it.each([
    { position: 'top-left', row: 0, left: true },
    { position: 'top-right', row: 0, left: false },
    { position: 'bottom-left', row: HEIGHT - 1, left: true },
    { position: 'bottom-right', row: HEIGHT - 1, left: false },
  ] as const)('should put a $position toast in that corner', ({ left, position, row }) => {
    const s = scene();
    s.root.removeChild(s.one);
    s.root.removeChild(s.two);
    toastOn(s, { position });

    const line = picture(s.root)[row] ?? '';
    expect(line.trimStart().startsWith('+')).to.equal(true);
    expect(line.startsWith('+')).to.equal(left);
    expect(line.length === WIDTH).to.equal(!left);
  });

  it('should hide what is under it even with no colour', () => {
    const s = scene();
    s.root.removeChild(s.one);
    s.root.removeChild(s.two);
    for (let row = 0; row < HEIGHT - 2; row++) {
      s.root.append(text('#'.repeat(WIDTH)));
    }
    toastOn(s, { message: 'x', position: 'top-right' });

    // colour level 0, so a background colour would have been dropped: it is the
    // blank cells the toast fills itself with that keep the wall from showing
    const [, middle] = picture(s.root);
    expect(middle).to.equal(`${'#'.repeat(WIDTH - 16)}| x            |`);
  });

  it('should drop escape sequences from what it is told to say', () => {
    const s = scene();
    toastOn(s, { message: '\u001b[31mred\u001b[0m', title: '\u001b[1mT\u001b[0m' });
    const lines = picture(s.root);
    expect(lines.at(-2)).to.match(/\| red\s+\|$/);
    expect(lines.at(-3)).to.match(/\| T\s+\|$/);
  });

  it('should wrap a long message at its width and never be wider than the screen', () => {
    const s = scene();
    toastOn(s, { message: 'one two three four five', width: 200 });
    const lines = picture(s.root);
    expect(lines.at(-1)).to.equal(`+${'-'.repeat(WIDTH - 2)}+`);
  });

  it('should take its role from the variant, as note() does', () => {
    const s = scene();
    const handle = toastOn(s, { variant: 'warning' });
    expect(handle.element.classes).to.include('sigil-toast-warning');
    expect(handle.element.classes).to.include('sigil-warn');
    expect(toastOn(s).element.classes).to.deep.equal(['sigil-toast', 'sigil-toast-note']);
  });

  it('should refuse a host that is not one, and bad options', () => {
    const s = scene();
    const bad = (opts: Partial<ToastOptions>) => () =>
      showToast(s.root, { message: 'x', ...opts } as ToastOptions);
    expect(() => showToast({} as never, { message: 'x' })).to.throw(TypeError, 'host');
    expect(bad({ message: 5 as never })).to.throw(TypeError, 'message');
    expect(bad({ title: 5 as never })).to.throw(TypeError, 'title');
    expect(bad({ variant: 'loud' as never })).to.throw(TypeError, 'variant');
    expect(bad({ position: 'middle' as never })).to.throw(TypeError, 'corner');
    for (const timeout of [0, -1, Number.NaN, 2 ** 31, '5' as never]) {
      expect(bad({ timeout })).to.throw(TypeError, 'timeout');
    }
    for (const max of [0, 1.5, Number.NaN]) {
      expect(bad({ max })).to.throw(TypeError, 'max');
    }
    // and nothing was put on the screen by any of them
    expect(s.root.children).to.have.length(2);
  });

  it('should take a renderer, or anything with a root', () => {
    const s = scene();
    const handle = showToast({ root: s.root }, { message: 'Hi', terminal: s.term.terminal });
    expect(s.root.contains(handle.element)).to.equal(true);
  });
});

describe('the timeout', () => {
  it('should go when its time runs out, and say so once', () => {
    const s = scene();
    const reasons: ToastCloseReason[] = [];
    const handle = toastOn(s, { onClose: (why) => reasons.push(why), timeout: 1000 });

    vi.advanceTimersByTime(999);
    expect(handle.open).to.equal(true);
    expect(screen(s.root)).to.include('Saved');

    vi.advanceTimersByTime(1);
    expect(handle.open).to.equal(false);
    expect(screen(s.root)).to.not.include('Saved');
    expect(reasons).to.deep.equal(['timeout']);

    handle.dismiss();
    expect(reasons).to.deep.equal(['timeout']);
  });

  it('should stay four seconds when nobody says', () => {
    const s = scene();
    const handle = toastOn(s);
    vi.advanceTimersByTime(3999);
    expect(handle.open).to.equal(true);
    vi.advanceTimersByTime(1);
    expect(handle.open).to.equal(false);
  });

  it('should start no timer at all for a toast that stays until it is dismissed', () => {
    const s = scene();
    const handle = toastOn(s, { timeout: Infinity });
    expect(vi.getTimerCount()).to.equal(0);
    vi.advanceTimersByTime(2 ** 31);
    expect(handle.open).to.equal(true);
    handle.dismiss();
    expect(handle.open).to.equal(false);
  });

  it('should clear its timer when it is dismissed, and leave nothing in the tree', () => {
    const s = scene();
    const reasons: ToastCloseReason[] = [];
    const handle = toastOn(s, { onClose: (why) => reasons.push(why) });
    expect(vi.getTimerCount()).to.equal(1);

    handle.dispose();
    handle.dispose();
    expect(vi.getTimerCount()).to.equal(0);
    expect(reasons).to.deep.equal(['dismiss']);
    // the corner's box went with its last toast
    expect(s.root.children).to.deep.equal([s.one, s.two]);
  });

  it('should not hold the process open', () => {
    const s = scene();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    toastOn(s);
    const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout;
    expect(timer.hasRef()).to.equal(false);
    spy.mockRestore();
  });
});

describe('the stack', () => {
  it('should put the newest nearest the corner, at the foot of a bottom stack', () => {
    const s = scene();
    toastOn(s, { message: 'first' });
    toastOn(s, { message: 'second' });
    const lines = picture(s.root);
    expect(lines.at(-2)).to.include('second');
    expect(lines.at(-5)).to.include('first');
  });

  it('should put the newest nearest the corner, at the head of a top stack', () => {
    const s = scene();
    toastOn(s, { message: 'first', position: 'top-left' });
    toastOn(s, { message: 'second', position: 'top-left' });
    const lines = picture(s.root);
    expect(lines[1]).to.include('second');
    expect(lines[4]).to.include('first');
  });

  it('should push the oldest out when the corner is full, and clear its timer', () => {
    const s = scene();
    const reasons: string[] = [];
    const raise = (message: string) =>
      toastOn(s, { message, onClose: (why) => reasons.push(`${message}:${why}`) });
    const first = raise('alpha');
    raise('beta');
    raise('gamma');
    expect(vi.getTimerCount()).to.equal(3);

    raise('delta');
    expect(first.open).to.equal(false);
    expect(reasons).to.deep.equal(['alpha:overflow']);
    expect(vi.getTimerCount()).to.equal(3);
    const shown = screen(s.root);
    expect(shown).to.not.include('alpha');
    for (const message of ['beta', 'gamma', 'delta']) {
      expect(shown).to.include(message);
    }
  });

  it('should hold as many as max says', () => {
    const s = scene();
    const first = toastOn(s, { message: 'first', max: 1 });
    const second = toastOn(s, { message: 'second', max: 1 });
    expect(first.open).to.equal(false);
    expect(second.open).to.equal(true);
  });

  it('should keep each corner to itself', () => {
    const s = scene();
    const left = toastOn(s, { message: 'left', max: 1, position: 'bottom-left' });
    toastOn(s, { message: 'right', max: 1, position: 'bottom-right' });
    expect(left.open).to.equal(true);
    expect(picture(s.root).at(-2)).to.match(/^\| left .*\| right\s+\|$/);
  });

  it('should close what was in a corner the app took out of the tree', () => {
    const s = scene();
    const reasons: ToastCloseReason[] = [];
    const old = toastOn(s, { message: 'old', onClose: (why) => reasons.push(why) });
    // the app clears its screen, the corner with it
    s.root.removeChild(s.one).removeChild(s.two);
    s.root.children[0]?.remove();

    toastOn(s, { message: 'new' });
    expect(old.open).to.equal(false);
    expect(reasons).to.deep.equal(['dismiss']);
    expect(vi.getTimerCount()).to.equal(1);
    expect(picture(s.root).at(-2)).to.include('new');
  });

  it('should be put back where it was after the corner emptied', () => {
    const s = scene();
    toastOn(s, { message: 'gone', timeout: 10 });
    vi.advanceTimersByTime(10);
    toastOn(s, { message: 'back' });
    expect(picture(s.root).at(-2)).to.include('back');
  });
});

describe('the focus', () => {
  it('should leave the focus where it was when one arrives, and when it goes', () => {
    const s = scene();
    s.input.focus.focus(s.two);
    const ring = s.input.focus.ring();

    const handle = toastOn(s);
    expect(s.input.focus.current.get()).to.equal(s.two);
    // and nothing in it is anywhere Tab could reach
    expect(s.input.focus.ring()).to.deep.equal(ring);

    vi.advanceTimersByTime(4000);
    expect(handle.open).to.equal(false);
    expect(s.input.focus.current.get()).to.equal(s.two);
  });

  it('should leave nothing focused when nothing was', () => {
    const s = scene();
    toastOn(s);
    expect(s.input.focus.current.get()).to.equal(undefined);
  });

  it('should be passed over by Tab, which still walks only the app', async () => {
    const s = scene();
    toastOn(s, { timeout: Infinity });
    toastOn(s, { position: 'top-left', timeout: Infinity });
    const visited: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      await s.term.press(KEYS.tab);
      visited.push(s.input.focus.current.get());
    }
    expect(visited).to.deep.equal([s.one, s.two, s.one, s.two]);
  });

  it('should take no key: what is typed reaches the focused row', async () => {
    const s = scene();
    s.input.focus.focus(s.one);
    toastOn(s);
    await s.term.press('x', KEYS.enter, KEYS.space);
    expect(s.seen).to.deep.equal(['one:x', 'one:enter', 'one:space']);
  });

  it('should not move the focus out of a modal it is raised over', () => {
    const s = scene();
    const dialog = openModal(s.root, { input: s.input, title: 'Sure?' });
    const inside = s.input.focus.current.get();
    toastOn(s);
    expect(s.input.focus.current.get()).to.equal(inside);
    vi.advanceTimersByTime(4000);
    expect(s.input.focus.current.get()).to.equal(inside);
    dialog.dispose();
  });
});

describe('the mouse', () => {
  /** A canvas at the top-left of the screen, which is all the router asks of one. */
  const surface = {
    height: HEIGHT,
    locate: async () => true,
    origin: { x: 0, y: 0 },
    toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
    width: WIDTH,
  };
  const ESC = String.fromCharCode(0x1b);
  /** A left press and its release at a canvas cell, as SGR reports. */
  const click = (x: number, y: number): string[] => [
    `${ESC}[<0;${x + 1};${y + 1}M`,
    `${ESC}[<0;${x + 1};${y + 1}m`,
  ];

  /** A focusable panel the size of the screen, with a router that routes the mouse. */
  function panelScene() {
    const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
    const row = text('a row', { focusable: true });
    const root = box(
      { 'flex-direction': 'column', focusable: true, height: HEIGHT, width: WIDTH },
      row
    );
    const heard: string[] = [];
    root.onMouse = (event) => {
      heard.push(event.kind);
    };
    const input = createInput({ mouse: { surface }, root, terminal: term.terminal });
    routers.push(input);
    return { heard, input, root, row, term };
  }

  it('should keep a press on it from focusing what it sits in', async () => {
    const s = panelScene();
    s.input.focus.focus(s.row);
    const handle = showToast(s.root, { message: 'Saved', terminal: s.term.terminal });
    picture(s.root);

    // the toast's bottom-right cell: inside it, over the focusable root
    expect(handle.element.contains(hitTest(s.root, WIDTH - 2, HEIGHT - 2) as Element)).to.equal(
      true
    );
    await s.term.press(...click(WIDTH - 2, HEIGHT - 2));
    expect(s.input.focus.current.get()).to.equal(s.row);
    // and nothing under it heard the press, the release or the click
    expect(s.heard).to.deep.equal([]);
  });

  it('should go when it is clicked', async () => {
    const s = panelScene();
    const reasons: ToastCloseReason[] = [];
    const handle = showToast(s.root, {
      message: 'Saved',
      onClose: (why) => reasons.push(why),
      terminal: s.term.terminal,
    });
    picture(s.root);

    await s.term.press(...click(WIDTH - 2, HEIGHT - 2));
    expect(handle.open).to.equal(false);
    expect(reasons).to.deep.equal(['dismiss']);
  });

  it('should be above a modal, so a click on it does not reach the backdrop', () => {
    const s = scene();
    openModal(s.root, { closeOnClickOutside: true, input: s.input });
    const handle = toastOn(s);
    picture(s.root);
    const hit = hitTest(s.root, WIDTH - 2, HEIGHT - 2) as Element;
    expect(handle.element.contains(hit)).to.equal(true);
  });
});

describe('ownership', () => {
  it('should go with the component it was raised in', () => {
    const s = scene();
    const reasons: ToastCloseReason[] = [];
    let handle: ReturnType<typeof showToast> | undefined;
    const dispose = createRoot((disposer) => {
      handle = toastOn(s, { onClose: (why) => reasons.push(why) });
      return disposer;
    });
    expect(handle?.open).to.equal(true);

    dispose();
    expect(handle?.open).to.equal(false);
    expect(reasons).to.deep.equal(['dismiss']);
    expect(vi.getTimerCount()).to.equal(0);
    expect(s.root.children).to.deep.equal([s.one, s.two]);
  });

  it('should go with the run of the effect that raised it', () => {
    const s = scene();
    const status = new State('saved');
    const raised: Array<ReturnType<typeof showToast>> = [];
    const dispose = createRoot((disposer) => {
      createEffect(() => {
        raised.push(toastOn(s, { message: status.get() }));
      });
      return disposer;
    });

    status.set('failed');
    flush();
    // the effect ran again, which is the last run's cleanup
    expect(raised.map((toast) => toast.open)).to.deep.equal([false, true]);
    dispose();
    expect(raised.map((toast) => toast.open)).to.deep.equal([false, false]);
  });

  it('should outlive a component when it was raised from outside one', () => {
    const s = scene();
    let handle: ReturnType<typeof showToast> | undefined;
    const dispose = createRoot((disposer) => {
      // a key handler or a promise: it runs after the body has returned
      s.one.onKey = () => {
        handle = toastOn(s);
      };
      return disposer;
    });
    s.one.onKey?.({} as never);
    dispose();
    expect(handle?.open).to.equal(true);
    expect(vi.getTimerCount()).to.equal(1);
  });

  /**
   * Raised from a handler, so no owner takes it: the renderer going is what
   * does, rather than the timer running out over a tree nobody is drawing.
   */
  it('should go with the renderer it was shown over, timer and corner', () => {
    const s = scene();
    const view = render(() => s.root, { terminal: s.term.terminal });
    const reasons: ToastCloseReason[] = [];
    const handle = showToast(view, {
      message: 'Saved',
      onClose: (why) => reasons.push(why),
      terminal: s.term.terminal,
    });
    expect(handle.open).to.equal(true);

    view.dispose();
    expect(handle.open).to.equal(false);
    expect(reasons).to.deep.equal(['dismiss']);
    expect(vi.getTimerCount()).to.equal(0);
    expect(s.root.children).to.deep.equal([s.one, s.two]);
  });

  it('should close at once over a renderer that has already gone', () => {
    const s = scene();
    const view = render(() => s.root, { terminal: s.term.terminal });
    view.dispose();
    const reasons: ToastCloseReason[] = [];
    const handle = showToast(view, {
      message: 'Saved',
      onClose: (why) => reasons.push(why),
      terminal: s.term.terminal,
    });

    expect(handle.open).to.equal(false);
    expect(reasons).to.deep.equal(['dismiss']);
    expect(vi.getTimerCount()).to.equal(0);
    expect(s.root.children).to.deep.equal([s.one, s.two]);
  });

  it('should let go of the renderer when it goes first', () => {
    const s = scene();
    const subscribed = new Set<() => void>();
    const host = {
      onDispose(handler: () => void) {
        subscribed.add(handler);
        return () => void subscribed.delete(handler);
      },
      root: s.root,
    };
    const handle = showToast(host, { message: 'Saved', terminal: s.term.terminal });
    expect(subscribed.size).to.equal(1);

    handle.dismiss();
    expect(subscribed.size).to.equal(0);
  });
});

describe('the quiet axis', () => {
  it('should show nothing under quiet, start no timer and close at once', () => {
    setQuiet(true);
    const s = scene();
    const reasons: ToastCloseReason[] = [];
    const handle = toastOn(s, { onClose: (why) => reasons.push(why) });

    expect(handle.open).to.equal(false);
    expect(reasons).to.deep.equal(['quiet']);
    expect(vi.getTimerCount()).to.equal(0);
    expect(s.root.children).to.deep.equal([s.one, s.two]);
    expect(screen(s.root)).to.not.include('Saved');
    // closed already, so a dismissal has nothing to do and says nothing
    handle.dismiss();
    expect(reasons).to.deep.equal(['quiet']);
    // and it is not one that turns up later
    setQuiet(undefined);
    vi.advanceTimersByTime(10_000);
    expect(screen(s.root)).to.not.include('Saved');
  });

  it('should show one that says it is not progress', () => {
    setQuiet(true);
    const s = scene();
    const handle = toastOn(s, { quiet: false });
    expect(handle.open).to.equal(true);
    expect(screen(s.root)).to.include('Saved');
  });

  it('should hide one that asks to be quiet, with nobody else asking', () => {
    const s = scene();
    expect(toastOn(s, { quiet: true }).open).to.equal(false);
  });

  it('should let one already showing run out its own time when quiet is asked for', () => {
    const s = scene();
    const handle = toastOn(s, { timeout: 1000 });
    setQuiet(true);
    vi.advanceTimersByTime(999);
    expect(handle.open).to.equal(true);
    expect(screen(s.root)).to.include('Saved');
    vi.advanceTimersByTime(1);
    expect(handle.open).to.equal(false);
  });

  it('should draw the same toast on a pipe as on a terminal', () => {
    const piped = scene();
    const term = createTestTerminal({ columns: WIDTH, isTTY: false, rows: HEIGHT });
    showToast(piped.root, { ascii: true, message: 'Saved', terminal: term.terminal, width: 16 });
    const live = scene();
    toastOn(live);
    expect(picture(piped.root)).to.deep.equal(picture(live.root));
  });
});
