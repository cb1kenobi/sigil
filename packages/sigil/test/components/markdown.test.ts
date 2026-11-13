import { strip } from '../../src/ansi/index.js';
import {
  diff,
  type HighlightSpan,
  markdown,
  type MarkdownBlock,
  type MarkdownOptions,
  markdownText,
  markdownView,
  parseMarkdown,
} from '../../src/components/index.js';
import { type Element, renderToString } from '../../src/element/index.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Markdown: the subset, read; and the document, drawn.
 *
 * The drawing is pinned at a fixed width with an empty environment, so neither
 * the terminal the suite runs in nor its `TERM` decides a character, and at
 * colour level 0 unless a test is about the colour.
 */

const ESC = String.fromCharCode(0x1b);
const osc8 = (url: string): string => `${ESC}]8;;${url}${ESC}\\`;

/** A document drawn plainly, at a width. */
function draw(source: string | readonly MarkdownBlock[], opts: MarkdownOptions = {}): string {
  return markdown(source, {
    colorLevel: 0,
    env: {},
    hyperlinks: false,
    platform: 'linux',
    width: 40,
    ...opts,
  });
}

/** The first block of a document. */
function first(source: string): MarkdownBlock {
  return parseMarkdown(source)[0];
}

/** The inline runs of a one-paragraph document. */
function runs(source: string): unknown {
  const block = first(source);
  return block.type === 'paragraph' ? block.children : block;
}

