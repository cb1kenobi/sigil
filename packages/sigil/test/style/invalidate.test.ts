import {
  Cascade,
  declare,
  difference,
  DIRTY_ORDER,
  LAYOUT_PROPERTIES,
  parseStylesheet,
  Restyler,
  type StyleTarget,
} from '../../src/style/index.js';
import { growthOf } from '../growth.js';
import { describe, expect, it } from 'vitest';

/** A mutable element, since invalidation is about things changing. */
interface Node {
  children: Node[];
  classes: string[];
  id?: string;
  parent?: Node;
  props?: Record<string, string>;
  states: string[];
  type: string;
}

function el(spec: string, children: Node[] = []): Node {
  const node: Node = { children, classes: [], states: [], type: 'box' };
  for (const [, sigil, name] of spec.matchAll(/([#.:]?)([-\w]+)/g)) {
    if (sigil === '#') {
      node.id = name;
    } else if (sigil === '.') {
      node.classes.push(name);
    } else if (sigil === ':') {
      node.states.push(name);
    } else {
      node.type = name;
    }
  }
  for (const child of children) {
    child.parent = node;
  }
  return node;
}

const as = (node: Node): StyleTarget => node as unknown as StyleTarget;

describe('the dirty bits', () => {
  it('should be ordered the way a frame settles them', () => {
    expect(DIRTY_ORDER).toEqual(['style', 'layout', 'paint']);
  });

  it('should classify the ones people get wrong', () => {
    expect(LAYOUT_PROPERTIES.has('width')).toBe(true);
    expect(LAYOUT_PROPERTIES.has('color')).toBe(false);
    // a border takes a cell on each edge; its colour does not
    expect(LAYOUT_PROPERTIES.has('borderStyle')).toBe(true);
    expect(LAYOUT_PROPERTIES.has('borderColor')).toBe(false);
    // both change how wide a text measures
    expect(LAYOUT_PROPERTIES.has('textTransform')).toBe(true);
    expect(LAYOUT_PROPERTIES.has('whiteSpace')).toBe(true);
    // hidden content still takes its space, which is the layout engine's own
    // recorded decision rather than a shortcut taken here
    expect(LAYOUT_PROPERTIES.has('visibility')).toBe(false);
  });
});

describe('comparing two styles', () => {
  it('should compare a length by value rather than by identity', () => {
    // two resolutions of `width: 4` are two equal objects; comparing by
    // identity would report every property as changed on every restyle and
    // make the dirty bits mean nothing
    expect(difference(declare({ width: '4' }), declare({ width: '4' }))).toEqual([]);
    expect(difference(declare({ width: '4' }), declare({ width: '5' }))).toEqual(['width']);
    expect(difference(declare({ width: '4' }), declare({ width: 'auto' }))).toEqual(['width']);
    expect(difference(declare({ width: '50%' }), declare({ width: '50%' }))).toEqual([]);
  });

  it('should report every property that differs and nothing else', () => {
    expect(difference(declare({ color: 'red' }), declare({ color: 'blue' }))).toEqual(['color']);
    expect(difference(declare({}), declare({ padding: '1' })).sort()).toEqual([
      'paddingBottom',
      'paddingLeft',
      'paddingRight',
      'paddingTop',
    ]);
  });
});

describe('what a change implies', () => {
  const sheet = parseStylesheet(`
    .panel { color: red }
    .panel.wide { width: 40 }
    .form.invalid .hint { color: red }
    text { color: blue }
  `);

  const build = () => {
    const hint = el('text.hint');
    const label = el('text.label');
    const panel = el('box.panel', [label, hint]);
    const form = el('box.form', [panel]);
    return { form, hint, label, panel };
  };

  it('should resolve the whole tree the first time', () => {
    const { form } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    const update = restyler.update(as(form));
    expect(update.restyled).toBe(4);
    expect(update.paint.size).toBeGreaterThan(0);
  });

  it('should do nothing when nothing changed', () => {
    const { form } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(form));
    const update = restyler.update(as(form));
    expect(update.restyled).toBe(0);
    expect(update.paint.size).toBe(0);
    expect(update.layout.size).toBe(0);
  });

  it('should paint one element and restyle nothing when a prop is written', () => {
    // the common case for a component updating itself, and it costs nothing:
    // props override the sheet per property and there are no attribute
    // selectors, so a prop write cannot change any other element's style
    const { form, hint } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(form));

    hint.props = { color: 'green' };
    restyler.touchProps(as(hint));
    const update = restyler.update(as(form));

    expect(update.restyled).toBe(0);
    expect([...update.paint]).toEqual([as(hint)]);
    expect(restyler.styleOf(as(hint))?.color).toBe(2);
  });

  it('should carry an inherited prop down to descendants', () => {
    // the claim that broke: props cannot change what another element *matches*,
    // which is not the same as cannot change another element. `color` inherits,
    // so a prop on the parent is a different resolved style on every child
    const { form, hint, label, panel } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(form));
    expect(restyler.styleOf(as(label))?.color).toBe(4);

    panel.props = { color: 'magenta' };
    restyler.touchProps(as(panel));
    const update = restyler.update(as(form));

    expect(restyler.styleOf(as(panel))?.color).toBe(5);
    // text { color: blue } still wins over what it inherits, because a
    // matching rule beats inheritance -- but the hint has no rule of its own
    expect(restyler.styleOf(as(label))?.color).toBe(4);
    expect(update.paint.has(as(panel))).toBe(true);
    expect(update.restyled).toBeGreaterThan(0);
    expect(restyler.styleOf(as(hint))?.color).toBe(4);
  });

  it('should carry an inherited prop to a child with no rule of its own', () => {
    const bare = parseStylesheet('.panel { color: red }');
    const child = el('box');
    const panel = el('box.panel', [child]);
    const restyler = new Restyler(new Cascade([bare]));
    restyler.update(as(panel));
    expect(restyler.styleOf(as(child))?.color).toBe(1);

    panel.props = { color: 'cyan' };
    restyler.touchProps(as(panel));
    const update = restyler.update(as(panel));

    expect(restyler.styleOf(as(child))?.color).toBe(6);
    expect(update.paint.has(as(child))).toBe(true);
  });

  it('should mark layout when a prop sets a property that moves a box', () => {
    // a renderer that trusts Update.layout would paint the new style into the
    // old box
    const { form, panel } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(form));

    panel.props = { width: '40' };
    restyler.touchProps(as(panel));
    const update = restyler.update(as(form));

    expect(update.layout.has(as(panel))).toBe(true);
    expect(update.paint.has(as(panel))).toBe(true);
  });

  it('should not paint an element whose prop write changed nothing', () => {
    const { form, panel } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    panel.props = { color: 'red' };
    restyler.update(as(form));

    restyler.touchProps(as(panel));
    const update = restyler.update(as(form));
    expect(update.paint.has(as(panel))).toBe(false);
  });

  it('should settle a prop on a parent and a child in one update', () => {
    const bare = parseStylesheet('.panel { color: red }');
    const child = el('box');
    const panel = el('box.panel', [child]);
    const restyler = new Restyler(new Cascade([bare]));
    restyler.update(as(panel));

    panel.props = { color: 'cyan' };
    child.props = { bold: 'true' };
    restyler.touchProps(as(panel));
    restyler.touchProps(as(child));
    restyler.update(as(panel));

    // the child is restyled because its parent's inherited value changed, and
    // its own prop still applies on top
    expect(restyler.styleOf(as(child))?.color).toBe(6);
    expect(restyler.styleOf(as(child))?.bold).toBe(true);
  });

  it('should not paint an element that was restyled to the same answer', () => {
    const { form, panel } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(form));

    panel.classes.push('irrelevant');
    restyler.touchClasses(as(panel));
    const update = restyler.update(as(form));

    expect(update.restyled).toBeGreaterThan(0);
    expect(update.paint.has(as(panel))).toBe(false);
    expect(update.layout.size).toBe(0);
  });

  it('should put everything in layout on the first resolution', () => {
    const { form, panel } = build();
    const update = new Restyler(new Cascade([sheet])).update(as(form));
    expect(update.layout.has(as(form))).toBe(true);
    expect(update.layout.has(as(panel))).toBe(true);
  });

  it('should restyle for a state change the way it does for a class', () => {
    const focus = parseStylesheet('.panel:focus text { bold: true }');
    const { form, label, panel } = build();
    const restyler = new Restyler(new Cascade([focus]));
    restyler.update(as(form));
    expect(restyler.styleOf(as(label))?.bold).toBe(false);

    panel.states.push('focus');
    restyler.touchClasses(as(panel));
    restyler.update(as(form));

    expect(restyler.styleOf(as(label))?.bold).toBe(true);
  });

  it('should restyle a subtree when a class changes, and anything a selector relates to it', () => {
    // the price of keeping combinators: `.form.invalid .hint` means toggling a
    // class on an ancestor restyles a descendant that never changed
    const { form, hint } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(form));
    expect(restyler.styleOf(as(hint))?.color).toBe(4);

    form.classes.push('invalid');
    restyler.touchClasses(as(form));
    const update = restyler.update(as(form));

    expect(update.restyled).toBe(4);
    expect(update.paint.has(as(hint))).toBe(true);
    expect(restyler.styleOf(as(hint))?.color).toBe(1);
  });

  it('should mark layout only when a property that moves a box changed', () => {
    const { form, panel } = build();
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(form));

    panel.classes.push('wide');
    restyler.touchClasses(as(panel));
    const update = restyler.update(as(form));

    expect(update.layout.has(as(panel))).toBe(true);
    expect(update.paint.has(as(panel))).toBe(true);
  });

  it('should mark paint but not layout for a colour change', () => {
    const colours = parseStylesheet('.panel { color: red } .panel.hot { color: blue }');
    const { form, panel } = build();
    const restyler = new Restyler(new Cascade([colours]));
    restyler.update(as(form));

    panel.classes.push('hot');
    restyler.touchClasses(as(panel));
    const update = restyler.update(as(form));

    expect(update.paint.has(as(panel))).toBe(true);
    expect(update.layout.has(as(panel))).toBe(false);
  });

  it('should carry an inherited change down to a child that did not change', () => {
    const inherit = parseStylesheet('.form { color: red } .form.cool { color: cyan }');
    const { form, label } = build();
    const restyler = new Restyler(new Cascade([inherit]));
    restyler.update(as(form));
    expect(restyler.styleOf(as(label))?.color).toBe(1);

    form.classes.push('cool');
    restyler.touchClasses(as(form));
    const update = restyler.update(as(form));

    expect(restyler.styleOf(as(label))?.color).toBe(6);
    expect(update.paint.has(as(label))).toBe(true);
  });
});

