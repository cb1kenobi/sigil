import { CellBuffer, Painter, StyleTable } from '../../src/canvas/index.js';
import {
  arrange,
  box,
  paint,
  renderToString,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A link on a text: `href`, painted as an OSC 8 hyperlink over its glyphs.
 *
 * The canvas has carried a link in every cell's style since the cell grid was
 * written, and nothing above it could set one -- the painter wrote `link: ''`
 * for every element. `href` is the reserved name that reaches it.
 */

const ESC = String.fromCharCode(0x1b);
const open = (url: string): string => `${ESC}]8;;${url}${ESC}\\`;
const CLOSE = open('');

/** The link in each cell of the first row, painted at a width. */
function links(root: ReturnType<typeof box>, width: number): string[] {
  resolveStyles(root);
  arrange(root, { height: 1, width });
  const styles = new StyleTable();
  const buffer = new CellBuffer(width, 1);
  paint(root, new Painter(buffer, styles));
  return Array.from({ length: width }, (_, x) => styles.get(buffer.styleAt(x, 0)).link);
}

describe('href', () => {
  it('should wrap the text it is on in an OSC 8 hyperlink', () => {
    expect(
      renderToString(text('docs', { href: 'https://example.com' }), { colorLevel: 3, width: 10 })
    ).to.equal(`${open('https://example.com')}docs${CLOSE}`);
  });

  it('should be read back off the element', () => {
    expect(text('x', { href: 'https://example.com' }).href).to.equal('https://example.com');
    expect(text('x').href).to.equal('');
  });

  it('should go on the glyphs the text draws and nothing else', () => {
    const row = box({ 'column-gap': 1 }, text('ab', { href: 'https://a' }), text('cd'));

    expect(links(row, 6)).to.deep.equal(['https://a', 'https://a', '', '', '', '']);
  });

  // the cells a link covers are the cells its words draw, so a box has none of
  // its own to give one
  it('should not be inherited by what a box holds', () => {
    const row = box({ href: 'https://a' }, text('ab'));

    expect(links(row, 2)).to.deep.equal(['', '']);
  });

  it('should follow a change made after the element was built', () => {
    const it = text('ab', { href: 'https://a' });
    it.setProps({ href: 'https://b' });

    expect(links(box({}, it), 2)).to.deep.equal(['https://b', 'https://b']);
    it.setProps({ href: undefined });
    expect(links(box({}, it), 2)).to.deep.equal(['', '']);
  });

  // level 0 is "write no escape sequences at all", and the cascade cannot drop
  // a link for it the way it drops a colour, because a link is not style
  it('should leave the link out of a string at colour level 0', () => {
    expect(
      renderToString(text('docs', { href: 'https://example.com' }), { colorLevel: 0, width: 10 })
    ).to.equal('docs');
  });

  // an OSC sequence runs until its terminator, so one inside the URL ends it
  // early and the rest reaches the terminal as commands
  it('should refuse a URL holding a control character where it is given', () => {
    expect(() => text('x', { href: `https://a${ESC}]2;pwned` })).to.throw(TypeError, /control/);
    expect(() => text('x').setProps({ href: 'https://a\u0007' })).to.throw(TypeError, /control/);
  });
});