describe('parseMarkdown()', () => {
  describe('headings', () => {
    it.each([1, 2, 3, 4, 5, 6])('should read an ATX heading of level %i', (level) => {
      expect(first(`${'#'.repeat(level)} Title`)).to.deep.equal({
        children: [{ text: 'Title', type: 'text' }],
        level,
        type: 'heading',
      });
    });

    it('should take a closing run of # off, but not one inside a word', () => {
      expect(first('## Title ##')).to.deep.include({ level: 2 });
      expect(first('## Title ##').type === 'heading' && first('## Title ##')).to.deep.include({
        children: [{ text: 'Title', type: 'text' }],
      });
      expect(first('# C#')).to.deep.include({ children: [{ text: 'C#', type: 'text' }] });
    });

    it('should not read a # with no space after it as a heading', () => {
      expect(first('#hashtag').type).to.equal('paragraph');
      expect(first('####### seven').type).to.equal('paragraph');
    });

    it('should read a setext heading', () => {
      expect(parseMarkdown('Title\n=====\n\nSub\n---')).to.deep.equal([
        { children: [{ text: 'Title', type: 'text' }], level: 1, type: 'heading' },
        { children: [{ text: 'Sub', type: 'text' }], level: 2, type: 'heading' },
      ]);
    });
  });

  describe('paragraphs', () => {
    it('should join the lines of a paragraph with a space', () => {
      expect(runs('one\ntwo')).to.deep.equal([{ text: 'one two', type: 'text' }]);
    });

    it('should break a line that ends in two spaces or a backslash', () => {
      expect(runs('one  \ntwo\\\nthree')).to.deep.equal([
        { text: 'one', type: 'text' },
        { type: 'break' },
        { text: 'two', type: 'text' },
        { type: 'break' },
        { text: 'three', type: 'text' },
      ]);
    });

    it('should end a paragraph at a blank line', () => {
      expect(parseMarkdown('one\n\ntwo')).to.have.length(2);
    });
  });

  describe('emphasis', () => {
    it('should read emphasis and strong emphasis, nested', () => {
      expect(runs('*a **b** c*')).to.deep.equal([
        {
          children: [
            { text: 'a ', type: 'text' },
            { children: [{ text: 'b', type: 'text' }], type: 'strong' },
            { text: ' c', type: 'text' },
          ],
          type: 'emphasis',
        },
      ]);
    });

    it('should read three delimiters as both', () => {
      expect(runs('***both***')).to.deep.equal([
        {
          children: [{ children: [{ text: 'both', type: 'text' }], type: 'strong' }],
          type: 'emphasis',
        },
      ]);
    });

    it('should read underscores as emphasis, but not inside a word', () => {
      expect(runs('_yes_ and snake_case_name')).to.deep.equal([
        { children: [{ text: 'yes', type: 'text' }], type: 'emphasis' },
        { text: ' and snake_case_name', type: 'text' },
      ]);
    });

    it('should read an asterisk inside a word as emphasis', () => {
      expect(runs('un**frigging**believable')).to.deep.equal([
        { text: 'un', type: 'text' },
        { children: [{ text: 'frigging', type: 'text' }], type: 'strong' },
        { text: 'believable', type: 'text' },
      ]);
    });

    it('should leave unterminated emphasis as the characters it was', () => {
      expect(runs('*open and **also open')).to.deep.equal([
        { text: '*open and **also open', type: 'text' },
      ]);
    });

    it('should leave a delimiter with white space on both sides alone', () => {
      expect(runs('a * b * c')).to.deep.equal([{ text: 'a * b * c', type: 'text' }]);
    });

    // the rule of three: without it the ** in the middle would close the first *
    it('should not close emphasis in the middle of a strong run', () => {
      expect(runs('*foo**bar*')).to.deep.equal([
        { children: [{ text: 'foo**bar', type: 'text' }], type: 'emphasis' },
      ]);
    });

    it('should not be slow over a long run of unmatched delimiters', () => {
      const started = performance.now();
      parseMarkdown('*a '.repeat(5000));
      expect(performance.now() - started).to.be.lessThan(2000);
    });
  });

  describe('code', () => {
    it('should read a code span', () => {
      expect(runs('run `npm test` now')).to.deep.equal([
        { text: 'run ', type: 'text' },
        { text: 'npm test', type: 'code' },
        { text: ' now', type: 'text' },
      ]);
    });

    it('should keep a backtick inside a span opened by two', () => {
      expect(runs('`` a ` b ``')).to.deep.equal([{ text: 'a ` b', type: 'code' }]);
    });

    it('should read nothing inside a code span', () => {
      expect(runs('`*not* [a](link)`')).to.deep.equal([{ text: '*not* [a](link)', type: 'code' }]);
    });

    it('should leave an unterminated backtick as a backtick', () => {
      expect(runs('a `b')).to.deep.equal([{ text: 'a `b', type: 'text' }]);
    });

    it('should read a fenced block and the language it names', () => {
      expect(first('```js title="x"\nconst a = 1;\n\nb();\n```')).to.deep.equal({
        info: 'js',
        text: 'const a = 1;\n\nb();',
        type: 'code',
      });
      expect(first('~~~\n```\n~~~')).to.deep.equal({ info: '', text: '```', type: 'code' });
    });

    it('should run an unterminated fence to the end', () => {
      expect(parseMarkdown('```\na\n\n# not a heading')).to.deep.equal([
        { info: '', text: 'a\n\n# not a heading', type: 'code' },
      ]);
    });

    it('should read an indented block', () => {
      expect(parseMarkdown('    one\n      two\n\nafter')[0]).to.deep.equal({
        info: '',
        text: 'one\n  two',
        type: 'code',
      });
    });

    it('should expand a tab to the next stop of four', () => {
      expect(first('\tcode')).to.deep.equal({ info: '', text: 'code', type: 'code' });
    });
  });

  describe('lists', () => {
    it('should read a bulleted list', () => {
      expect(first('- one\n- two')).to.deep.equal({
        items: [
          [{ children: [{ text: 'one', type: 'text' }], type: 'paragraph' }],
          [{ children: [{ text: 'two', type: 'text' }], type: 'paragraph' }],
        ],
        ordered: false,
        start: 1,
        tight: true,
        type: 'list',
      });
    });

    it('should read a numbered list and where it starts', () => {
      expect(first('3. three\n4. four')).to.deep.include({ ordered: true, start: 3 });
    });

    it('should nest a list indented under an item', () => {
      const list = first('- a\n  - b\n    - c\n- d');
      expect(list.type === 'list' && list.items.length).to.equal(2);
      const nested = list.type === 'list' ? list.items[0][1] : undefined;
      expect(nested?.type).to.equal('list');
      const deeper = nested?.type === 'list' ? nested.items[0][1] : undefined;
      expect(deeper?.type).to.equal('list');
    });

    it('should carry an item on to a line that is not indented', () => {
      expect(first('- one\ntwo')).to.deep.include({
        items: [[{ children: [{ text: 'one two', type: 'text' }], type: 'paragraph' }]],
      });
    });

    it('should be loose where a blank line sits between items', () => {
      expect(first('- a\n\n- b')).to.deep.include({ tight: false });
      expect(first('- a\n- b')).to.deep.include({ tight: true });
    });

    it('should be loose where a blank line sits between the blocks of an item', () => {
      expect(first('- a\n\n  more\n- b')).to.deep.include({ tight: false });
    });

    // the nested list consumes its own blank lines, so they say nothing about
    // the list around it
    it('should not be loosened by a blank line inside a nested list', () => {
      const list = first('- a\n  - b\n\n  - c\n- d');
      expect(list).to.deep.include({ tight: true });
      expect(list.type === 'list' && list.items[0][1]).to.deep.include({ tight: false });
    });

    it('should start a new list at a different bullet', () => {
      expect(parseMarkdown('- a\n* b').map((block) => block.type)).to.deep.equal(['list', 'list']);
    });

    // CommonMark's rule, so a sentence that wraps onto a line starting with a
    // year is not a list
    it('should not let a number other than one interrupt a paragraph', () => {
      expect(parseMarkdown('In\n2015. was a year').map((block) => block.type)).to.deep.equal([
        'paragraph',
      ]);
      expect(parseMarkdown('In\n1. first').map((block) => block.type)).to.deep.equal([
        'paragraph',
        'list',
      ]);
    });
  });

  describe('task lists', () => {
    const para = (text: string): MarkdownBlock => ({
      children: [{ text, type: 'text' }],
      type: 'paragraph',
    });

    it('should read a box at the start of an item, and take it off the text', () => {
      expect(first('- [ ] todo\n- [x] done\n- [X] also')).to.deep.include({
        checked: [false, true, true],
        items: [[para('todo')], [para('done')], [para('also')]],
      });
    });

    it('should say which items of a mixed list are not tasks', () => {
      expect(first('1. [x] one\n2. two')).to.deep.include({
        checked: [true, undefined],
        items: [[para('one')], [para('two')]],
      });
    });

    it('should leave a list with no task in it as it was', () => {
      expect(first('- a\n- b')).not.to.have.property('checked');
    });

    it.each([
      ['in the middle of an item', '- a [x] b', '- a [x] b'],
      ['with nothing after it', '- [x]', '- [x]'],
      ['with no space after it', '- [x]b', '- [x]b'],
      ['escaped', '- \\[x] b', '- [x] b'],
      ['another character in it', '- [-] b', '- [-] b'],
    ])('should not read a box %s', (_, source, shown) => {
      const block = first(source);
      expect(block).not.to.have.property('checked');
      expect(block.type === 'list' && block.items[0]).to.deep.equal([para(shown.slice(2))]);
    });

    it('should not read a box outside a list', () => {
      expect(first('[x] not a task')).to.deep.equal(para('[x] not a task'));
    });

    it('should not read a box at the start of anything but the first paragraph', () => {
      expect(first('- # [x] heading')).not.to.have.property('checked');
      expect(first('- > [x] quote')).not.to.have.property('checked');
      expect(first('- a\n\n  [x] second paragraph')).not.to.have.property('checked');
    });

    it('should take a box before a link of the same label', () => {
      const block = first('- [x] done\n\n[x]: https://x');
      expect(block).to.deep.include({ checked: [true], items: [[para('done')]] });
    });
  });

  describe('block quotes', () => {
    it('should read what a quote holds as blocks', () => {
      expect(first('> # Title\n>\n> - item')).to.deep.equal({
        children: [
          { children: [{ text: 'Title', type: 'text' }], level: 1, type: 'heading' },
          {
            items: [[{ children: [{ text: 'item', type: 'text' }], type: 'paragraph' }]],
            ordered: false,
            start: 1,
            tight: true,
            type: 'list',
          },
        ],
        type: 'quote',
      });
    });

    it('should carry a quoted paragraph on to a line with no marker', () => {
      expect(first('> one\ntwo')).to.deep.equal({
        children: [{ children: [{ text: 'one two', type: 'text' }], type: 'paragraph' }],
        type: 'quote',
      });
    });

    it('should nest', () => {
      const outer = first('> > inner');
      expect(outer.type === 'quote' && outer.children[0].type).to.equal('quote');
    });
  });

  describe('tables', () => {
    it('should read a header, the alignments and the rows', () => {
      expect(
        first('| a | b | c | d |\n| --- | :-- | --: | :-: |\n| 1 | 2 | 3 | 4 |')
      ).to.deep.equal({
        align: [undefined, 'left', 'right', 'center'],
        head: ['a', 'b', 'c', 'd'].map((text) => [{ text, type: 'text' }]),
        rows: [['1', '2', '3', '4'].map((text) => [{ text, type: 'text' }])],
        type: 'table',
      });
    });

    // GFM's rule, and the one `sigil reference` writes its tables for
    it('should read an escaped bar as a bar, inside a code span too', () => {
      const table = first('| flag |\n| --- |\n| `--lint [a\\|b]` |');
      expect(table.type === 'table' && table.rows[0][0]).to.deep.equal([
        { text: '--lint [a|b]', type: 'code' },
      ]);
    });

    it('should fill a short row and drop what a long one has past the header', () => {
      const table = first('a | b\n--|--\n1\n1 | 2 | 3');
      expect(table.type === 'table' && table.rows).to.deep.equal([
        [[{ text: '1', type: 'text' }], []],
        [[{ text: '1', type: 'text' }], [{ text: '2', type: 'text' }]],
      ]);
    });

    it('should not be a table where the delimiter row has a different number of cells', () => {
      expect(parseMarkdown('a | b\n---').map((block) => block.type)).to.deep.equal(['heading']);
    });

    it('should end at a blank line', () => {
      expect(
        parseMarkdown('| a |\n| - |\n| 1 |\n\nafter').map((block) => block.type)
      ).to.deep.equal(['table', 'paragraph']);
    });
  });

  describe('links', () => {
    it('should read an inline link and its title', () => {
      expect(runs('[the docs](https://example.com "Docs")')).to.deep.equal([
        {
          children: [{ text: 'the docs', type: 'text' }],
          href: 'https://example.com',
          title: 'Docs',
          type: 'link',
        },
      ]);
    });

    it('should read a destination in angle brackets, and one with parentheses in it', () => {
      expect(runs('[a](<with space>) [b](https://x/(y))')).to.deep.equal([
        { children: [{ text: 'a', type: 'text' }], href: 'with space', type: 'link' },
        { text: ' ', type: 'text' },
        { children: [{ text: 'b', type: 'text' }], href: 'https://x/(y)', type: 'link' },
      ]);
    });

    it('should read the three kinds of reference link', () => {
      expect(runs('[a][ref], [ref][] and [REF]\n\n[ref]: https://ref.example')).to.deep.equal([
        { children: [{ text: 'a', type: 'text' }], href: 'https://ref.example', type: 'link' },
        { text: ', ', type: 'text' },
        { children: [{ text: 'ref', type: 'text' }], href: 'https://ref.example', type: 'link' },
        { text: ' and ', type: 'text' },
        { children: [{ text: 'REF', type: 'text' }], href: 'https://ref.example', type: 'link' },
      ]);
    });

    it('should take the first definition of a label', () => {
      expect(runs('[a]\n\n[a]: https://one\n[a]: https://two')).to.deep.equal([
        { children: [{ text: 'a', type: 'text' }], href: 'https://one', type: 'link' },
      ]);
    });

    it('should leave a reference to nothing as its brackets', () => {
      expect(runs('[not defined] and [a](')).to.deep.equal([
        { text: '[not defined] and [a](', type: 'text' },
      ]);
    });

    it('should read an autolink and an email autolink', () => {
      expect(runs('<https://example.com> <me@example.com>')).to.deep.equal([
        {
          children: [{ text: 'https://example.com', type: 'text' }],
          href: 'https://example.com',
          type: 'link',
        },
        { text: ' ', type: 'text' },
        {
          children: [{ text: 'me@example.com', type: 'text' }],
          href: 'mailto:me@example.com',
          type: 'link',
        },
      ]);
    });

    it('should not put a link inside a link', () => {
      expect(runs('[a [b](https://b) c](https://a)')).to.deep.equal([
        { text: '[a ', type: 'text' },
        { children: [{ text: 'b', type: 'text' }], href: 'https://b', type: 'link' },
        { text: ' c](https://a)', type: 'text' },
      ]);
    });

    it('should read emphasis inside a link', () => {
      expect(runs('[*a*](https://a)')).to.deep.equal([
        {
          children: [{ children: [{ text: 'a', type: 'text' }], type: 'emphasis' }],
          href: 'https://a',
          type: 'link',
        },
      ]);
    });

    it('should read an image and its description, inside a link too', () => {
      expect(runs('[![npm *version*](https://badge.svg)](https://npm)')).to.deep.equal([
        {
          children: [{ alt: 'npm version', src: 'https://badge.svg', type: 'image' }],
          href: 'https://npm',
          type: 'link',
        },
      ]);
    });
  });

  describe('strikethrough', () => {
    const struck = (text: string) => ({
      children: [{ text, type: 'text' }],
      type: 'strikethrough',
    });

    it('should read a run between two pairs of tildes', () => {
      expect(runs('a ~~gone~~ b')).to.deep.equal([
        { text: 'a ', type: 'text' },
        struck('gone'),
        { text: ' b', type: 'text' },
      ]);
    });

    it('should read emphasis inside it, and it inside emphasis', () => {
      expect(runs('~~**a**~~ *~~b~~*')).to.deep.equal([
        {
          children: [{ children: [{ text: 'a', type: 'text' }], type: 'strong' }],
          type: 'strikethrough',
        },
        { text: ' ', type: 'text' },
        { children: [struck('b')], type: 'emphasis' },
      ]);
    });

    // GitHub takes one tilde as well; in what a CLI prints, one is "about" or a
    // home directory, and two of them in a paragraph would strike everything between
    it.each(['~one~', 'about ~5s, or ~/.config and ~/.cache', 'a ~~~three~~~', '~~a~', 'a~~'])(
      'should leave %j as the text it is',
      (source) => {
        expect(runs(source)).to.deep.equal([{ text: source, type: 'text' }]);
      }
    );

    it('should follow the flanking rules emphasis does', () => {
      expect(runs('~~ a ~~')).to.deep.equal([{ text: '~~ a ~~', type: 'text' }]);
      expect(runs('a~~b~~c')).to.deep.equal([
        { text: 'a', type: 'text' },
        struck('b'),
        { text: 'c', type: 'text' },
      ]);
    });

    it('should not be read inside a code span, and keep an escaped tilde', () => {
      expect(runs('`~~a~~` \\~~b~~')).to.deep.equal([
        { text: '~~a~~', type: 'code' },
        { text: ' ~~b~~', type: 'text' },
      ]);
    });
  });

  describe('footnotes', () => {
    const note = (index: number, label: string, text: string) => ({
      children: [{ children: [{ text, type: 'text' }], type: 'paragraph' }],
      index,
      label,
    });

    it('should number the references by where each is first made, and collect the notes at the end', () => {
      const doc = parseMarkdown('b[^b] a[^a] b again[^b]\n\n[^a]: A.\n[^b]: B.');
      expect(doc).to.deep.equal([
        {
          children: [
            { text: 'b', type: 'text' },
            { index: 1, label: 'b', type: 'footnote' },
            { text: ' a', type: 'text' },
            { index: 2, label: 'a', type: 'footnote' },
            { text: ' b again', type: 'text' },
            { index: 1, label: 'b', type: 'footnote' },
          ],
          type: 'paragraph',
        },
        { notes: [note(1, 'b', 'B.'), note(2, 'a', 'A.')], type: 'footnotes' },
      ]);
    });

    it('should read the indented blocks under a definition as its own', () => {
      const doc = parseMarkdown('x[^1]\n\n[^1]: One\ncarried on.\n\n    Two.\n\nAfter.');
      expect(doc.map((block) => block.type)).to.deep.equal(['paragraph', 'paragraph', 'footnotes']);
      const notes = doc.at(-1)!;
      expect(notes.type === 'footnotes' && notes.notes[0].children).to.deep.equal([
        { children: [{ text: 'One carried on.', type: 'text' }], type: 'paragraph' },
        { children: [{ text: 'Two.', type: 'text' }], type: 'paragraph' },
      ]);
    });

    it('should end a paragraph, and a definition, at the next definition', () => {
      const doc = parseMarkdown('x[^1][^2]\n[^1]: One\n[^2]: Two');
      expect(doc).to.have.length(2);
      expect(doc[1]).to.deep.equal({
        notes: [note(1, '1', 'One'), note(2, '2', 'Two')],
        type: 'footnotes',
      });
    });

    it('should leave a reference to nothing as the text it is', () => {
      expect(parseMarkdown('a[^nope]')).to.deep.equal([
        { children: [{ text: 'a[^nope]', type: 'text' }], type: 'paragraph' },
      ]);
    });

    it('should keep a definition nothing refers to, numbered after the rest', () => {
      const doc = parseMarkdown('a[^used]\n\n[^spare]: Spare.\n[^used]: Used.');
      expect(doc.at(-1)).to.deep.equal({
        notes: [note(1, 'used', 'Used.'), note(2, 'spare', 'Spare.')],
        type: 'footnotes',
      });
    });

    it("should number a reference made inside a note after the document's own", () => {
      const doc = parseMarkdown('a[^1]\n\n[^1]: see[^2]\n[^2]: Two.\n[^3]: Three.');
      const notes = doc.at(-1)!;
      expect(notes.type === 'footnotes' && notes.notes.map((it) => it.label)).to.deep.equal([
        '1',
        '2',
        '3',
      ]);
    });

    it('should collect a definition from inside a list or a quote', () => {
      const doc = parseMarkdown('- a[^1]\n\n  [^1]: In a list.\n\n> [^2]: In a quote.');
      const notes = doc.at(-1)!;
      expect(notes.type === 'footnotes' && notes.notes.map((it) => it.label)).to.deep.equal([
        '1',
        '2',
      ]);
    });

    it('should match a label in any case, and take the first definition of one', () => {
      const doc = parseMarkdown('a[^Note]\n\n[^note]: First.\n[^NOTE]: Second.');
      expect(doc.at(-1)).to.deep.equal({ notes: [note(1, 'note', 'First.')], type: 'footnotes' });
    });

    it('should read a link with a destination as a link, and an image as no reference', () => {
      const doc = parseMarkdown('[^1](https://x) ![^1]\n\n[^1]: N.');
      expect(doc[0].type === 'paragraph' && doc[0].children.map((it) => it.type)).to.deep.equal([
        'link',
        'text',
      ]);
    });

    it('should say a reference as its number in markdownText()', () => {
      const block = parseMarkdown('a[^1] ~~b~~\n\n[^1]: N.')[0];
      expect(block.type === 'paragraph' && markdownText(block.children)).to.equal('a[1] ~~b~~');
    });

    it('should keep the tildes round a strikethrough in markdownText()', () => {
      const block = parseMarkdown('a ~~b *c*~~ d')[0];
      expect(block.type === 'paragraph' && markdownText(block.children)).to.equal('a ~~b c~~ d');
    });

    it('should keep the tildes in an image description', () => {
      const block = parseMarkdown('![~~old~~ logo](logo.png)')[0];
      expect(block.type === 'paragraph' && block.children[0]).to.deep.include({
        alt: '~~old~~ logo',
        type: 'image',
      });
    });
  });

  describe('everything else', () => {
    it('should read a backslash escape and the entities it knows', () => {
      expect(runs('\\*not\\* &amp; &copy; &#65; &#x42; &unknown;')).to.deep.equal([
        { text: '*not* & © A B &unknown;', type: 'text' },
      ]);
    });

    it('should read a thematic break', () => {
      expect(parseMarkdown('***\n- - -\n___')).to.deep.equal([
        { type: 'rule' },
        { type: 'rule' },
        { type: 'rule' },
      ]);
    });

    it('should leave raw HTML as the text it is', () => {
      expect(runs('<b>bold</b>')).to.deep.equal([{ text: '<b>bold</b>', type: 'text' }]);
    });

    // data for a site generator, and read as CommonMark it would be a rule and a
    // setext heading made of its own keys -- which is what `sigil reference`
    // writes at the top of every page it gives a file of its own
    it('should take a front matter block off the top', () => {
      expect(parseMarkdown('---\ntitle: "x"\n---\n\n# x')).to.deep.equal([
        { children: [{ text: 'x', type: 'text' }], level: 1, type: 'heading' },
      ]);
    });

    it('should read a front matter block that never closes as markdown', () => {
      expect(parseMarkdown('---\ntitle').map((block) => block.type)).to.deep.equal([
        'rule',
        'paragraph',
      ]);
    });

    it('should read nothing out of nothing', () => {
      expect(parseMarkdown('')).to.deep.equal([]);
      expect(parseMarkdown('\n\n  \n')).to.deep.equal([]);
    });

    it('should read a Windows line ending as a line ending', () => {
      expect(parseMarkdown('# a\r\n\r\nb')).to.have.length(2);
    });

    it('should refuse a source that is not a string', () => {
      expect(() => parseMarkdown(42 as unknown as string)).to.throw(TypeError);
    });
  });
});