describe('sideways', () => {
  // the case that is easy to forget and visible immediately when wrong
  const sheet = parseStylesheet('text:first-child { bold: true } text:nth-child(2) { dim: true }');

  it('should restyle siblings when a child is added', () => {
    const first = el('text');
    const parent = el('box', [first]);
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(parent));
    expect(restyler.styleOf(as(first))?.bold).toBe(true);

    const inserted = el('text');
    inserted.parent = parent;
    parent.children.unshift(inserted);
    restyler.touchChildren(as(parent));
    const update = restyler.update(as(parent));

    // the element that never changed in any way an element-level check would
    // see: it is no longer the first child
    expect(restyler.styleOf(as(first))?.bold).toBe(false);
    expect(restyler.styleOf(as(first))?.dim).toBe(true);
    expect(update.paint.has(as(first))).toBe(true);
  });

  it('should restyle who is left when a child is removed', () => {
    const a = el('text');
    const b = el('text');
    const parent = el('box', [a, b]);
    const restyler = new Restyler(new Cascade([sheet]));
    restyler.update(as(parent));
    expect(restyler.styleOf(as(b))?.dim).toBe(true);

    parent.children.shift();
    restyler.forget(as(a));
    restyler.touchChildren(as(parent));
    restyler.update(as(parent));

    expect(restyler.styleOf(as(b))?.bold).toBe(true);
    expect(restyler.styleOf(as(b))?.dim).toBe(false);
    // and the removed element is gone rather than held for the life of the
    // Restyler, which in a long-running TUI is a leak
    expect(restyler.styleOf(as(a))).toBeUndefined();
  });

  it('should resolve a reinserted element against where it is now', () => {
    // the "never resolved" branch is the safety net and it does not fire for
    // an element object that was detached and put back somewhere else
    const moving = el('text');
    const here = el('box.here', [moving]);
    const there = el('box.there');
    const root = el('box', [here, there]);
    const sheets = parseStylesheet('.here text { bold: true } .there text { dim: true }');
    const restyler = new Restyler(new Cascade([sheets]));
    restyler.update(as(root));
    expect(restyler.styleOf(as(moving))?.bold).toBe(true);

    here.children.pop();
    restyler.forget(as(moving));
    there.children.push(moving);
    moving.parent = there;
    restyler.touchChildren(as(here));
    restyler.touchChildren(as(there));
    restyler.update(as(root));

    expect(restyler.styleOf(as(moving))?.bold).toBe(false);
    expect(restyler.styleOf(as(moving))?.dim).toBe(true);
  });

  it('should restyle a later sibling for a ~ combinator', () => {
    const later = parseStylesheet('.on ~ text { bold: true }');
    const a = el('text');
    const b = el('text');
    const c = el('text');
    const parent = el('box', [a, b, c]);
    const restyler = new Restyler(new Cascade([later]));
    restyler.update(as(parent));

    a.classes.push('on');
    restyler.touchClasses(as(a));
    restyler.update(as(parent));

    expect(restyler.styleOf(as(b))?.bold).toBe(true);
    expect(restyler.styleOf(as(c))?.bold).toBe(true);
  });

  it('should restyle a descendant of a sibling', () => {
    const deep = parseStylesheet('.on + box text { bold: true }');
    const inner = el('text');
    const a = el('box');
    const b = el('box', [inner]);
    const parent = el('box', [a, b]);
    const restyler = new Restyler(new Cascade([deep]));
    restyler.update(as(parent));
    expect(restyler.styleOf(as(inner))?.bold).toBe(false);

    a.classes.push('on');
    restyler.touchClasses(as(a));
    restyler.update(as(parent));

    expect(restyler.styleOf(as(inner))?.bold).toBe(true);
  });

  it('should restyle siblings when a class changes on one of them', () => {
    const sibling = parseStylesheet('.on + text { bold: true }');
    const a = el('text');
    const b = el('text');
    const parent = el('box', [a, b]);
    const restyler = new Restyler(new Cascade([sibling]));
    restyler.update(as(parent));
    expect(restyler.styleOf(as(b))?.bold).toBe(false);

    a.classes.push('on');
    restyler.touchClasses(as(a));
    restyler.update(as(parent));

    expect(restyler.styleOf(as(b))?.bold).toBe(true);
  });
});

