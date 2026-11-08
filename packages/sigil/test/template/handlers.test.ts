/**
 * Event handlers and refs as template props, in both frontends.
 *
 * A host element used to take style and six reserved props and nothing else, so
 * an app written in a template was display-only. Every case runs over both
 * frontends, so a behaviour that holds for one and not the other fails by name
 * -- which is the claim the two rest on. JSX is driven by calling `jsx()` and
 * `jsxs()`, which is what the transform emits; the tag is called directly.
 */

import { box, type Element, HANDLER_PROPS, text } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { createEffect, createRoot, onCleanup } from '../../src/renderer/index.js';
import { flush, State } from '../../src/signals/index.js';
import { ui } from '../../src/template/index.js';
import { jsx, jsxs } from '../../src/template/runtime.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { describe, expect, it } from 'vitest';

/** The props the cases below set; the rest of the template is the same in both. */
interface Props {
  class?: unknown;
  onKey?: unknown;
  onMouse?: unknown;
  onResize?: unknown;
  ref?: unknown;
}

/** One frontend writing `<box ...props><text>x</text><text>y</text></box>`. */
interface Frontend {
  name: string;
  build: (props: Props) => Element;
}

const FRONTENDS: Frontend[] = [
  {
    build: (props) =>
      jsxs('box', {
        ...props,
        children: [jsx('text', { children: 'x' }), jsx('text', { children: 'y' })],
      }),
    name: 'jsx',
  },
  {
    build: (props) =>
      ui`<box class=${props.class} onKey=${props.onKey} onMouse=${props.onMouse} onResize=${props.onResize} ref=${props.ref}><text>x</text><text>y</text></box>`,
    name: 'the ui tag',
  },
];

/** Builds under an owner and tears it down, so a stray effect cannot outlive the test. */
function inRoot<T>(make: () => T): T {
  return createRoot((dispose) => {
    const value = make();
    dispose();
    return value;
  });
}

describe.each(FRONTENDS)('a handler prop in $name', ({ build }) => {
  it('should assign the function and never call it', () => {
    // the thunk rule would have called it with no arguments while the template
    // built, and set whatever it returned as a style property
    let calls = 0;
    const onKey = () => {
      calls += 1;
    };
    const el = inRoot(() => build({ onKey }));
    expect(el.onKey).toBe(onKey);
    expect(calls).toBe(0);
  });

  it('should assign every one of the seven hooks', () => {
    for (const name of HANDLER_PROPS) {
      const handler = () => false;
      const el =
        name === 'onKey' || name === 'onMouse' || name === 'onResize'
          ? inRoot(() => build({ [name]: handler }))
          : inRoot(() => jsx('box', { [name]: handler }));
      expect(el[name], name).toBe(handler);
    }
  });

  it('should not subscribe the handler to anything it reads when it runs', () => {
    // a handler is not an effect: a signal it reads on a key must not make the
    // element re-assign it, and writing one must not call it
    const count = new State(0);
    let calls = 0;
    const onKey = () => {
      calls += 1;
      count.get();
    };
    createRoot((dispose) => {
      build({ onKey });
      count.set(1);
      dispose();
    });
    expect(calls).toBe(0);
  });

  it('should leave a prop beside it reactive', () => {
    const wide = new State(false);
    createRoot((dispose) => {
      const el = build({ class: () => (wide.get() ? 'wide' : 'narrow'), onKey: () => {} });
      expect([...el.classes]).toEqual(['narrow']);
      wide.set(true);
      flush();
      expect([...el.classes]).toEqual(['wide']);
      dispose();
    });
  });

  it('should set nothing for undefined, which is an omitted prop', () => {
    const el = inRoot(() => build({ onKey: undefined }));
    expect(el.onKey).toBeUndefined();
  });

  it('should refuse a value that is not a function, naming the prop', () => {
    expect(() => inRoot(() => build({ onKey: 'x' }))).toThrow(/`onKey` takes a function/);
    expect(() => inRoot(() => build({ onMouse: 3 }))).toThrow(/`onMouse` takes a function/);
    expect(() => inRoot(() => build({ onKey: null }))).toThrow(/`onKey` takes a function/);
  });

  it('should reach the router, so an app written in a template is interactive', async () => {
    const keys: string[] = [];
    const el = inRoot(() =>
      build({ onKey: (event: { key: { name: string } }) => keys.push(event.key.name) })
    );
    const first = el.children[0]!;
    first.setProp('focusable', true);
    const term = createTestTerminal();
    const input = createInput({ root: el, terminal: term.terminal });
    input.focus.focus(first);
    await term.press('a');
    // bubbled from the focused child to the box the handler is on
    expect(keys).toEqual(['a']);
    input.stop();
  });
});

