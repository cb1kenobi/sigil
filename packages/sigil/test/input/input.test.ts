import { arrange, box, type Element, resolveStyles, text } from '../../src/element/index.js';
import { createInput, InputError, type KeyEvent } from '../../src/input/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The key router and the focus ring.
 *
 * Driven by feeding bytes rather than by a real keyboard: what a terminal sends
 * is a string, and `decodeKeys()` is already tested against the shapes of one.
 * What is new here is where a decoded key *goes*.
 */

interface Harness {
  /** How many listeners the stream is carrying, by event. */
  counts: () => Record<string, number>;
  /** Sends an event the stream itself would, rather than a chunk. */
  emit: (event: string, ...args: unknown[]) => void;
  feed: (chunk: string) => void;
  out: string[];
  /** Whether the stream is in raw mode, so a test can ask who put it back. */
  readonly raw: boolean;
  terminal: Terminal;
}

/** A terminal whose stdin is a TTY nothing is typing on. */
function harness(): Harness {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const out: string[] = [];

  const stdin = {
    isTTY: true,
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
      return this;
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
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
    raw: false,
    setRawMode(mode: boolean) {
      this.raw = mode;
      return this;
    },
  };

  const terminal = createTerminal({
    env: {},
    isTTY: true,
    proc: { on() {}, pid: 1, removeListener() {} } as never,
    stderr: { isTTY: true, write: (chunk: string) => void out.push(chunk) } as never,
    stdin: stdin as never,
    stdout: { isTTY: true, write: (chunk: string) => void out.push(chunk) } as never,
  });

  return {
    counts() {
      return {
        data: listeners.get('data')?.size ?? 0,
        end: listeners.get('end')?.size ?? 0,
        error: listeners.get('error')?.size ?? 0,
      };
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) {
        fn(...args);
      }
    },
    feed(chunk: string) {
      for (const fn of listeners.get('data') ?? []) {
        fn(chunk);
      }
    },
    out,
    get raw() {
      return stdin.raw;
    },
    terminal,
  };
}

/** A tree of three focusable boxes inside a container that watches them. */
function tree(): { first: Element; root: Element; second: Element; third: Element } {
  const first = box({ focusable: true }, text('one'));
  const second = box({ focusable: true }, text('two'));
  const third = box({ focusable: true }, text('three'));
  const root = box({}, first, second, third);
  return { first, root, second, third };
}

