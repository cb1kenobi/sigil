import { Button } from '../../src/components/button.js';
import { Checkbox } from '../../src/components/checkbox.js';
import { Collapsible } from '../../src/components/collapsible.js';
import { DataTable } from '../../src/components/data-table.js';
import { Dropdown } from '../../src/components/dropdown.js';
import { ListView } from '../../src/components/list-view.js';
import { Menubar } from '../../src/components/menubar.js';
import { openModal } from '../../src/components/modal.js';
import { createPager } from '../../src/components/pager.js';
import { RadioSet } from '../../src/components/radio-set.js';
import { ScrollBox } from '../../src/components/scroll-box.js';
import { Slider } from '../../src/components/slider.js';
import { Switch } from '../../src/components/switch.js';
import { tabRowView, Tabs } from '../../src/components/tabs.js';
import { TextArea } from '../../src/components/text-area.js';
import { TextField } from '../../src/components/text-field.js';
import { showToast } from '../../src/components/toast.js';
import { attachTooltip } from '../../src/components/tooltip.js';
import { TreeListView } from '../../src/components/tree-list-view.js';
import {
  box,
  type Element,
  type ElementProps,
  type ElementPropsWithout,
  HANDLER_PROPS,
  type HandlerProp,
  renderToLines,
  text,
} from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { createRoot, Show } from '../../src/renderer/index.js';
import { flush } from '../../src/signals/index.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A component's `props` may not carry a hook the component owns (SIG-305).
 *
 * `ElementProps` took the seven hooks so that `box({ onKey })` and a template are
 * one path -- and a component that spreads its caller's `props` into its host and
 * then assigns its own hook overwrote the caller's, with no error: the same
 * silent no-op the ticket set out to remove, moved one level. So each component
 * refuses, at run time and in its type, exactly the hooks it assigns itself.
 *
 * Which hooks a component owns is not written down here and trusted: the first
 * case builds each one with no props and reads which hooks it left on its host,
 * so a component that starts assigning another one fails this file until it
 * refuses that one too.
 */

const mine = (): void => {};

interface Built {
  /** The element the caller's `props` went to. */
  element: Element;
  dispose?: () => void;
}

interface Case {
  /** What the refusal names. */
  name: string;
  /** The hooks the component assigns on that element itself. */
  owns: readonly HandlerProp[];
  make: (props: Record<string, unknown>) => Built;
}

function scene() {
  const term = createTestTerminal({ columns: 40, rows: 12 });
  const anchor = text('Save', { focusable: true });
  const root = box({ height: 12, width: 40 }, anchor);
  const input = createInput({ root, terminal: term.terminal });
  return { anchor, input, root, term };
}

const stops: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
  vi.useRealTimers();
});

