import { strip } from '../../src/ansi/index.js';
import { rule, type RuleOptions, ruleView } from '../../src/components/rule.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A rule, read as the line it prints.
 *
 * `env` is pinned to an empty one so that what a developer's own `TERM` says
 * cannot decide the character a test sees, and the colour level to none so the
 * line is plain unless a test asks for colour.
 */
function line(opts: RuleOptions = {}): string {
  return rule({ colorLevel: 0, env: {}, platform: 'linux', width: 20, ...opts });
}

describe('rule()', () => {
  describe('the line', () => {
    it('should span the width it was given', () => {
      expect(line({ width: 12 })).to.equal('─'.repeat(12));
    });

    it('should be one row with no trailing newline', () => {
      expect(line()).to.not.include('\n');
    });

    it('should span the terminal when no width is given', () => {
      expect(stringWidth(line({ width: undefined, env: { COLUMNS: '33' } }))).to.equal(33);
    });

    it('should read a width that is not a number as no width', () => {
      expect(stringWidth(line({ width: Number.NaN, env: { COLUMNS: '17' } }))).to.equal(17);
    });

    it('should draw a single column for a width under one', () => {
      expect(line({ width: 0, env: { COLUMNS: '9' } })).to.equal('─'.repeat(9));
      expect(line({ width: 1 })).to.equal('─');
    });

    it('should floor a fractional width', () => {
      expect(stringWidth(line({ width: 10.9 }))).to.equal(10);
    });
  });

  describe('the line style', () => {
    it.each([
      ['single', '─'],
      ['double', '═'],
      ['bold', '━'],
      ['ascii', '-'],
    ] as const)('should draw %s with %s', (style, char) => {
      expect(line({ line: style, width: 5 })).to.equal(char.repeat(5));
    });

    it('should fall back to ASCII where the terminal cannot draw box characters', () => {
      expect(line({ env: { TERM: 'linux' }, width: 5 })).to.equal('-----');
      expect(line({ env: { TERM: 'dumb' }, width: 5 })).to.equal('-----');
    });

    it('should fall back to ASCII on a Windows console not known to cope', () => {
      expect(line({ env: {}, platform: 'win32', width: 5 })).to.equal('-----');
    });

    it('should let an explicit line style beat the fallback', () => {
      expect(line({ env: { TERM: 'dumb' }, line: 'double', width: 3 })).to.equal('═══');
    });
  });

  describe('the label', () => {
    it('should centre, with the odd cell on the right', () => {
      expect(line({ label: 'Mid' })).to.equal('─────── Mid ────────');
    });

    it('should sit at the left, two cells in', () => {
      expect(line({ align: 'left', label: 'Start' })).to.equal('── Start ───────────');
    });

    it('should sit at the right, two cells in', () => {
      expect(line({ align: 'right', label: 'End' })).to.equal('───────────── End ──');
    });

    it('should span the width whatever the alignment', () => {
      for (const align of ['left', 'center', 'right'] as const) {
        expect(stringWidth(line({ align, label: 'Build', width: 31 }))).to.equal(31);
      }
    });

    it('should measure a wide label in columns', () => {
      const out = line({ label: '日本語', width: 21 });

      expect(stringWidth(out)).to.equal(21);
      expect(out).to.include(' 日本語 ');
    });

    it('should measure an emoji and a combining mark in columns', () => {
      expect(stringWidth(line({ label: '👨‍👩‍👧 é', width: 24 }))).to.equal(24);
    });

    it('should cut a label that is too long, and still span the width', () => {
      const out = line({ label: 'a label that is far too long', width: 16 });

      expect(stringWidth(out)).to.equal(16);
      expect(out).to.include('…');
      expect(out.startsWith('─')).to.equal(true);
      expect(out.endsWith('─')).to.equal(true);
    });

    it('should keep a line cell at each end of a centred label however much is cut', () => {
      const out = line({ label: 'x'.repeat(50), width: 12 });

      expect(out[0]).to.equal('─');
      expect(out.at(-1)).to.equal('─');
    });

    it('should keep the two cells and the one at the ends of an aligned label', () => {
      expect(line({ align: 'left', label: 'x'.repeat(50), width: 12 })).to.match(/^── .+ ─$/);
      expect(line({ align: 'right', label: 'x'.repeat(50), width: 12 })).to.match(/^─ .+ ──$/);
    });

    it('should go without the label where there is no room for the line around it', () => {
      expect(line({ label: 'Hi', width: 4 })).to.equal('────');
      expect(line({ label: 'Hi', width: 5 })).to.equal('─────');
      expect(line({ align: 'left', label: 'Hi', width: 6 })).to.equal('──────');
      expect(line({ align: 'left', label: 'Hi', width: 7 })).to.equal('── Hi ─');
      expect(line({ align: 'right', label: 'Hi', width: 7 })).to.equal('─ Hi ──');
    });

    it('should draw no label for an empty or blank one', () => {
      expect(line({ label: '' })).to.equal('─'.repeat(20));
      expect(line({ label: '  \n ' })).to.equal('─'.repeat(20));
    });

    it('should read a label as one line, with its escape sequences dropped', () => {
      const ESC = String.fromCharCode(0x1b);

      expect(line({ label: `${ESC}[31mred${ESC}[39m\nand\tblue` })).to.equal(
        line({ label: 'red and blue' })
      );
    });

    it('should draw the label in the line style of the rest', () => {
      expect(line({ label: 'Mid', line: 'ascii' })).to.equal('------- Mid --------');
      expect(line({ label: 'Mid', line: 'double' })).to.equal('═══════ Mid ════════');
    });
  });

  describe('colour', () => {
    const RED = `${String.fromCharCode(0x1b)}[31m`;

    it('should draw nothing in colour at colour level 0', () => {
      expect(line({ label: 'Mid', role: 'error' })).to.equal(strip(line({ label: 'Mid' })));
    });

    it('should dim the line by default, because a divider recedes', () => {
      const out = rule({ colorLevel: 1, env: {}, platform: 'linux', width: 6 });

      expect(out).to.include(`${String.fromCharCode(0x1b)}[2m`);
    });

    it('should colour the line and the label in a state role, and dim neither', () => {
      const out = rule({
        colorLevel: 1,
        env: {},
        label: 'Fail',
        platform: 'linux',
        role: 'error',
        width: 20,
      });

      // one run of red, which is the line and the label both: a colour is the
      // whole rule's, and only the muted default takes the label out of it
      expect(out.startsWith(RED)).to.equal(true);
      expect(out).to.not.include(`${String.fromCharCode(0x1b)}[2m`);
      expect(strip(out)).to.equal(line({ label: 'Fail' }));
    });

    it('should not dim a label, because the words are the one part meant to be read', () => {
      const out = rule({ colorLevel: 1, env: {}, label: 'Words', platform: 'linux', width: 20 });
      const ESC = String.fromCharCode(0x1b);
      const dim = `${ESC}[2m`;

      // the line is dim and the label is bold, and a bold label that was dim as well
      // would be written as one run with the dim still open across it
      expect(out.startsWith(dim)).to.equal(true);
      expect(out).to.include(` ${ESC}[22;1mWords `);
    });

    it('should let a theme restyle the line through the role, and the label through its own class', () => {
      const out = rule({
        colorLevel: 1,
        env: {},
        label: 'Mid',
        platform: 'linux',
        theme: '.sigil-muted { dim: false; color: magenta } .sigil-rule-label { color: cyan }',
        width: 20,
      });
      const ESC = String.fromCharCode(0x1b);

      expect(out).to.include(`${ESC}[35m`);
      expect(out).to.match(new RegExp(`${ESC}\\[(?:1;)?36mMid`));
      expect(out).to.not.include(`${ESC}[2m`);
    });

    it('should draw in the terminal foreground for the none role', () => {
      const out = rule({ colorLevel: 1, env: {}, platform: 'linux', role: 'none', width: 6 });

      expect(out).to.equal('─'.repeat(6));
    });
  });
});

