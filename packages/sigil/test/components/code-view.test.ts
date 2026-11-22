import { codeRun, codeView, type CodeViewOptions } from '../../src/components/code-view.js';
import { highlightCode } from '../../src/components/highlight.js';
import { PromptError } from '../../src/components/prompt.js';
import { type Element, renderToString } from '../../src/element/index.js';
import { describe, expect, it } from 'vitest';

/** The rows of a view: each a list of its children's classes and text. */
function rowsOf(view: Element): { classes: string; text: string }[][] {
  return view.children.map((row) =>
    row.children.map((child) => ({ classes: child.classes.join(' '), text: child.text ?? '' }))
  );
}

/** What a view prints, with no colour. */
function printed(code: string, opts: CodeViewOptions): string[] {
  return renderToString(codeView(code, opts), { colorLevel: 0, width: opts.width }).split('\n');
}

describe('codeView()', () => {
  describe('the gutter', () => {
    it('should number each line, right-aligned to the last number', () => {
      const lines = Array.from({ length: 10 }, (_, n) => `l${n}`).join('\n');
      expect(printed(lines, { gutter: true, width: 20 }).slice(0, 2)).toEqual([' 1 l0', ' 2 l1']);
      expect(printed(lines, { gutter: true, width: 20 })[9]).toBe('10 l9');
    });

    it('should draw no gutter unless it is asked for', () => {
      expect(printed('a\nb', { width: 20 })).toEqual(['a', 'b']);
    });

    it('should start at the line it is told, for an excerpt', () => {
      expect(printed('a\nb', { firstLine: 98, gutter: true, width: 20 })).toEqual(['98 a', '99 b']);
    });

    it('should read a first line under 1 as 1', () => {
      expect(printed('a\nb', { firstLine: -3, gutter: true, width: 20 })).toEqual(['1 a', '2 b']);
      expect(printed('a', { firstLine: 0, gutter: true, width: 20 })).toEqual(['1 a']);
    });

    it('should leave the gutter out where it would leave no room for a cell of code', () => {
      const code = Array.from({ length: 1000 }, () => 'x').join('\n');
      // four digits and a space is five columns, and four leaves nothing for code
      expect(rowsOf(codeView(code, { gutter: true, width: 4 }))[0]).toEqual([
        { classes: 'sigil-code', text: 'x' },
      ]);
      expect(rowsOf(codeView(code, { gutter: true, width: 5 }))[0]).toHaveLength(1);
      expect(rowsOf(codeView(code, { gutter: true, width: 6 }))[0]).toHaveLength(2);
    });

    it('should carry a blank gutter on the rows a folded line goes on to', () => {
      expect(printed('abcdefgh\nij', { gutter: true, width: 6, wrap: 'fold' })).toEqual([
        '1 abcd',
        '  efgh',
        '2 ij',
      ]);
    });

    it('should name the gutter after the class and draw it in the muted role', () => {
      const [row] = rowsOf(codeView('a', { class: 'mine', gutter: true, width: 10 }));
      expect(row?.[0]).toEqual({ classes: 'mine-gutter sigil-muted', text: '1' });
    });
  });

  describe('a line wider than the room', () => {
    it('should be cut at the edge by default', () => {
      expect(printed('abcdefghij\nk', { width: 4 })).toEqual(['abcd', 'k']);
    });

    it('should be folded onto the next row, at a cluster, when asked', () => {
      expect(printed('abcdefghij', { width: 4, wrap: 'fold' })).toEqual(['abcd', 'efgh', 'ij']);
    });

    it('should not split a wide character, and move it to the next row', () => {
      expect(printed('abc漢def', { width: 4, wrap: 'fold' })).toEqual(['abc', '漢de', 'f']);
      expect(printed('abc漢def', { width: 4 })).toEqual(['abc']);
    });

    it('should put a character wider than the whole room alone on a row when folding', () => {
      const rows = rowsOf(codeView('a漢b', { width: 1, wrap: 'fold' }));
      expect(rows.map((row) => row.map((run) => run.text))).toEqual([['a'], ['漢'], ['b']]);
    });

    it('should keep the token across the fold, in its own style on both rows', () => {
      const rows = rowsOf(
        codeView('abcdef', {
          tokens: ['keyword', 'keyword', 'keyword', 'keyword', undefined, undefined],
          width: 3,
          wrap: 'fold',
        })
      );
      expect(rows[0]?.[0]?.classes).toContain('sigil-token-keyword');
      expect(
        rows[1]?.map((run) => [run.text, run.classes.includes('sigil-token-keyword')])
      ).toEqual([
        ['d', true],
        ['ef', false],
      ]);
    });
  });

  describe('tabs', () => {
    it('should go to the next stop of four, and cut at the width', () => {
      expect(printed('\tab\tcdefghij', { width: 10 })).toEqual(['    ab  cd']);
    });

    it('should count a stop from the start of the row a tab is on', () => {
      expect(printed('abc\td', { tabSize: 8, width: 20 })).toEqual(['abc     d']);
      expect(printed('abcdef\tg', { width: 5, wrap: 'fold' })).toEqual(['abcde', 'f   g']);
      // a tab that does not fit where it is is a whole tab on the row it moves to
      expect(printed('abcde\tg', { width: 6, wrap: 'fold' })).toEqual(['abcde', '    g']);
    });

    it('should clamp a tab wider than the whole room to the room when folding', () => {
      const [row] = rowsOf(codeView('\tab', { width: 3, wrap: 'fold' }));
      expect(row?.map((run) => run.text)).toEqual(['   ']);
    });

    it('should read a size that is not a size as four', () => {
      expect(printed('\ta', { tabSize: Number.NaN, width: 10 })).toEqual(['    a']);
      expect(printed('\ta', { tabSize: 0, width: 10 })).toEqual(['    a']);
      expect(printed('\ta', { tabSize: 1, width: 10 })).toEqual([' a']);
    });
  });

  describe('highlighting', () => {
    it('should draw each token in its role, and the rest as the plain class', () => {
      const [row] = rowsOf(
        codeView('const a = 1;', { highlight: highlightCode, lang: 'ts', width: 40 })
      );
      const keyword = row?.find((run) => run.text === 'const');
      expect(keyword?.classes).toBe('sigil-code sigil-token sigil-token-keyword sigil-accent');
      expect(row?.find((run) => run.text.includes('1'))?.classes).toContain('sigil-token-number');
      expect(row?.find((run) => run.text === ' a = ')?.classes).toBe('sigil-code');
    });

    it('should hand the language to the highlighter, and the whole text once', () => {
      const calls: unknown[][] = [];
      codeView('a\nb', {
        highlight: (code, lang) => {
          calls.push([code, lang]);
          return [];
        },
        lang: 'sh',
        width: 10,
      });
      expect(calls).toEqual([['a\nb', 'sh']]);
    });

    it('should read a span over several lines as one token on each of them', () => {
      const rows = rowsOf(
        codeView('/* a\nb */', { highlight: highlightCode, lang: 'ts', width: 10 })
      );
      expect(rows.map((row) => row[0]?.classes)).toEqual([
        expect.stringContaining('sigil-token-comment'),
        expect.stringContaining('sigil-token-comment'),
      ]);
    });

    it('should put a span that starts on a later line on that line', () => {
      // an off-by-one in the offset of a line moves the token a column or a line
      const rows = rowsOf(
        codeView('ab\ncd\nef', {
          highlight: () => [{ end: 7, start: 4, token: 'string' }],
          width: 10,
        })
      );
      expect(
        rows.map((row) => row.map((run) => [run.text, run.classes.includes('string')]))
      ).toEqual([
        [['ab', false]],
        [
          ['c', false],
          ['d', true],
        ],
        [
          ['e', true],
          ['f', false],
        ],
      ]);
    });

    it('should draw a line of plain ASCII as one run, the same as the cluster walk does', () => {
      // a token array with nothing in it takes the walk, and a line with a
      // control character or a wide one takes it too
      const code = 'let a = 1;\n\n  x';
      const quick = codeView(code, { gutter: true, width: 20 });
      const walked = codeView(code, {
        gutter: true,
        tokens: Array.from({ length: code.length }),
        width: 20,
      });
      expect(rowsOf(quick)).toEqual(rowsOf(walked));
    });

    it('should leave a language it does not know plain', () => {
      const [row] = rowsOf(
        codeView('const a = 1;', { highlight: highlightCode, lang: 'cobol', width: 40 })
      );
      expect(row).toEqual([{ classes: 'sigil-code', text: 'const a = 1;' }]);
    });

    it('should read a token a caller already has, in place of a highlighter', () => {
      const [row] = rowsOf(codeView('ab', { tokens: ['number', undefined], width: 10 }));
      expect(row?.map((run) => run.text)).toEqual(['a', 'b']);
      expect(row?.[0]?.classes).toContain('sigil-token-number');
    });

    it('should clip a span out of range rather than refuse it', () => {
      const [row] = rowsOf(
        codeView('abcdef', {
          highlight: () => [
            { end: 2, start: -5, token: 'number' },
            { end: 200, start: 4, token: 'string' },
          ],
          width: 10,
        })
      );
      expect(row?.map((run) => run.text)).toEqual(['ab', 'cd', 'ef']);
    });

    it('should refuse a token no class can carry, and let a hook that throws throw', () => {
      expect(() =>
        codeView('a', { highlight: () => [{ end: 1, start: 0, token: 'a b' }], width: 10 })
      ).toThrow(PromptError);
      const boom = new Error('the grammar is missing');
      expect(() =>
        codeView('a', {
          highlight: () => {
            throw boom;
          },
          width: 10,
        })
      ).toThrow(boom);
    });

    it('should take the token of the code unit a cluster starts at', () => {
      // the emoji is two code units, so the keyword that follows it starts at 3
      const [row] = rowsOf(
        codeView('😀 const', {
          highlight: () => [{ end: 8, start: 3, token: 'keyword' }],
          width: 20,
        })
      );
      expect(row?.map((run) => run.text)).toEqual(['😀 ', 'const']);
    });

    it('should draw a role on a run with no token when asked to', () => {
      const [row] = rowsOf(codeView('a', { plain: 'sigil-accent', width: 10 }));
      expect(row).toEqual([{ classes: 'sigil-code sigil-accent', text: 'a' }]);
    });
  });

  describe('the tree', () => {
    it('should keep a row for an empty line', () => {
      const rows = rowsOf(codeView('a\n\nb', { width: 10 }));
      expect(rows).toHaveLength(3);
      expect(rows[1]).toEqual([{ classes: 'sigil-code', text: '' }]);
      expect(printed('a\n\nb', { width: 10 })).toEqual(['a', '', 'b']);
    });

    it('should be a column of rows named after the class, with props on the column', () => {
      const view = codeView('a', {
        class: 'mine',
        props: { class: 'mine-block', 'padding-left': 2 },
        width: 10,
      });
      expect(view.classes).toEqual(['mine-block']);
      expect(view.children[0]?.classes).toEqual(['mine-row']);
      expect(codeView('a', { width: 10 }).classes).toEqual(['sigil-code-view']);
    });

    it('should measure a control character as a text draws it, which is not at all', () => {
      const [row] = rowsOf(codeView('a\u0007b', { width: 2 }));
      expect(row?.map((run) => run.text).join('')).toBe('ab');
    });

    it('should floor a width, and read one under a column as one', () => {
      const shown = (width: number): string =>
        rowsOf(codeView('abc', { width }))[0]!
          .map((run) => run.text)
          .join('');
      expect(shown(2.9)).toBe('ab');
      expect(shown(0)).toBe('a');
      expect(shown(Number.NaN)).toBe('a');
    });

    it('should not change the text it was given', () => {
      const source = 'a\tb\nc';
      codeView(source, { gutter: true, width: 10 });
      expect(source).toBe('a\tb\nc');
    });
  });
});

