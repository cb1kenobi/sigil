/**
 * The `ui` tag's source positions, which used to cost O(k²) for a template of
 * k nodes (SIG-349).
 *
 * `loc()` joined and split the whole consumed prefix of the template on every
 * call, and it is called once per element and per text run. It now counts
 * forward from where it last stopped. Every position below was recorded from
 * the quadratic version before it was replaced, so these pin that nothing a
 * reader is told moved: only `\n` ends a line, a `\r` and a tab are each one
 * column, an astral character is two (UTF-16 code units), and what was
 * interpolated counts for nothing.
 */

import { Expr, type IRNode, parse, ui } from '../../src/template/index.js';
import { describe, expect, it } from 'vitest';

/** What a template's parse throws, or `undefined` if it parses. */
function parseError(strings: readonly string[], values: readonly unknown[] = []): unknown {
  try {
    parse(strings, values);
  } catch (e: unknown) {
    return (e as Error).message;
  }
  return undefined;
}

/** Every node's kind and position, in document order. */
function positions(node: IRNode, out: string[] = []): string[] {
  out.push(`${node.kind} ${node.loc ? `${node.loc.line}:${node.loc.column}` : '-'}`);
  if (node.kind === 'element') {
    for (const child of node.children) {
      positions(child, out);
    }
  }
  return out;
}

/** The IR positions of a template whose interpolations are all expressions. */
function locsOf(strings: readonly string[]): string[] {
  const values = strings.slice(1).map((_, at) => new Expr(`v${at}`));
  return positions(parse(strings, values));
}

describe('the ui tag reports the positions it reported before SIG-349', () => {
  it.each([
    [
      'on the first line',
      ['<box %></box>'],
      [],
      'Unexpected "%" in <box> on line 1 of the template',
    ],
    [
      'after several newlines',
      ['<box>\n  <text>a</text>\n\n  <text $></text>\n</box>'],
      [],
      'Unexpected "$" in <text> on line 4 of the template',
    ],
    [
      'after a hole',
      ['<box>\n  <text>', '</text>\n  <box =x/>\n</box>'],
      [1],
      'Unexpected "=" in <box> on line 3 of the template',
    ],
    [
      'inside an attribute',
      ['<box\n  class="row'],
      [],
      'Unterminated attribute value on line 2 of the template',
    ],
    [
      'at a hole inside a quoted attribute',
      ['<box\n   class="a', '"/>'],
      [1],
      'An interpolation inside a quoted value is not supported on line 2 of the template; ' +
        'write the whole value as one interpolation',
    ],
    [
      'after CRLF line endings',
      ['<box>\r\n  <text>a</text>\r\n  <text #/>\r\n</box>'],
      [],
      'Unexpected "#" in <text> on line 3 of the template',
    ],
    [
      'after a tab',
      ['<box>\n\t\t<text \t#/>\n</box>'],
      [],
      'Unexpected "#" in <text> on line 2 of the template',
    ],
    [
      'after a wide character',
      ['<box>\n  <text>漢字漢字</text><text ?/>\n</box>'],
      [],
      'Unexpected "?" in <text> on line 2 of the template',
    ],
    [
      'after an astral character',
      ['<box>\n  <text>😀😀</text> <box ?/>\n</box>'],
      [],
      'Unexpected "?" in <box> on line 2 of the template',
    ],
    [
      'at an interpolated tag',
      ['<box>\n  <', ' />\n</box>'],
      [42],
      'An interpolated tag must be a component function, got number on line 2 of the template',
    ],
    [
      'at a spread attribute',
      ['<box>\n\n <box ', ' />\n</box>'],
      [{}],
      'A spread attribute is not supported on line 3 of the template',
    ],
    [
      'after an interpolated value',
      ['<box>\n <box width=', 'px />\n</box>'],
      [10],
      'An interpolated value is the whole value, so "p" cannot follow it on line 2 of the ' +
        'template; quote the value or interpolate all of it',
    ],
    [
      'at a missing ">"',
      ['<box>\n  <box /x\n</box>'],
      [],
      'Expected ">" on line 2 of the template',
    ],
    [
      'at a missing tag name',
      ['<box>\n  < box/>\n</box>'],
      [],
      'Expected a tag name after "<" on line 2 of the template',
    ],
    [
      'across several holes and lines',
      ['<box>\n', '\n  <text>', '\n</text>\n', '\n  <box\n   class="x', '"/>'],
      [1, 2, 3, 4],
      'An interpolation inside a quoted value is not supported on line 7 of the template; ' +
        'write the whole value as one interpolation',
    ],
  ])('should name the same line %s', (_, strings, values, message) => {
    expect(parseError(strings, values)).toBe(message);
  });

  it('should carry the same position into an error the emitter raises', () => {
    const indented = [
      '\n      <box>\n        <text>fine</text>\n        <text><box/></text>\n      </box>\n    ',
    ];
    expect(() => ui(Object.assign([...indented], { raw: indented }))).toThrow(
      'An element cannot go inside <text>; there is no inline layout (at line 4)'
    );

    const astral = ['<box>\n  😀', '\n  <text>a<box/></text>\n</box>'];
    expect(() => ui(Object.assign([...astral], { raw: astral }), 'x')).toThrow(
      'An element cannot go inside <text>; there is no inline layout (at line 3)'
    );
  });

  it('should give every node the line and column it had', () => {
    expect(locsOf(['<box>\n  <text>a</text>\n  <text>b ', ' c</text>\n</box>'])).toEqual([
      'element 1:1',
      'element 2:3',
      'text 2:9',
      'element 3:3',
      'text 3:9',
      'slot 3:11',
      'text 3:11',
    ]);

    // CRLF, a tab, a wide and an astral character, and a hole: a `\r` is a
    // column, and so is each half of the surrogate pair
    expect(
      locsOf(['<box>\r\n\t<text>漢😀x</text>\r\n\t', '\n  <box class="r"/>  text\n</box>'])
    ).toEqual(['element 1:1', 'element 2:2', 'text 2:8', 'slot 3:2', 'element 4:3', 'text 4:19']);

    expect(locsOf(['\n\n   <box>', '<', '/>', '\n  </box>'])).toEqual([
      'element 3:4',
      'slot 3:9',
      'element 3:9',
      'slot 3:12',
    ]);

    // a comment with a hole and a newline in it is still counted past
    expect(locsOf(['<box><!-- a\n b ', ' -->\n <text>x</text></box>'])).toEqual([
      'element 1:1',
      'element 3:2',
      'text 3:8',
    ]);
  });
});