describe('the router', () => {
  it('should refuse to exist where there is nobody to type', () => {
    // `PromptError`'s rule generalized: a prompt with nobody to answer it fails
    // loudly rather than hanging, and a router exists to read keys
    const terminal = createTerminal({
      env: {},
      isTTY: false,
      proc: { on() {}, pid: 1, removeListener() {} } as never,
      stdin: undefined,
      stdout: { write: () => true } as never,
    });

    expect(() => createInput({ terminal })).toThrow(InputError);
  });

  // the same rule `hideCursor()` follows: a router built inside a full-screen app
  // that is already raw must not take the app out of it on the way out, or what
  // the app gets back is a cooked stream that echoes
  it('should put raw mode back only if it was what turned it on', () => {
    const outer = harness();
    outer.terminal.setRawMode(true);
    expect(outer.raw).to.equal(true);

    createInput({ terminal: outer.terminal }).stop();
    expect(outer.raw, 'the app was taken out of raw mode').to.equal(true);

    const own = harness();
    const router = createInput({ terminal: own.terminal });
    expect(own.raw).to.equal(true);

    router.stop();
    expect(own.raw).to.equal(false);
  });

  // something waiting on a key has to be told when none will ever arrive, or it
  // waits forever -- and stdin is the router's
  it('should report the stream ending', () => {
    const { emit, terminal } = harness();
    const input = createInput({ terminal });
    const seen: unknown[] = [];

    input.onEnd((error) => seen.push(error ?? 'ended'));
    emit('end');

    expect(seen).to.deep.equal(['ended']);
    input.stop();
  });

  it('should report the stream erroring, with what it failed with', () => {
    const { emit, terminal } = harness();
    const input = createInput({ terminal });
    const seen: unknown[] = [];
    const boom = new Error('gone');

    input.onEnd((error) => seen.push(error));
    emit('error', boom);

    expect(seen).to.deep.equal([boom]);
    input.stop();
  });

  it('should stop reporting it once the handler is removed', () => {
    const { emit, terminal } = harness();
    const input = createInput({ terminal });
    const seen: unknown[] = [];

    input.onEnd(() => seen.push('ended'))();
    emit('end');

    expect(seen).to.deep.equal([]);
    input.stop();
  });

  // and nothing is left listening, or the next reader gets our events too
  it('should take its listeners back off', () => {
    const { counts, terminal } = harness();
    const input = createInput({ terminal });

    expect(counts()).to.deep.equal({ data: 1, end: 1, error: 1 });

    input.stop();
    expect(counts()).to.deep.equal({ data: 0, end: 0, error: 0 });
  });

  it('should give a key to a binding before anything focused', () => {
    // an app that cannot be quit because a focused input swallowed Ctrl-C is
    // the failure this order exists to prevent
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const seen: string[] = [];

    input.focus.focus(first);
    first.onKey = () => seen.push('element');
    input.bind((event) => {
      seen.push('binding');
      if (event.key.ctrl && event.key.name === 'c') {
        event.stop();
      }
    });

    feed('a');
    expect(seen).toEqual(['binding', 'element']);

    seen.length = 0;
    feed('');
    expect(seen).toEqual(['binding']);

    input.stop();
  });

  it('should bubble from the focused element up to the root', () => {
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const seen: string[] = [];

    input.focus.focus(first);
    first.onKey = () => seen.push('first');
    root.onKey = () => seen.push('root');

    feed('x');
    expect(seen).toEqual(['first', 'root']);
    input.stop();
  });

  it('should let a handler stop the event before its ancestors see it', () => {
    // without this a text input's Left is also the list's "previous item", and
    // the only thing that can know the key was meant for the input is the input
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const seen: string[] = [];

    input.focus.focus(first);
    first.onKey = (event: KeyEvent) => {
      seen.push('first');
      event.stop();
    };
    root.onKey = () => seen.push('root');

    feed('[D');
    expect(seen).toEqual(['first']);
    input.stop();
  });

  it('should say which element it is asking as the event climbs', () => {
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const asked: (Element | undefined)[] = [];

    input.focus.focus(first);
    first.onKey = (event) => asked.push(event.current);
    root.onKey = (event) => {
      asked.push(event.current);
      expect(event.target).toBe(first);
    };

    feed('x');
    expect(asked).toEqual([first, root]);
    input.stop();
  });

  it('should not give the current key to a binding registered while it dispatches', () => {
    // a component that binds a key in response to being focused would otherwise
    // have that new binding see the very key that focused it, and whether it did
    // would depend on where in the iteration it joined
    const { feed, terminal } = harness();
    const input = createInput({ root: box({}), terminal });
    const seen: string[] = [];

    input.bind(() => {
      seen.push('first');
      if (seen.length === 1) {
        input.bind(() => seen.push('late'));
      }
    });

    feed('a');
    expect(seen).toEqual(['first']);

    // and the next key reaches it, so what it missed was this key rather than
    // every key
    feed('b');
    expect(seen).toEqual(['first', 'first', 'late']);
    input.stop();
  });

  it('should not call a binding unbound while the key is dispatching', () => {
    // the other half of the same rule, and the half a snapshot on its own gets
    // wrong: a dialog closed by Escape must not then hand Escape to the bindings
    // it was closing
    const { feed, terminal } = harness();
    const input = createInput({ root: box({}), terminal });
    const seen: string[] = [];

    const off = input.bind(() => seen.push('doomed'));
    input.bind(() => {
      seen.push('closer');
      off();
    });

    // the closer is second, so the doomed one has already run once; what it must
    // not do is run again on the *next* key
    feed('a');
    expect(seen).toEqual(['doomed', 'closer']);

    feed('b');
    expect(seen).toEqual(['doomed', 'closer', 'closer']);
    input.stop();
  });

  it('should skip a binding another binding unbinds before it is reached', () => {
    const { feed, terminal } = harness();
    const input = createInput({ root: box({}), terminal });
    const seen: string[] = [];

    let off = () => {};
    input.bind(() => {
      seen.push('closer');
      off();
    });
    off = input.bind(() => seen.push('doomed'));

    feed('a');
    expect(seen).toEqual(['closer']);
    input.stop();
  });

  it('should hold a sequence that arrives split and read it whole', () => {
    // ssh, a pty under load, and a small read buffer all split a chunk, and
    // `ESC [` then `A` decodes as an unknown sequence and a literal `A`
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const names: string[] = [];

    input.focus.focus(first);
    first.onKey = (event) => names.push(event.key.name);

    feed('[');
    expect(names).toEqual([]);
    feed('A');
    expect(names).toEqual(['up']);
    input.stop();
  });

  it("should carry the terminal's other event", () => {
    // the thing that owns stdin owns the other event a terminal produces, so an
    // app subscribes in one place for the two halves of one frame. What a
    // resize *means* -- re-evaluate the media queries, re-lay out, repaint whole
    // rather than diff against a grid that described a different screen -- is
    // the renderer's, and is deliberately not decided here
    const { terminal } = harness();
    const input = createInput({ root: box({}), terminal });
    const sizes: { height: number; width: number }[] = [];

    const off = input.onResize((size) => sizes.push(size));
    expect(typeof off).toBe('function');
    input.stop();
  });

  it('should put the stream and the modes back on stop', () => {
    const { out, terminal } = harness();
    const input = createInput({ root: box({}), terminal });

    expect(out.join('')).toContain('[?2004h');
    input.stop();
    expect(out.join('')).toContain('[?2004l');
  });
});

