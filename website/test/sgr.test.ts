import { sgrRows } from '../src/lib/sgr.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ESC = '\u001b';
const sgr = (params: string) => `${ESC}[${params}m`;

describe('sgrRows()', () => {
  it('should draw a help heading bold in fg-strong, and close it on 22', () => {
    // what sigil's own help prints, captured
    const [row] = sgrRows(`${sgr('1')}Usage: ${sgr('22')}my-cli [options] <command>`);

    assert.deepEqual(row!.spans, [
      { className: 'text-fg-strong font-bold', text: 'Usage: ' },
      { text: 'my-cli [options] <command>' },
    ]);
  });

  it('should draw a dim hint in the dim token', () => {
    const [row] = sgrRows(`Where to deploy it ${sgr('2')}(default: staging)${sgr('0')}`);
    assert.deepEqual(row!.spans.at(-1), { className: 'text-dim', text: '(default: staging)' });
  });

  it('should fold the sixteen colours onto the terminal tokens', () => {
    const colours = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96, 90, 97].map(
      (code) => sgrRows(`${sgr(String(code))}x`)[0]!.spans[0]!.className
    );

    assert.deepEqual(colours, [
      'text-term-red',
      'text-term-green',
      'text-term-yellow',
      'text-term-blue',
      'text-term-accent',
      'text-term-accent',
      'text-term-red',
      'text-term-green',
      'text-term-yellow',
      'text-term-blue',
      'text-term-accent',
      'text-term-accent',
      'text-dim',
      'text-fg-strong',
    ]);
  });

  it('should draw an inverted status colour as the badge for it', () => {
    // `demos/components/30-badge.js`, captured: PASS, FAIL and a warning
    const spans = sgrRows(
      `${sgr('7;32')} PASS ${sgr('0')} ${sgr('7;31')} FAIL ${sgr('0')} ${sgr('7;33')} SKIP ${sgr('0')}`
    )[0]!.spans;

    assert.deepEqual(
      spans.filter((span) => span.className).map((span) => span.className),
      [
        'bg-badge-pass text-brand-fg font-bold',
        'bg-badge-fail text-brand-fg font-bold',
        'bg-badge-beta text-brand-fg font-bold',
      ]
    );
  });

  it('should draw a plain or accent inverse as a selected choice', () => {
    assert.equal(
      sgrRows(`${sgr('7')} beta ${sgr('0')}`)[0]!.spans[0]!.className,
      'bg-term-select text-term-select-fg'
    );
    assert.equal(
      sgrRows(`${sgr('7;36')}› ap-southeast-2${sgr('0')}`)[0]!.spans[0]!.className,
      'bg-term-select text-term-select-fg'
    );
  });

  it("should end a badge on 27;39 as well as on a reset, which is sigil's table cell", () => {
    const spans = sgrRows(`${sgr('7;32')} PASS ${sgr('27;39')}  2.1s`)[0]!.spans;
    assert.deepEqual(spans.at(-1), { text: '  2.1s' });
  });

  it('should carry a style across a newline, the way a terminal does', () => {
    const rows = sgrRows(`${sgr('34')}one\ntwo${sgr('0')}\nthree`);

    assert.deepEqual(
      rows.map((row) => row.spans),
      [
        [{ className: 'text-term-blue', text: 'one' }],
        [{ className: 'text-term-blue', text: 'two' }],
        [{ text: 'three' }],
      ]
    );
  });

  it('should keep empty rows, one per blank line', () => {
    assert.deepEqual(
      sgrRows('a\n\nb').map((row) => row.spans.length),
      [1, 0, 1]
    );
  });

  it("should read T.416's six-parameter truecolor as one colour, not a colour and a reset", () => {
    // `38;2;;255;0;0` with an empty colour space: read as five, the trailing `0`
    // would be a reset and the bold would be gone
    const [span] = sgrRows(`${sgr('1;38;2;;255;0;0')}red`)[0]!.spans;
    assert.deepEqual(span, { className: 'font-bold', color: '#ff0000', text: 'red' });
  });

  it('should give a palette colour past the sixteen its exact value', () => {
    assert.equal(sgrRows(`${sgr('38;5;214')}x`)[0]!.spans[0]!.color, '#ffaf00');
    assert.equal(sgrRows(`${sgr('38;5;244')}x`)[0]!.spans[0]!.color, '#808080');
    // and one of the sixteen through the tokens, like any other
    assert.equal(sgrRows(`${sgr('38;5;2')}x`)[0]!.spans[0]!.className, 'text-term-green');
  });

  it('should read the colon form of an extended colour', () => {
    assert.equal(sgrRows(`${sgr('38:2::16:32:48')}x`)[0]!.spans[0]!.color, '#102030');
  });

  it('should keep the text of a hyperlink and draw nothing for the sequence', () => {
    const link = `${ESC}]8;;https://example.com${ESC}\\docs${ESC}]8;;${ESC}\\`;
    assert.deepEqual(sgrRows(`see ${link}`)[0]!.spans, [{ text: 'see docs' }]);
  });

  it('should drop a control character other than a tab', () => {
    assert.deepEqual(sgrRows('a\rb\tc\u0007')[0]!.spans, [{ text: 'ab\tc' }]);
  });

  it('should draw plain text as one span with no style', () => {
    assert.deepEqual(sgrRows('hello world'), [{ spans: [{ text: 'hello world' }] }]);
  });
});