describe('the terminal changing', () => {
  const sheet = parseStylesheet(
    '.panel { padding: 1 } @media (min-width: 100) { .panel { padding: 4 } }'
  );

  it('should restyle everything on a resize, media queries included', () => {
    const panel = el('box.panel', [el('text')]);
    const cascade = new Cascade([sheet]);
    cascade.media = {
      colorLevel: 3,
      colorScheme: 'dark',
      height: 24,
      reducedMotion: 'no-preference',
      width: 40,
    };
    const restyler = new Restyler(cascade);
    restyler.update(as(panel));
    expect(restyler.styleOf(as(panel))?.paddingTop).toBe(1);

    cascade.media = {
      colorLevel: 3,
      colorScheme: 'dark',
      height: 24,
      reducedMotion: 'no-preference',
      width: 120,
    };
    restyler.touchMedia();
    const update = restyler.update(as(panel));

    expect(update.restyled).toBe(2);
    expect(restyler.styleOf(as(panel))?.paddingTop).toBe(4);
    expect(update.layout.has(as(panel))).toBe(true);
  });

  it('should restyle everything when the sheets change', () => {
    const panel = el('box.panel');
    const cascade = new Cascade([sheet]);
    const restyler = new Restyler(cascade);
    restyler.update(as(panel));

    cascade.add(parseStylesheet('.panel { color: magenta }'));
    restyler.touchSheets();
    restyler.update(as(panel));

    expect(restyler.styleOf(as(panel))?.color).toBe(5);
  });
});