describe('focus', () => {
  it('should move along the ring and wrap', () => {
    const { feed, terminal } = harness();
    const { first, root, second, third } = tree();
    const input = createInput({ root, terminal });

    expect(input.focus.ring()).toEqual([first, second, third]);

    feed('\t');
    expect(input.focus.current.get()).toBe(first);
    feed('\t');
    expect(input.focus.current.get()).toBe(second);
    feed('\t\t');
    expect(input.focus.current.get()).toBe(first);

    // Shift-Tab is `ESC [ Z`, which the decoder names `tab` with shift
    feed('[Z');
    expect(input.focus.current.get()).toBe(third);
    input.stop();
  });

  it('should let a component keep Tab by stopping the event', () => {
    // Tab is the default rather than the first thing tried, so a completion or
    // a grid cell keeps it
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });

    input.focus.focus(first);
    first.onKey = (event) => {
      if (event.key.name === 'tab') {
        event.stop();
      }
    };

    feed('\t');
    expect(input.focus.current.get()).toBe(first);
    input.stop();
  });

  it('should set the state a selector matches', () => {
    // which is what makes an input that highlights when focused zero lines of
    // component code
    const { terminal } = harness();
    const { first, root, second } = tree();
    const input = createInput({ root, terminal });

    input.focus.focus(first);
    expect(first.states).toContain('focus');

    input.focus.focus(second);
    expect(first.states).not.toContain('focus');
    expect(second.states).toContain('focus');
    input.stop();
  });

  it('should follow the tree rather than a list it kept', () => {
    const { terminal } = harness();
    const { first, root, second } = tree();
    const input = createInput({ root, terminal });

    const added = box({ focusable: true });
    root.insertBefore(added, second);
    expect(input.focus.ring()[1]).toBe(added);

    first.remove();
    expect(input.focus.ring()[0]).toBe(added);
    input.stop();
  });

  it('should honour a tabindex over document order', () => {
    const { terminal } = harness();
    const last = box({ focusable: true, tabindex: 2 });
    const early = box({ focusable: true, tabindex: 1 });
    const root = box({}, last, early);
    const input = createInput({ root, terminal });

    expect(input.focus.ring()).toEqual([early, last]);
    input.stop();
  });

  it('should skip a subtree that is not displayed', () => {
    // there is nothing on screen to move the focus to. Read off the *resolved*
    // style rather than the prop, because `display` can come from a sheet --
    // which is why the ring is asked after a resolve, exactly as a frame does
    const { terminal } = harness();
    const hidden = box({ display: 'none' }, box({ focusable: true }));
    const shown = box({ focusable: true });
    const root = box({}, hidden, shown);
    resolveStyles(root);
    const input = createInput({ root, terminal });

    expect(input.focus.ring()).toEqual([shown]);
    input.stop();
  });

  it('should hand focus on when the element holding it is unmounted', () => {
    // dropping it into nothing reads as an app that stopped responding: every
    // key then goes to the bindings and nowhere else
    const { feed, terminal } = harness();
    const { root, second, third } = tree();
    const input = createInput({ root, terminal });

    input.focus.focus(second);
    second.remove();

    feed('x');
    expect(input.focus.current.get()).toBe(third);
    input.stop();
  });
});