describe('a handler in the tag', () => {
  it('should refuse a static value and a bare attribute', () => {
    expect(() => inRoot(() => ui`<box onKey="x" />`)).toThrow(/`onKey` takes a function/);
    expect(() => inRoot(() => ui`<box onResize />`)).toThrow(/`onResize` takes a function/);
  });

  it('should point the error at the template', () => {
    expect(() => inRoot(() => ui`<box>\n<text onKey="x" /></box>`)).toThrow(/at line 2/);
  });
});

describe.each(FRONTENDS)('a ref in $name', ({ build }) => {
  it('should be called once with the element', () => {
    const seen: Element[] = [];
    const el = inRoot(() => build({ ref: (one: Element) => seen.push(one) }));
    expect(seen).toEqual([el]);
  });

  it('should see the props and the children and no parent and no layout', () => {
    let at: { box: unknown; children: number; classes: string[]; parent: unknown } | undefined;
    inRoot(() =>
      build({
        class: 'row',
        ref: (el: Element) => {
          at = {
            box: el.box,
            children: el.children.length,
            classes: [...el.classes],
            parent: el.parent,
          };
        },
      })
    );
    expect(at).toEqual({ box: undefined, children: 2, classes: ['row'], parent: undefined });
  });

  it('should be called before the element is attached to its parent', () => {
    const parents: unknown[] = [];
    const ref = (el: Element) => parents.push(el.parent);
    inRoot(() => {
      const child = build({ ref });
      const parent = box({}, child);
      expect(child.parent).toBe(parent);
    });
    expect(parents).toEqual([undefined]);
  });

  it('should hold a State, which is the shape a ref takes in an app', () => {
    const node = new State<Element | undefined>(undefined);
    const el = inRoot(() => build({ ref: (one: Element) => node.set(one) }));
    expect(node.get()).toBe(el);
  });

  it('should not be called when the element is removed or the owner disposed', () => {
    let calls = 0;
    createRoot((dispose) => {
      const parent = box();
      const el = build({ ref: () => (calls += 1) });
      parent.append(el);
      el.remove();
      dispose();
    });
    expect(calls).toBe(1);
  });

  it('should leave cleanup to the owner', () => {
    const log: string[] = [];
    createRoot((dispose) => {
      build({ ref: () => onCleanup(() => log.push('cleaned')) });
      expect(log).toEqual([]);
      dispose();
    });
    expect(log).toEqual(['cleaned']);
  });

  it('should be called as a function and never run as a thunk', () => {
    // the thunk rule would have called it with no arguments and set its result
    // as a property named `ref`, which the cascade refuses
    let arity = -1;
    inRoot(() =>
      build({
        ref: (...args: unknown[]) => {
          arity = args.length;
        },
      })
    );
    expect(arity).toBe(1);
  });

  it('should not subscribe the owner to a signal the ref reads', () => {
    // a template built inside an effect -- a `For` row is -- would otherwise
    // be rebuilt when the ref's signal moved
    const count = new State(0);
    let builds = 0;
    createRoot((dispose) => {
      const ref = () => {
        builds += 1;
        count.get();
      };
      createEffect(() => {
        build({ ref });
      });
      flush();
      count.set(1);
      flush();
      dispose();
    });
    expect(builds).toBe(1);
  });

  it('should set nothing for undefined', () => {
    expect(() => inRoot(() => build({ ref: undefined }))).not.toThrow();
  });

  it('should refuse a value that is not a function', () => {
    expect(() => inRoot(() => build({ ref: 'x' }))).toThrow(/`ref` takes a function/);
    expect(() => inRoot(() => build({ ref: new State(undefined) }))).toThrow(
      /`ref` takes a function/
    );
  });
});

describe('a ref on the other host types', () => {
  it('should be called on a text, after its content is built', () => {
    let seen = '';
    inRoot(() => ui`<text ref=${(el: Element) => (seen = el.text)}>a ${() => 'b'}</text>`);
    expect(seen).toBe('a b');
  });

  it('should be called on a raw, which has no children to wait for', () => {
    let type = '';
    inRoot(
      () =>
        ui`<raw measure=${() => ({ height: 1, width: 1 })} paint=${() => {}} ref=${(el: Element) => (type = el.type)} />`
    );
    expect(type).toBe('raw');
  });

  it('should see a child built by a nested template before its own children are attached', () => {
    const order: string[] = [];
    inRoot(
      () =>
        ui`<box ref=${(el: Element) => order.push(`box:${el.children.length}`)}>
          <text ref=${() => order.push('text')}>a</text>
        </box>`
    );
    // the child's ref runs while the child is built, which is before the box
    // has it as a child, and the box's runs once the child is in
    expect(order).toEqual(['text', 'box:1']);
  });
});

describe('box() and a template', () => {
  it('should set a handler through one path', () => {
    const onKey = () => {};
    const viaBox = box({ onKey });
    const viaTemplate = inRoot(() => ui`<box onKey=${onKey} />`);
    expect(viaTemplate.onKey).toBe(viaBox.onKey);
    expect(text('x', { onKey }).onKey).toBe(onKey);
  });
});
