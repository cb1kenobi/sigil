import {
  commandRow,
  consoleRows,
  copiedText,
  glyphRows,
  plainText,
  shellRows,
  tighten,
  type Row,
} from '../src/lib/terminal-rows.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ESC = '\u001b';
const text = (row: Row) => row.spans.map((span) => span.text).join('');
const classOf = (row: Row, piece: string) =>
  row.spans.find((span) => span.text === piece)?.className;

describe('glyphRows()', () => {
  it('should draw a `$` line as a dim prompt and command', () => {
    const [row] = glyphRows('$ my-cli hello');

    assert.equal(row!.command, 'my-cli hello');
    assert.deepEqual(row!.spans, [
      { className: 'text-dim', text: '$ ' },
      { className: 'text-dim', text: 'my-cli hello' },
    ]);
  });

  it('should colour the status glyph and leave the message alone', () => {
    const rows = glyphRows('✔ Added\n✖ Title needs a terminal\n▲ Deprecated\n⚠ Careful\nℹ Note');

    assert.deepEqual(
      rows.map((row) => row.spans[0]!.className),
      ['text-term-green', 'text-term-red', 'text-term-yellow', 'text-term-yellow', 'text-term-blue']
    );
    assert.deepEqual(rows[0]!.spans[1], { text: ' Added' });
  });

  it('should colour an indented glyph and keep the indent', () => {
    const [row] = glyphRows('  ✔ us-east-1');
    assert.deepEqual(row!.spans.slice(0, 2), [
      { text: '  ' },
      { className: 'text-term-green', text: '✔' },
    ]);
  });

  it('should draw the accent glyphs and a spinner frame in the accent', () => {
    const rows = glyphRows('? Regions\n› ap-southeast-2\n◆ deploy\n⠋ Installing');
    assert.deepEqual(
      rows.map((row) => row.spans[0]!.className),
      ['text-term-accent', 'text-term-accent', 'text-term-accent', 'text-term-accent']
    );
  });

  it('should not read a question mark inside a word as a prompt', () => {
    assert.equal(glyphRows('?foo')[0]!.spans[0]!.className, undefined);
  });

  it('should draw a help heading bold in fg-strong, and only the heading of a usage line', () => {
    const [heading, usage] = glyphRows('Global options:\nUsage: my-cli [options] <command>');

    assert.deepEqual(heading!.spans, [
      { className: 'font-bold text-fg-strong', text: 'Global options:' },
    ]);
    assert.equal(classOf(usage!, 'Usage:'), 'font-bold text-fg-strong');
    assert.equal(classOf(usage!, ' my-cli [options] <command>'), undefined);
  });

  it('should not read an error message as a heading', () => {
    assert.equal(glyphRows('Error: Invalid integer: lots')[0]!.spans[0]!.className, undefined);
  });

  it('should draw key=value fields dim', () => {
    const [row] = glyphRows('✔ Added title="Renew passport" ms=412');

    assert.equal(classOf(row!, 'title="Renew passport"'), 'text-dim');
    assert.equal(classOf(row!, 'ms=412'), 'text-dim');
    assert.equal(text(row!), '✔ Added title="Renew passport" ms=412');
  });

  it('should draw an elision dim, since the program did not print it', () => {
    assert.deepEqual(glyphRows('...')[0]!.spans, [{ className: 'text-dim', text: '...' }]);
  });
});

describe('tighten()', () => {
  it('should tighten a run of block rows so that they join up', () => {
    // the seal's half-block banner, as the design draws it
    const rows = glyphRows('$ sigil\n\n█▀▀▀▀██  sigil\n█ ▀▀▀▀█\n██▀▀▀ █\n▀▀▀▀▀▀▀\n\nUsage:');

    assert.deepEqual(
      rows.map((row) => row.tight === true),
      [false, false, true, true, true, true, false, false]
    );
  });

  it('should leave a lone row of blocks alone, which is a progress bar', () => {
    const rows = glyphRows('Installing\n████░░░░ 50%\ndone');
    assert.deepEqual(
      rows.map((row) => row.tight === true),
      [false, false, false]
    );
  });

  it('should not mark rows with no blocks in them', () => {
    assert.equal(
      tighten([{ spans: [{ text: '─────' }] }, { spans: [{ text: '│ x │' }] }]).some(
        (row) => row.tight
      ),
      false
    );
  });
});

describe('shellRows()', () => {
  it('should prompt every command, and draw the command at full strength', () => {
    const [row] = shellRows('npx @ttylabs/cli new my-cli');
    assert.deepEqual(row!.spans, [
      { className: 'text-dim', text: '$ ' },
      { text: 'npx @ttylabs/cli new my-cli' },
    ]);
  });

  it('should give a comment and a continuation no prompt', () => {
    const rows = shellRows('# make it\nnpm install \\\n  --save-exact\n\nnpm test');

    assert.deepEqual(
      rows.map((row) => row.command),
      [undefined, 'npm install \\', undefined, undefined, 'npm test']
    );
    assert.equal(rows[0]!.spans[0]!.className, 'text-dim');
  });
});

describe('consoleRows()', () => {
  const help = `${ESC}[1mUsage: ${ESC}[22mmy-cli <command>`;
  const lookup = (command: string, output: string) =>
    command === 'my-cli --help' && output === 'Usage: my-cli <command>' ? help : undefined;

  it('should draw a run from its capture when the capture says what the page says', () => {
    const rows = consoleRows('$ my-cli --help\nUsage: my-cli <command>', lookup);

    assert.equal(rows[0]!.command, 'my-cli --help');
    // the capture's spans: `Usage: ` with its trailing space inside the bold,
    // which the glyph rules would have drawn without it
    assert.deepEqual(rows[1]!.spans[0], { className: 'text-fg-strong font-bold', text: 'Usage: ' });
  });

  it('should fall back to the glyph rules when the text has moved on from the capture', () => {
    const rows = consoleRows('$ my-cli --help\nUsage: my-cli [options] <command>', lookup);
    assert.deepEqual(rows[1]!.spans[0], { className: 'font-bold text-fg-strong', text: 'Usage:' });
  });

  it('should draw output before the first command by the glyph rules', () => {
    const rows = consoleRows('✔ ready\n$ my-cli hello\nhello world', () => undefined);
    assert.deepEqual(rows.map(text), ['✔ ready', '$ my-cli hello', 'hello world']);
  });

  it('should keep a command that printed nothing as its row alone', () => {
    assert.deepEqual(consoleRows('$ my-cli a\n$ my-cli b', () => undefined).map(text), [
      '$ my-cli a',
      '$ my-cli b',
    ]);
  });
});

describe('what a reader copies', () => {
  it('should be the plain text when selected, one line per row', () => {
    const rows = consoleRows(
      `$ my-cli --help\nUsage: my-cli <command>`,
      () => `${ESC}[1mUsage:${ESC}[0m my-cli <command>`
    );
    assert.equal(plainText(rows), '$ my-cli --help\nUsage: my-cli <command>');
  });

  it('should be the commands without prompts for the Copy button', () => {
    const rows = glyphRows('$ my-cli hello\nhello world\n$ my-cli hello Ada\nhello Ada');
    assert.equal(copiedText(rows), 'my-cli hello\nmy-cli hello Ada');
  });

  it('should be the output for a block with no command in it', () => {
    assert.equal(copiedText(glyphRows('✔ Added\n✖ Failed')), '✔ Added\n✖ Failed');
  });

  it('should carry the command a row echoes', () => {
    assert.equal(commandRow('npm test').command, 'npm test');
  });
});
