import { palette } from '../../src/canvas/index.js';
import {
  Cascade,
  compareSpecificity,
  inheritFrom,
  initialStyle,
  LAYERS,
  type Matched,
  ORIGINS,
  type Origin,
  parseStylesheet,
  type PropertyName,
  resolveKeyword,
  type Rule,
  type Style,
  type StyleNode,
  type Stylesheet,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Who wins a property, held to the algorithm the cascade is documented as.
 *
 * `resolveSheets()` compares two declarations off their matched rules and keeps
 * the winners in a table it reuses across calls (SIG-381). Before that it built a
 * precedence object for every declaration and a fresh map of winners per call,
 * which is the algorithm written out below -- so this file is the evidence that
 * the rewrite moved no answer, and the place an answer that moves is caught.
 */

const node = (spec: Partial<StyleNode> & { type: string }): StyleNode => spec;

/** The precedence tuple, as a fresh object per declaration: the old shape. */
function precedence(matched: Matched, important: boolean): number[] {
  const layer = LAYERS.indexOf(matched.rule.layer);
  const origin = ORIGINS.indexOf(matched.origin);
  return important
    ? [2, ORIGINS.length - 1 - origin, LAYERS.length - 1 - layer, matched.order]
    : [0, origin, layer, matched.order];
}

function compare(a: Matched, aImportant: boolean, b: Matched, bImportant: boolean): number {
  const [aBand, aOrigin, aLayer, aOrder] = precedence(a, aImportant) as [
    number,
    number,
    number,
    number,
  ];
  const [bBand, bOrigin, bLayer, bOrder] = precedence(b, bImportant) as [
    number,
    number,
    number,
    number,
  ];
  return (
    aBand - bBand ||
    aOrigin - bOrigin ||
    aLayer - bLayer ||
    compareSpecificity(a.specificity, b.specificity) ||
    aOrder - bOrder
  );
}

/** The cascade's answer worked out the long way, from what `match()` reports. */
function reference(
  cascade: Cascade,
  target: StyleNode,
  parent?: Style
): { locked: PropertyName[]; style: Style } {
  const style = (parent ? inheritFrom(parent) : initialStyle()) as Record<PropertyName, unknown>;
  const winners = new Map<PropertyName, { important: boolean; matched: Matched }>();
  const locked = new Set<PropertyName>();
  for (const matched of cascade.match(target)) {
    for (const declaration of matched.rule.declarations) {
      const held = winners.get(declaration.property);
      if (held && compare(matched, declaration.important, held.matched, held.important) < 0) {
        continue;
      }
      winners.set(declaration.property, { important: declaration.important, matched });
      style[declaration.property] = declaration.keyword
        ? resolveKeyword(declaration.keyword, declaration.property, parent)
        : declaration.value;
      if (declaration.important) {
        locked.add(declaration.property);
      }
    }
  }
  return { locked: [...locked].sort(), style: style as Style };
}

/** A small seeded generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(next: () => number, from: readonly T[]): T =>
  from[Math.floor(next() * from.length)] as T;

const SELECTORS = [
  '*',
  'box',
  'text',
  '.a',
  '.b',
  '.a.b',
  'box.a',
  '#x',
  '#x.a',
  '#x, .b',
  'root box',
  'root > .a',
  'box:first-child',
];

const DECLARATIONS = [
  'color: red',
  'color: blue',
  'color: inherit',
  'color: initial',
  'background-color: green',
  'padding: 1',
  'padding: 2 3',
  'padding-left: 4',
  'width: 5',
  'width: 6',
  'width: unset',
  'font-weight: bold',
  'bold: false',
  'margin: 1',
];

/** A sheet of a few rules, some layered and some important. */
function randomSheet(next: () => number, origin: Origin): Stylesheet {
  const rules: string[] = [];
  const count = 1 + Math.floor(next() * 6);
  for (let i = 0; i < count; i++) {
    const body: string[] = [];
    const declarations = 1 + Math.floor(next() * 3);
    for (let j = 0; j < declarations; j++) {
      body.push(`${pick(next, DECLARATIONS)}${next() < 0.25 ? ' !important' : ''}`);
    }
    const rule = `${pick(next, SELECTORS)} { ${body.join('; ')} }`;
    const layer = next();
    rules.push(
      layer < 0.2 ? `@layer base { ${rule} }` : layer < 0.4 ? `@layer utilities { ${rule} }` : rule
    );
  }
  return parseStylesheet(rules.join('\n'), { origin });
}

/** A root and its children, each a mix of the classes and the id above. */
function randomTree(next: () => number): StyleNode[] {
  // the same array, filled in below: a child's `parent` is the root, so the
  // root has to exist before its children do
  const children: StyleNode[] = [];
  const root = node({ children, type: 'root' });
  for (let i = 0; i < 4; i++) {
    const classes = ['a', 'b'].filter(() => next() < 0.5);
    const child = node({
      classes,
      id: next() < 0.3 ? 'x' : undefined,
      parent: root,
      type: next() < 0.7 ? 'box' : 'text',
    });
    children.push(child);
  }
  return [root, ...children];
}

describe('precedence, against the algorithm written out', () => {
  it('should pick every winner and lock every property the reference does', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const sheets = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
        randomSheet(next, pick(next, ORIGINS))
      );
      const cascade = new Cascade(sheets);
      const [root, ...children] = randomTree(next) as [StyleNode, ...StyleNode[]];
      const parent = cascade.resolveSheets(root).style;

      // one cascade resolving several elements in a row, which is what reusing
      // the winners across calls has to survive
      for (const target of [root, ...children]) {
        const asParent = target === root ? undefined : parent;
        const expected = reference(cascade, target, asParent);
        const actual = cascade.resolveSheets(target, asParent);
        expect(actual.style, `seed ${seed}`).toEqual(expected.style);
        expect([...actual.locked].sort(), `seed ${seed}`).toEqual(expected.locked);
      }
    }
  });
});