describe('what a run is drawn as', () => {
  it('should keep its spaces, in a run and in a gutter', () => {
    const view = codeView('  a\n  b', { gutter: true, width: 20 });
    const row = view.children[0] as Element;
    expect(row.children[0]?.props['white-space']).toBe('pre');
    expect(row.children[1]?.props['white-space']).toBe('pre');
    expect(codeRun(' a', undefined).props['white-space']).toBe('pre');
  });
});

describe('codeRun()', () => {
  it('should draw a token in its role, after its classes, with a width of its own', () => {
    const run = codeRun('const', 'keyword', { class: 'mine' });
    expect(run.classes).toEqual(['mine', 'sigil-token', 'sigil-token-keyword', 'sigil-accent']);
    expect(run.text).toBe('const');
  });

  it('should let a caller put a role in place of the token', () => {
    const run = codeRun('const', 'keyword', { role: 'sigil-muted' });
    expect(run.classes).toEqual(['sigil-token', 'sigil-token-keyword', 'sigil-muted']);
  });

  it('should leave a token with no role as the plain foreground with its class', () => {
    expect(codeRun('x', 'binding').classes).toEqual(['sigil-token', 'sigil-token-binding']);
    expect(codeRun('x', undefined, { class: 'mine' }).classes).toEqual(['mine']);
  });
});
