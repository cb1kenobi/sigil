import { createAnsi } from '../../src/ansi/index.js';
import {
  createOutline,
  outline,
  type OutlineOptions,
  outlineView,
} from '../../src/components/outline.js';
import { loadCatalog } from '../../src/i18n/index.js';
import { setQuiet } from '../../src/style/output.js';
import { stringWidth } from '../../src/width/index.js';
import { screenSetup, setup } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(async () => {
  setQuiet(undefined);
  await loadCatalog(undefined, {});
});

/**
 * What a test says about the terminal, so that a developer's own `TERM` and the
 * platform the suite runs on cannot decide which bullets it sees.
 */
const TERMINAL = { env: {}, platform: 'linux' } as const;

/**
 * An outline, read as the lines it prints.
 *
 * The colour level is none so the lines are plain unless a test asks for colour.
 */
function lines(items: Parameters<typeof outline>[0], opts: OutlineOptions = {}): string[] {
  return outline(items, { colorLevel: 0, ...TERMINAL, width: 40, ...opts }).split('\n');
}

describe('outline()', () => {
  describe('the markers', () => {
    it('should dim the markers and leave the item alone', () => {
      const out = outline(['a'], { colorLevel: 3, ...TERMINAL, width: 40 });

      expect(out).to.equal('\u001B[2m• \u001B[22ma');
    });

    it('should bullet the top of a list and dash the list under it by default', () => {
      expect(lines(['a', { items: ['b', 'c'], text: 'd' }, 'e'])).to.deep.equal([
        '• a',
        '• d',
        '  – b',
        '  – c',
        '• e',
      ]);
    });

    it('should draw ASCII bullets where the terminal cannot be trusted with the others', () => {
      expect(lines(['a', { items: ['b'], text: 'c' }], { env: { TERM: 'dumb' } })).to.deep.equal([
        '* a',
        '* c',
        '  - b',
      ]);
      expect(lines(['a'], { ascii: true })).to.deep.equal(['* a']);
    });

    it('should count an ordered list from one', () => {
      expect(lines(['a', 'b', 'c'], { enumerator: 'arabic' })).to.deep.equal([
        '1. a',
        '2. b',
        '3. c',
      ]);
    });

    it('should start counting where `start` says', () => {
      expect(lines(['a', 'b'], { enumerator: 'arabic', start: 5 })).to.deep.equal(['5. a', '6. b']);
      expect(lines(['a', 'b'], { enumerator: 'alpha', start: 3 })).to.deep.equal(['c. a', 'd. b']);
    });

    it('should count in letters, and carry on past z the way a spreadsheet does', () => {
      const items = Array.from({ length: 28 }, (_, i) => `item ${i}`);
      const rows = lines(items, { enumerator: 'alpha' });

      expect(rows[0]).to.equal(' a. item 0');
      expect(rows[25]).to.equal(' z. item 25');
      expect(rows[26]).to.equal('aa. item 26');
      expect(rows[27]).to.equal('ab. item 27');
    });

    it('should count in capital letters and in roman numerals of either case', () => {
      expect(lines(['a', 'b'], { enumerator: 'ALPHA' })).to.deep.equal(['A. a', 'B. b']);
      expect(lines(['a', 'b', 'c', 'd'], { enumerator: 'roman' })).to.deep.equal([
        '  i. a',
        ' ii. b',
        'iii. c',
        ' iv. d',
      ]);
      expect(lines(['a', 'b'], { enumerator: 'ROMAN' })).to.deep.equal([' I. a', 'II. b']);
    });

    it('should write the numerals right, including the subtractive ones', () => {
      const items = Array.from({ length: 49 }, () => '');
      const rows = lines(items, { enumerator: 'roman', width: 80 }).map((row) => row.trim());

      expect(rows[3]).to.equal('iv.');
      expect(rows[8]).to.equal('ix.');
      expect(rows[39]).to.equal('xl.');
      expect(rows[48]).to.equal('xlix.');
    });

    it('should draw a number with no numeral as the number, rather than as nothing', () => {
      expect(lines(['a'], { enumerator: 'roman', start: 4000 })).to.deep.equal(['4000. a']);
      expect(lines(['a'], { enumerator: 'roman', start: 0 })).to.deep.equal(['0. a']);
      expect(lines(['a'], { enumerator: 'alpha', start: 0 })).to.deep.equal(['0. a']);
    });

    it('should line a counting list up on its full stops', () => {
      const items = Array.from({ length: 10 }, (_, i) => `item ${i}`);
      const rows = lines(items, { enumerator: 'arabic' });

      expect(rows[8]).to.equal(' 9. item 8');
      expect(rows[9]).to.equal('10. item 9');
    });

    it('should read the enumerators by depth, and cycle when the outline runs deeper', () => {
      const items = [
        { items: [{ items: [{ items: ['deep'], text: 'c' }], text: 'b' }], text: 'a' },
      ];

      expect(lines(items, { enumerator: ['arabic', 'alpha'] })).to.deep.equal([
        '1. a',
        '   a. b',
        '      1. c',
        '         a. deep',
      ]);
    });

    it('should take one enumerator for every depth', () => {
      expect(lines([{ items: ['b'], text: 'a' }], { enumerator: 'dash' })).to.deep.equal([
        '– a',
        '  – b',
      ]);
    });

    it('should draw no marker for none, and still nest', () => {
      expect(lines(['a', { items: ['b'], text: 'c' }], { enumerator: 'none' })).to.deep.equal([
        'a',
        'c',
        '  b',
      ]);
    });
  });

  describe('a custom enumerator', () => {
    it('should be a function that is told where it is', () => {
      const seen: unknown[] = [];

      outline(['a', { items: ['b'], text: 'c' }], {
        colorLevel: 0,
        enumerator: (info) => {
          seen.push(info);
          return '>';
        },
        width: 40,
      });

      expect(seen).to.deep.equal([
        { count: 2, depth: 0, index: 0, item: 'a' },
        { count: 2, depth: 0, index: 1, item: 'c' },
        { count: 1, depth: 1, index: 0, item: 'b' },
      ]);
    });

    it('should draw what it returns', () => {
      const rows = lines(['a', 'b'], {
        enumerator: ({ count, index }) => `${index + 1}/${count}`,
      });

      expect(rows).to.deep.equal(['1/2 a', '2/2 b']);
    });

    it('should be allowed in a list of enumerators beside the names', () => {
      const rows = lines([{ items: ['b'], text: 'a' }], {
        enumerator: ['arabic', ({ index }) => `(${String.fromCharCode(97 + index)})`],
      });

      expect(rows).to.deep.equal(['1. a', '   (a) b']);
    });

    it('should have a line break in what it returns read as a space', () => {
      expect(lines(['a'], { enumerator: () => 'x\ny' })).to.deep.equal(['x y a']);
    });

    it('should align markers of different widths on the right', () => {
      const rows = lines(['a', 'b'], { enumerator: ({ index }) => '#'.repeat(index + 1) });

      expect(rows).to.deep.equal([' # a', '## b']);
    });

    it('should drop the escape sequences a marker carries, and leave the colour to the theme', () => {
      const ansi = createAnsi({ level: 3 });
      const out = outline(['a'], { colorLevel: 0, enumerator: () => ansi.red('!'), width: 40 });

      expect(out).to.equal('! a');
    });
  });

  describe('a hanging indent', () => {
    it('should wrap an item under its own text rather than under its marker', () => {
      const rows = lines(['one two three four five six seven'], { width: 14 });

      expect(rows).to.deep.equal(['• one two', '  three four', '  five six', '  seven']);
    });

    it('should hang under the width of a counting marker', () => {
      const items = Array.from({ length: 10 }, () => 'alpha beta gamma');
      const rows = lines(items, { enumerator: 'arabic', width: 12 });

      // the tenth is the widest marker, and every wrapped line sits under the text
      expect(rows[0]).to.equal(' 1. alpha');
      expect(rows[1]).to.equal('    beta');
      expect(rows.at(-3)).to.equal('10. alpha');
      expect(rows.at(-2)).to.equal('    beta');
    });

    it('should wrap a nested item at what is left of the room', () => {
      const rows = lines([{ items: ['one two three four five'], text: 'top' }], {
        enumerator: ['arabic', 'alpha'],
        width: 16,
      });

      expect(rows).to.deep.equal(['1. top', '   a. one two', '      three four', '      five']);
      expect(Math.max(...rows.map((row) => stringWidth(row)))).to.be.at.most(16);
    });

    it('should keep the line breaks an item already has under the same indent', () => {
      expect(lines(['first\nsecond'])).to.deep.equal(['• first', '  second']);
    });

    it('should break a word too long for its line rather than run past the width', () => {
      const rows = lines(['x'.repeat(30)], { width: 12 });

      expect(Math.max(...rows.map((row) => stringWidth(row)))).to.be.at.most(12);
      expect(rows.length).to.be.greaterThan(2);
      expect(rows.every((row, i) => i === 0 || row.startsWith('  '))).to.equal(true);
    });

    it('should drop the escape sequences in an item, which would print as the text after them', () => {
      const ansi = createAnsi({ level: 3 });
      const out = outline([ansi.red('one two')], { colorLevel: 0, width: 40 });

      expect(out).to.equal('• one two');
    });

    it('should indent the whole block by `indent`', () => {
      expect(lines(['a', 'b'], { indent: 3 })).to.deep.equal(['   • a', '   • b']);
    });

    it('should never be wider than the width it was given', () => {
      const rows = lines(['word '.repeat(30)], { indent: 2, width: 20 });

      expect(Math.max(...rows.map((row) => stringWidth(row)))).to.be.at.most(20);
    });
  });

  describe('the items', () => {
    it('should be an empty string for an empty list', () => {
      expect(outline([], { colorLevel: 0 })).to.equal('');
    });

    it('should draw an item with no text as a marker alone', () => {
      expect(lines([''])).to.deep.equal(['•']);
    });

    it('should leave an object with no items as a leaf', () => {
      expect(lines([{ text: 'a' }, { items: [], text: 'b' }])).to.deep.equal(['• a', '• b']);
    });

    it('should count nested lists from the start of their own list', () => {
      const items = [
        { items: ['x', 'y'], text: 'a' },
        { items: ['z'], text: 'b' },
      ];

      expect(lines(items, { enumerator: 'arabic' })).to.deep.equal([
        '1. a',
        '   1. x',
        '   2. y',
        '2. b',
        '   1. z',
      ]);
    });

    it('should draw frozen items, which are an input and not a thing to write on', () => {
      const items = Object.freeze([Object.freeze({ items: Object.freeze(['b']), text: 'a' })]);

      expect(lines(items)).to.deep.equal(['• a', '  – b']);
    });

    it('should take the width of the terminal when none is given', () => {
      const rows = outline(['word '.repeat(30)], {
        colorLevel: 0,
        env: { COLUMNS: '30' },
        platform: 'linux',
      }).split('\n');

      expect(Math.max(...rows.map((row) => stringWidth(row)))).to.be.at.most(30);
      expect(rows.length).to.be.greaterThan(1);
    });
  });

  describe('a malformed outline', () => {
    it('should refuse items that are not a list', () => {
      expect(() => outline('a' as never)).to.throw(TypeError, 'Expected items to be an array');
    });

    it('should refuse an item that is neither a string nor an object with text', () => {
      expect(() => outline([42] as never)).to.throw(TypeError, 'string or an object');
      expect(() => outline([null] as never)).to.throw(TypeError, 'string or an object');
      expect(() => outline([{ text: 1 }] as never)).to.throw(TypeError, 'string or an object');
    });

    it('should refuse a malformed item however deep it is', () => {
      expect(() => outline([{ items: [{ items: [7], text: 'b' }], text: 'a' }] as never)).to.throw(
        TypeError,
        'string or an object'
      );
    });

    it('should refuse an enumerator it does not know', () => {
      expect(() => outline(['a'], { enumerator: 'hex' as never })).to.throw(
        TypeError,
        'Unknown outline enumerator hex'
      );
    });

    it('should refuse an empty list of enumerators', () => {
      expect(() => outline(['a'], { enumerator: [] })).to.throw(TypeError, 'at least one');
    });

    it('should refuse an enumerator function that returns something else', () => {
      expect(() => outline(['a'], { enumerator: (() => 1) as never })).to.throw(
        TypeError,
        'return a string'
      );
    });
  });
});

