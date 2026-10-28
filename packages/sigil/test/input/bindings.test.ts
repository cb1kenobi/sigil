import { box, type Element, text } from '../../src/element/index.js';
import { createInput, KeySpecError } from '../../src/input/index.js';
import { createEffect } from '../../src/renderer/index.js';
import { createTestTerminal, tick } from '../../src/testing/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The described bindings: what `bind()` and `describe()` publish, and which of
 * them `bindings()` says apply to the focus as it is now.
 *
 * Nothing here changes what a key does, which is half of the claim and has its
 * own test: a description is read by a listing and by nothing in dispatch.
 */

function setup(): {
  a: Element;
  b: Element;
  inner: Element;
  input: ReturnType<typeof createInput>;
  press: (chunk: string) => Promise<void>;
} {
  const inner = box({ focusable: true }, text('inner'));
  const a = box({ focusable: true }, text('a'), inner);
  const b = box({ focusable: true }, text('b'));
  const root = box({}, a, b);
  const term = createTestTerminal();
  const input = createInput({ root, terminal: term.terminal });
  return { a, b, inner, input, press: (chunk) => term.press(chunk) };
}

describe('described bindings', () => {
  it('should list a bind() that carries a description, in canonical spelling', () => {
    const { input } = setup();
    input.bind('Ctrl+S', () => {}, { description: 'save', group: 'file', priority: 3 });

    expect(input.bindings().map((b) => ({ ...b }))).toEqual([
      { description: 'save', group: 'file', keys: 'ctrl+s', priority: 3, scope: undefined },
    ]);
  });

  it('should not list a binding that has no description', () => {
    const { input } = setup();
    input.bind('q', () => {});
    input.bind('x', () => {}, { description: 'cut' });

    expect(input.bindings().map((b) => b.keys)).toEqual(['x']);
  });

  it('should leave dispatch exactly as it was for a described binding', async () => {
    const { input, press } = setup();
    const seen: string[] = [];
    input.bind('g g', () => seen.push('top'), { description: 'top' });
    input.bind('q', () => seen.push('quit'));

    await press('g');
    await press('g');
    await press('q');

    expect(seen).toEqual(['top', 'quit']);
  });

  it('should take the listing off with the binding', () => {
    const { input } = setup();
    const off = input.bind('q', () => {}, { description: 'quit' });
    expect(input.bindings()).toHaveLength(1);

    off();
    expect(input.bindings()).toHaveLength(0);
  });

  it('should list a leader binding under the whole sequence', () => {
    const { input } = setup();
    const leader = input.leader('space');
    leader.bind('f', () => {}, { description: 'find' });

    expect(input.bindings().map((b) => b.keys)).toEqual(['space f']);

    leader.dispose();
    expect(input.bindings()).toHaveLength(0);
  });

  it('should refuse a bad description or spec and leave nothing registered', async () => {
    const { input, press } = setup();
    const seen: string[] = [];

    expect(() => input.bind('q', () => seen.push('q'), { description: '' })).toThrow(TypeError);
    expect(() => input.bind('q', () => {}, { description: 3 as never })).toThrow(TypeError);
    expect(() => input.describe('nope+', { description: 'x' })).toThrow(KeySpecError);
    expect(input.bindings()).toHaveLength(0);

    // the refused bind() took its handler back off, so `q` is still no key at all
    await press('q');
    expect(seen).toEqual([]);
  });

  it('should list a scoped description only while the focus is inside its scope', () => {
    const { a, b, inner, input } = setup();
    input.bind('q', () => {}, { description: 'quit' });
    input.describe('enter', { description: 'open', scope: a });
    input.describe('x', { description: 'drop', scope: b });

    expect(
      input.bindings().map((x) => x.keys),
      'nothing focused'
    ).toEqual(['q']);

    input.focus.focus(a);
    expect(input.bindings().map((x) => x.keys)).toEqual(['q', 'enter']);

    // a descendant is inside the scope
    input.focus.focus(inner);
    expect(input.bindings().map((x) => x.keys)).toEqual(['q', 'enter']);

    input.focus.focus(b);
    expect(input.bindings().map((x) => x.keys)).toEqual(['q', 'x']);
  });

  it('should order the scoped entries from the focused element outwards', () => {
    const { a, inner, input } = setup();
    input.describe('enter', { description: 'outer', scope: a });
    input.describe('space', { description: 'inner', scope: inner });
    input.bind('q', () => {}, { description: 'quit' });
    input.focus.focus(inner);

    expect(input.bindings().map((x) => x.description)).toEqual(['quit', 'inner', 'outer']);
  });

  it('should be read reactively, so an effect follows the focus and the set', async () => {
    const { a, b, input } = setup();
    const seen: string[][] = [];
    const stop = createEffect(() => void seen.push(input.bindings().map((x) => x.keys)));
    input.describe('enter', { description: 'open', scope: a });

    input.focus.focus(a);
    await tick();
    input.focus.focus(b);
    await tick();
    input.bind('q', () => {}, { description: 'quit' });
    await tick();
    stop();

    expect(seen.at(-3)).toEqual(['enter']);
    expect(seen.at(-2)).toEqual([]);
    expect(seen.at(-1)).toEqual(['q']);
  });

  it('should hand out records that cannot be edited', () => {
    const { input } = setup();
    input.bind('q', () => {}, { description: 'quit' });
    const [first] = input.bindings();

    expect(() => {
      (first as { description: string }).description = 'x';
    }).toThrow(TypeError);
  });
});
