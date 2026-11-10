import {
  compareSpecificity,
  keysFor,
  matches,
  parseSelector,
  parseSelectorList,
  STATES,
  type StyleNode,
  StyleError,
  UNIVERSAL_KEY,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/** A node, written the way a selector is: `box#main.panel:focus`. */
interface Node extends StyleNode {
  children: Node[];
  classes: string[];
  id?: string;
  parent?: Node;
  states: StyleState[];
  type: string;
}

type StyleState = (typeof STATES)[number];

function el(spec: string, children: Node[] = []): Node {
  const node: Node = { children, classes: [], states: [], type: '' };

  for (const [, sigil, name] of spec.matchAll(/([#.:]?)([-\w]+)/g)) {
    if (sigil === '#') {
      node.id = name;
    } else if (sigil === '.') {
      node.classes.push(name);
    } else if (sigil === ':') {
      node.states.push(name as StyleState);
    } else {
      node.type = name;
    }
  }

  for (const child of children) {
    child.parent = node;
  }
  return node;
}

/** The whole tree from one literal, so a test reads as a shape. */
const tree = el('box#app.root', [
  el('text.title'),
  el('box.panel:focus', [el('text.label'), el('text.value.wide'), el('button:disabled')]),
  el('text.footer'),
]);

const [title, panel, footer] = tree.children;
const [label, value, button] = panel.children;

describe('reading a selector', () => {
  it('should read the simple selectors', () => {
    expect(parseSelector('*').steps[0].compound.simples).toEqual([{ kind: 'universal' }]);
    expect(parseSelector('text').steps[0].compound.simples).toEqual([
      { kind: 'type', name: 'text' },
    ]);
    expect(parseSelector('#email').steps[0].compound.simples).toEqual([
      { kind: 'id', name: 'email' },
    ]);
    expect(parseSelector('.error').steps[0].compound.simples).toEqual([
      { kind: 'class', name: 'error' },
    ]);
  });

  it('should read a compound selector as one step', () => {
    const selector = parseSelector('text#a.b.c:focus');
    expect(selector.steps).toHaveLength(1);
    expect(selector.steps[0].compound.simples).toHaveLength(5);
  });

  it('should read every combinator', () => {
    expect(parseSelector('a b').steps[1].combinator).toBe('descendant');
    expect(parseSelector('a > b').steps[1].combinator).toBe('child');
    expect(parseSelector('a + b').steps[1].combinator).toBe('next-sibling');
    expect(parseSelector('a ~ b').steps[1].combinator).toBe('later-sibling');
    // whitespace around a combinator is optional, and its absence is not a
    // descendant combinator
    expect(parseSelector('a>b').steps).toHaveLength(2);
    expect(parseSelector('a>b').steps[1].combinator).toBe('child');
  });

  it('should read a comma-separated list', () => {
    const list = parseSelectorList('.a, .b > .c , #d');
    expect(list.map((selector) => selector.source)).toEqual(['.a', '.b > .c', '#d']);
  });

  it('should keep a comma inside :not() out of the list', () => {
    const list = parseSelectorList('.a:not(.b, .c), .d');
    expect(list).toHaveLength(2);
  });

  it('should refuse an attribute selector, and say why', () => {
    expect(() => parseSelector('text[disabled]')).toThrow(/deliberately out/);
    expect(() => parseSelector('text[disabled]')).toThrow(StyleError);
  });

  it('should refuse a pseudo-class it does not have', () => {
    expect(() => parseSelector(':nth-of-type(2)')).toThrow(/Unknown pseudo-class/);
    expect(() => parseSelector('text::before')).toThrow(/pseudo-elements/);
  });

  it('should refuse nonsense', () => {
    expect(() => parseSelector('')).toThrow(StyleError);
    expect(() => parseSelector('> .a')).toThrow(StyleError);
    expect(() => parseSelector('.a,')).toThrow(StyleError);
    expect(() => parseSelector('.')).toThrow(StyleError);
    expect(parseSelectorList('.a .b')).toHaveLength(1);
  });

  it('should refuse a combinator inside :not()', () => {
    expect(() => parseSelector(':not(.a .b)')).toThrow(/combinators are not allowed/);
  });
});

describe('escapes', () => {
  // what makes a class called `md:flex-row` or `w-1/2` writable at all: the
  // colon and the slash mean something else to this grammar, so the rule is
  // written `.md\:flex-row` and the name is `md:flex-row`
  it('should read a backslash as escaping the next character', () => {
    expect(parseSelector('.md\\:flex-row').steps[0].compound.simples).toEqual([
      { kind: 'class', name: 'md:flex-row' },
    ]);
    expect(parseSelector('.w-1\\/2').steps[0].compound.simples).toEqual([
      { kind: 'class', name: 'w-1/2' },
    ]);
  });

  it('should store the unescaped name, which is what an element carries', () => {
    const node = { classes: ['md:flex-row', 'w-1/2'], type: 'box' } as unknown as Node;
    expect(matches(parseSelector('.md\\:flex-row'), node)).toBe(true);
    expect(matches(parseSelector('.w-1\\/2'), node)).toBe(true);
    expect(parseSelector('.md\\:flex-row').key).toBe('.md:flex-row');
    expect(keysFor(node)).toContain('.md:flex-row');
  });

  it('should escape at the start of a name', () => {
    expect(parseSelector('.\\:odd').steps[0].compound.simples).toEqual([
      { kind: 'class', name: ':odd' },
    ]);
  });

  it('should let a backslash escape a backslash', () => {
    expect(parseSelector('.a\\\\b').steps[0].compound.simples).toEqual([
      { kind: 'class', name: 'a\\b' },
    ]);
  });

  it('should refuse a trailing backslash, which escapes nothing', () => {
    expect(() => parseSelector('.a\\')).toThrow(/escapes nothing/);
  });

  it('should not read a pseudo-class out of an escaped colon', () => {
    // `.focus\:text-red:focus` is one class and one pseudo-class, and reading
    // the escaped colon as the pseudo-class would make every variant rule
    // match on state it never asked about
    const selector = parseSelector('.focus\\:text-red:focus');
    expect(selector.steps[0].compound.simples).toEqual([
      { kind: 'class', name: 'focus:text-red' },
      { kind: 'state', name: 'focus' },
    ]);
  });
});

describe('specificity', () => {
  it('should count ids, classes, and types', () => {
    expect(parseSelector('*').specificity).toEqual([0, 0, 0]);
    expect(parseSelector('text').specificity).toEqual([0, 0, 1]);
    expect(parseSelector('.error').specificity).toEqual([0, 1, 0]);
    expect(parseSelector('#email').specificity).toEqual([1, 0, 0]);
    expect(parseSelector('#email.error text').specificity).toEqual([1, 1, 1]);
  });

  it('should count a pseudo-class as a class', () => {
    expect(parseSelector(':focus').specificity).toEqual([0, 1, 0]);
    expect(parseSelector(':first-child').specificity).toEqual([0, 1, 0]);
    expect(parseSelector(':nth-child(2n)').specificity).toEqual([0, 1, 0]);
  });

  it('should count :not() as the most specific thing inside it', () => {
    // `:not()` itself is worth nothing and its argument is worth what it says,
    // which is the CSS rule
    expect(parseSelector(':not(text)').specificity).toEqual([0, 0, 1]);
    expect(parseSelector(':not(.a)').specificity).toEqual([0, 1, 0]);
    expect(parseSelector(':not(#a, .b)').specificity).toEqual([1, 0, 0]);
  });

  it('should compare left to right', () => {
    const a = parseSelector('#x').specificity;
    const b = parseSelector('.a.b.c.d').specificity;
    expect(compareSpecificity(a, b)).toBeGreaterThan(0);
    expect(compareSpecificity(b, a)).toBeLessThan(0);
    expect(compareSpecificity(a, a)).toBe(0);
  });
});

describe('bucketing', () => {
  it('should file a selector under the most selective thing on its right', () => {
    expect(parseSelector('box .panel#main').key).toBe('#main');
    expect(parseSelector('box .panel.wide').key).toBe('.wide');
    expect(parseSelector('box text').key).toBe('text');
    expect(parseSelector(':focus').key).toBe(UNIVERSAL_KEY);
    expect(parseSelector('.a *').key).toBe(UNIVERSAL_KEY);
  });

  it('should list every bucket an element has to test', () => {
    expect(keysFor(value)).toEqual(['*', 'text', '.value', '.wide']);
    expect(keysFor(tree)).toEqual(['*', 'box', '#app', '.root']);
  });
});

describe('matching', () => {
  const hits = (source: string): string[] => {
    const selectors = parseSelectorList(source);
    const out: string[] = [];
    const walk = (node: Node, path: string): void => {
      if (selectors.some((selector) => matches(selector, node))) {
        out.push(path);
      }
      for (const child of node.children) {
        walk(child, `${path}/${child.type}${child.classes.map((c) => `.${c}`).join('')}`);
      }
    };
    walk(tree, 'box.root');
    return out;
  };

  it('should match a type, a class, an id, and the universal selector', () => {
    expect(hits('button')).toEqual(['box.root/box.panel/button']);
    expect(hits('.title')).toEqual(['box.root/text.title']);
    expect(hits('#app')).toEqual(['box.root']);
    expect(hits('*')).toHaveLength(7);
  });

  it('should match a compound only when every part does', () => {
    expect(hits('text.value.wide')).toEqual(['box.root/box.panel/text.value.wide']);
    expect(hits('text.value.missing')).toEqual([]);
  });

  it('should tell a descendant from a child', () => {
    expect(hits('#app text')).toHaveLength(4);
    expect(hits('#app > text')).toEqual(['box.root/text.title', 'box.root/text.footer']);
  });

  it('should match the sibling combinators', () => {
    expect(hits('.label + text')).toEqual(['box.root/box.panel/text.value.wide']);
    expect(hits('.label + button')).toEqual([]);
    expect(hits('.label ~ button')).toEqual(['box.root/box.panel/button']);
  });

  it('should backtrack through ancestors', () => {
    // the rightmost compound matches first and only then does anything walk
    // the tree, and more than one ancestor can be the one that matches
    expect(hits('box box text')).toEqual([
      'box.root/box.panel/text.label',
      'box.root/box.panel/text.value.wide',
    ]);
  });

  it('should restyle children from a container state', () => {
    // the thing props styling cannot do cleanly, and the reason the whole
    // feature is worth having
    expect(hits('.panel:focus text')).toHaveLength(2);
    expect(hits('.panel:disabled text')).toEqual([]);
  });

  it('should match a state pseudo-class against what the element reports', () => {
    expect(hits(':focus')).toEqual(['box.root/box.panel']);
    expect(hits(':disabled')).toEqual(['box.root/box.panel/button']);
    // nothing in *this* tree reports `:hover`, which is the same answer it always
    // gave -- the difference since the mouse landed is that something now can,
    // which is the input router setting the state from its hit test
    expect(hits(':hover')).toEqual([]);
  });

  it('should match the structural pseudo-classes', () => {
    expect(hits('.panel > :first-child')).toEqual(['box.root/box.panel/text.label']);
    expect(hits('.panel > :last-child')).toEqual(['box.root/box.panel/button']);
    expect(hits('.panel > :nth-child(2)')).toEqual(['box.root/box.panel/text.value.wide']);
  });

  it('should treat an element with no parent as a first child', () => {
    // what browsers answer for the root: it has no siblings, so it is first
    expect(matches(parseSelector(':first-child'), el('box'))).toBe(true);
    expect(matches(parseSelector(':last-child'), el('box'))).toBe(true);
  });

  it('should read every :nth-child() form', () => {
    const list = el('box', [el('a'), el('a'), el('a'), el('a'), el('a')]);
    const which = (argument: string): number[] => {
      const selector = parseSelector(`:nth-child(${argument})`);
      return list.children
        .map((child, i) => (matches(selector, child) ? i + 1 : 0))
        .filter(Boolean);
    };

    expect(which('odd')).toEqual([1, 3, 5]);
    expect(which('even')).toEqual([2, 4]);
    expect(which('3')).toEqual([3]);
    expect(which('2n+1')).toEqual([1, 3, 5]);
    expect(which('n')).toEqual([1, 2, 3, 4, 5]);
    expect(which('n+3')).toEqual([3, 4, 5]);
    // a negative step counts backwards from the offset, which is how "the
    // first three" is spelled
    expect(which('-n+3')).toEqual([1, 2, 3]);
    expect(which('0n+2')).toEqual([2]);
  });

  it('should refuse a :nth-child() argument it cannot read', () => {
    expect(() => parseSelector(':nth-child(two)')).toThrow(/expected odd, even, or an\+b/);
    expect(() => parseSelector(':nth-child()')).toThrow(StyleError);
    expect(() => parseSelector(':nth-child(2n')).toThrow(/closing parenthesis/);
  });

  it('should match :not() against everything it is not', () => {
    expect(hits('.panel > :not(text)')).toEqual(['box.root/box.panel/button']);
    expect(hits('#app > text:not(.title)')).toEqual(['box.root/text.footer']);
    expect(hits(':not(*)')).toEqual([]);
  });

  it('should match types, classes, and ids case-sensitively', () => {
    // they are JavaScript-land names rather than CSS keywords, and a second
    // rule about case is one more thing to get wrong
    expect(matches(parseSelector('Box'), tree)).toBe(false);
    expect(matches(parseSelector('.Root'), tree)).toBe(false);
    expect(matches(parseSelector('box'), tree)).toBe(true);
  });

  it('should read a pseudo-class in any case, because it is a keyword', () => {
    expect(matches(parseSelector(':FOCUS'), panel)).toBe(true);
  });

  it('should not walk the tree when the rightmost compound cannot match', () => {
    expect(matches(parseSelector('#app .nothing'), label)).toBe(false);
    expect(matches(parseSelector('#app .label'), label)).toBe(true);
    expect(matches(parseSelector('#nothing .label'), label)).toBe(false);
  });

  it('should answer for every node in the fixture', () => {
    expect([title, panel, footer, label, value, button].map((n) => n.parent?.type)).toEqual([
      'box',
      'box',
      'box',
      'box',
      'box',
      'box',
    ]);
  });
});

describe('the later-sibling combinator', () => {
  // every node carries an id, so a match reads back as a list of names
  const siblings = el('box#root', [
    el('section#s1.a', [
      el('row#r1'),
      el('text#h1.heading'),
      el('row#r2.x'),
      el('row#r3'),
      el('text#h2.heading'),
      el('box#g1', [el('text#t1')]),
      el('row#r4'),
    ]),
    el('section#s2', [el('row#r5'), el('text#h3.heading'), el('row#r6')]),
  ]);

  const which = (source: string): string[] => {
    const selector = parseSelector(source);
    const out: string[] = [];
    const walk = (node: Node): void => {
      if (matches(selector, node)) {
        out.push(node.id ?? '');
      }
      node.children.forEach(walk);
    };
    walk(siblings);
    return out;
  };

  it.each([
    // [selector, what it matches in document order, its specificity]
    ['.heading ~ row', ['r2', 'r3', 'r4', 'r6'], [0, 1, 1]],
    ['row ~ row', ['r2', 'r3', 'r4', 'r6'], [0, 0, 2]],
    ['.heading ~ .heading', ['h2'], [0, 2, 0]],
    ['* ~ box', ['g1'], [0, 0, 1]],
    ['#r4 ~ *', [], [1, 0, 0]],
    // a descendant to the left of the sibling step
    ['.a .heading ~ row', ['r2', 'r3', 'r4'], [0, 2, 1]],
    ['section ~ section row', ['r5', 'r6'], [0, 0, 3]],
    // two sibling steps, each of which can backtrack
    ['.heading ~ .heading ~ row', ['r4'], [0, 2, 1]],
    ['row ~ .heading ~ row', ['r2', 'r3', 'r4', 'r6'], [0, 1, 2]],
    // a next-sibling step to its left
    ['.heading + row ~ *', ['r3', 'h2', 'g1', 'r4'], [0, 1, 1]],
    ['.x + row ~ row', ['r4'], [0, 1, 2]],
    // a child step to its right
    ['.heading ~ box > text', ['t1'], [0, 1, 2]],
    ['.heading ~ box text', ['t1'], [0, 1, 2]],
    // `:not()` on either side; its argument is a compound, never a combinator
    [':not(.heading) ~ .heading', ['h1', 'h2', 'h3'], [0, 2, 0]],
    ['.heading ~ :not(row)', ['h2', 'g1'], [0, 1, 1]],
    [':not(section) ~ row:not(.x)', ['r3', 'r4', 'r6'], [0, 1, 2]],
  ] as const)('%s', (source, matched, specificity) => {
    expect(which(source)).toEqual(matched);
    expect(parseSelector(source).specificity).toEqual(specificity);
  });

  it('should never match an element with no parent', () => {
    // it has no siblings to have come after
    expect(matches(parseSelector('* ~ *'), el('box'))).toBe(false);
    expect(matches(parseSelector('* ~ box'), siblings)).toBe(false);
  });

  it('should find its siblings once per element, not once per step back', () => {
    // A children list that counts how many entries `indexOf()` reads, which is
    // the work the matcher does to learn where an element sits. Walking back by
    // asking each sibling for its own position made one element cost O(n^2)
    // and a list of them O(n^3); a single lookup is O(n) and O(n^2). Doubling
    // the list therefore multiplies the work by 8 before and 4 after, and the
    // bound sits between the two.
    class Counting extends Array<Node> {
      read = 0;
      override indexOf(search: Node, from = 0): number {
        const index = super.indexOf(search, from);
        this.read += (index === -1 ? this.length : index + 1) - from;
        return index;
      }
    }
    const work = (source: string, n: number): number => {
      const list = new Counting();
      for (let i = 0; i < n; i++) {
        list.push(el('row'));
      }
      el('box', list);
      const selector = parseSelector(source);
      for (const row of list) {
        matches(selector, row);
      }
      return list.read;
    };

    // the left side never matches, which is the expensive case: every
    // sibling is tried and none ends the walk
    for (const source of ['.heading ~ row', 'row + row', 'row:nth-child(odd)']) {
      const small = work(source, 100);
      const large = work(source, 200);
      expect(large / small, source).toBeLessThan(6);
      expect(large, source).toBeLessThanOrEqual(200 * 201);
    }
  });
});
