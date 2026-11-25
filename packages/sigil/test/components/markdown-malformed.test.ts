import {
  markdown,
  type MarkdownBlock,
  type MarkdownOptions,
  type MarkdownInline,
  markdownText,
  markdownView,
  parseMarkdown,
} from '../../src/components/index.js';
import { type Element, renderToString } from '../../src/element/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { growthOf } from '../growth.js';
import { describe, expect, it } from 'vitest';

/**
 * Markdown the app did not write: model output, a fetched README, release notes
 * (SIG-362).
 *
 * Every shape here was quadratic or worse, or overflowed the stack. None of these
 * asserts a time. Linearity is pinned by reading one document and one eight times
 * its size and asking that the second cost less than twenty-four times the first,
 * where linear is eight and every one of these was sixty or more. The gap is wide
 * because the suite runs beside everything else on the machine. The larger size is
 * picked so that the old cost was hundreds of milliseconds at the least.
 *
 * The measurement is `growthOf()` in `test/growth.ts`, which the highlighter's
 * linear-time check shares (SIG-649): CPU time where the platform reports it, a
 * span of clock rather than a floor for the small side, and the best of seven with
 * the two sides taking turns, and more of them while the ratio is over {@link LIMIT}
 * (SIG-681): on a runner without a fine CPU clock a stall costs a long read its
 * whole wait, and `]` followed by `(`, repeated, read 25.07 on one. This file used to read the wall clock and count a
 * side under two milliseconds as two.
 *
 * The two tests that draw (SIG-423) count calls to an element's `measure` instead
 * (SIG-437): they are about how often the layout measures, which is a number and
 * not a duration, and a duration failed them once in a loaded full run.
 */

/**
 * How much of the clock the small side is read to fill, in milliseconds. The
 * highlighter reads documents of a few short lines and needs three; the smallest
 * document here is a few kilobytes and costs a good part of one on its own, and
 * the work is seven reads of each side, so the shared default would have made this
 * file do about two and a half times what it did before.
 */
const SPAN = 1;

/**
 * The ratio a read has to come in under, and what `growthOf()` samples towards:
 * it goes on reading past seven runs while the best is not under it (SIG-681), so
 * that a stall on a loaded runner is read again rather than failed. A ratio that
 * stays over it after that is the read's own.
 */
const LIMIT = 24;

/** How much more a document eight times the size costs to read. */
function growth(make: (size: number) => string, size: number): number {
  return growthOf(parseMarkdown, make(size), make(size * 8), 8, make(12).slice(0, 12), SPAN, LIMIT);
}

/**
 * A budget for every test in this file. What the linear-time ones assert is a
 * ratio, which no clock speed moves, so this is not a limit on how long linear
 * takes: it is the default's ten seconds made twelve times wider, so that a runner
 * that is slow for want of a core -- one of these tests timed out at ten on a
 * macOS runner (SIG-649), where the same run passed on Linux and Windows -- fails
 * on a quadratic and on nothing else. A synchronous parse cannot be timed out
 * anyway, so a quadratic bad enough to hang is not made worse by it.
 */
const BUDGET = 120_000;

/**
 * How much more measuring drawing `large` takes than drawing `small`: how many
 * times the layout asked an element for its size, rather than how long it took
 * (SIG-437).
 *
 * The layout calls an element's `measure` once for each width it measures it at,
 * so a draw that measures a deep document at one more width per level is a count
 * that grows with the square of the depth -- and the count is the same on a
 * loaded machine as on an idle one, which a clock is not: the two timing tests
 * this replaced each failed once in a full run. Every element's `measure` is
 * wrapped before the draw, and nothing else about the tree is touched.
 */