/**
 * How many characters the parser examines to read a template.
 *
 * Counted rather than timed, because a ratio of two timings is a flake on a
 * loaded machine. Each static string is handed over as a `Proxy` around a
 * `String`, and every operation on it is charged by what it costs: an index
 * or a `.length` is one, `charCodeAt()` is one, `indexOf()` is the distance it
 * scanned, and anything else -- a `slice()`, a `split()`, being concatenated --
 * is the whole string. So the count sees the work done _inside_ one string as
 * well as how many strings are read, and a method the parser starts using that
 * this does not know about is charged as a full scan rather than as nothing.
 */
function work(strings: readonly string[]): number {
  let count = 0;
  const wrapped = strings.map((string) => {
    // a proxy needs an object, so the primitive is wrapped
    return new Proxy(new String(string), {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== 'function') {
          if (typeof key === 'string') {
            count += 1;
          }
          return value;
        }
        return (...args: unknown[]) => {
          const result: unknown = (string as unknown as Record<string, Function>)[key as string]!(
            ...args
          );
          if (key === 'charCodeAt' || key === 'charAt' || key === 'at') {
            count += 1;
          } else if (key === 'indexOf') {
            const from = typeof args[1] === 'number' ? args[1] : 0;
            count += (result === -1 ? string.length : (result as number) + 1) - from;
          } else {
            count += string.length;
          }
          return result;
        };
      },
    });
  }) as unknown as string[];
  parse(
    wrapped,
    strings.slice(1).map((_, at) => new Expr(`v${at}`))
  );
  return count;
}

describe('the ui tag parses in time linear in the template', () => {
  it('should not re-read the template for every node it reports a position for', () => {
    // k text elements, one hole each: the first `loc()` concatenated every
    // string before the cursor on each call, so this grew with k²
    const holes = (k: number) => [
      '<box><text>',
      ...Array.from({ length: k - 1 }, () => '</text><text>'),
      '</text></box>',
    ];
    // linear is 2x; recounting from the start was close to 4x
    expect(work(holes(1000)) / work(holes(500))).toBeLessThan(2.5);
  });

  it('should not scan to the end of a line for every node on it', () => {
    // k text elements on one line: a newline search not bounded by the cursor
    // ran to the end of the line from every node, so this grew with k²
    const line = (k: number) => [`<box>${'<text>item</text>'.repeat(k)}</box>`];
    expect(work(line(1000)) / work(line(500))).toBeLessThan(2.5);
  });
});