describe('the size of the naive answer', () => {
  /** A tree of about two hundred elements at forty rows, which is a large terminal UI. */
  function tree(count = 40): Node {
    const rows: Node[] = [];
    for (let i = 0; i < count; i++) {
      rows.push(
        el(`box.row${i % 7 === 0 ? '.odd' : ''}`, [
          el('text.label'),
          el('text.value'),
          el('box.cell', [el('text')]),
        ])
      );
    }
    return el('box#app.root', rows);
  }

  /** A hundred rules, which is a large stylesheet. */
  function rules(): string {
    const out: string[] = [];
    for (let i = 0; i < 50; i++) {
      out.push(`.c${i} { color: red } .row .c${i} text { padding: ${i % 8} }`);
    }
    out.push('.root .row:nth-child(2n) .label { bold: true }');
    out.push('.odd + .row .value { dim: true }');
    return out.join('\n');
  }

  /** A tree of `count` rows, a stylesheet over it, and the restyler that has seen it once. */
  function fixture(count: number): { restyler: Restyler; root: Node; size: number } {
    const root = tree(count);
    const restyler = new Restyler(new Cascade([parseStylesheet(rules())]));
    const size = (node: Node): number =>
      1 + node.children.reduce((total, child) => total + size(child), 0);
    restyler.update(as(root));
    return { restyler, root, size: size(root) };
  }

  // the ticket's central claim, measured rather than asserted. Browsers
  // build invalidation sets because they have two orders of magnitude more
  // elements and rules than this; what must not happen is an architecture
  // where that optimization could not be added if this measurement ever
  // surprises us.
  //
  // It was the median of twenty wall-clock passes against 50 ms, which is fifty
  // times the cost it guarded and sat on a clock a loaded runner moves
  // (SIG-657). Growth is what a re-match that had gone quadratic changes and
  // what a slow machine does not: eight times the rows must cost less than three
  // times eight, where linear is eight and a re-match that reads every element
  // for each one is sixty-four. `growthOf()` reads CPU time where it can, over a
  // span, and takes the best of seven.
  // What this no longer says is how long a re-match takes: a linear one a hundred
  // times slower than this passes. That claim is a clock's and the clock is what
  // moved, so it is left to the profile this architecture was chosen to be
  // measured against.
  it('should re-match the whole tree in time linear in its size', () => {
    const small = fixture(5);
    const large = fixture(40);
    expect(large.size).toBeGreaterThan(150);

    const rematch = (tree: ReturnType<typeof fixture>): void => {
      tree.restyler.touchSheets();
      expect(tree.restyler.update(as(tree.root)).restyled).toBe(tree.size);
    };

    expect(growthOf(rematch, small, large, 8, 'rematch', undefined, 24)).toBeLessThan(24);
  });
});

