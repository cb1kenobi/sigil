import { box, type Element, text } from '../../src/element/index.js';
import { createInput, KeySpecError } from '../../src/input/index.js';
import { createEffect } from '../../src/renderer/index.js';
import { flush } from '../../src/signals/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { describe, expect, it } from 'vitest';

/**
 * `fallback()`: an app-level key that a focused element outranks.
 *
 * The fifth layer of a key's dispatch -- function bindings, sequences, the
 * focused element and its ancestors, the fallbacks, the Tab default -- and the
 * only one that runs when nothing is focused.
 */

function setup(): {
  field: Element;
  input: ReturnType<typeof createInput>;
  other: Element;
  press: (chunk: string) => Promise<void>;
  root: Element;
} {
  const field = box({ focusable: true }, text('field'));
  // a text field takes the characters it is typed: it stops the event
  field.onKey = (event) => {
    if (event.key.sequence.length === 1 && event.key.sequence >= ' ') {
      event.stop();
    }
  };
  const other = box({ focusable: true }, text('other'));
  const root = box({}, field, other);
  const term = createTestTerminal();
  const input = createInput({ root, terminal: term.terminal });
  return { field, input, other, press: (chunk) => term.press(chunk), root };
}

describe('fallback()', () => {
  it('should run with nothing focused, where the focus walk has nobody to ask', async () => {
    const { input, press, root } = setup();
    // not even the root's own handler is reached with nothing focused, which is
    // why a fallback exists
    let rootSaw = 0;
    root.onKey = () => void rootSaw++;
    const seen: string[] = [];
    input.fallback('q', (key) => seen.push(key.name));

    expect(input.focus.current.get()).toBeUndefined();
    await press('q');

    expect(seen).toEqual(['q']);
    expect(rootSaw).toBe(0);
  });

  it('should not run for a key a focused field took, and should for any other focus', async () => {
    const { field, input, other, press } = setup();
    const seen: string[] = [];
    input.fallback('q', () => seen.push('q'));

    input.focus.focus(field);
    await press('q');
    expect(seen).toEqual([]);

    input.focus.focus(other);
    await press('q');
    expect(seen).toEqual(['q']);
  });

  it('should run after an ancestor that did not stop the key, and not after one that did', async () => {
    const { input, other, press, root } = setup();
    const order: string[] = [];
    input.fallback('q', () => order.push('fallback'));
    input.focus.focus(other);

    root.onKey = () => void order.push('root');
    await press('q');
    expect(order).toEqual(['root', 'fallback']);

    order.length = 0;
    root.onKey = (event) => {
      order.push('root');
      event.stop();
    };
    await press('q');
    expect(order).toEqual(['root']);
  });

  it('should come after a function binding and a sequence on the same key', async () => {
    const { input, press } = setup();
    const order: string[] = [];
    input.fallback('q', () => order.push('fallback'));

    const offSequence = input.bind('q', () => order.push('sequence'));
    await press('q');
    expect(order).toEqual(['sequence']);
    offSequence();

    order.length = 0;
    const offFn = input.bind((event) => {
      order.push('function');
      event.stop();
    });
    await press('q');
    expect(order).toEqual(['function']);
    offFn();
  });

  it('should claim the key it matched, so the Tab default does not also move the focus', async () => {
    const { input, press } = setup();
    const seen: string[] = [];
    input.fallback('tab', () => seen.push('tab'));

    await press(KEYS.tab);

    expect(seen).toEqual(['tab']);
    expect(input.focus.current.get()).toBeUndefined();
  });

  it('should leave the Tab default alone when no fallback is on the key', async () => {
    const { field, input, press } = setup();
    input.fallback('q', () => {});

    await press(KEYS.tab);

    expect(input.focus.current.get()).toBe(field);
  });

  it('should match modifiers, so ctrl+r is not r', async () => {
    const { input, press } = setup();
    const seen: string[] = [];
    input.fallback('ctrl+r', () => seen.push('ctrl+r'));
    input.fallback('r', () => seen.push('r'));

    await press('\u0012');
    await press('r');

    expect(seen).toEqual(['ctrl+r', 'r']);
  });

  it('should refuse a spec that names two keys, and leave nothing registered', async () => {
    const { input, press } = setup();
    const seen: string[] = [];

    expect(() => input.fallback('g g', () => seen.push('g'))).toThrow(KeySpecError);
    expect(() => input.fallback('g g', () => seen.push('g'))).toThrow(/one key/);
    expect(() => input.fallback('', () => seen.push('empty'))).toThrow(KeySpecError);
    expect(() => input.fallback('q', undefined as never)).toThrow(TypeError);
    expect(() => input.fallback('q', () => seen.push('q'), { description: '' })).toThrow(TypeError);
    expect(input.bindings()).toHaveLength(0);

    await press('g');
    await press('g');
    await press('q');
    expect(seen).toEqual([]);
  });

  it('should never see a pasted key, and should not be cancelled or advanced by one', async () => {
    const { input, press } = setup();
    const seen: string[] = [];
    input.fallback('q', () => seen.push('q'));

    await press('\u001b[200~qq\u001b[201~');
    expect(seen).toEqual([]);

    await press('q');
    expect(seen).toEqual(['q']);
  });

  it('should run every fallback on a key, in the order they were added', async () => {
    const { input, press } = setup();
    const seen: string[] = [];
    input.fallback('q', () => seen.push('first'));
    input.fallback('q', () => seen.push('second'));

    await press('q');

    expect(seen).toEqual(['first', 'second']);
  });

  it('should hand the key to the handler', async () => {
    const { input, press } = setup();
    let got: { name: string; ctrl: boolean } | undefined;
    input.fallback('ctrl+x', (key) => (got = { ctrl: key.ctrl, name: key.name }));

    await press('\u0018');

    expect(got).toEqual({ ctrl: true, name: 'x' });
  });

  it('should take the key off with the disposer, once, and leave a twin registered', async () => {
    const { input, press } = setup();
    const seen: string[] = [];
    const handler = () => seen.push('q');
    const offA = input.fallback('q', handler);
    const offB = input.fallback('q', handler);

    offA();
    offA();
    await press('q');
    // one function added twice is two registrations: the first disposer took
    // off its own and no more
    expect(seen).toEqual(['q']);

    offB();
    await press('q');
    expect(seen).toEqual(['q']);
  });

  it('should not run a fallback that an earlier one removed during the same key', async () => {
    const { input, press } = setup();
    const seen: string[] = [];
    let offSecond = () => {};
    input.fallback('q', () => {
      seen.push('first');
      offSecond();
    });
    offSecond = input.fallback('q', () => seen.push('second'));

    await press('q');

    expect(seen).toEqual(['first']);
  });

  it('should run no more fallbacks once one of them stopped the router', async () => {
    const { input } = setup();
    const seen: string[] = [];
    input.fallback('q', () => {
      seen.push('first');
      input.stop();
    });
    input.fallback('q', () => seen.push('second'));

    // fed rather than pressed: a stopped router no longer reads the terminal
    input.feed('q');

    expect(seen).toEqual(['first']);
  });

  it('should not hand a key to a fallback added while that key was being dispatched', async () => {
    const { input, press } = setup();
    const seen: string[] = [];
    input.fallback('q', () => {
      seen.push('first');
      input.fallback('q', () => seen.push('late'));
    });

    await press('q');
    expect(seen).toEqual(['first']);
  });

  it('should stop claiming the key once the last fallback on it is gone', async () => {
    const { field, input, press } = setup();
    const off = input.fallback('tab', () => {});
    await press(KEYS.tab);
    expect(input.focus.current.get()).toBeUndefined();

    off();
    await press(KEYS.tab);
    expect(input.focus.current.get()).toBe(field);
  });
});

