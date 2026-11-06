import {
  arrange,
  box,
  createTree,
  type Element,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import { canReadKeys, createInput, InputError, type KeyEvent } from '../../src/input/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { createTestTerminal, tick } from '../../src/testing/index.js';
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

  it('should agree with canReadKeys() about where it can exist', () => {
    // one rule asked two ways, by `createInput()` and the prompts before they
    // start and by a caller deciding whether to fetch what a prompt would offer
    // (SIG-304) -- so the two answers are held to each other rather than each
    // to a copy of the rule
    const tty = harness().terminal;
    const piped = createTerminal({
      env: {},
      isTTY: false,
      proc: { on() {}, pid: 1, removeListener() {} } as never,
      stdin: undefined,
      stdout: { write: () => true } as never,
    });
    const cases = [
      { can: true, opts: { terminal: tty } },
      // the terminal draws, but nothing types into the input it was handed
      { can: false, opts: { stdin: { isTTY: false } as never, terminal: tty } },
      // and the other way round: keys arrive, but nothing would show the question
      { can: false, opts: { stdin: harness().terminal.stdin as never, terminal: piped } },
      { can: false, opts: { terminal: piped } },
    ];

    for (const { can, opts } of cases) {
      expect(canReadKeys(opts), JSON.stringify(can)).toBe(can);
      if (can) {
        createInput(opts).stop();
      } else {
        expect(() => createInput(opts)).toThrow(InputError);
      }
    }
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

  // `destroy(err)` sets `errored` at once and emits a tick later, so a router
  // stopped in between took its listener off an error already on its way: the
  // emit found nobody, which is an uncaught exception
  it('should hand onEnd an error the stream was destroyed with and had yet to emit when it stopped', async () => {
    const term = createTestTerminal();
    const input = createInput({ terminal: term.terminal });
    const seen: unknown[] = [];
    const boom = new Error('destroyed');
    input.onEnd((error) => seen.push(error));

    term.stdin.destroy(boom);
    input.stop();
    // told before `stop()` returns, with raw mode already put back
    expect(seen).toEqual([boom]);
    expect(term.stdin.rawMode).toBe(false);
    expect(term.stdin.listenerCount('error')).toBe(1);

    await tick();
    // the emit landed on the guard, which went with it -- and was not told twice
    expect(term.stdin.listenerCount('error')).toBe(0);
    expect(seen).toEqual([boom]);
  });

  it('should not tell onEnd twice about a destroyed stream whose error it already heard', async () => {
    const term = createTestTerminal();
    const input = createInput({ terminal: term.terminal });
    const seen: unknown[] = [];
    input.onEnd((error) => seen.push(error));

    term.stdin.destroy(new Error('heard'));
    await tick();
    input.stop();
    expect(seen.map(String)).toEqual(['Error: heard']);
    expect(term.stdin.listenerCount('error')).toBe(0);
  });

  it('should not claim an error the stream already carried when it attached', async () => {
    const term = createTestTerminal();
    const first = createInput({ terminal: term.terminal });
    term.stdin.destroy(new Error('old'));
    await tick();
    first.stop();

    // `errored` stays set after the event, and this router was not listening
    // when it fired: that is history, not an error in flight
    const later = createInput({ terminal: term.terminal });
    const seen: unknown[] = [];
    later.onEnd((error) => seen.push(error));
    later.stop();
    expect(seen).toEqual([]);
    expect(term.stdin.listenerCount('error')).toBe(0);
  });

  it('should not claim an in-flight error for a router that attached after the stream failed', async () => {
    const term = createTestTerminal();
    const first = createInput({ terminal: term.terminal });
    const told: unknown[] = [];
    first.onEnd((error) => told.push(error));
    term.stdin.destroy(new Error('in flight'));
    first.stop();

    const later = createInput({ terminal: term.terminal });
    const seen: unknown[] = [];
    later.onEnd((error) => seen.push(error));
    later.stop();
    expect(told.map(String)).toEqual(['Error: in flight']);
    expect(seen).toEqual([]);
    // the first router's guard, and no second one
    expect(term.stdin.listenerCount('error')).toBe(1);
    await tick();
    expect(term.stdin.listenerCount('error')).toBe(0);
  });

  it.each([
    ['before the emit', false],
    ['after it', true],
  ])(
    'should guard, and not tell, the only router attached between a destroy and its emit, stopped %s',
    async (_, afterTick) => {
      const term = createTestTerminal();
      term.stdin.destroy(new Error('gap'));
      // no earlier router, so nothing else is listening for the emit to come
      const input = createInput({ terminal: term.terminal });
      const seen: unknown[] = [];
      input.onEnd((error) => seen.push(error));
      if (afterTick) {
        await tick();
      }
      input.stop();
      // a failure from before it attached, so never this router's to report --
      // and the same answer whichever side of the tick it stopped on
      expect(seen).toEqual([]);
      expect(term.stdin.listenerCount('error')).toBe(afterTick ? 0 : 1);
      await tick();
      expect(term.stdin.listenerCount('error')).toBe(0);
    }
  );

  it('should leave no guard for an emit no router heard, once its own tick has passed', async () => {
    const term = createTestTerminal();
    // heard by somebody else's listener, so nothing here recorded it
    const listener = (): void => {};
    term.stdin.on('error', listener);
    term.stdin.destroy(new Error('elsewhere'));
    await tick();
    term.stdin.off('error', listener);

    const input = createInput({ terminal: term.terminal });
    // the tick it queued at attach runs after the emit was due, which is how it
    // knows the emit is behind it without asking the stream's internals
    await tick();
    input.stop();
    expect(term.stdin.listenerCount('error')).toBe(0);
  });

  it('should not let a different error spend the guard kept for the destroy error', async () => {
    const term = createTestTerminal();
    const input = createInput({ terminal: term.terminal });
    term.stdin.destroy(new Error('own'));
    input.stop();
    expect(term.stdin.listenerCount('error')).toBe(1);

    // the guard alone is transparent to an error it is not for: thrown from the
    // emit, as it would have been with nobody listening -- and still there after
    expect(() => term.stdin.emit('error', new Error('other'))).toThrow('other');
    expect(term.stdin.listenerCount('error')).toBe(1);
    await tick();
    // and its own error, a tick later, took it off
    expect(term.stdin.listenerCount('error')).toBe(0);
  });

  it('should leave a different error to the other listeners when the guard is not alone', async () => {
    const term = createTestTerminal();
    const input = createInput({ terminal: term.terminal });
    term.stdin.destroy(new Error('own'));
    input.stop();
    const others: unknown[] = [];
    const listener = (error: unknown): number => others.push(error);
    term.stdin.on('error', listener);

    expect(() => term.stdin.emit('error', new Error('other'))).not.toThrow();
    expect(others.map(String)).toEqual(['Error: other']);
    await tick();
    term.stdin.off('error', listener);
    expect(term.stdin.listenerCount('error')).toBe(0);
  });

  it('should tell every router that was listening, and leave one guard for the one emit', async () => {
    const term = createTestTerminal();
    const a = createInput({ terminal: term.terminal });
    const b = createInput({ terminal: term.terminal });
    const seen: string[] = [];
    a.onEnd(() => seen.push('a'));
    b.onEnd(() => seen.push('b'));
    term.stdin.destroy(new Error('both'));
    a.stop();
    b.stop();
    // each would have heard it a tick sooner, so each is told
    expect(seen).toEqual(['a', 'b']);
    expect(term.stdin.listenerCount('error')).toBe(1);
    await tick();
    expect(term.stdin.listenerCount('error')).toBe(0);
  });

  it('should run every onEnd handler when one throws, and rethrow that error as itself', () => {
    const { emit, terminal } = harness();
    const input = createInput({ terminal });
    const seen: string[] = [];
    const boom = new Error('only');
    input.onEnd(() => {
      throw boom;
    });
    input.onEnd(() => seen.push('second'));

    let thrown: unknown;
    try {
      emit('end');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);
    expect(seen).toEqual(['second']);
    input.stop();
  });

  it('should run every onEnd handler when several throw, and rethrow them all as an AggregateError', () => {
    const { emit, terminal } = harness();
    const input = createInput({ terminal });
    const seen: string[] = [];
    const first = new Error('first');
    const third = new Error('third');
    input.onEnd(() => {
      throw first;
    });
    input.onEnd(() => seen.push('second'));
    input.onEnd(() => {
      throw third;
    });

    let thrown: unknown;
    try {
      emit('end');
    } catch (error) {
      thrown = error;
    }
    // every one, in the order the handlers ran -- the first alone dropped the rest
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([first, third]);
    expect(seen).toEqual(['second']);
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

  it('should tell both ends of a move, in the order the states change', () => {
    // a control shows its focus from `onFocusChange` rather than by asking a
    // router it was never handed, so the hook has to see every route to a move:
    // the key here, and the router's own `focus()` an app or a click calls
    const { feed, terminal } = harness();
    const { first, root, second } = tree();
    const input = createInput({ root, terminal });
    const heard: string[] = [];
    first.onFocusChange = (element, focused) => {
      heard.push(`first ${focused} ${element === first}`);
    };
    second.onFocusChange = (element, focused) => {
      heard.push(`second ${focused} ${element === second}`);
    };

    feed('\t');
    feed('\t');
    input.focus.focus(undefined);
    expect(heard).toEqual([
      'first true true',
      'first false true',
      'second true true',
      'second false true',
    ]);
    input.stop();
  });

  it('should leave one element focused when a handler moves the focus during a move', () => {
    // a handler used to run between the router's writes, while `current` still
    // named the element losing the focus -- so a blur handler that moved it on
    // finished the move it was inside of as well, and two elements were left
    // with `:focus` and the role, only one of which the keys went to
    const { terminal } = harness();
    const { first, root, second, third } = tree();
    const input = createInput({ root, terminal });
    const seen: string[] = [];
    for (const element of [first, second, third]) {
      element.onFocusChange = (target, focused) => {
        // and a handler reads a router that agrees with the state it was told
        seen.push(`${input.focus.current.get() === target} ${focused}`);
        target.toggleClass('sigil-focus', focused);
      };
    }
    first.onFocusChange = (target, focused) => {
      seen.push(`${input.focus.current.get() === target} ${focused}`);
      if (!focused) {
        input.focus.focus(third);
      }
      target.toggleClass('sigil-focus', focused);
    };

    input.focus.focus(first);
    input.focus.focus(second);
    expect(input.focus.current.get()).toBe(third);
    expect([first, second, third].map((el) => el.states.includes('focus'))).toEqual([
      false,
      false,
      true,
    ]);
    expect([first, second, third].map((el) => el.classes.includes('sigil-focus'))).toEqual([
      false,
      false,
      true,
    ]);
    expect(seen.every((line) => line === 'true true' || line === 'false false')).toBe(true);
    input.stop();
  });

  it('should let a blur handler take the focus back, which is a focus trap', () => {
    // the nested `focus(first)` used to return at once, because `current` still
    // named `first` though its state had been cleared -- and the outer move then
    // focused `second` anyway, so a trap written in the hook could not hold
    const { terminal } = harness();
    const { first, root, second } = tree();
    const input = createInput({ root, terminal });
    const heard: string[] = [];
    first.onFocusChange = (_, focused) => {
      heard.push(`first ${focused}`);
      if (!focused) {
        input.focus.focus(first);
      }
    };
    second.onFocusChange = (_, focused) => {
      heard.push(`second ${focused}`);
    };

    input.focus.focus(first);
    input.focus.focus(second);
    expect(input.focus.current.get()).toBe(first);
    expect(first.states).toContain('focus');
    expect(second.states).not.toContain('focus');
    // `second` had the focus for no longer than the move, so it is told nothing
    expect(heard).toEqual(['first true', 'first false', 'first true']);
    input.stop();
  });

  it('should finish a move and tell the other end when a handler throws', () => {
    // a throw used to abort the move after the state was cleared and before
    // `current` was set, so `:focus` and the router disagreed and the element
    // gaining the focus was never told it had it
    const { terminal } = harness();
    const { first, root, second } = tree();
    const input = createInput({ root, terminal });
    const boom = new Error('boom');
    first.onFocusChange = (_, focused) => {
      if (!focused) {
        throw boom;
      }
    };
    second.onFocusChange = (target, focused) => {
      target.toggleClass('sigil-focus', focused);
    };

    input.focus.focus(first);
    expect(() => input.focus.focus(second)).toThrow(boom);
    expect(input.focus.current.get()).toBe(second);
    expect(first.states).not.toContain('focus');
    expect(second.states).toContain('focus');
    expect(second.classes).toContain('sigil-focus');

    // and both ends throwing is both errors, the way a graph walk reports them
    second.onFocusChange = () => {
      throw new Error('bang');
    };
    first.onFocusChange = () => {
      throw boom;
    };
    let caught: unknown;
    try {
      input.focus.focus(first);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((err: Error) => err.message)).toEqual([
      'bang',
      'boom',
    ]);
    expect(input.focus.current.get()).toBe(first);
    input.stop();
  });

  it('should refuse a blur handler that puts the focus back with setState', () => {
    // taken, the write left `first` and `second` both with `:focus` and the role
    // while `current` named `second` -- the round-one failure, by the write that
    // does not go through the router. `focus()` is the spelling that works
    const { terminal } = harness();
    const { first, root, second } = tree();
    const input = createInput({ root, terminal });
    for (const element of [first, second]) {
      element.onFocusChange = (target, focused) => target.toggleClass('sigil-focus', focused);
    }
    first.onFocusChange = (target, focused) => {
      target.toggleClass('sigil-focus', focused);
      if (!focused) {
        target.setState('focus', true);
      }
    };

    input.focus.focus(first);
    expect(() => input.focus.focus(second)).toThrow(/focus\.focus\(\)/);
    expect(input.focus.current.get()).toBe(second);
    expect([first, second].map((el) => el.states.includes('focus'))).toEqual([false, true]);
    expect([first, second].map((el) => el.classes.includes('sigil-focus'))).toEqual([false, true]);
    input.stop();
  });

  for (const which of ['another element', 'the element being written'] as const) {
    it(`should refuse a setState of the focus on ${which} from the tree's mark callback`, () => {
      // `setState()` runs the tree's mark callback between its check and its
      // return, and the router's permission used to be a flag held across both of
      // its writes -- so a callback writing another element's focus was let
      // through, and two elements wore `:focus` and the role while the keys went
      // to one. The permission is spent by the write it allows, so the element
      // being written cannot be written a second time from inside that write
      const { terminal } = harness();
      const { first, root, second, third } = tree();
      const input = createInput({ root, terminal });
      for (const element of [first, second, third]) {
        element.onFocusChange = (target, focused) => target.toggleClass('sigil-focus', focused);
      }
      let armed = false;
      createTree(root, () => {
        if (armed) {
          armed = false;
          (which === 'another element' ? third : first).setState('focus', true);
        }
      });

      input.focus.focus(first);
      armed = true;
      expect(() => input.focus.focus(second)).toThrow(/focus\.focus\(\)/);
      expect(input.focus.current.get()).toBe(second);
      expect([first, second, third].filter((el) => el.states.includes('focus'))).toEqual([second]);
      expect([first, second, third].filter((el) => el.classes.includes('sigil-focus'))).toEqual([
        second,
      ]);
      input.stop();
    });
  }

  for (const [at, name] of [
    [1, 'losing'],
    [2, 'gaining'],
  ] as const) {
    it(`should leave one element focused when the mark callback moves the focus while the ${name} end is written`, () => {
      // a `focus()` from the mark callback used to clear the router's permission in
      // its own `finally`, so the open move's second write threw; and whichever
      // write it came from, finishing the open move afterwards would focus a
      // second element. The move started inside is the router's latest, so it wins
      const { terminal } = harness();
      const { first, root, second, third } = tree();
      const input = createInput({ root, terminal });
      for (const element of [first, second, third]) {
        element.onFocusChange = (target, focused) => target.toggleClass('sigil-focus', focused);
      }
      let marks = -1;
      createTree(root, () => {
        if (marks >= 0 && ++marks === at) {
          input.focus.focus(third);
        }
      });

      input.focus.focus(first);
      marks = 0;
      input.focus.focus(second);
      expect(input.focus.current.get()).toBe(third);
      expect([first, second, third].filter((el) => el.states.includes('focus'))).toEqual([third]);
      expect([first, second, third].filter((el) => el.classes.includes('sigil-focus'))).toEqual([
        third,
      ]);
      input.stop();
    });
  }

  it('should settle a chain that passes the focus on through sixty controls', () => {
    // a one-way chain tells each control at most twice however long it is --
    // gaining the focus and passing it on, the last one once -- and the bound used
    // to count every call in a drain, so sixty hops gave up at the fiftieth with
    // the focus on a control that had never been told it had it. What this pins
    // is that the bound is counted per element; how large it is, the bounce test
    const { terminal } = harness();
    const rows = Array.from({ length: 60 }, (_, i) => box({ focusable: true }, text(`${i}`)));
    const root = box({}, ...rows);
    const input = createInput({ root, terminal });
    for (const [i, row] of rows.entries()) {
      row.onFocusChange = (target, focused) => {
        target.toggleClass('sigil-focus', focused);
        const next = rows[i + 1];
        if (focused && next) {
          input.focus.focus(next);
        }
      };
    }

    input.focus.focus(rows[0]);
    expect(input.focus.current.get()).toBe(rows[59]);
    expect(rows.filter((row) => row.states.includes('focus'))).toEqual([rows[59]]);
    expect(rows.filter((row) => row.classes.includes('sigil-focus'))).toEqual([rows[59]]);
    input.stop();
  });

  it('should settle handlers that bounce the focus back and forth until they stop', () => {
    // `bounces` round trips tell the element that starts 2 * bounces + 1 times and
    // the other 2 * bounces, which is not a cycle however large it is -- until it
    // passes the bound. So 49 settles at 99 tells and 50 gives up at the 101st,
    // which pins the bound at a hundred to within one: a bound of a couple of calls
    // per element, or of twenty, would call the first a cycle
    function bounce(bounces: number): { counts: number[]; error: unknown } {
      const { terminal } = harness();
      const { first, root, second } = tree();
      const input = createInput({ root, terminal });
      const counts = [0, 0];
      let left = bounces;
      first.onFocusChange = (target, focused) => {
        counts[0]++;
        target.toggleClass('sigil-focus', focused);
        if (focused && left-- > 0) {
          input.focus.focus(second);
        }
      };
      second.onFocusChange = (target, focused) => {
        counts[1]++;
        target.toggleClass('sigil-focus', focused);
        if (focused) {
          input.focus.focus(first);
        }
      };
      let error: unknown;
      try {
        input.focus.focus(first);
      } catch (err) {
        error = err;
      }
      if (error === undefined) {
        expect(input.focus.current.get()).toBe(first);
        expect([first, second].map((el) => el.classes.includes('sigil-focus'))).toEqual([
          true,
          false,
        ]);
      }
      input.stop();
      return { counts, error };
    }

    expect(bounce(49)).toEqual({ counts: [99, 98], error: undefined });
    expect(String(bounce(50).error)).toMatch(/did not settle/);
  });

  it('should give up on a cycle and still tell the elements it left behind', () => {
    // handlers that keep moving the focus to each other spin for ever, so a drain
    // gives up -- and used to leave what the element it stopped on had last been
    // told as though it were true, so that element sat focused without the role
    // and its next blur was skipped as a change it had already heard
    const { terminal } = harness();
    const { first, root, second, third } = tree();
    const input = createInput({ root, terminal });
    first.onFocusChange = (_, focused) => {
      if (focused) {
        input.focus.focus(second);
      }
    };
    second.onFocusChange = (_, focused) => {
      if (focused) {
        input.focus.focus(first);
      }
    };

    expect(() => input.focus.focus(first)).toThrow(/did not settle/);
    const left = input.focus.current.get();
    expect([first, second]).toContain(left);
    expect([first, second, third].filter((el) => el.states.includes('focus'))).toEqual([left]);

    // honest handlers from here on: the element left focused is told it lost the
    // focus, and nothing is left wearing the role but the one that has it
    const heard: string[] = [];
    for (const [name, element] of [
      ['first', first],
      ['second', second],
      ['third', third],
    ] as const) {
      element.onFocusChange = (target, focused) => {
        heard.push(`${name} ${focused}`);
        target.toggleClass('sigil-focus', focused);
      };
    }
    input.focus.focus(third);
    expect(heard).toContain(`${left === first ? 'first' : 'second'} false`);
    expect(heard).toContain('third true');
    expect([first, second, third].filter((el) => el.classes.includes('sigil-focus'))).toEqual([
      third,
    ]);
    input.stop();
  });

  it("should tell another router's handlers when the outermost move lets go", () => {
    // the queue is one per process, because an element does not know which router
    // owns it: a `focus()` on a second router from inside the first one's handler
    // commits at once, returns before its own handlers run, and what they throw is
    // raised from the outermost move -- a decision, pinned so that it stays one
    const one = tree();
    const two = tree();
    const inputOne = createInput({ root: one.root, terminal: harness().terminal });
    const inputTwo = createInput({ root: two.root, terminal: harness().terminal });
    const log: string[] = [];
    one.first.onFocusChange = (_, focused) => {
      if (!focused) {
        inputTwo.focus.focus(two.first);
        log.push(`returned, told ${two.first.classes.includes('sigil-focus')}`);
      }
    };
    two.first.onFocusChange = (target, focused) => {
      target.toggleClass('sigil-focus', focused);
      log.push(`two.first ${focused}`);
      throw new Error('from two');
    };

    inputOne.focus.focus(one.first);
    expect(() => inputOne.focus.focus(one.second)).toThrow('from two');
    expect(log).toEqual(['returned, told false', 'two.first true']);
    expect(inputTwo.focus.current.get()).toBe(two.first);
    expect(two.first.classes).toContain('sigil-focus');
    inputOne.stop();
    inputTwo.stop();
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

    it('should hold a large paste in time linear in its size', () => {
      // joining what was held to each read and searching the result made V8
      // flatten the whole paste every time, so 16 MB in a macOS pty's 1022-byte
      // reads took about 9s; searching the held tail takes about 5ms. The budget
      // sits an order of magnitude from both, so neither a loaded machine nor a
      // quadratic search lands on the wrong side of it
      const { feed, keys, pasted, stop } = recording();
      const chunk = 'x'.repeat(1022);
      const reads = 16_000;

      const began = performance.now();
      feed(start);
      for (let i = 0; i < reads; i++) {
        feed(chunk);
      }
      feed(end);
      const took = performance.now() - began;

      expect(pasted.map((text) => text.length)).toEqual([reads * chunk.length]);
      expect(took).toBeLessThan(1000);
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

  it('should still tell the focus handlers when the scroll a move caused throws', () => {
    // the scroll into view is part of the move's commit, and a throw out of it
    // must neither skip the handlers nor leave every later move's held for ever
    const { terminal } = harness();
    const { root, rows, view } = scroller(12);
    const input = createInput({ root, terminal });
    const heard: string[] = [];
    for (const [i, row] of rows.entries()) {
      row.onFocusChange = (_, focused) => heard.push(`r${i} ${focused}`);
    }
    view.onScroll = () => {
      throw new Error('scroll');
    };

    expect(() => input.focus.focus(rows[7])).toThrow('scroll');
    expect(input.focus.current.get()).toBe(rows[7]);
    view.onScroll = undefined;
    input.focus.focus(rows[6]);
    expect(heard).toEqual(['r7 true', 'r7 false', 'r6 true']);
    input.stop();
  });

  it('should refuse a setState of the focus from the scroll a move caused', () => {
    // the scroll into view runs inside the move, so a write there landed before
    // the announcement it should have been part of: a second row with `:focus`,
    // told it had it while `current` named the first, wearing the role as well
    const { terminal } = harness();
    const { root, rows, view } = scroller(12);
    const input = createInput({ root, terminal });
    for (const row of rows) {
      row.onFocusChange = (target, focused) => target.toggleClass('sigil-focus', focused);
    }
    view.onScroll = () => {
      rows[0]?.setState('focus', true);
    };

    expect(() => input.focus.focus(rows[7])).toThrow(/focus\.focus\(\)/);
    expect(input.focus.current.get()).toBe(rows[7]);
    expect(rows.filter((row) => row.states.includes('focus'))).toEqual([rows[7]]);
    expect(rows.filter((row) => row.classes.includes('sigil-focus'))).toEqual([rows[7]]);
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