describe('paste', () => {
  it('should arrive whole rather than as a burst of keys', () => {
    // a newline in the middle of a pasted address is content, and a text input
    // that read it as Enter would submit half of it
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const pasted: string[] = [];
    const names: string[] = [];

    input.focus.focus(first);
    first.onKey = (event) => names.push(event.key.name);
    input.onPaste((event) => {
      pasted.push(event.text);
      event.stop();
    });

    feed('[200~one\ntwo[201~');
    expect(pasted).toEqual(['one\ntwo']);
    expect(names).toEqual([]);
    input.stop();
  });

  it('should hold a paste that arrives in pieces', () => {
    const { feed, terminal } = harness();
    const input = createInput({ root: box({}), terminal });
    const pasted: string[] = [];

    input.onPaste((event) => {
      pasted.push(event.text);
      event.stop();
    });

    feed('[200~one');
    feed(' and two');
    expect(pasted).toEqual([]);
    feed('[201~');
    expect(pasted).toEqual(['one and two']);
    input.stop();
  });

  describe('a marker split across two reads', () => {
    // a marker splits like anything else, and on a macOS pty a read is at most
    // 1022 bytes: pastes of 1011, 1013, 1015 and 2035 bytes put the end marker
    // across a read boundary. Searching each chunk on its own meant the paste
    // never ended, and every key after it -- Ctrl-C included -- was content for
    // the life of the process
    const start = '\u001b[200~';
    const end = '\u001b[201~';

    /** A router that records each paste and each key, Ctrl-C by name. */
    function recording(): {
      feed: (chunk: string) => void;
      keys: string[];
      pasted: string[];
      stop: () => void;
    } {
      const { feed, terminal } = harness();
      const input = createInput({ root: box({}), terminal });
      const keys: string[] = [];
      const pasted: string[] = [];
      input.onPaste((event) => {
        pasted.push(event.text);
        event.stop();
      });
      input.bind((event) => {
        keys.push(event.key.ctrl ? `ctrl-${event.key.name}` : event.key.name);
      });
      return { feed, keys, pasted, stop: () => input.stop() };
    }

    // every place a marker can be cut in two, which is after each byte but the last
    const starts = Array.from({ length: start.length - 1 }, (_, i) => i + 1);
    const ends = Array.from({ length: end.length - 1 }, (_, i) => i + 1);

    it.each(ends)('should end a paste whose end marker splits after byte %i', (at) => {
      const { feed, keys, pasted, stop } = recording();

      feed(`a${start}one\ntwo${end.slice(0, at)}`);
      expect(pasted).toEqual([]);
      feed(`${end.slice(at)}b`);
      expect(pasted).toEqual(['one\ntwo']);
      feed('\u0003');
      expect(keys).toEqual(['a', 'b', 'ctrl-c']);
      stop();
    });

    it.each(starts)('should begin a paste whose start marker splits after byte %i', (at) => {
      const { feed, keys, pasted, stop } = recording();

      feed(`a${start.slice(0, at)}`);
      feed(`${start.slice(at)}one\ntwo${end}b`);
      expect(pasted).toEqual(['one\ntwo']);
      feed('\u0003');
      expect(keys).toEqual(['a', 'b', 'ctrl-c']);
      stop();
    });

    it('should hold both markers when every byte is its own read', () => {
      const { feed, keys, pasted, stop } = recording();

      for (const char of `a${start}one\ntwo${end}b`) {
        feed(char);
      }
      expect(pasted).toEqual(['one\ntwo']);
      feed('\u0003');
      expect(keys).toEqual(['a', 'b', 'ctrl-c']);
      stop();
    });

    it('should keep content that only looks like the start of an end marker', () => {
      // what a read ends on is held as content until the next one says whether
      // it was a marker, and here it was not
      const { feed, keys, pasted, stop } = recording();

      feed(`${start}x\u001b[20`);
      feed('0');
      feed(`y${end}`);
      expect(pasted).toEqual(['x\u001b[200y']);
      feed('\u0003');
      expect(keys).toEqual(['ctrl-c']);
      stop();
    });
  });

  it('should type it in when nobody wanted it whole', () => {
    // which is what a terminal that cannot bracket a paste sends anyway
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const names: string[] = [];

    input.focus.focus(first);
    first.onKey = (event) => names.push(event.key.name);

    feed('[200~ab[201~');
    expect(names).toEqual(['a', 'b']);
    input.stop();
  });

  it('should mark a typed-in paste as one', () => {
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const flags: boolean[] = [];

    input.focus.focus(first);
    first.onKey = (event) => flags.push(event.paste);

    feed('a');
    feed('[200~b[201~');
    expect(flags).toEqual([false, true]);
    input.stop();
  });

  it('should keep the keys either side of a paste', () => {
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const names: string[] = [];

    input.focus.focus(first);
    first.onKey = (event) => names.push(event.key.name);
    input.onPaste((event) => event.stop());

    feed('a[200~xyz[201~b');
    expect(names).toEqual(['a', 'b']);
    input.stop();
  });

  it('should offer a paste to the focused element and its ancestors before any handler', () => {
    // a focused text field is what a paste was aimed at, and an app-wide handler
    // registered before the field existed must not be able to take it away --
    // inside a modal that handler is one under the dialog
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const order: string[] = [];

    input.onPaste((event) => {
      order.push(`router:${event.text}`);
      event.stop();
    });
    input.focus.focus(first);
    first.onPaste = (event) => order.push(`first:${event.text}`);
    root.onPaste = (event) => {
      order.push(`root:${event.text}`);
      event.stop();
    };

    feed('\u001b[200~one\u001b[201~');
    expect(order).toEqual(['first:one', 'root:one']);
    input.stop();
  });

  it('should hand on what the tree did not stop, and type in what nothing did', () => {
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const order: string[] = [];

    input.focus.focus(first);
    first.onPaste = (event) => order.push(`first:${event.text}`);
    first.onKey = (event) => order.push(`key:${event.key.name}`);
    input.onPaste((event) => order.push(`router:${event.text}`));

    feed('\u001b[200~ab\u001b[201~');
    expect(order).toEqual(['first:ab', 'router:ab', 'key:a', 'key:b']);
    input.stop();
  });

  it('should offer a paste to no element when nothing is focused', () => {
    const { feed, terminal } = harness();
    const { first, root } = tree();
    const input = createInput({ root, terminal });
    const order: string[] = [];

    root.onPaste = (event) => order.push(`root:${event.text}`);
    first.onPaste = (event) => order.push(`first:${event.text}`);
    input.onPaste((event) => {
      order.push(`router:${event.text}`);
      event.stop();
    });

    feed('\u001b[200~x\u001b[201~');
    expect(order).toEqual(['router:x']);
    input.stop();
  });
});

