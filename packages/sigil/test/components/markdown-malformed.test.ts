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

/** How much more a document eight times the size costs to read. */
function growth(make: (size: number) => string, size: number): number {
  const small = make(size);
  const large = make(size * 8);
  const time = (source: string): number => {
    const start = performance.now();
    parseMarkdown(source);
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
      for (const lead of ['- ', '#', '[^a]: ']) {
        expect(growth((n) => `${lead}${' '.repeat(n)}a${LINE_SEPARATOR}`, 2 * K)).toBeLessThan(24);
      }
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

    it('should return a document for footnote definitions nested two thousand deep', () => {
      const blocks = parseMarkdown(`${'[^a]: '.repeat(2000)}x\n\n[^a]`);
      expect(blocks.at(-1)?.type).to.equal('footnotes');
    });

    it('should still nest a dozen deep exactly as written', () => {
      expect(depthOf(parseMarkdown(`${'> '.repeat(12)}a`))).to.equal(12);
      expect(depthOf(parseMarkdown(`${'- '.repeat(12)}a`))).to.equal(12);
    });

    it('should draw the deepest document the parser reads', () => {
      // a little past the limit, so that every one is as deep as a document goes
      // and the paragraph left at the bottom is short enough to draw quickly
      for (const source of [
        `${'- '.repeat(110)}a`,
        `${'>'.repeat(110)}a`,
        `${'- > '.repeat(55)}x`,
        `${'1. '.repeat(110)}x`,
      ]) {
        expect(depthOf(parseMarkdown(source))).to.equal(100);
        expect(markdown(source, plain)).to.be.a('string');
      }
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