function measuringRatio(small: string, large: string, opts: MarkdownOptions): number {
  const count = (source: string): number => {
    const { element, width } = markdownView(source, opts);
    let calls = 0;
    const walk = (node: Element): void => {
      const measure = node.measure;
      if (measure) {
        node.measure = (at) => {
          calls++;
          return measure(at);
        };
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(element);
    renderToString(element, { cascade: themedCascade(opts), colorLevel: 0, width });
    return calls;
  };
  return count(large) / count(small);
}

/** How many containers deep a document goes. */
function depthOf(blocks: readonly MarkdownBlock[]): number {
  let deepest = 0;
  const walk = (list: readonly MarkdownBlock[], depth: number): void => {
    for (const block of list) {
      deepest = Math.max(deepest, depth);
      if (block.type === 'quote') {
        walk(block.children, depth + 1);
      } else if (block.type === 'list') {
        for (const item of block.items) {
          walk(item, depth + 1);
        }
      }
    }
  };
  walk(blocks, 0);
  return deepest;
}

/** The innermost blocks of a document that nests one block per level. */
function innermost(blocks: readonly MarkdownBlock[]): readonly MarkdownBlock[] {
  let at = blocks;
  for (;;) {
    const block = at[0];
    if (block?.type === 'quote') {
      at = block.children;
    } else if (block?.type === 'list') {
      at = block.items[0];
    } else {
      return at;
    }
  }
}

const plain = { colorLevel: 0, env: {}, hyperlinks: false, width: 60 } as const;

/** `plain`, with the box-drawing markers, which no source here writes. */
const glyphs = { ...plain, platform: 'linux' } as const;

/**
 * What a drawing says once its bullets, boxes and quote bars are taken out: its
 * words, one space between each. The bars are on every line of a quote, so they
 * fall between the words of a paragraph that wraps.
 */
function wordsOf(drawn: string): string {
  return drawn
    .split(/\s+/)
    .filter((it) => it !== '' && !/^[•◦▪│☐☒]$/u.test(it))
    .join(' ');
}
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const K = 1024;

describe('parseMarkdown() on malformed input', { timeout: BUDGET }, () => {
  describe('a long run of spaces', () => {
    it('should read spaces before a line end in linear time, which was a backtracking pattern', () => {
      expect(growth((n) => `a${' '.repeat(n)}b\nc`, 16 * K)).toBeLessThan(LIMIT);
    });

    it('should read a heading with spaces in it in linear time', () => {
      expect(growth((n) => `# a${' '.repeat(n)}b`, 16 * K)).toBeLessThan(LIMIT);
    });

    it('should read a table delimiter row with spaces after it in linear time', () => {
      expect(growth((n) => `a|b\n---${' '.repeat(n)}x`, 8 * K)).toBeLessThan(LIMIT);
    });

    it('should read a line with a line separator after its spaces in linear time', () => {
      for (const lead of ['- ', '[^a]: ']) {
        expect(growth((n) => `${lead}${' '.repeat(n)}a${LINE_SEPARATOR}`, 2 * K)).toBeLessThan(
          LIMIT
        );
      }
      // the heading was cubic, and a synchronous parse cannot be timed out: at
      // 16 KB the old cost was hours, so a regression would hang the suite rather
      // than fail it. At 4 KB it is fifteen seconds a run, which still fails
      expect(growth((n) => `#${' '.repeat(n)}a${LINE_SEPARATOR}`, 512)).toBeLessThan(LIMIT);
      expect(growth((n) => `${'`'.repeat(n)}${LINE_SEPARATOR}`, 4 * K)).toBeLessThan(LIMIT);
    });

    it('should still take a hard break from two spaces, and only from spaces', () => {
      const [hard] = parseMarkdown('a  \nb');
      expect(hard).to.deep.equal({
        children: [{ text: 'a', type: 'text' }, { type: 'break' }, { text: 'b', type: 'text' }],
        type: 'paragraph',
      });
      // a tab that arrived as an entity is kept, as it always was
      const [tab] = parseMarkdown('a&#9;\nb');
      expect(tab).to.deep.equal({ children: [{ text: 'a\t b', type: 'text' }], type: 'paragraph' });
    });

    it('should still take a closing run of `#` off only after a space', () => {
      const titles = ['# a ##', '# a#', '# ###', '# a ## #', '# C#   ', '#   '].map((source) => {
        const [block] = parseMarkdown(source);
        return block?.type === 'heading' ? markdownText(block.children) : undefined;
      });
      expect(titles).to.deep.equal(['a', 'a#', '', 'a ##', 'C#', '']);
    });

    it('should still read no heading from a line holding a line separator', () => {
      const [block] = parseMarkdown(`# a${LINE_SEPARATOR}b`);
      expect(block?.type).to.equal('paragraph');
    });
  });

  describe('a link that never closes', () => {
    it('should not scan to the end for every `](` whose parentheses never balance', () => {
      expect(growth((n) => '[]('.repeat(n / 3), 3 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => '[a]('.repeat(n / 4), 4 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => '![a]('.repeat(n / 5), 4 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => '[a](b'.repeat(n / 5), 4 * K)).toBeLessThan(LIMIT);
    });

    it('should not scan to the end for every title that never closes', () => {
      expect(growth((n) => '[a](b ('.repeat(n / 7), 16 * K)).toBeLessThan(LIMIT);
    });

    it('should read a destination nested 32 deep, and not one nested 33 deep, as cmark does', () => {
      const link = (depth: number): MarkdownInline | undefined => {
        const [block] = parseMarkdown(`[x](a${'('.repeat(depth)}b${')'.repeat(depth)})`);
        return block?.type === 'paragraph' ? block.children[0] : undefined;
      };
      expect(link(32)).to.include({ href: `a${'('.repeat(32)}b${')'.repeat(32)}`, type: 'link' });
      expect(link(33)?.type).to.equal('text');
    });

    it('should still read a long destination whole, which a length limit would refuse', () => {
      const href = `data:image/png;base64,${'A'.repeat(64 * K)}`;
      const [block] = parseMarkdown(`![a](${href})`);
      expect(block?.type === 'paragraph' && block.children[0]).to.include({ src: href });
    });
  });

  describe('a `]`', () => {
    it('should not walk back over every token for a `]` with no `[`', () => {
      expect(growth((n) => ']'.repeat(n), 16 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => ']('.repeat(n / 2), 10 * K)).toBeLessThan(LIMIT);
    });

    it('should not put out every earlier bracket once per link', () => {
      expect(growth((n) => '[a](b) '.repeat(n / 7), 16 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => '[a](b)['.repeat(n / 7), 8 * K)).toBeLessThan(LIMIT);
    });

    it('should not normalize every label of nested brackets', () => {
      expect(growth((n) => '['.repeat(n / 2) + ']'.repeat(n / 2), 4 * K)).toBeLessThan(LIMIT);
    });

    it('should still read a bracket opened after an image that held a link as a link', () => {
      const [block] = parseMarkdown('![x [a](u)](i)[b](v)');
      expect(block?.type === 'paragraph' && block.children.map((it) => it.type)).to.deep.equal([
        'image',
        'link',
      ]);
    });

    it('should still read a shortcut reference whose label collapses to a definition', () => {
      const [block] = parseMarkdown(`[a${' '.repeat(3000)}b]\n\n[a b]: /u`);
      expect(block?.type === 'paragraph' && block.children[0]).to.include({
        href: '/u',
        type: 'link',
      });
    });
  });

  describe('emphasis', () => {
    it('should match mixed delimiter runs in linear time', () => {
      expect(growth((n) => '_*'.repeat(n / 2), 4 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => '*a*_b_'.repeat(n / 6), 8 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => 'a*'.repeat(n / 2), 8 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => 'a~~'.repeat(n / 3), 8 * K)).toBeLessThan(LIMIT);
      expect(growth((n) => 'a_ b*'.repeat(n / 5), 4 * K)).toBeLessThan(LIMIT);
    });
  });

  describe('deep nesting', () => {
    it('should return a document for list markers sixteen hundred deep, not a RangeError', () => {
      const blocks = parseMarkdown(`${'- '.repeat(1600)}a`);
      expect(depthOf(blocks)).to.equal(100);
      const [rest] = innermost(blocks);
      expect(rest?.type === 'paragraph' && markdownText(rest.children)).to.equal(
        `${'- '.repeat(1500)}a`
      );
    });

    it('should return a document for `>` twenty-five hundred deep', () => {
      const blocks = parseMarkdown(`${'>'.repeat(2500)}a`);
      expect(depthOf(blocks)).to.equal(100);
      const [rest] = innermost(blocks);
      expect(rest?.type === 'paragraph' && markdownText(rest.children)).to.equal(
        `${'>'.repeat(2400)}a`
      );
    });

    it('should return a document for `* ` two thousand deep, and quotes and lists mixed', () => {
      expect(depthOf(parseMarkdown(`${'* '.repeat(2000)}x`))).to.equal(100);
      expect(depthOf(parseMarkdown(`${'- > '.repeat(2000)}x`))).to.equal(100);
      expect(depthOf(parseMarkdown(`${'1. '.repeat(2000)}x`))).to.equal(100);
    });

    it('should return a document for footnote definitions nested ten thousand deep', () => {
      // the parser this replaced ran out of stack between two and five thousand
      const blocks = parseMarkdown(`${'[^a]: '.repeat(10000)}x\n\n[^a]`);
      const notes = blocks.at(-1);
      expect(notes?.type === 'footnotes' && notes.notes.length).to.equal(1);
      // the innermost note opened is the one kept, since the first definition of
      // a label wins and it is the first to finish; what it holds is the line past
      // the limit, a paragraph whose every `[^a]` refers to the note itself
      const [inside] = notes?.type === 'footnotes' ? notes.notes[0].children : [];
      expect(inside?.type === 'paragraph' && markdownText(inside.children)).to.equal(
        `${'[1]: '.repeat(9900)}x`
      );
    });

    it('should still nest a dozen deep exactly as written', () => {
      expect(depthOf(parseMarkdown(`${'> '.repeat(12)}a`))).to.equal(12);
      expect(depthOf(parseMarkdown(`${'- '.repeat(12)}a`))).to.equal(12);
    });

    it('should draw the deepest document the parser reads, down to its innermost words', () => {
      // a little past the limit, so that every one is as deep as a document goes.
      // Each level takes two or three columns, so a hundred of them leave no room
      // for words at sixty: drawn at four hundred, the innermost paragraph -- the
      // markers past the limit, as written -- has to come out at the end of the line
      for (const [source, rest] of [
        [`${'- '.repeat(110)}a`, `${'- '.repeat(10)}a`],
        [`${'>'.repeat(110)}a`, `${'>'.repeat(10)}a`],
        [`${'- > '.repeat(55)}x`, `${'- > '.repeat(5)}x`],
        [`${'1. '.repeat(110)}x`, `${'1. '.repeat(10)}x`],
      ]) {
        expect(depthOf(parseMarkdown(source))).to.equal(100);
        const drawn = markdown(source, { ...plain, width: 400 }).split('\n');
        expect(drawn).to.have.length(1);
        expect(drawn[0].trimEnd().endsWith(rest)).to.equal(true);
        // and at sixty, where a hundred levels cannot all be indented, the same
        // words are the last thing drawn: they used to be the one thing that was
        // not (SIG-423)
        expect(wordsOf(markdown(source, glyphs)).endsWith(rest)).to.equal(true);
      }
    });

    it('should draw the words of a list nested deeper than the width can indent, which it dropped', () => {
      // each level of list took two or three columns of the room inside it, so
      // at sixty a list past about 29 levels drew its bullets and none of its
      // words, with nothing to say they were gone (SIG-423)
      const words = 'alpha bravo charlie delta echo foxtrot golf';
      for (const depth of [20, 30, 50, 100]) {
        for (const marker of ['- ', '1. ', '- [ ] ', '1. [x] ', '- > ']) {
          const source = `${marker.repeat(depth)}${words}`;
          const drawn = markdown(source, glyphs);
          expect(wordsOf(drawn).endsWith(words), `${depth} of '${marker}'`).to.equal(true);
          // and in room for more than a word a line
          expect(drawn, `${depth} of '${marker}'`).to.include('alpha bravo');
        }
      }
    });

    it('should draw the words of a quote nested deeper than the width can indent', () => {
      const words = 'alpha bravo charlie delta echo foxtrot golf';
      for (const depth of [20, 30, 50, 100]) {
        const drawn = markdown(`${'> '.repeat(depth)}${words}`, glyphs);
        expect(wordsOf(drawn).endsWith(words), `${depth}`).to.equal(true);
        expect(drawn, `${depth}`).to.include('alpha bravo');
      }
    });

    it('should stop indenting where the text would have less than twenty columns', () => {
      // twenty levels of list take forty columns, which leaves the twentieth
      // level's words twenty; the twenty-first lines up with the twentieth's
      // words rather than indenting past them, and so does every level after it
      const source = Array.from(
        { length: 23 },
        (_, level) => `${'  '.repeat(level)}- level ${level + 1}`
      ).join('\n');
      const drawn = markdown(source, glyphs).split('\n');
      expect(drawn.slice(18)).to.deep.equal([
        `${' '.repeat(36)}• level 19`,
        `${' '.repeat(38)}◦ level 20`,
        `${' '.repeat(40)}▪ level 21`,
        `${' '.repeat(40)}• level 22`,
        `${' '.repeat(40)}◦ level 23`,
      ]);
    });

    it('should keep what comes before a nested list beside the marker, past where indenting stops', () => {
      // the twenty-first level cannot indent: its paragraphs stay beside the
      // marker, and the list inside it goes under the marker rather than beside,
      // where it would have indented again. An empty item is its marker alone,
      // with no blank line under it that a loose list would put above a block
      const pad = '  '.repeat(21);
      const source = [
        `${'- '.repeat(21)}one`,
        '',
        `${pad}two, a second paragraph`,
        '',
        `${pad}-`,
        '',
        `${pad}- three`,
      ].join('\n');
      expect(markdown(source, glyphs).split('\n')).to.deep.equal([
        `${'• ◦ ▪ '.repeat(7)}one`,
        '',
        `${' '.repeat(42)}two, a second`,
        `${' '.repeat(42)}paragraph`,
        '',
        `${' '.repeat(40)}•`,
        '',
        `${' '.repeat(40)}• three`,
      ]);
    });

    it('should put the words of an item under its marker where there is no room beside it', () => {
      // three levels leave four columns at the narrowest width, and a marker
      // `10.` takes all four: beside it the words had none, and were not drawn
      const items = Array.from({ length: 10 }, (_, i) => `      ${i + 1}. w${i + 1}`);
      const drawn = markdown(['- a', '  - b', '    - c', ...items].join('\n'), {
        ...glyphs,
        width: 10,
      }).split('\n');
      expect(drawn.slice(3, 7)).to.deep.equal(['       1.', '      w1', '       2.', '      w2']);
      expect(drawn.slice(-2)).to.deep.equal(['      10.', '      w10']);
    });

    it('should draw a block too wide for the room beside a marker under it, not off the grid', () => {
      // six levels leave two columns beside the innermost marker at ten, twelve
      // and fourteen columns. A paragraph wraps into two, but a code block is two
      // columns in and a table needs a column each and the gap: beside the marker
      // they were drawn past the edge, and the bullet was all that was on screen
      const blocks = {
        code: ['```', 'secret', '```'],
        table: ['| a | b |', '| - | - |', '| x | y |'],
      };
      for (const width of [10, 12, 14]) {
        for (const [kind, lines] of Object.entries(blocks)) {
          const levels = Array.from({ length: 5 }, (_, i) => `${'  '.repeat(i)}- l${i + 1}`);
          const block = lines.map((line, i) => (i === 0 ? '- ' : '  ') + line);
          const source = [...levels, ...block.map((line) => `${'  '.repeat(5)}${line}`)];
          const drawn = markdown(source.join('\n'), { ...glyphs, width }).split('\n');
          const label = `${kind} at ${width}`;
          expect(Math.max(...drawn.map((line) => line.trimEnd().length)), label).to.be.at.most(
            width
          );
          if (kind === 'code') {
            expect(drawn.join('').replaceAll(/\s/g, ''), label).to.include('secret');
          } else {
            expect(
              drawn.map((line) => line.trim()),
              label
            ).to.include.members(['a  b', 'x  y']);
          }
        }
      }
    });

    it('should draw the code under an ASCII task box, which takes three columns', () => {
      // `[ ]` is three columns where a bullet is one, so a task list runs out of
      // room a level sooner: the code after an item's words went beside them, in
      // two columns, and was drawn off the grid
      for (const width of [10, 12, 14]) {
        const source = '- [ ] a\n  - [ ] b\n    - [ ] c\n      ```\n      secret\n      ```\n';
        const drawn = markdown(source, { ...plain, platform: 'win32', width }).split('\n');
        expect(Math.max(...drawn.map((line) => line.trimEnd().length))).to.be.at.most(width);
        expect(drawn.join('').replaceAll(/\s/g, ''), `at ${width}`).to.include('secret');
      }
    });

    it('should keep four columns of a narrow document for the text, so a list three deep still indents', () => {
      // twenty columns is more than a narrow document has to give: at the
      // narrowest, ten, a list three deep keeps the four columns it has always
      // had there. The fourth level stops indenting, and its one-letter word is
      // the one kind of block that two columns beside the marker can draw
      const drawn = markdown('- a\n  - b\n    - c d\n      - e', { ...glyphs, width: 10 });
      expect(drawn.split('\n')).to.deep.equal(['• a', '  ◦ b', '    ▪ c d', '      • e']);
      // and never fewer than four, which a table of two columns needs: a third
      // of ten is three, and a list that left three indented a table into them
      const table = ['- a', '  1. b', '     - c', '', '       | a | b |', '       | - | - |'];
      expect(markdown(table.join('\n'), { ...glyphs, width: 10 }).split('\n')).to.deep.equal([
        '• a',
        '  1. b',
        '     ▪ c',
        '',
        '     a  b',
        '     ─  ─',
      ]);
    });

    it('should draw deep nesting in measuring linear in its depth, not in its square', () => {
      // a row measures a flexible child at the whole row's width and then at the
      // width it got, so the body inside each list item was measured at one more
      // width per level, and so was everything in it: at sixty a paragraph a
      // hundred deep took about 13ms to draw, and twelve deep about half of one.
      // Drawn at a width that indents every level, so this is the measure alone
      // and not the depth rule above
      const wide = { ...plain, width: 400 };
      // eight times the depth is about 6 times the measuring, where the square of
      // it is 64: the old row came to 50
      for (const marker of ['- ', '> ', '1. ']) {
        const at = (depth: number): string => `${marker.repeat(depth)}a\n\n`.repeat(8);
        expect(measuringRatio(at(12), at(96), wide), JSON.stringify(marker)).toBeLessThan(12);
      }
    });

    it('should measure the words of a paragraph under deep quotes once, not once per quote', () => {
      // linear in its lines and always was, but every word was measured at one
      // more width per quote around it: the paragraph under 99 quotes cost about
      // forty times what it does unquoted. What is left is the bars, which are
      // drawn on every line and measure nothing: the count came to 1.01 times
      const lines = `a\n${'b\n'.repeat(2000)}`;
      expect(
        measuringRatio(lines, `${'> '.repeat(99)}${lines}`, { ...plain, width: 400 })
      ).toBeLessThan(2);
    });

    it('should read a footnote definition at the limit as text, not as a link definition', () => {
      // `[^n]: url` is also a link definition of the label `^n`, so where the
      // footnote was not opened it took the line away and made every `[^n]` a link
      const blocks = parseMarkdown(`${'> '.repeat(100)}[^n]: https://example.com\n\nsee [^n]`);
      const [rest] = innermost(blocks);
      expect(rest?.type === 'paragraph' && markdownText(rest.children)).to.equal(
        '[^n]: https://example.com'
      );
      expect(blocks[1]).to.deep.equal({
        children: [{ text: 'see [^n]', type: 'text' }],
        type: 'paragraph',
      });
      // one level less, it is the footnote it always was
      const shallow = parseMarkdown(`${'> '.repeat(99)}[^n]: https://example.com\n\nsee [^n]`);
      expect(shallow.at(-1)?.type).to.equal('footnotes');
    });

    it('should read and draw emphasis ten thousand deep, which nothing bounds', () => {
      const source = `${'*'.repeat(20000)}a${'*'.repeat(20000)}`;
      const [block] = parseMarkdown(source);
      expect(block?.type === 'paragraph' && markdownText(block.children)).to.equal('a');
      expect(markdown(source, plain)).to.equal('a');
      const [image] = parseMarkdown(`![${source}](i)`);
      expect(image?.type === 'paragraph' && image.children[0]).to.include({ alt: 'a' });
    });
  });
});