const CASES: Case[] = [
  {
    make: (props) => ({ element: TextField({ props: props as never }) }),
    name: 'TextField',
    owns: ['onKey', 'onPaste', 'onFocusChange', 'onResize'],
  },
  {
    make: (props) => ({ element: TextArea({ props: props as never }) }),
    name: 'TextArea',
    owns: ['onKey', 'onMouse', 'onPaste', 'onFocusChange'],
  },
  {
    make: (props) => ({
      element: ScrollBox({ children: () => box(), props: props as never }),
    }),
    name: 'ScrollBox',
    owns: ['onKey', 'onMouse'],
  },
  {
    make: (props) => ({ element: ListView({ items: ['a', 'b'], props: props as never }) }),
    name: 'ListView',
    owns: ['onKey', 'onFocusChange'],
  },
  {
    make: (props) => ({ element: TreeListView({ items: ['a', 'b'], props: props as never }) }),
    name: 'TreeListView',
    owns: ['onKey', 'onFocusChange'],
  },
  {
    make: (props) => ({
      element: DataTable({ columns: ['a'], rows: [{ a: 1 }], props: props as never }),
    }),
    name: 'DataTable',
    owns: ['onKey', 'onResize'],
  },
  {
    make: (props) => ({ element: createPager({ content: 'a\nb', props: props as never }).element }),
    name: 'createPager',
    owns: ['onKey'],
  },
  {
    make: (props) => ({ element: tabRowView({ labels: ['a', 'b'], props: props as never }) }),
    name: 'tabRowView',
    owns: ['onKey', 'onFocusChange', 'onResize'],
  },
  {
    make: (props) => ({ element: Slider({ props: props as never }) }),
    name: 'Slider',
    owns: ['onKey', 'onFocusChange'],
  },
  {
    make: (props) => {
      const s = scene();
      stops.push(() => s.input.stop());
      const handle = openModal(s.root, { input: s.input, props: props as never });
      const panel = find(handle.element, 'sigil-modal');
      return { dispose: () => handle.dispose(), element: panel };
    },
    name: 'openModal',
    owns: ['onPaste'],
  },
  {
    make: (props) => {
      const s = scene();
      stops.push(() => s.input.stop());
      const handle = showToast(s.root, {
        message: 'Saved',
        props: props as never,
        terminal: s.term.terminal,
      });
      return { dispose: () => handle.dispose(), element: find(handle.element, 'sigil-toast') };
    },
    name: 'showToast',
    owns: ['onMouse'],
  },
  {
    make: (props) => {
      const s = scene();
      stops.push(() => s.input.stop());
      const handle = attachTooltip(s.anchor, {
        input: s.input,
        props: props as never,
        text: 'Writes it',
      });
      stops.push(() => handle.dispose());
      // the bubble is built when it is shown, so show it: laid out once, then
      // focused and left for the delay
      renderToLines(s.root, { height: 12, width: 40 });
      s.input.focus.focus(s.anchor);
      flush();
      vi.advanceTimersByTime(500);
      flush();
      return { dispose: () => handle.dispose(), element: find(handle.element, 'sigil-tooltip') };
    },
    name: 'attachTooltip',
    owns: ['onLayout'],
  },
  {
    make: (props) => {
      const s = scene();
      stops.push(() => s.input.stop());
      return { element: Dropdown({ input: s.input, options: ['a'], props: props as never }) };
    },
    name: 'Dropdown',
    owns: ['onFocusChange', 'onKey', 'onMouse'],
  },
  {
    make: (props) => ({ element: Button({ label: 'OK', props: props as never }) }),
    name: 'Button',
    owns: ['onKey', 'onMouse', 'onFocusChange'],
  },
  {
    make: (props) => ({ element: Checkbox({ label: 'On', props: props as never }) }),
    name: 'Checkbox',
    owns: ['onKey', 'onMouse', 'onFocusChange'],
  },
  {
    make: (props) => ({ element: Switch({ props: props as never }) }),
    name: 'Switch',
    owns: ['onKey', 'onMouse', 'onFocusChange'],
  },
  {
    // the options take the clicks, so the host's own `onMouse` is the caller's
    make: (props) => ({ element: RadioSet({ options: ['a', 'b'], props: props as never }) }),
    name: 'RadioSet',
    owns: ['onKey', 'onFocusChange'],
  },
];

/** The element with a class, at or under a root. */
function find(root: Element | undefined, name: string): Element {
  const walk = (it: Element): Element | undefined =>
    it.classes.includes(name)
      ? it
      : it.children.reduce<Element | undefined>((hit, child) => hit ?? walk(child), undefined);
  const found = root ? walk(root) : undefined;
  if (!found) {
    throw new Error(`no ${name}`);
  }
  return found;
}

const defined = (el: Element): HandlerProp[] =>
  HANDLER_PROPS.filter((name) => el[name] !== undefined);

describe.each(CASES)('$name', ({ make, name, owns }) => {
  it('should own exactly the hooks it leaves on its host', () => {
    // the list in this file against the component, so a hook it starts assigning
    // is one this fails for
    createRoot((dispose) => {
      const { element } = make({});
      expect(defined(element).toSorted()).toEqual([...owns].toSorted());
      dispose();
    });
  });

  it.each(owns)("should refuse a caller's %s rather than overwrite it", (hook) => {
    createRoot((dispose) => {
      expect(() => make({ [hook]: mine })).toThrow(TypeError);
      expect(() => make({ [hook]: mine })).toThrow(name);
      expect(() => make({ [hook]: mine })).toThrow(hook);
      dispose();
    });
  });

  it('should take a hook it owns as undefined, which is no handler', () => {
    createRoot((dispose) => {
      expect(() => make(Object.fromEntries(owns.map((hook) => [hook, undefined])))).not.toThrow();
      dispose();
    });
  });

  it('should keep a hook it does not own, on the element the props went to', () => {
    createRoot((dispose) => {
      const free = HANDLER_PROPS.filter((hook) => !owns.includes(hook));
      const { element } = make(Object.fromEntries(free.map((hook) => [hook, mine])));
      for (const hook of free) {
        expect(element[hook], hook).toBe(mine);
      }
      dispose();
    });
  });
});