describe('the focus ring and the clip rect', () => {
  /** A scrolling list of `count` focusable rows, in a four-row viewport. */
  function scroller(count: number): { root: Element; rows: Element[]; view: Element } {
    const rows = Array.from({ length: count }, (_, i) => text(`r${i}`, { focusable: true }));
    const content = box({ 'flex-direction': 'column', 'flex-shrink': 0 }, ...rows);
    const view = box(
      { 'flex-direction': 'column', height: 4, overflow: 'hidden', width: 10 },
      content
    );
    const root = box({}, view);
    resolveStyles(root);
    arrange(root, { height: 4, width: 10 });
    return { root, rows, view };
  }

  it('should scroll a focused row below the fold into view', () => {
    // the requirement the ticket is written around: a highlight somewhere the
    // user cannot see reads as an app that stopped responding
    const { terminal } = harness();
    const { root, rows, view } = scroller(12);
    const input = createInput({ root, terminal });

    input.focus.focus(rows[7]);
    expect(view.scroll?.y).toBe(4);
    input.stop();
  });

  it('should scroll it back when Tab wraps to the first row', () => {
    const { terminal } = harness();
    const { root, rows, view } = scroller(12);
    const input = createInput({ root, terminal });

    input.focus.focus(rows[11]);
    expect(view.scroll?.y).toBe(8);

    // the ring wraps, and the arrange that follows is what moves the boxes --
    // so the next move is computed against them rather than against a guess
    resolveStyles(root);
    arrange(root, { height: 4, width: 10 });
    input.focus.next();
    expect(input.focus.current.get()).toBe(rows[0]);
    expect(view.scroll?.y).toBe(0);
    input.stop();
  });

  it('should leave a row already on screen where it is', () => {
    const { terminal } = harness();
    const { root, rows, view } = scroller(12);
    const input = createInput({ root, terminal });

    input.focus.focus(rows[2]);
    expect(view.scroll).toBeUndefined();
    input.stop();
  });

  it('should not touch a tree nothing has laid out', () => {
    const { terminal } = harness();
    const rows = [text('a', { focusable: true }), text('b', { focusable: true })];
    const root = box({ height: 1, overflow: 'hidden' }, ...rows);
    const input = createInput({ root, terminal });

    expect(() => input.focus.focus(rows[1])).not.toThrow();
    expect(root.scroll).toBeUndefined();
    input.stop();
  });
});