describe('markdown()', () => {
  const DOCUMENT = [
    '# Release *notes*',
    '',
    'A paragraph with **bold**, `code` and a [link](https://example.com), which goes on long',
    'enough to wrap.',
    '',
    '- one',
    '- two',
    '  1. nested',
    '  2. again',
    '',
    '> quoted',
    '',
    '```',
    'const x = 1;',
    '```',
    '',
    '| Name | Size |',
    '| ---- | ---: |',
    '| a    | 1    |',
    '| bb   | 22   |',
    '',
    '---',
  ].join('\n');

  it('should draw a document at a fixed width', () => {
    expect(draw(DOCUMENT).split('\n')).to.deep.equal([
      'Release notes',
      '',
      'A paragraph with bold, code and a link',
      '(https://example.com), which goes on',
      'long enough to wrap.',
      '',
      '• one',
      '• two',
      '  1. nested',
      '  2. again',
      '',
      '│ quoted',
      '',
      '  const x = 1;',
      '',
      'Name  Size',
      '────  ────',
      'a        1',
      'bb      22',
      '',
      '─'.repeat(40),
    ]);
  });

  it('should wrap every line to the width it was given', () => {
    for (const width of [10, 17, 25, 40, 60]) {
      for (const line of draw(DOCUMENT, { width }).split('\n')) {
        expect(stringWidth(line), `${JSON.stringify(line)} at ${width}`).to.be.at.most(width);
      }
    }
  });

  it('should wrap at the terminal when no width is given', () => {
    const lines = draw('word '.repeat(40), { env: { COLUMNS: '30' }, width: undefined }).split(
      '\n'
    );
    expect(Math.max(...lines.map(stringWidth))).to.be.at.most(30);
    expect(lines.length).to.be.greaterThan(1);
  });

  it('should draw nothing for an empty document', () => {
    expect(draw('')).to.equal('');
  });

  it('should take blocks parseMarkdown() already read', () => {
    expect(draw(parseMarkdown('# a'))).to.equal('a');
  });

  it('should refuse a source that is neither a string nor blocks', () => {
    expect(() => draw(42 as unknown as string)).to.throw(TypeError);
  });

  describe('wrapping', () => {
    it('should hang a wrapped list item under its text, not its marker', () => {
      expect(draw('- one two three four five six', { width: 14 }).split('\n')).to.deep.equal([
        '• one two',
        '  three four',
        '  five six',
      ]);
    });

    it('should line the numbers of a list that reaches ten up on their right', () => {
      expect(draw('9. nine\n10. ten').split('\n')).to.deep.equal([' 9. nine', '10. ten']);
    });

    it('should indent each level of a nested list under the one above', () => {
      expect(draw('- a\n  - b\n    - c\n      - d').split('\n')).to.deep.equal([
        '• a',
        '  ◦ b',
        '    ▪ c',
        '      • d',
      ]);
    });

    it('should keep a bar down the whole of a quote that wraps', () => {
      expect(draw('> one two three four', { width: 12 }).split('\n')).to.deep.equal([
        '│ one two',
        '│ three four',
      ]);
    });

    it('should fold a code line wider than the room by columns', () => {
      expect(draw(`\`\`\`\n${'x'.repeat(25)}\n\`\`\``, { width: 12 }).split('\n')).to.deep.equal([
        '  xxxxxxxxxx',
        '  xxxxxxxxxx',
        '  xxxxx',
      ]);
    });

    it('should break a URL longer than the line, and keep what follows it on its line', () => {
      const lines = draw(`[docs](https://example.com/${'a'.repeat(30)}).`, { width: 20 }).split(
        '\n'
      );
      expect(lines.every((line) => stringWidth(line) <= 20)).to.equal(true);
      expect(lines.at(-1)?.endsWith(').')).to.equal(true);
    });

    // a run with no space in it is one word however long it is, which is every
    // sentence of Chinese or Japanese -- and a word wider than the line used to
    // be made one text in its longest piece's style, so the link went with it
    it('should keep a link inside a run with no spaces that is wider than the line', () => {
      const source =
        '日本語の説明文はとても長くて、[ドキュメント](https://example.com)を参照してください。';
      const linked = draw(source, { colorLevel: 1, hyperlinks: true });
      expect(linked).to.include(`${osc8('https://example.com')}ドキュメント`);
      expect(strip(linked).replaceAll('\n', '')).to.equal(
        '日本語の説明文はとても長くて、ドキュメントを参照してください。'
      );
      expect(
        strip(linked)
          .split('\n')
          .every((line) => stringWidth(line) <= 40)
      ).to.equal(true);

      // and where a piece is itself wider than the line, which is the one shape
      // that is still made one text: not when a link is in it
      const long = draw(`${'長'.repeat(25)}[リンク](https://example.com)を`, {
        colorLevel: 1,
        hyperlinks: true,
      });
      expect(long).to.include(`${osc8('https://example.com')}リンク`);

      const shown = draw(source).split('\n');
      expect(shown.some((line) => line.includes('(https://example.com)'))).to.equal(true);
      expect(shown.every((line) => stringWidth(line) <= 40)).to.equal(true);
    });

    it('should keep the styles inside a run with no spaces that is wider than the line', () => {
      const out = draw('日本語の説明文はとても長くて、**重要**な`設定`を参照してください。', {
        colorLevel: 1,
      });
      expect(out).to.include(`${ESC}[1m重要`);
      expect(out).to.match(new RegExp(`${ESC}\\[[0-9;]*m設定`));
    });

    it('should keep a hard break', () => {
      expect(draw('one  \ntwo')).to.equal('one\ntwo');
    });

    it('should keep a word and the punctuation after its emphasis together', () => {
      expect(draw('**bold**, *em*.')).to.equal('bold, em.');
    });
  });

  describe('tables', () => {
    it('should measure wide characters in columns, so the columns line up', () => {
      const lines = draw('| name | n |\n| --- | --- |\n| 日本語 | 1 |\n| ab | 2 |').split('\n');
      // the second column starts in the same display column on every row
      const starts = lines.map((line) => {
        const at = line.lastIndexOf(' ');
        return stringWidth(line.slice(0, at + 1));
      });
      expect(new Set(starts).size, lines.join('\n')).to.equal(1);
      expect(lines[2]).to.equal('日本語  1');
    });

    it('should narrow a table wider than the room, widest column first, and wrap its cells', () => {
      const lines = draw(
        '| key | description |\n| --- | --- |\n| a | the long description that has to wrap |',
        { width: 24 }
      ).split('\n');
      expect(lines).to.deep.equal([
        'key  description',
        '───  ───────────────────',
        'a    the long',
        '     description that',
        '     has to wrap',
      ]);
    });

    it('should align a column right or center', () => {
      expect(
        draw('| left | right | mid |\n| :-- | --: | :-: |\n| a | b | c |').split('\n')[2]
      ).to.equal('a         b   c');
    });

    it('should align every line of a cell that wraps', () => {
      expect(
        draw('| k | v |\n| - | --: |\n| a | one two three |', { width: 12 }).split('\n')
      ).to.deep.equal(['k          v', '─  ─────────', 'a    one two', '       three']);
    });

    it('should draw the inline markup in a cell, and an escaped bar as a bar', () => {
      expect(draw('| a |\n| - |\n| **b** \\| `c` ~~d~~ |').split('\n')[2]).to.equal('b | c ~~d~~');
      expect(draw('| a |\n| - |\n| **b** |', { colorLevel: 1 }).split('\n')[2]).to.equal(
        `${ESC}[1mb${ESC}[0m`
      );
    });
  });

  describe('strikethrough', () => {
    it('should keep the tildes at colour level 0, where the line is dropped', () => {
      expect(draw('a ~~old flag~~ new')).to.equal('a ~~old flag~~ new');
    });

    it('should strike the words and keep the tildes beside them, muted, where colour is drawn', () => {
      expect(draw('a ~~old~~ b', { colorLevel: 1 })).to.equal(
        `a ${ESC}[2m~~${ESC}[22;9mold${ESC}[29;2m~~ ${ESC}[22mb`
      );
    });

    it('should mute the tildes round a struck flag, so its dashes are not a third pair', () => {
      expect(draw('~~`--legacy`~~', { colorLevel: 1 })).to.equal(
        `${ESC}[2m~~${ESC}[22;9;36m--legacy${ESC}[29;2;39m~~${ESC}[0m`
      );
    });

    it('should keep the underline on a struck link', () => {
      const out = draw('[~~a~~](https://a)', { colorLevel: 1, hyperlinks: true });
      expect(out).to.match(new RegExp(`${ESC}\\[4;36m.*~~${ESC}\\[9ma`));
      expect(out).not.to.include(`${ESC}[24m${ESC}[9m`);
    });

    it("should leave a struck link's tildes in the link's style rather than muted", () => {
      // the muted run after it is the written-out URL, which is not the tildes'
      expect(draw('[~~a~~](https://a)', { colorLevel: 1 })).to.equal(
        `${ESC}[4;36m~~${ESC}[9ma${ESC}[29m~~${ESC}[24;39m ${ESC}[2m(https://a)${ESC}[0m`
      );
    });

    it('should let an app that knows its terminal draws the line take the tildes away', () => {
      expect(
        draw('a ~~old~~ b', {
          colorLevel: 1,
          sheets: ['.sigil-markdown-strike-marker { display: none }'],
        })
      ).to.equal(`a ${ESC}[9mold${ESC}[29m b`);
    });
  });

  describe('task lists', () => {
    it('should draw a box where the bullet would be', () => {
      expect(draw('- [ ] todo\n- [x] done\n- plain').split('\n')).to.deep.equal([
        '☐ todo',
        '☒ done',
        '• plain',
      ]);
    });

    it('should draw the box after the number of a numbered item, and hang a wrap under its text', () => {
      expect(
        draw('1. [x] first\n2. second\n3. [ ] third, which is long', { width: 16 }).split('\n')
      ).to.deep.equal(['1. ☒ first', '2.   second', '3. ☐ third,', '     which is', '     long']);
    });

    it('should draw the boxes as the author typed them where box drawing is not safe', () => {
      expect(
        draw('- [ ] todo\n- [x] done\n- plain', { env: { TERM: 'linux' } }).split('\n')
      ).to.deep.equal(['[ ] todo', '[x] done', '*   plain']);
    });

    it('should draw an open box muted and a ticked one in the success role', () => {
      const out = draw('- [ ] a\n- [x] b', { colorLevel: 1 }).split('\n');
      expect(out[0]).to.match(new RegExp(`^${ESC}\\[2m☐`));
      expect(out[1]).to.match(new RegExp(`^${ESC}\\[32m☒`));
    });
  });

  describe('footnotes', () => {
    it('should draw a reference as its number, and the notes after a rule at the end', () => {
      expect(
        draw('Said[^a] twice[^a], and[^b].\n\n[^b]: Bee.\n[^a]: Ay.\n\nEnd.', { width: 20 }).split(
          '\n'
        )
      ).to.deep.equal([
        'Said[1] twice[1],',
        'and[2].',
        '',
        'End.',
        '',
        '─'.repeat(20),
        '[1] Ay.',
        '[2] Bee.',
      ]);
    });

    it('should hang a note under its text, and space notes apart when one is two blocks', () => {
      expect(
        draw('a[^1] b[^2]\n\n[^1]: One two three.\n\n    More.\n[^2]: Two.', { width: 12 }).split(
          '\n'
        )
      ).to.deep.equal([
        'a[1] b[2]',
        '',
        '─'.repeat(12),
        '[1] One two',
        '    three.',
        '',
        '    More.',
        '',
        '[2] Two.',
      ]);
    });

    it('should draw a reference to nothing as it was written', () => {
      expect(draw('a[^nope]')).to.equal('a[^nope]');
    });

    it('should draw a reference muted, and not as part of the link it is in', () => {
      const out = draw('[a[^1]](https://a) b[^1]\n\n[^1]: N.', {
        colorLevel: 1,
        hyperlinks: true,
      }).split('\n')[0];
      // the hyperlink is closed before the reference, and its underline taken off
      expect(out).to.include(`${ESC}[24;2;39m${osc8('')}[1]`);
      expect(out).to.include(`b${ESC}[2m[1]`);
    });
  });

  describe('links', () => {
    it('should show the URL after the words where there is no hyperlink', () => {
      expect(draw('see [docs](https://example.com)')).to.equal('see docs (https://example.com)');
    });

    it('should not say the URL twice for an autolink', () => {
      expect(draw('<https://example.com> and <me@example.com>')).to.equal(
        'https://example.com and me@example.com'
      );
    });

    it('should write an OSC 8 hyperlink over the words where there is one', () => {
      const out = draw('see [the docs](https://example.com)', { colorLevel: 1, hyperlinks: true });
      expect(out).to.include(`${osc8('https://example.com')}the`);
      expect(out).to.include(`${osc8('https://example.com')}docs`);
      expect(strip(out)).to.equal('see the docs');
    });

    // level 0 is "write no escape sequences", and an OSC 8 is one
    it('should show the URL at colour level 0 whatever the terminal could do', () => {
      expect(draw('[docs](https://example.com)', { colorLevel: 0, hyperlinks: true })).to.equal(
        'docs (https://example.com)'
      );
    });

    it('should ask the terminal when it is not told', () => {
      const ask = (env: Record<string, string>, isTTY: boolean): string =>
        draw('[docs](https://example.com)', {
          colorLevel: 1,
          env,
          hyperlinks: undefined,
          stream: { isTTY },
        });
      expect(ask({ TERM_PROGRAM: 'WezTerm' }, true)).to.include(osc8('https://example.com'));
      expect(strip(ask({ TERM_PROGRAM: 'WezTerm' }, false))).to.equal('docs (https://example.com)');
      expect(strip(ask({}, true))).to.equal('docs (https://example.com)');
    });

    it('should resolve a relative link against baseUrl', () => {
      expect(
        draw('[guide](docs/guide.md)', { baseUrl: 'https://github.com/o/r/blob/main/', width: 80 })
      ).to.equal('guide (https://github.com/o/r/blob/main/docs/guide.md)');
      expect(
        draw('[guide](docs/guide.md)', {
          baseUrl: 'https://github.com/o/r/blob/main/',
          colorLevel: 1,
          hyperlinks: true,
        })
      ).to.include(osc8('https://github.com/o/r/blob/main/docs/guide.md'));
    });

    it('should show a relative link with no baseUrl, and never make it a hyperlink', () => {
      const out = draw('[guide](docs/guide.md)', { colorLevel: 1, hyperlinks: true });
      expect(out).not.to.include(`${ESC}]8`);
      expect(strip(out)).to.equal('guide (docs/guide.md)');
    });

    it('should show a link into the document as its words alone', () => {
      expect(draw('[usage](#usage)', { colorLevel: 1, hyperlinks: true })).not.to.include(
        `${ESC}]8`
      );
      expect(draw('[usage](#usage)')).to.equal('usage');
    });

    it('should percent-encode what OSC 8 cannot carry', () => {
      expect(
        draw('[a](<https://example.com/a b/é>)', { colorLevel: 1, hyperlinks: true })
      ).to.include(osc8('https://example.com/a%20b/%C3%A9'));
    });

    it('should never link or show a URL holding a control character', () => {
      const out = draw(`[a](<https://x/\u0007>)`, { colorLevel: 1, hyperlinks: true });
      expect(out).not.to.include('\u0007');
      expect(out).not.to.include(`${ESC}]8`);
      expect(strip(out)).to.equal('a');
      // and not shown either: a text drops the character, which would print a
      // URL that is not the one the document holds
      expect(draw(`[a](<https://x/\u0007>)`)).to.equal('a');
    });

    it('should draw an image as its description, linked where it can be', () => {
      expect(draw('![the logo](https://x/logo.png)')).to.equal('the logo');
      expect(draw('![](https://x/logo.png)')).to.equal('image');
      expect(
        draw('![the logo](https://x/logo.png)', { colorLevel: 1, hyperlinks: true })
      ).to.include(osc8('https://x/logo.png'));
    });
  });

  describe('the theme', () => {
    const coloured = (source: string, opts: MarkdownOptions = {}): string =>
      draw(source, { colorLevel: 1, ...opts });

    it('should set emphasis, strong emphasis and a link in what they mean', () => {
      expect(coloured('*em*')).to.equal(`${ESC}[3mem${ESC}[0m`);
      expect(coloured('**strong**')).to.equal(`${ESC}[1mstrong${ESC}[0m`);
      expect(coloured('[a](https://a)', { hyperlinks: true })).to.include(`${ESC}[4;36m`);
    });

    it('should draw the rest through the roles', () => {
      // a heading is the heading role, and the first level the accent beside it
      expect(coloured('# a')).to.equal(`${ESC}[1;36ma${ESC}[0m`);
      expect(coloured('## a')).to.equal(`${ESC}[1ma${ESC}[0m`);
      // code is the accent, and a list marker the muted role
      expect(coloured('`a`')).to.equal(`${ESC}[36ma${ESC}[0m`);
      expect(coloured('- a')).to.include(`${ESC}[2m•`);
    });

    it('should be restyled by a theme through the roles', () => {
      expect(coloured('`a`', { theme: '.sigil-accent { color: magenta }' })).to.equal(
        `${ESC}[35ma${ESC}[0m`
      );
    });

    it('should be restyled by a theme through its own classes', () => {
      expect(
        coloured('*a*', { theme: '.sigil-markdown-em { font-style: normal; color: red }' })
      ).to.equal(`${ESC}[31ma${ESC}[0m`);
      expect(coloured('### a', { theme: '.sigil-markdown-h3 { color: yellow }' })).to.equal(
        `${ESC}[1;33ma${ESC}[0m`
      );
    });

    // the classes table() draws with, so a theme written for one reaches both
    it('should restyle a table the way it restyles table()', () => {
      const out = coloured('| a |\n| - |\n| 1 |', { theme: '.sigil-table-head { color: green }' });
      expect(out.split('\n')[0]).to.equal(`${ESC}[1;32ma${ESC}[0m`);
    });

    it('should let an app beat the theme', () => {
      expect(
        coloured('`a`', {
          sheets: ['.sigil-markdown-code { color: blue }'],
          theme: '.sigil-markdown-code { color: magenta }',
        })
      ).to.equal(`${ESC}[34ma${ESC}[0m`);
    });

    it('should draw no escape sequence at all at colour level 0', () => {
      expect(draw(DOCUMENT, { colorLevel: 0, hyperlinks: true })).not.to.include(ESC);
    });
  });

  describe('highlight', () => {
    const coloured = (source: string, opts: MarkdownOptions = {}): string =>
      draw(source, { colorLevel: 1, ...opts });

    const keywords = (code: string): HighlightSpan[] =>
      [...code.matchAll(/\bconst\b/g)].map((match) => ({
        end: match.index + match[0].length,
        start: match.index,
        token: 'keyword',
      }));

    it('should hand the hook each block whole, with the language its fence named', () => {
      const seen: [string, string | undefined][] = [];
      draw('```ts title="x"\nconst a\n/* b */\n```\n\n```\nplain\n```\n\n    indented', {
        highlight: (code, lang) => {
          seen.push([code, lang]);
          return [];
        },
      });

      expect(seen).to.deep.equal([
        ['const a\n/* b */', 'ts'],
        ['plain', undefined],
        ['indented', undefined],
      ]);
    });

    it('should never hand the hook an inline code span, which has no language', () => {
      const seen: string[] = [];
      draw('`const a` in a sentence', {
        highlight: (code) => {
          seen.push(code);
          return keywords(code);
        },
      });

      expect(seen).to.deep.equal([]);
    });

    it('should highlight a code block inside a list and a quote', () => {
      const seen: string[] = [];
      draw('- item\n\n  ```js\n  one\n  ```\n\n> ```js\n> two\n> ```', {
        highlight: (code) => {
          seen.push(code);
          return [];
        },
      });

      expect(seen).to.deep.equal(['one', 'two']);
    });

    it('should draw a token in its role, and the rest of the block in the foreground', () => {
      const out = coloured('```ts\nconst a = 1;\n```', { highlight: keywords });

      // the keyword is the accent, and what it did not mark is not: the accent an
      // unhighlighted block is drawn in is the keyword's, so keeping it hides them
      expect(out).to.match(new RegExp(`${ESC}\\[36mconst`));
      expect(out).to.match(new RegExp(`${ESC}\\[39ma = 1;`));
      expect(strip(out)).to.equal('  const a = 1;');
    });

    it('should draw a block the hook marked nothing in as it is drawn without one', () => {
      const source = '```sh\nnpm install\n\nnpm test\n```';
      const plain = coloured(source);

      expect(coloured(source, { highlight: () => [] })).to.equal(plain);
      // spans wholly out of range mark nothing either
      expect(
        coloured(source, { highlight: () => [{ end: 99, start: 50, token: 'keyword' }] })
      ).to.equal(plain);
    });

    it('should paint the second line of a span that began on the first', () => {
      // a comment is only one where its opener is in the code the hook was handed,
      // which a hook asked about one line at a time would not have been
      const out = coloured('```c\n/* one\ntwo */ x\n```', {
        highlight: (code) =>
          code.includes('/*')
            ? [{ end: code.indexOf('*/') + 2, start: code.indexOf('/*'), token: 'comment' }]
            : [],
      });

      expect(out.split('\n')[1]).to.match(new RegExp(`${ESC}\\[2mtwo \\*/`));
    });

    it('should put a token on a later line where the span put it', () => {
      const out = coloured('```ts\nconst a\nconst b\n\n  const c\n```', { highlight: keywords });

      expect(out.split('\n').map((row) => strip(row))).to.deep.equal([
        '  const a',
        '  const b',
        '',
        '    const c',
      ]);
      expect(out.match(new RegExp(`${ESC}\\[36mconst\\b`, 'g'))).to.have.length(3);
    });

    it('should carry a token onto every row a fold breaks its line into', () => {
      const code = `const ${'x'.repeat(25)}`;
      const out = coloured(`\`\`\`\n${code}\n\`\`\``, {
        highlight: () => [{ end: code.length, start: 6, token: 'string' }],
        width: 12,
      });

      const rows = out.split('\n');
      expect(rows.map((row) => strip(row))).to.deep.equal([
        '  const xxxx',
        '  xxxxxxxxxx',
        '  xxxxxxxxxx',
        '  x',
      ]);
      for (const row of rows) {
        expect(row).to.match(new RegExp(`${ESC}\\[32mx`));
      }
    });

    it('should keep every line, a blank one included, where the block was highlighted', () => {
      const source = `\`\`\`ts\nconst a\n\n${'x'.repeat(14)}\nconst b\n\`\`\``;
      const highlighted = draw(source, { highlight: keywords, width: 12 });

      expect(highlighted).to.equal(draw(source, { width: 12 }));
      expect(highlighted.split('\n')).to.have.length(5);
    });

    it('should read a span in code units, as diff() and multiline() do', () => {
      // the emoji is two code units, so the keyword starts at 3 and not at 2
      const out = coloured('```\n😀 const\n```', { highlight: keywords });

      expect(out).to.match(new RegExp(`${ESC}\\[36mconst`));
    });

    it('should clip a span out of range rather than refuse it', () => {
      const out = coloured('```\nabcdef\n```', {
        highlight: () => [
          { end: 2, start: -5, token: 'number' },
          { end: 200, start: 4, token: 'string' },
        ],
      });

      expect(strip(out)).to.equal('  abcdef');
      expect(out).to.match(new RegExp(`${ESC}\\[34mab`));
      expect(out).to.match(new RegExp(`${ESC}\\[32mef`));
    });

    it('should refuse a token no class can carry', () => {
      expect(() =>
        draw('```\na\n```', { highlight: () => [{ end: 1, start: 0, token: 'a b' }] })
      ).to.throw(/token/);
    });

    it('should let what the hook throws reach the caller', () => {
      const boom = new Error('the grammar is missing');
      expect(() =>
        draw('```ts\na\n```', {
          highlight: () => {
            throw boom;
          },
        })
      ).to.throw(boom);
    });

    it("should carry diff()'s token classes, so one sheet colours both", () => {
      const theme = '.sigil-token-binding { color: magenta }';
      const highlight = (): HighlightSpan[] => [{ end: 3, start: 0, token: 'binding' }];

      expect(coloured('```\nlet a\n```', { highlight, theme })).to.match(
        new RegExp(`${ESC}\\[35mlet`)
      );
      expect(diff({ new: 'let a', old: '' }, { colorLevel: 1, highlight, theme })).to.match(
        new RegExp(`${ESC}\\[[\\d;]*35mlet`)
      );
    });

    it('should put the token classes on the element tree the string is drawn from', () => {
      const { element } = markdownView('```ts\nconst a\n```', {
        env: {},
        highlight: keywords,
        hyperlinks: false,
        width: 20,
      });
      const classes: string[][] = [];
      const visit = (node: Element): void => {
        classes.push([...node.classes]);
        node.children.forEach(visit);
      };
      visit(element);

      expect(classes).to.deep.include([
        'sigil-markdown-code',
        'sigil-token',
        'sigil-token-keyword',
        'sigil-accent',
      ]);
    });
  });

  describe('where box drawing is not safe', () => {
    it('should draw the bullets, the quote bar and the rules in ASCII', () => {
      expect(
        draw('- a\n  - b\n\n> q\n\n| h |\n| - |\n| 1 |\n\n***', {
          env: { TERM: 'linux' },
          width: 10,
        }).split('\n')
      ).to.deep.equal(['* a', '  - b', '', '| q', '', 'h', '-', '1', '', '----------']);
    });
  });
});