describe('ruleView()', () => {
  it('should hand back the room the tree was built for', () => {
    expect(ruleView({ env: {}, width: 40 }).width).to.equal(40);
  });

  it('should carry the classes a theme restyles it by', () => {
    const { element } = ruleView({ env: {}, label: 'Mid', platform: 'linux', width: 20 });

    expect(element.classes).to.deep.equal(['sigil-rule']);
    expect(element.children.map((child) => child.classes)).to.deep.equal([
      ['sigil-rule-line', 'sigil-muted'],
      ['sigil-rule-label', 'sigil-heading'],
      ['sigil-rule-line', 'sigil-muted'],
    ]);
  });
});

describe('ruleView() roles', () => {
  it('should put a colour role on the label as well as the line, and the muted default on the line alone', () => {
    const { element } = ruleView({ env: {}, label: 'Mid', platform: 'linux', role: 'warn' });

    expect(element.children.map((child) => child.classes)).to.deep.equal([
      ['sigil-rule-line', 'sigil-warn'],
      ['sigil-rule-label', 'sigil-heading', 'sigil-warn'],
      ['sigil-rule-line', 'sigil-warn'],
    ]);
  });

  it('should carry no role class at all for none', () => {
    const { element } = ruleView({ env: {}, label: 'Mid', platform: 'linux', role: 'none' });

    expect(element.children.map((child) => child.classes)).to.deep.equal([
      ['sigil-rule-line'],
      ['sigil-rule-label', 'sigil-heading'],
      ['sigil-rule-line'],
    ]);
  });
});