describe('a component that owns no hook on its host', () => {
  const everything = Object.fromEntries(HANDLER_PROPS.map((hook) => [hook, mine]));

  it.each([
    ['Collapsible', () => Collapsible({ props: everything as never, title: 'More' })],
    [
      'Tabs',
      () => Tabs({ props: everything as never, tabs: [{ children: () => box(), label: 'a' }] }),
    ],
    [
      'Menubar',
      () => {
        const s = scene();
        stops.push(() => s.input.stop());
        return Menubar({ input: s.input, menus: [], props: everything as never });
      },
    ],
    [
      'Show',
      () =>
        Show({
          children: () => box(),
          props: everything as never,
          when: () => true,
        } as never),
    ],
  ])('should keep every hook given to %s', (_, make) => {
    createRoot((dispose) => {
      const element = make();
      for (const hook of HANDLER_PROPS) {
        expect(element[hook], hook).toBe(mine);
      }
      dispose();
    });
  });
});

describe("the type of a component's props", () => {
  it('should leave out the hooks it owns, and keep the rest', () => {
    // nothing runs: `tsc` is the test, and `pnpm check` is what fails if an
    // `@ts-expect-error` stops being an error. An `Omit<>` would not do it -- the
    // index signature already admits a hook -- which is why the type pins the key
    const never = (): void => {
      // @ts-expect-error -- TextField sets onKey itself
      TextField({ props: { onKey: mine } });
      // @ts-expect-error -- and onResize
      TextField({ props: { onResize: () => false } });
      // @ts-expect-error -- ScrollBox sets onMouse itself
      ScrollBox({ children: () => box(), props: { onMouse: mine } });
      // @ts-expect-error -- createPager sets onKey itself
      createPager({ content: '', props: { onKey: mine } });
      // @ts-expect-error -- tabRowView sets onFocusChange itself
      tabRowView({ labels: ['a'], props: { onFocusChange: mine } });
      // @ts-expect-error -- openModal sets onPaste itself
      openModal(box(), { input: {} as never, props: { onPaste: mine } });
      // @ts-expect-error -- showToast sets onMouse itself
      showToast(box(), { message: '', props: { onMouse: mine }, terminal: {} as never });
      // @ts-expect-error -- attachTooltip sets onLayout itself
      attachTooltip(box(), { input: {} as never, props: { onLayout: () => false }, text: '' });
      // @ts-expect-error -- Dropdown sets onKey itself
      Dropdown({ input: {} as never, options: [], props: { onKey: mine } });
      // @ts-expect-error -- Button sets onMouse itself
      Button({ label: 'x', props: { onMouse: mine } });
      // @ts-expect-error -- Checkbox sets onKey itself
      Checkbox({ label: 'x', props: { onKey: mine } });
      // @ts-expect-error -- Switch sets onFocusChange itself
      Switch({ props: { onFocusChange: mine } });
      // @ts-expect-error -- RadioSet sets onKey itself
      RadioSet({ options: ['a'], props: { onKey: mine } });

      // the rest of the seven, and everything else, is accepted
      TextField({ props: { onMouse: mine, padding: 1 } });
      ScrollBox({ children: () => box(), props: { onPaste: mine } });
      Collapsible({ props: { onKey: mine }, title: 'x' });
      RadioSet({ options: ['a'], props: { onMouse: mine } });
      // and a hook passed along as undefined is not a handler
      TextField({ props: { onKey: undefined } });
    };
    expect(never).toBeTypeOf('function');
  });

  it('should make a forwarder type its own props as ElementPropsWithout<>', () => {
    // a value typed `ElementProps` no longer fits a component that owns a hook,
    // where it compiled before hooks became props. Accepted: it is the type
    // telling the truth, since such a value may carry a handler the component
    // would replace. The spelling that compiles is the narrower one
    const never = (): void => {
      type FieldProps = ElementPropsWithout<'onFocusChange' | 'onKey' | 'onPaste' | 'onResize'>;
      const forwarder = (p: { props?: FieldProps }): Element => TextField({ props: p.props });
      const shared: FieldProps = { padding: 1 };
      forwarder({ props: shared });

      // @ts-expect-error -- a wrapper that types its props as ElementProps does not fit
      const wrapper = (p: { props?: ElementProps }): Element => TextField({ props: p.props });
      const style: ElementProps = { padding: 1 };
      // @ts-expect-error -- nor does a shared value typed ElementProps
      TextField({ props: style });
      void wrapper;
    };
    expect(never).toBeTypeOf('function');
  });
});