describe('outlineView()', () => {
  it('should hand back the tree and the room it was built for', () => {
    const { element, width } = outlineView(['a'], { ...TERMINAL, indent: 2, width: 30 });

    expect(width).to.equal(30);
    expect(element.type).to.equal('box');
  });

  it('should take a floor under the room so that a marker and a column are left', () => {
    expect(outlineView(['a'], { ...TERMINAL, width: 1 }).width).to.equal(4);
  });
});

describe('createOutline()', () => {
  it('should draw the list in place on a terminal', () => {
    const ui = screenSetup({ rows: 10 });
    const live = createOutline(['a', 'b'], { ansi: ui.ansi, ...TERMINAL, terminal: ui.terminal });

    expect(ui.log).to.deep.equal(['• a', '• b']);
    live.done();
  });

  it('should redraw when the items are replaced', () => {
    const ui = screenSetup({ rows: 10 });
    const live = createOutline(['a', 'b', 'c'], {
      ansi: ui.ansi,
      ...TERMINAL,
      terminal: ui.terminal,
    });

    live.update(['a', { items: ['x'], text: 'b' }]);

    expect(ui.log).to.deep.equal(['• a', '• b', '  – x']);
    live.done();
  });

  it('should leave the last frame where it was on done', () => {
    const ui = screenSetup({ rows: 10 });
    const live = createOutline(['a'], { ansi: ui.ansi, ...TERMINAL, terminal: ui.terminal });

    live.update(['a', 'b']);
    live.done();

    expect(ui.log).to.deep.equal(['• a', '• b']);
  });

  it('should leave nothing behind on stop', () => {
    const ui = screenSetup({ rows: 10 });
    const live = createOutline(['a', 'b'], { ansi: ui.ansi, ...TERMINAL, terminal: ui.terminal });

    live.stop();

    expect(ui.log).to.deep.equal([]);
  });

  it('should ignore a change after it has ended', () => {
    const ui = screenSetup({ rows: 10 });
    const live = createOutline(['a'], { ansi: ui.ansi, ...TERMINAL, terminal: ui.terminal });

    live.done();
    live.update(['b']);
    live.done();

    expect(ui.log).to.deep.equal(['• a']);
  });

  it('should refuse a malformed update, and keep what it was showing', () => {
    const ui = screenSetup({ rows: 10 });
    const live = createOutline(['a'], { ansi: ui.ansi, ...TERMINAL, terminal: ui.terminal });

    expect(() => live.update([1] as never)).to.throw(TypeError);
    expect(ui.log).to.deep.equal(['• a']);
    live.done();
  });

  it('should refuse malformed items where they are handed over', () => {
    const ui = screenSetup({ rows: 10 });

    expect(() => createOutline([1] as never, { terminal: ui.terminal })).to.throw(TypeError);
  });

  describe('where there is no terminal', () => {
    it('should write nothing until it is done, and then the list once', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const live = createOutline(['a'], { ansi, ...TERMINAL, terminal });

      live.update(['a', 'b']);
      expect(stdout.text).to.equal('');

      live.done();
      live.done();

      expect(stdout.text).to.equal('• a\n• b\n');
    });

    it('should write nothing on stop', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const live = createOutline(['a'], { ansi, ...TERMINAL, terminal });

      live.stop();
      live.done();

      expect(stdout.text).to.equal('');
    });
  });

  describe('when asked to be quiet', () => {
    it('should draw nothing on a terminal', () => {
      setQuiet(true);
      const ui = screenSetup({ rows: 10 });
      const live = createOutline(['a'], { ansi: ui.ansi, ...TERMINAL, terminal: ui.terminal });

      live.update(['b']);
      live.done();

      expect(ui.output).to.equal('');
    });

    it('should write nothing to a pipe', () => {
      setQuiet(true);
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const live = createOutline(['a'], { ansi, ...TERMINAL, terminal });

      live.done();

      expect(stdout.text).to.equal('');
    });
  });
});