describe('fallback() and the key listing', () => {
  it('should list a described fallback after the scoped entries, which is its place in dispatch', () => {
    const { field, input } = setup();
    // registered first, listed last
    input.fallback('q', () => {}, { description: 'Quit' });
    input.describe('enter', { description: 'edit', scope: field });
    input.bind('ctrl+s', () => {}, { description: 'save' });
    input.focus.focus(field);

    expect(input.bindings().map((b) => b.keys)).toEqual(['ctrl+s', 'enter', 'q']);
  });

  it('should list a fallback wherever the focus is, including inside a text field', () => {
    const { field, input } = setup();
    input.fallback('q', () => {}, { description: 'Quit' });

    expect(input.bindings().map((b) => b.keys)).toEqual(['q']);
    input.focus.focus(field);
    // accepted: the router cannot know whether this field takes the key
    expect(input.bindings().map((b) => b.keys)).toEqual(['q']);
  });

  it('should not list a fallback with no description', () => {
    const { input } = setup();
    input.fallback('q', () => {});

    expect(input.bindings()).toHaveLength(0);
  });

  it('should take the listing off with the fallback', () => {
    const { input } = setup();
    const off = input.fallback('q', () => {}, { description: 'Quit' });
    expect(input.bindings()).toHaveLength(1);

    off();
    expect(input.bindings()).toHaveLength(0);
  });

  it('should be read reactively, so a footer follows a fallback being added and removed', () => {
    const { input } = setup();
    const seen: string[][] = [];
    createEffect(() => {
      seen.push(input.bindings().map((b) => b.keys));
    });
    flush();
    expect(seen).toEqual([[]]);

    const off = input.fallback('q', () => {}, { description: 'Quit' });
    flush();
    off();
    flush();

    expect(seen).toEqual([[], ['q'], []]);
  });

  it('should let an effect register a fallback without depending on what it registered', () => {
    const { input } = setup();
    let runs = 0;
    createEffect(() => {
      runs++;
      input.fallback('q', () => {}, { description: 'Quit' });
    });
    flush();
    flush();

    expect(runs).toBe(1);
  });
});
