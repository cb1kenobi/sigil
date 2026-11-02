import { strip } from '../../src/ansi/index.js';
import { confirmModal, type ModalOptions, openModal } from '../../src/components/modal.js';
import { box, type Element, hitTest, renderToLines, text } from '../../src/element/index.js';
import { createInput, ESCAPE_TIMEOUT, type MouseEvent } from '../../src/input/index.js';
import { flush } from '../../src/signals/index.js';
import { setQuiet } from '../../src/style/index.js';
import { createTestTerminal, ctrl, KEYS } from '../../src/testing/index.js';
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
    expect((s.input.focus.current.get() as Element).text).to.include('B');
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
