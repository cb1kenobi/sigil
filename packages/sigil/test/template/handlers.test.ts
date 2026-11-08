/**
 * Event handlers and refs as template props, in both frontends.
 *
 * A host element used to take style and six reserved props and nothing else, so
 * an app written in a template was display-only. Every case runs over both
 * frontends, so a behaviour that holds for one and not the other fails by name
 * -- which is the claim the two rest on. JSX is driven by calling `jsx()` and
 * `jsxs()`, which is what the transform emits; the tag is called directly.
 */

import { box, type Element, HANDLER_PROPS, renderToString, text } from '../../src/element/index.js';
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
  onFocusChange?: unknown;
  onKey?: unknown;
  onLayout?: unknown;
  onMouse?: unknown;
  onPaste?: unknown;
  onResize?: unknown;
  onScroll?: unknown;
  ref?: unknown;
}

/** One frontend writing `<box ...props><text>x</text><text>y</text></box>`. */
interface Frontend {
  name: string;
  build: (props: Props) => Element;
  /** `<box><box ref=${ref} /></box>`: a ref on an element that gets a parent. */
  nest: (ref: unknown) => Element;
}

const FRONTENDS: Frontend[] = [
  {
    build: (props) =>
      jsxs('box', {
        ...props,
        children: [jsx('text', { children: 'x' }), jsx('text', { children: 'y' })],
      }),
    name: 'jsx',
    nest: (ref) => jsx('box', { children: jsx('box', { ref }) }),
  },
  {
    build: (props) =>
      ui`<box
        class=${props.class}
        onFocusChange=${props.onFocusChange}
        onKey=${props.onKey}
        onLayout=${props.onLayout}
        onMouse=${props.onMouse}
        onPaste=${props.onPaste}
        onResize=${props.onResize}
        onScroll=${props.onScroll}
        ref=${props.ref}
      ><text>x</text><text>y</text></box>`,
    name: 'the ui tag',
    nest: (ref) => ui`<box><box ref=${ref} /></box>`,
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
    // all seven through each frontend: the tag's template names each of them, so
    // a hook this frontend did not route is one that fails here by name
    for (const name of HANDLER_PROPS) {
      const handler = () => false;
      const el = inRoot(() => build({ [name]: handler }));
      expect(el[name], name).toBe(handler);
      for (const other of HANDLER_PROPS.filter((hook) => hook !== name)) {
        expect(el[other], `${name} set ${other}`).toBeUndefined();
      }
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

  it('should name a value it cannot print, rather than fail printing it', () => {
    // `String(Object.create(null))` throws, and that was the error reported
    // instead of the one that says what is wrong
    const bare = Object.create(null);
    const hostile = {
      toString: () => {
        throw new Error('no');
      },
    };
    for (const value of [bare, hostile]) {
      expect(() => inRoot(() => build({ onKey: value }))).toThrow(
        /`onKey` takes a function, and was given \[object Object\]/
      );
      expect(() => inRoot(() => build({ ref: value }))).toThrow(
        /`ref` takes a function, and was given \[object Object\]/
      );
    }
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

/** `<box NAME=${value} />`, with the attribute name chosen by the caller. */
function tagWith(name: string, value: unknown): Element {
  const strings = [`<box ${name}=`, ' />'];
  return ui(Object.assign(strings, { raw: strings }) as TemplateStringsArray, value);
}

describe('a near miss for a handler name', () => {
  // the thunk rule would call the function with no arguments while the template
  // built and carry on, which is the failure the hooks-as-props change ended for
  // exactly one spelling. Each of these used to build
  let calls = 0;
  const fn = () => {
    calls += 1;
  };

  it.each([
    ['on-key', 'onKey'],
    ['onkey', 'onKey'],
    ['onKEY', 'onKey'],
    ['on-focus-change', 'onFocusChange'],
    ['onfocuschange', 'onFocusChange'],
  ])('should point %s at %s, in both frontends, without calling it', (spelled, right) => {
    calls = 0;
    const message = new RegExp(`\`${spelled}\` is not a handler name: write \`${right}\``);
    expect(() => inRoot(() => jsx('box', { [spelled]: fn }))).toThrow(message);
    expect(() => inRoot(() => tagWith(spelled, fn))).toThrow(message);
    expect(calls).toBe(0);
  });

  it.each(['onClick', 'on-click', 'onChange', 'onFocus'])(
    'should refuse %s given a function as an event this element does not have',
    (name) => {
      calls = 0;
      const message = new RegExp(`\`${name}\` is not an event this element has`);
      expect(() => inRoot(() => jsx('box', { [name]: fn }))).toThrow(message);
      expect(() => inRoot(() => tagWith(name, fn))).toThrow(message);
      expect(calls).toBe(0);
    }
  );

  it('should name the seven in the message, so the right one is on screen', () => {
    expect(() => inRoot(() => ui`<box onClick=${fn} />`)).toThrow(
      'The handlers are onKey, onMouse, onPaste, onFocusChange, onScroll, onResize, onLayout'
    );
  });

  it('should let a name that is not a function reach the cascade, which refuses it', () => {
    // not the near-miss rule's: a value is never called, and the cascade already
    // says what is wrong with a property it does not know
    // at the first style resolve, where every unknown property is refused
    expect(() =>
      renderToString(
        inRoot(() => ui`<box onClick="x" />`),
        { colorLevel: 0, width: 10 }
      )
    ).toThrow(/Unknown property/);
  });

  it('should leave a component alone, which reads its props as it likes', () => {
    const seen: string[] = [];
    const Comp = (props: Record<string, unknown>) => {
      seen.push(...Object.keys(props));
      return box();
    };
    inRoot(() => ui`<${Comp} onClick=${fn} on-key=${fn} ref=${fn} />`);
    expect(seen).toEqual(['onClick', 'on-key', 'ref']);
    expect(calls).toBe(0);
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

describe.each(FRONTENDS)('a ref in $name', ({ build, nest }) => {
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
    // built through the template with a parent, so the parent is the template's
    // own: a ref called after `append()` would see it
    const seen: { parent: unknown; siblings: number | undefined }[] = [];
    const outer = inRoot(() =>
      nest((el: Element) => seen.push({ parent: el.parent, siblings: el.parent?.children.length }))
    );
    expect(seen).toEqual([{ parent: undefined, siblings: undefined }]);
    // and it did get one, afterwards
    expect(outer.children[0]?.parent).toBe(outer);
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
