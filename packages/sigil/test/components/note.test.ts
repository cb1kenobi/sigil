import { strip } from '../../src/ansi/index.js';
import { type NoteOptions, note, noteView, unicodeSupported } from '../../src/components/note.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A note, read as the lines it prints.
 *
 * `env` is pinned to an empty one so that what a developer's own `TERM` says
 * cannot decide the border a test sees, and the colour level to none so the
 * lines are plain unless a test asks for colour.
 */
function lines(message: string, opts: NoteOptions = {}): string[] {
  return note(message, { colorLevel: 0, env: {}, width: 40, ...opts }).split('\n');
}

/** The width of every line, which for a block is one number. */
function widths(rows: string[]): number[] {
  return [...new Set(rows.map((row) => stringWidth(row)))];
}

const ESC = String.fromCharCode(0x1b);

describe('note()', () => {
  describe('the block', () => {
    it('should shrink to its message rather than fill the line', () => {
      expect(lines('Short')).to.deep.equal(['╭───────╮', '│ Short │', '╰───────╯']);
    });

    it('should grow with the longest line of the message', () => {
      const rows = lines('a\nlonger line\nb');

      expect(widths(rows)).to.deep.equal([stringWidth('longer line') + 4]);
    });

    it('should wrap at the width it was given and stay a rectangle', () => {
      const rows = lines('one two three four five six seven eight nine ten', { width: 20 });

      expect(rows.length).to.be.greaterThan(3);
      expect(widths(rows)).to.deep.equal([20]);
    });

    it('should never be wider than the width it was given', () => {
      const rows = lines('x'.repeat(100), { title: 'a title', width: 30 });

      expect(Math.max(...rows.map((row) => stringWidth(row)))).to.equal(30);
    });

    it('should keep the line breaks, the blank lines and the indentation of the message', () => {
      expect(lines('Next:\n\n  $ npm install')).to.deep.equal([
        '╭─────────────────╮',
        '│ Next:           │',
        '│                 │',
        '│   $ npm install │',
        '╰─────────────────╯',
      ]);
    });

    it('should read a carriage return and a line feed as one line break', () => {
      expect(lines('a\r\nb')).to.deep.equal(lines('a\nb'));
    });

    it('should align the border around wide characters', () => {
      const rows = lines('日本語のテキスト and some more words that wrap', { width: 24 });

      expect(widths(rows)).to.deep.equal([24]);
      expect(
        rows.every((row) => row.endsWith('│') || row.endsWith('╮') || row.endsWith('╯'))
      ).to.equal(true);
    });

    it('should align the border around an emoji and a combining mark', () => {
      const rows = lines('👨‍👩‍👧 family\né acute');

      expect(widths(rows)).to.have.length(1);
    });

    it('should drop escape sequences from the message, because colour is a role', () => {
      const styled = `${ESC}[31mred${ESC}[39m and ${ESC}[1mbold${ESC}[22m`;

      expect(lines(styled)).to.deep.equal(lines('red and bold'));
    });

    it('should indent the whole block', () => {
      const rows = lines('x', { indent: 3 });

      expect(rows.every((row) => row.startsWith('   '))).to.equal(true);
      expect(rows[0]).to.equal('   ╭───╮');
    });

    it('should draw a block for an empty message', () => {
      expect(lines('')).to.deep.equal(['╭──╮', '│  │', '╰──╯']);
    });

    it('should keep one column for the message however narrow it is told to be', () => {
      expect(lines('hello', { title: 'title', width: 2 })).to.deep.equal([
        '╭───╮',
        '│ h │',
        '│ e │',
        '│ l │',
        '│ l │',
        '│ o │',
        '╰───╯',
      ]);
    });
  });

  describe('the title', () => {
    it('should sit in the top border, one rule away from the corner', () => {
      expect(lines('hello there, this is long', { title: 'Next steps' })[0]).to.equal(
        '╭─ Next steps ──────────────╮'
      );
    });

    it('should centre in the top border', () => {
      const top = lines('a message that is long enough', { title: 'Mid', titleAlign: 'center' })[0];

      expect(top).to.equal('╭───────────── Mid ─────────────╮');
    });

    it('should sit at the right of the top border', () => {
      const top = lines('a message that is long enough', { title: 'End', titleAlign: 'right' })[0];

      expect(top).to.equal('╭───────────────────────── End ─╮');
    });

    it('should widen a short message to hold its title', () => {
      expect(lines('x', { title: 'A longer title' })).to.deep.equal([
        '╭─ A longer title ─╮',
        '│ x                │',
        '╰──────────────────╯',
      ]);
    });

    it('should measure a wide title in columns', () => {
      const rows = lines('x', { title: '日本語' });

      expect(rows[0]).to.equal('╭─ 日本語 ─╮');
      expect(widths(rows)).to.have.length(1);
    });

    it('should cut a title that cannot fit and say so', () => {
      const rows = lines('x', { title: 'A very long title that cannot possibly fit', width: 20 });

      expect(rows[0]).to.contain('…');
      expect(widths(rows)).to.deep.equal([20]);
    });

    it('should read a title as one line without escape sequences', () => {
      const messy = `${ESC}[1mFirst${ESC}[22m\n  second`;

      expect(lines('x', { title: messy })[0]).to.equal(lines('x', { title: 'First second' })[0]);
    });

    it('should draw no title row for a blank title', () => {
      expect(lines('x', { title: '  ' })).to.deep.equal(lines('x'));
    });

    it('should leave the title out where the corners would have to hold it', () => {
      expect(lines('x', { title: 'title', width: 8 })).to.deep.equal(lines('x', { width: 8 }));
    });

    it('should leave no no-break space in what it prints', () => {
      expect(note('x', { colorLevel: 0, env: {}, title: 'Hi' })).to.not.contain(' ');
    });
  });

  describe('the border', () => {
    it('should be rounded by default', () => {
      expect(lines('x')[0]).to.equal('╭───╮');
    });

    it('should fall back to ASCII where the terminal cannot be trusted with box drawing', () => {
      expect(lines('x', { env: { TERM: 'linux' } })).to.deep.equal(['+---+', '| x |', '+---+']);
      expect(lines('x', { env: { TERM: 'dumb' } })[0]).to.equal('+---+');
    });

    it('should fall back to ASCII on a Windows console that is not known to cope', () => {
      expect(lines('x', { env: {}, platform: 'win32' })[0]).to.equal('+---+');
      expect(lines('x', { env: { WT_SESSION: 'abc' }, platform: 'win32' })[0]).to.equal('╭───╮');
    });

    it('should honour an explicit border over what it detected', () => {
      expect(lines('x', { border: 'double', env: { TERM: 'linux' } })[0]).to.equal('╔═══╗');
      expect(lines('x', { border: 'single' })[0]).to.equal('┌───┐');
      expect(lines('x', { border: 'bold' })[0]).to.equal('┏━━━┓');
      expect(lines('x', { border: 'ascii' })[0]).to.equal('+---+');
    });

    it('should keep the title whole in an ASCII border', () => {
      expect(lines('x', { border: 'ascii', title: 'Hi' })[0]).to.equal('+- Hi -+');
    });
  });

  describe('the variants', () => {
    const colour = { colorLevel: 1 as const };

    it('should draw a plain note with no colour at all', () => {
      expect(note('x', { ...colour, env: {} })).to.not.contain(ESC);
    });

    it.each([
      ['error', '31'],
      ['success', '32'],
      ['warning', '33'],
      ['info', '34'],
    ] as const)(
      'should take the %s colour from its role, on the border and the message',
      (variant, sgr) => {
        const out = note('x', { ...colour, env: {}, variant });
        const [top, middle] = out.split('\n');

        expect(top).to.contain(`${ESC}[${sgr}m`);
        expect(middle).to.contain(`${ESC}[${sgr}m`);
      }
    );

    it('should draw no colour at colour level 0, whatever the variant', () => {
      expect(note('x', { colorLevel: 0, env: {}, variant: 'error' })).to.not.contain(ESC);
    });

    it('should let a theme restyle a variant through its role', () => {
      const out = note('x', {
        ...colour,
        env: {},
        theme: '.sigil-error { color: magenta; border-color: magenta }',
        variant: 'error',
      });

      expect(out).to.contain(`${ESC}[35m`);
      expect(out).to.not.contain(`${ESC}[31m`);
    });

    it('should let a theme restyle only the border of a variant', () => {
      const out = note('x', {
        ...colour,
        env: {},
        theme: '.sigil-note-error { border-color: cyan }',
        variant: 'error',
      });
      const [top, middle] = out.split('\n');

      expect(top).to.contain(`${ESC}[36m`);
      expect(middle).to.contain(`${ESC}[36m`);
      expect(middle).to.contain(`${ESC}[31m`);
    });

    it('should print the same text for every variant', () => {
      for (const variant of ['note', 'info', 'success', 'warning', 'error'] as const) {
        expect(strip(note('x', { ...colour, env: {}, variant }))).to.equal(
          lines('x', { width: 80 }).join('\n')
        );
      }
    });

    it('should bold the title through the heading role', () => {
      const out = note('x', { ...colour, env: {}, title: 'T' });

      expect(out.split('\n')[0]).to.contain(`${ESC}[1m`);
    });
  });
});

describe('noteView()', () => {
  it('should return a tree and the width it was built for', () => {
    const { element, width } = noteView('hello', { env: {}, indent: 2, width: 50 });

    expect(element.type).to.equal('box');
    expect(width).to.equal(50);
  });

  it('should default to the terminal width', () => {
    expect(noteView('hello', { env: { COLUMNS: '33' } }).width).to.equal(33);
  });
});

describe('unicodeSupported()', () => {
  it('should trust everything but the Linux console and a dumb terminal off Windows', () => {
    expect(unicodeSupported({ TERM: 'xterm-256color' }, 'linux')).to.equal(true);
    expect(unicodeSupported({}, 'darwin')).to.equal(true);
    expect(unicodeSupported({ TERM: 'linux' }, 'linux')).to.equal(false);
    expect(unicodeSupported({ TERM: 'dumb' }, 'darwin')).to.equal(false);
  });

  it('should trust only the Windows terminals known to cope', () => {
    expect(unicodeSupported({}, 'win32')).to.equal(false);
    expect(unicodeSupported({ WT_SESSION: '1' }, 'win32')).to.equal(true);
    expect(unicodeSupported({ TERM_PROGRAM: 'vscode' }, 'win32')).to.equal(true);
  });
});