describe('what a resolve leaves behind for the next one', () => {
  const box = node({ classes: ['a'], id: 'x', type: 'box' });
  const plain = node({ classes: ['a'], type: 'box' });

  it('should not carry one element’s winner over to the next', () => {
    // `#x` wins colour for the first element, and the second does not match it at
    // all -- so if its winner were still standing, `.a` would lose to a rule the
    // second element never matched
    const cascade = new Cascade([parseStylesheet('#x { color: red } .a { color: blue }')]);
    expect(cascade.resolveSheets(box).style.color).toEqual(palette(1));
    expect(cascade.resolveSheets(plain).style.color).toEqual(palette(4));
  });

  it('should not carry a winner over between two cascades either', () => {
    const first = new Cascade([parseStylesheet('#x { color: red !important }')]);
    const second = new Cascade([parseStylesheet('.a { color: blue }')]);
    expect(first.resolveSheets(box).style.color).toEqual(palette(1));
    expect(second.resolveSheets(box).style.color).toEqual(palette(4));
  });

  it('should lock nothing for an element that matched no important declaration', () => {
    const cascade = new Cascade([parseStylesheet('#x { width: 4 !important } .a { color: blue }')]);
    expect([...cascade.resolveSheets(box).locked]).toEqual(['width']);
    expect([...cascade.resolveSheets(plain).locked]).toEqual([]);
    // and the element after it still locks what it should
    expect([...cascade.resolveSheets(box).locked]).toEqual(['width']);
  });

  it('should keep a property locked when a more important declaration takes it', () => {
    // both are important, and the second wins on specificity -- the property was
    // locked by the first and stays locked by the second
    const cascade = new Cascade([
      parseStylesheet('.a { width: 4 !important } #x { width: 5 !important }'),
    ]);
    const result = cascade.resolveSheets(box);
    expect([...result.locked]).toEqual(['width']);
    expect(result.style.width).toEqual({ type: 'cells', value: 5 });
  });

  it('should let the later of two declarations in one rule win, unless the earlier is important', () => {
    const later = new Cascade([parseStylesheet('.a { color: red; color: blue }')]);
    expect(later.resolveSheets(plain).style.color).toEqual(palette(4));

    const important = new Cascade([parseStylesheet('.a { color: red !important; color: blue }')]);
    expect(important.resolveSheets(plain).style.color).toEqual(palette(1));
    expect([...important.resolveSheets(plain).locked]).toEqual(['color']);
  });
});

describe('a resolve started inside another one', () => {
  it('should give the interrupted resolve the answer it would have had', () => {
    const outer = node({ id: 'x', type: 'box' });
    const inner = node({ classes: ['b'], type: 'text' });
    const cascade = new Cascade();

    // the type bucket is read before the id bucket, so `box` wins colour first and
    // `#x` then has to lose to it -- which it can only do while `box` is still on
    // record as the winner. Reading the winning value starts a resolve of another
    // element that sets colour too. Written by hand, because a getter on a
    // declaration is the one way into a resolve from inside one: a `Stylesheet` is
    // a plain object an app can build
    const parsed = parseStylesheet(
      'box { color: red !important } #x { color: blue } .b { color: green }'
    );
    let reentered = 0;
    const rules: Rule[] = parsed.rules.map((rule, at) =>
      at === 0
        ? {
            ...rule,
            declarations: rule.declarations.map((declaration) => ({
              ...declaration,
              get value() {
                reentered++;
                expect(cascade.resolveSheets(inner).style.color).toEqual(palette(2));
                return declaration.value;
              },
            })),
          }
        : rule
    );
    cascade.add({ ...parsed, rules });

    const result = cascade.resolveSheets(outer);
    expect(reentered).toBe(1);
    expect(result.style.color).toEqual(palette(1));
    expect([...result.locked]).toEqual(['color']);
    expect(cascade.resolveSheets(inner).style.color).toEqual(palette(2));
  });
});
