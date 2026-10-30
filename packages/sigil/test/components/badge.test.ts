import { strip } from '../../src/ansi/index.js';
import { badge, badgeView } from '../../src/components/badge.js';
import { table } from '../../src/components/table.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);

/** The SGR parameters a string opens with, such as `7;32`. */
function params(value: string): string | undefined {
  return new RegExp(`${ESC}\\[([0-9;]+)m`).exec(value)?.[1];
}

describe('badge()', () => {
  describe('the label', () => {
    it('should pad the label with a column each side where there is colour', () => {
      expect(strip(badge('PASS', { colorLevel: 1 }))).to.equal(' PASS ');
    });

    it('should draw brackets in place of the padding at colour level 0', () => {
      expect(badge('PASS', { colorLevel: 0 })).to.equal('[PASS]');
    });

    it('should be as wide at level 0 as it is with colour', () => {
      expect(stringWidth(badge('PASS', { colorLevel: 0 }))).to.equal(
        stringWidth(strip(badge('PASS', { colorLevel: 3 })))
      );
    });

    it('should keep the label as typed, with no case change', () => {
      expect(badge('beta', { colorLevel: 0 })).to.equal('[beta]');
    });

    it('should drop escape sequences and put a line break on one line', () => {
      expect(badge(`${ESC}[31mPA\nSS${ESC}[0m`, { colorLevel: 0 })).to.equal('[PA SS]');
    });

    it('should be empty for an empty label', () => {
      expect(badge('', { colorLevel: 1 })).to.equal('');
      expect(badge('  \n ', { colorLevel: 0 })).to.equal('');
      expect(badgeView('', { colorLevel: 1 }).width).to.equal(0);
    });

    it('should measure a wide label in columns', () => {
      expect(badgeView('日本', { colorLevel: 1 }).width).to.equal(6);
      expect(stringWidth(badge('日本', { colorLevel: 0 }))).to.equal(6);
    });
  });

  describe('the colour', () => {
    it('should put the variant role behind the label by inverting it', () => {
      expect(params(badge('x', { colorLevel: 1, variant: 'success' }))).to.equal('7;32');
      expect(params(badge('x', { colorLevel: 1, variant: 'error' }))).to.equal('7;31');
      expect(params(badge('x', { colorLevel: 1, variant: 'warning' }))).to.equal('7;33');
      expect(params(badge('x', { colorLevel: 1, variant: 'info' }))).to.equal('7;34');
    });

    it('should invert the terminal foreground for a neutral badge', () => {
      expect(params(badge('x', { colorLevel: 1 }))).to.equal('7');
    });

    it('should paint the padding as well as the label', () => {
      const out = badge('x', { colorLevel: 1, variant: 'success' });

      expect(out.endsWith(`${ESC}[0m`)).to.equal(true);
      expect(out.slice(out.indexOf('m') + 1, out.lastIndexOf(ESC))).to.equal(' x ');
    });

    it('should take a role from a theme rather than from the component', () => {
      const out = badge('x', {
        colorLevel: 1,
        theme: '.sigil-success { color: magenta }',
        variant: 'success',
      });

      expect(params(out)).to.equal('7;35');
    });

    it('should let a theme restyle the badge class alone', () => {
      const out = badge('x', {
        colorLevel: 1,
        theme: '.sigil-badge { inverse: false }',
        variant: 'success',
      });

      expect(params(out)).to.equal('32');
    });

    it('should carry the variant on a class of its own for a theme to reach', () => {
      const theme = '.sigil-badge-error { font-weight: bold }';

      expect(params(badge('x', { colorLevel: 1, theme, variant: 'error' }))).to.contain('1');
      expect(params(badge('x', { colorLevel: 1, theme, variant: 'info' }))).not.to.contain('1;');
    });
  });

  describe('as a table cell', () => {
    const rows = [
      ['build', badgeView('PASS', { colorLevel: 1, variant: 'success' })],
      ['lint', badgeView('FAIL', { colorLevel: 1, variant: 'error' })],
      ['docs', 'n/a'],
    ];

    it('should keep its colour, which a string cell cannot', () => {
      const out = table(rows, { colorLevel: 1 });

      expect(out).to.contain(`${ESC}[7;32m PASS ${ESC}[0m`);
      expect(out).to.contain(`${ESC}[7;31m FAIL ${ESC}[0m`);
    });

    it('should size the column by the badge', () => {
      expect(strip(table(rows, { colorLevel: 1 })).split('\n')).to.deep.equal([
        'build   PASS ',
        'lint    FAIL ',
        'docs   n/a',
      ]);
    });

    it('should align a badge by its column', () => {
      const out = table(
        [
          [badgeView('ok', { colorLevel: 0 }), 'a'],
          [badgeView('failing', { colorLevel: 0 }), 'b'],
        ],
        { colorLevel: 0, columns: [{ align: 'right' }, {}] }
      );

      expect(out.split('\n')).to.deep.equal(['     [ok]  a', '[failing]  b']);
    });

    it('should cut a badge wider than its column at the column', () => {
      const out = table([[badgeView('failing', { colorLevel: 0 })]], {
        colorLevel: 0,
        columns: [{ maxWidth: 5 }],
      });

      expect(out).to.equal('[fail');
    });

    it('should leave a string cell with an escape sequence as plain text', () => {
      expect(table([[`${ESC}[31mred${ESC}[0m`]], { colorLevel: 1 })).not.to.contain(ESC);
    });

    it('should not take a width that is not a number as a view', () => {
      const { element } = badgeView('x', { colorLevel: 0 });

      expect(table([[{ element, width: Number.NaN }]], { colorLevel: 0 })).to.equal(
        '[object Object]'
      );
    });

    it('should read an object that is not a view as a value to print', () => {
      expect(table([[{ width: 3 }]], { colorLevel: 0 })).to.equal('[object Object]');
    });
  });
});