describe('the inherit keyword', () => {
  // `inherit` works on a property that does not inherit by default -- that is
  // the whole reason to write it -- so "force children when an INHERITED
  // property changed" is not the same question as "can a child read this"
  const sheet = parseStylesheet('.child { width: inherit }');

  it('should reach a child that inherits a property which does not inherit', () => {
    const child = el('box.child');
    const parent = el('box.parent', [child]);
    const restyler = new Restyler(new Cascade([sheet]));
    parent.props = { width: '10' };
    restyler.update(as(parent));
    expect(restyler.styleOf(as(child))?.width).toEqual({ type: 'cells', value: 10 });

    parent.props = { width: '20' };
    restyler.touchProps(as(parent));
    const update = restyler.update(as(parent));

    expect(restyler.styleOf(as(child))?.width).toEqual({ type: 'cells', value: 20 });
    expect(update.layout.has(as(child))).toBe(true);
  });

  it('should still cost nothing when a prop write changed nothing', () => {
    const child = el('box.child');
    const parent = el('box.parent', [child]);
    const restyler = new Restyler(new Cascade([sheet]));
    parent.props = { width: '10' };
    restyler.update(as(parent));

    restyler.touchProps(as(parent));
    const update = restyler.update(as(parent));
    expect(update.restyled).toBe(0);
    expect(update.paint.size).toBe(0);
  });

  it('should cost nothing on a leaf, which is where a prop write usually lands', () => {
    const leaf = el('text');
    const parent = el('box', [leaf]);
    const restyler = new Restyler(new Cascade([parseStylesheet('text { color: red }')]));
    restyler.update(as(parent));

    leaf.props = { color: 'blue' };
    restyler.touchProps(as(leaf));
    const update = restyler.update(as(parent));

    expect(update.restyled).toBe(0);
    expect([...update.paint]).toEqual([as(leaf)]);
  });
});

