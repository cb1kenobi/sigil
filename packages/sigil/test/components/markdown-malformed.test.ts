import {
  markdown,
  type MarkdownBlock,
  type MarkdownInline,
  markdownText,
  parseMarkdown,
} from '../../src/components/index.js';
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
 * Each side is the best of seven, and the two sides take turns, so that a garbage
 * collection or a busy core costs one sample of one side rather than every sample
 * of it. Taken one side after the other, best of three, `_*` read eight times
 * larger came out 27 times slower in the full suite, where on its own it is 3.5.
 * A side under two milliseconds counts as two, which is what the timer can say.
 */

/**
 * How much more a document eight times the size costs to read, or to do `work`
 * with: drawing, for the renderer's half (SIG-423).
 */
function growth(
  make: (size: number) => string,
  size: number,
  work: (source: string) => unknown = parseMarkdown
): number {
  return costRatio(make(size), make(size * 8), work);
}

/** How much more `large` costs than `small`, each the best of seven taken in turns. */
function costRatio(small: string, large: string, work: (source: string) => unknown): number {
  const time = (source: string): number => {
    const start = performance.now();
    work(source);
    return performance.now() - start;
  };
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let run = 0; run < 7; run++) {
    bestSmall = Math.min(bestSmall, time(small));
    bestLarge = Math.min(bestLarge, time(large));
  }
  return Math.max(bestLarge, 2) / Math.max(bestSmall, 2);
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

describe('parseMarkdown() on malformed input', () => {
  describe('a long run of spaces', () => {
    it('should read spaces before a line end in linear time, which was a backtracking pattern', () => {
      expect(growth((n) => `a${' '.repeat(n)}b\nc`, 16 * K)).toBeLessThan(24);
    });

    it('should read a heading with spaces in it in linear time', () => {
      expect(growth((n) => `# a${' '.repeat(n)}b`, 16 * K)).toBeLessThan(24);
    });

    it('should read a table delimiter row with spaces after it in linear time', () => {
      expect(growth((n) => `a|b\n---${' '.repeat(n)}x`, 8 * K)).toBeLessThan(24);
    });

    it('should read a line with a line separator after its spaces in linear time', () => {
      for (const lead of ['- ', '[^a]: ']) {
        expect(growth((n) => `${lead}${' '.repeat(n)}a${LINE_SEPARATOR}`, 2 * K)).toBeLessThan(24);
      }
      // the heading was cubic, and a synchronous parse cannot be timed out: at
      // 16 KB the old cost was hours, so a regression would hang the suite rather
      // than fail it. At 4 KB it is fifteen seconds a run, which still fails
      expect(growth((n) => `#${' '.repeat(n)}a${LINE_SEPARATOR}`, 512)).toBeLessThan(24);
      expect(growth((n) => `${'`'.repeat(n)}${LINE_SEPARATOR}`, 4 * K)).toBeLessThan(24);
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
      expect(growth((n) => '[]('.repeat(n / 3), 3 * K)).toBeLessThan(24);
      expect(growth((n) => '[a]('.repeat(n / 4), 4 * K)).toBeLessThan(24);
      expect(growth((n) => '![a]('.repeat(n / 5), 4 * K)).toBeLessThan(24);
      expect(growth((n) => '[a](b'.repeat(n / 5), 4 * K)).toBeLessThan(24);
    });

    it('should not scan to the end for every title that never closes', () => {
      expect(growth((n) => '[a](b ('.repeat(n / 7), 16 * K)).toBeLessThan(24);
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
      expect(growth((n) => ']'.repeat(n), 16 * K)).toBeLessThan(24);
      expect(growth((n) => ']('.repeat(n / 2), 10 * K)).toBeLessThan(24);
    });

    it('should not put out every earlier bracket once per link', () => {
      expect(growth((n) => '[a](b) '.repeat(n / 7), 16 * K)).toBeLessThan(24);
      expect(growth((n) => '[a](b)['.repeat(n / 7), 8 * K)).toBeLessThan(24);
    });

    it('should not normalize every label of nested brackets', () => {
      expect(growth((n) => '['.repeat(n / 2) + ']'.repeat(n / 2), 4 * K)).toBeLessThan(24);
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
      expect(growth((n) => '_*'.repeat(n / 2), 4 * K)).toBeLessThan(24);
      expect(growth((n) => '*a*_b_'.repeat(n / 6), 8 * K)).toBeLessThan(24);
      expect(growth((n) => 'a*'.repeat(n / 2), 8 * K)).toBeLessThan(24);
      expect(growth((n) => 'a~~'.repeat(n / 3), 8 * K)).toBeLessThan(24);
      expect(growth((n) => 'a_ b*'.repeat(n / 5), 4 * K)).toBeLessThan(24);
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

    it('should keep a third of a narrow document for the text, so a list three deep still indents', () => {
      // twenty columns is more than a narrow document has to give: at the
      // narrowest, ten, a third is three, and a list three deep keeps the four
      // columns it has always had there
      const drawn = markdown('- a\n  - b\n    - c d\n      - e', { ...glyphs, width: 10 });
      expect(drawn.split('\n')).to.deep.equal(['• a', '  ◦ b', '    ▪ c d', '      • e']);
    });

    it('should draw deep nesting in time linear in its depth, not in its square', () => {
      // a row measures a flexible child at the whole row's width and then at the
      // width it got, so the body inside each list item was measured at one more
      // width per level, and so was everything in it: at sixty a paragraph a
      // hundred deep took about 13ms to draw, and twelve deep about half of one.
      // Drawn at a width that indents every level, so this is the measure alone
      // and not the depth rule above
      const wide = { ...plain, width: 400 };
      const draw = (source: string): string => markdown(source, wide);
      expect(growth((depth) => `${'- '.repeat(depth)}a\n\n`.repeat(8), 12, draw)).toBeLessThan(24);
      expect(growth((depth) => `${'> '.repeat(depth)}a\n\n`.repeat(8), 12, draw)).toBeLessThan(24);
      expect(growth((depth) => `${'1. '.repeat(depth)}a\n\n`.repeat(8), 12, draw)).toBeLessThan(24);
    });

    it('should measure the words of a paragraph under deep quotes once, not once per quote', () => {
      // linear in its lines and always was, but every word was measured at one
      // more width per quote around it: the paragraph under 99 quotes cost about
      // forty times what it does unquoted. What is left is the bars, which are
      // drawn on every line, and is about two and a half
      const draw = (source: string): string => markdown(source, { ...plain, width: 400 });
      const lines = `a\n${'b\n'.repeat(2000)}`;
      expect(costRatio(lines, `${'> '.repeat(99)}${lines}`, draw)).toBeLessThan(10);
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