describe('markdownText()', () => {
  it('should say what a run of inline content says, without its formatting', () => {
    const block = parseMarkdown('**a** `b` [*c*](https://c) ![d](https://d)  \ne')[0];
    expect(block.type === 'paragraph' && markdownText(block.children)).to.equal('a b c d e');
  });
});

describe('markdownView()', () => {
  it('should return the tree and the room it was built for', () => {
    const view = markdownView('# a', { colorLevel: 0, env: {}, hyperlinks: false, width: 33 });
    expect(view.width).to.equal(33);
    expect(renderToString(view.element, { colorLevel: 0, width: view.width })).to.equal('a');
  });

  it('should never lay out narrower than ten columns', () => {
    expect(markdownView('a', { env: {}, hyperlinks: false, width: 3 }).width).to.equal(10);
  });

  it('should carry its hooks for a theme', () => {
    const view = markdownView('# a\n\n- b', { env: {}, hyperlinks: false, width: 20 });
    expect(view.element.classes).to.include('sigil-markdown');
  });

  it('should reflow every body to the width it is laid out at, not only the top level', () => {
    // a tree is built for a width and laid out at whatever the app gives it. A
    // `max-width` on each nested body, tried for SIG-423's measure, held a list
    // item's words to the twelve columns it was built for while the paragraph
    // above it took all forty
    const plain = {
      colorLevel: 0,
      env: {},
      hyperlinks: false,
      platform: 'linux',
      width: 12,
    } as const;
    const view = markdownView(
      'a top-level paragraph to fill the line\n\n- hello world from a nested body\n\n> quoted words that go on\n\n- one\n  - two three four five six',
      plain
    );
    expect(renderToString(view.element, { colorLevel: 0, width: 40 }).split('\n')).to.deep.equal([
      'a top-level paragraph to fill the line',
      '',
      '• hello world from a nested body',
      '',
      '│ quoted words that go on',
      '',
      '• one',
      '  ◦ two three four five six',
    ]);
  });
});