describe('an inherit chain', () => {
  // the fix that was one level too shallow: a node restyled because its parent
  // forced it decided about its own children with the narrow rule, so the
  // second link of the chain never moved
  const sheet = parseStylesheet('.mid { width: inherit } .leaf { width: inherit }');

  const chain = () => {
    const leaf = el('box.leaf');
    const mid = el('box.mid', [leaf]);
    const grand = el('box.grand', [mid]);
    return { grand, leaf, mid };
  };

  it('should reach every level of the chain', () => {
    const { grand, leaf, mid } = chain();
    const restyler = new Restyler(new Cascade([sheet]));
    grand.props = { width: '10' };
    restyler.update(as(grand));
    expect(restyler.styleOf(as(leaf))?.width).toEqual({ type: 'cells', value: 10 });

    grand.props = { width: '20' };
    restyler.touchProps(as(grand));
    restyler.update(as(grand));

    expect(restyler.styleOf(as(mid))?.width).toEqual({ type: 'cells', value: 20 });
    expect(restyler.styleOf(as(leaf))?.width).toEqual({ type: 'cells', value: 20 });
  });

  it('should agree with a Restyler that has never seen the tree', () => {
    // the property worth pinning rather than any particular rule: after any
    // sequence of marks, a cached style is what a fresh resolve would produce
    const { grand, leaf, mid } = chain();
    const cascade = new Cascade([sheet]);
    const restyler = new Restyler(cascade);

    grand.props = { width: '10' };
    restyler.update(as(grand));
    grand.props = { width: '20' };
    restyler.touchProps(as(grand));
    restyler.update(as(grand));
    mid.classes.push('extra');
    restyler.touchClasses(as(mid));
    restyler.update(as(grand));

    const fresh = new Restyler(cascade);
    fresh.update(as(grand));

    for (const node of [grand, mid, leaf]) {
      expect(restyler.styleOf(as(node)), node.classes.join('.')).toEqual(fresh.styleOf(as(node)));
    }
  });
});

describe('a focus-within change', () => {
  /**
   * Two panels and a footer of thirty rows, each panel a header over a body over
   * a list -- deep enough that the list and the title are not siblings, so a
   * restyle that reached the title got there through the panel and nothing else.
   */
  function screen() {
    const side = (name: string) => {
      const row = el(`text.${name}-row`);
      const list = el(`box.${name}-list`, [row]);
      const body = el(`box.${name}-body`, [list]);
      const title = el(`text.${name}-title`);
      const header = el(`box.${name}-header`, [title]);
      const panel = el(`box.panel.${name}`, [header, body]);
      return { body, header, list, panel, row, title };
    };
    const a = side('a');
    const b = side('b');
    const footer = el(
      'box.footer',
      Array.from({ length: 30 }, () => el('text.key'))
    );
    const root = el('box.root', [a.panel, b.panel, footer]);
    return { a, b, footer, root };
  }

  /** Moves the focus from one list to the other, as the element tree reports it. */
  function move(from: Node[], to: Node[]): void {
    for (const node of from) {
      node.states = node.states.filter((state) => state !== 'focus' && state !== 'focus-within');
    }
    for (const node of to) {
      node.states.push('focus-within');
    }
  }

  /** Every node `update()` re-resolved, read off the cascade it asked. */
  function spy(cascade: Cascade): Set<Node> {
    const seen = new Set<Node>();
    const resolve = cascade.resolveSheets.bind(cascade);
    cascade.resolveSheets = (node, parent) => {
      seen.add(node as unknown as Node);
      return resolve(node, parent);
    };
    return seen;
  }

  it('should restyle the two chains a focus move flips, not the tree', () => {
    // SIG-372: the root is an ancestor of everything, so `touchClasses()` on
    // every link of both chains would restyle the whole screen on every move
    const { a, b, footer, root } = screen();
    const cascade = new Cascade([
      parseStylesheet(`
        .panel { border-color: gray }
        .panel:focus-within { border-color: green }
      `),
    ]);
    const restyler = new Restyler(cascade);
    a.list.states.push('focus');
    for (const node of [root, a.panel, a.body, a.list]) {
      node.states.push('focus-within');
    }
    restyler.update(as(root));
    expect(restyler.styleOf(as(a.panel))?.borderColor).toBe(2);

    const seen = spy(cascade);
    move([a.panel, a.body, a.list], [b.panel, b.body, b.list]);
    b.list.states.push('focus');
    // what the renderer hands over: each end's own `focus` is a class change,
    // and every ancestor is a state change -- the root too, which stays lit but
    // passes through nought between the blur and the focus, the order the
    // router writes them in (`should move with the focus` in the element tests)
    restyler.touchClasses(as(a.list));
    restyler.touchClasses(as(b.list));
    for (const node of [root, a.panel, a.body, b.panel, b.body]) {
      restyler.touchState(as(node), 'focus-within');
    }
    restyler.update(as(root));

    expect(restyler.styleOf(as(a.panel))?.borderColor).toBe(8);
    expect(restyler.styleOf(as(b.panel))?.borderColor).toBe(2);
    // each chain up to the root, each end's subtree, and the children of a
    // panel whose border changed -- forced, because a child may read anything
    // through `inherit` -- which stop there, since nothing they resolve to
    // moved. The root resolved to what it was, so nothing under it is forced
    expect(seen).toEqual(
      new Set([
        root,
        a.panel,
        a.header,
        a.body,
        a.list,
        a.row,
        b.panel,
        b.header,
        b.body,
        b.list,
        b.row,
      ])
    );
    expect(seen.has(footer)).toBe(false);
  });

  it('should carry an inherited colour down from a panel restyled alone', () => {
    // a node restyled on its own has no marked subtree under it, so its children
    // are forced exactly when its style changed -- the prop path's rule, and the
    // one that brings an inherited `color` to a title nothing else touched
    const { a, b, root } = screen();
    const cascade = new Cascade([parseStylesheet('.panel:focus-within { color: green }')]);
    const restyler = new Restyler(cascade);
    a.panel.states.push('focus-within');
    restyler.update(as(root));
    expect(restyler.styleOf(as(a.title))?.color).toBe(2);

    move([a.panel], [b.panel]);
    restyler.touchState(as(a.panel), 'focus-within');
    restyler.touchState(as(b.panel), 'focus-within');
    restyler.update(as(root));

    expect(restyler.styleOf(as(a.title))?.color).not.toBe(2);
    expect(restyler.styleOf(as(b.title))?.color).toBe(2);
    expect(restyler.styleOf(as(b.row))?.color).toBe(2);
  });

  it('should restyle what a class change would once a selector reads it through a combinator', () => {
    // `.panel:focus-within .title` makes the panel's state a question its title
    // asks, so restyling the panel alone would leave the title on the old answer
    const { a, b, footer, root } = screen();
    const cascade = new Cascade([parseStylesheet('.panel:focus-within .a-title { bold: true }')]);
    const restyler = new Restyler(cascade);
    a.panel.states.push('focus-within');
    restyler.update(as(root));
    expect(restyler.styleOf(as(a.title))?.bold).toBe(true);

    const seen = spy(cascade);
    move([a.panel], [b.panel]);
    restyler.touchState(as(a.panel), 'focus-within');
    restyler.touchState(as(b.panel), 'focus-within');
    restyler.update(as(root));

    expect(restyler.styleOf(as(a.title))?.bold).toBe(false);
    // the subtree and the siblings, which is `touchClasses()`
    expect(seen.has(a.title)).toBe(true);
    expect(seen.has(footer)).toBe(true);
    expect(seen.has(root)).toBe(false);
  });

  it('should read the sheets again once they change', () => {
    const cascade = new Cascade([parseStylesheet('.panel:focus-within { bold: true }')]);
    expect(cascade.reaches('focus-within')).toBe(false);
    cascade.add(
      parseStylesheet('@media (min-width: 999) { .panel:focus-within text { bold: true } }')
    );
    // a rule whose media query does not apply still counts, so a resize -- which
    // is not a change to the sheet set -- cannot make the answer stale
    expect(cascade.reaches('focus-within')).toBe(true);
    expect(cascade.reaches('focus')).toBe(false);
  });
});
