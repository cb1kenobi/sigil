import { rasterize } from '../src/rasterize.js';
import { screenshot } from '../src/screenshot.js';
import { escapeAttribute, escapeText, renderSvg, type SvgOptions } from '../src/svg.js';
import { frame, golden, showcase } from './helpers.js';
import { ATTR, CellBuffer, palette, rgb } from '@ttylabs/sigil/canvas';
import { decodePng } from '@ttylabs/sigil/png';
import { Screen } from '@ttylabs/sigil/testing';
import { describe, expect, it } from 'vitest';

/**
 * The SVG half: text the viewer draws over rectangles, links that survive, and
 * escaping that keeps the document a document.
 */

const OPTS: SvgOptions = { env: {} };

describe('the document', () => {
  it('should be one SVG sized to the grid, with the background behind everything', () => {
    const svg = renderSvg(new CellBuffer(10, 3), OPTS);
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="80" height="54" viewBox="0 0 80 54">/
    );
    expect(svg).toContain('<rect width="80" height="54" fill="#1e1e1e"/>');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('should be the same size as the PNG of the same frame', () => {
    const shot = showcase();
    const image = rasterize(shot, { ...OPTS, padding: 4, scale: 2 });
    const svg = renderSvg(shot, { ...OPTS, padding: 4, scale: 2 });
    expect(svg).toContain(`width="${image.width}" height="${image.height}"`);
  });

  it('should scale by the size it declares and keep its coordinates', () => {
    const svg = renderSvg(new CellBuffer(10, 3), { ...OPTS, scale: 2 });
    expect(svg).toContain('width="160" height="108" viewBox="0 0 80 54"');
  });

  it('should set the text in the font stack it was given', () => {
    expect(renderSvg(new CellBuffer(1, 1), OPTS)).toContain("'JetBrains Mono', ui-monospace");
    expect(renderSvg(new CellBuffer(1, 1), { ...OPTS, fontFamily: 'Iosevka' })).toContain(
      'font-family:Iosevka;'
    );
    expect(() => renderSvg(new CellBuffer(1, 1), { ...OPTS, fontFamily: ' ' })).toThrow(TypeError);
    expect(
      renderSvg(new CellBuffer(1, 1), { ...OPTS, fontFamily: '"Fira Code", mono-1.0' })
    ).toContain('font-family:"Fira Code", mono-1.0;');
  });

  it('should take a font name in any script', () => {
    // review round 2: `\w` is ASCII, and the whitelist refused real names
    for (const fontFamily of ['微软雅黑', '源ノ角ゴシック', 'Noto Sans CJK JP, monospace']) {
      expect(renderSvg(new CellBuffer(1, 1), { ...OPTS, fontFamily })).toContain(
        `font-family:${fontFamily};`
      );
    }
  });

  it('should refuse a font stack that would reach past its declaration', () => {
    // review round 1: a `;` or a `}` ends the declaration, and what follows is
    // a rule -- an `@import` an SVG opened in a browser fetches
    for (const fontFamily of [
      "Iosevka; } @import 'https://evil.test/x.css'; text { font-family: Iosevka",
      'x</style><script>alert(1)</script>',
      'a{}',
      'url(x)',
      'a\\b',
    ]) {
      expect(() => renderSvg(new CellBuffer(1, 1), { ...OPTS, fontFamily }), fontFamily).toThrow(
        TypeError
      );
    }
  });
});

describe('text', () => {
  it('should put a run of one look in one element, at its column and baseline', () => {
    const svg = renderSvg(
      frame(10, 1, (p) => p.text(2, 0, 'hello', { fg: palette(1) })),
      OPTS
    );
    expect(svg).toContain(
      '<text x="16" y="14" textLength="40" fill="#cd3131" xml:space="preserve">hello</text>'
    );
  });

  it('should break a run where the look changes', () => {
    const svg = renderSvg(
      frame(10, 1, (p) => {
        p.text(0, 0, 'ab');
        p.text(2, 0, 'cd', { attrs: ATTR.bold });
      }),
      OPTS
    );
    expect(svg).toContain('>ab</text>');
    expect(svg).toContain('font-weight="bold" xml:space="preserve">cd</text>');
  });

  it('should spell every attribute', () => {
    const svg = renderSvg(
      frame(4, 1, (p) =>
        p.text(0, 0, 'x', {
          attrs: ATTR.italic | ATTR.dim | ATTR.underline | ATTR.strikethrough | ATTR.overline,
        })
      ),
      OPTS
    );
    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain('fill-opacity="0.5"');
    expect(svg).toContain('text-decoration="underline line-through overline"');
  });

  it('should give a wide character the width of both its cells', () => {
    const svg = renderSvg(
      frame(4, 1, (p) => p.text(0, 0, '漢a')),
      OPTS
    );
    expect(svg).toContain('textLength="24"');
    expect(svg).toContain('>漢a</text>');
  });

  it('should leave out what is hidden and draw its background', () => {
    const svg = renderSvg(
      frame(6, 1, (p) => p.text(0, 0, 'secret', { attrs: ATTR.hidden, bg: palette(1) })),
      OPTS
    );
    expect(svg).not.toContain('secret');
    expect(svg).toContain('fill="#cd3131"');
  });

  it('should draw nothing for a run of spaces, unless it carries a line', () => {
    expect(
      renderSvg(
        frame(4, 1, (p) => p.text(0, 0, '    ')),
        OPTS
      )
    ).not.toContain('<text');
    expect(
      renderSvg(
        frame(4, 1, (p) => p.text(0, 0, '  ', { attrs: ATTR.underline })),
        OPTS
      )
    ).toContain('text-decoration="underline"');
  });

  it('should swap an inverse cell into the default colours', () => {
    const svg = renderSvg(
      frame(2, 1, (p) => p.text(0, 0, 'x', { attrs: ATTR.inverse })),
      OPTS
    );
    expect(svg).toContain('fill="#d4d4d4"/>');
    expect(svg).toContain('fill="#1e1e1e" xml:space="preserve">x</text>');
  });
});

describe('backgrounds', () => {
  it('should merge a run of one colour into one rectangle', () => {
    const svg = renderSvg(
      frame(10, 1, (p) => p.text(1, 0, '    ', { bg: rgb(1, 2, 3) })),
      OPTS
    );
    const rects = svg.match(/<rect [^>]*fill="#010203"\/>/g) ?? [];
    expect(rects).toEqual(['<rect x="8" y="0" width="32" height="18" fill="#010203"/>']);
  });

  it('should draw no rectangle for the default background', () => {
    const svg = renderSvg(
      frame(10, 1, (p) => p.text(0, 0, 'text')),
      OPTS
    );
    expect(svg.match(/<rect /g)).toHaveLength(1);
  });
});

describe('geometry', () => {
  it('should draw box drawing as rectangles rather than text', () => {
    const svg = renderSvg(
      frame(3, 1, (p) => p.text(0, 0, '───', { fg: palette(6) })),
      OPTS
    );
    expect(svg).not.toContain('<text');
    expect(svg).toContain('<g fill="#11a8cd">');
    // each line is its two arms, which meet at the center: every one on the
    // center row and a pixel high
    const rects = svg.match(/<g fill="#11a8cd">(.*)<\/g>/)?.[1].match(/<rect [^>]*>/g) ?? [];
    expect(rects).toHaveLength(6);
    for (const rect of rects) {
      expect(rect).toMatch(/ y="9" width="\d+" height="1"\/>$/);
    }
  });

  it('should draw an arc as a path', () => {
    expect(
      renderSvg(
        frame(1, 1, (p) => p.text(0, 0, '╭')),
        OPTS
      )
    ).toMatch(/<path d="M[^"]+Q[^"]+Z"\/>/);
  });

  it('should draw a shade at its opacity', () => {
    expect(
      renderSvg(
        frame(1, 1, (p) => p.text(0, 0, '▒')),
        OPTS
      )
    ).toContain('fill-opacity="0.5"');
  });
});

describe('links', () => {
  it('should keep a link as an anchor, escaped', () => {
    const svg = renderSvg(
      frame(6, 1, (p) => p.text(0, 0, 'docs', { link: 'https://example.com/?a=1&b=2' })),
      OPTS
    );
    expect(svg).toContain('<a href="https://example.com/?a=1&amp;b=2"><text');
    expect(svg).toContain('>docs</text></a>');
  });

  it('should drop a link whose scheme would run something, and keep the text', () => {
    const svg = renderSvg(
      frame(6, 1, (p) => p.text(0, 0, 'click', { link: 'javascript:alert(1)' })),
      OPTS
    );
    expect(svg).not.toContain('<a ');
    expect(svg).not.toContain('javascript');
    expect(svg).toContain('>click</text>');
  });

  it.each(['mailto:a@example.com', 'http://example.com', 'file:///tmp/x', 'ftp://example.com'])(
    'should keep %s',
    (link) => {
      expect(
        renderSvg(
          frame(2, 1, (p) => p.text(0, 0, 'x', { link })),
          OPTS
        )
      ).toContain('<a href=');
    }
  );

  it('should drop a link with a character that could end the attribute', () => {
    const svg = renderSvg(
      frame(2, 1, (p) => p.text(0, 0, 'x', { link: 'https://e.com/"x' })),
      OPTS
    );
    expect(svg).not.toContain('<a ');
  });
});

describe('escaping', () => {
  it('should escape what changes what a document means', () => {
    expect(escapeText('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
    expect(escapeAttribute(`"'<`)).toBe('&quot;&#39;&lt;');
  });

  it('should replace what XML cannot hold at all', () => {
    expect(escapeText('\uD800x￾￿\u0001\u0085')).toBe('�x����');
    // and leave an astral character alone
    expect(escapeText('🙂')).toBe('🙂');
  });

  it('should escape the text a frame holds', () => {
    const svg = renderSvg(
      frame(10, 1, (p) => p.text(0, 0, '<&> "x"')),
      OPTS
    );
    expect(svg).toContain('>&lt;&amp;&gt; "x"</text>');
  });
});

describe('screenshot()', () => {
  it('should be an SVG by default and a PNG when asked', () => {
    const shot = frame(4, 1, (p) => p.text(0, 0, 'hi'));
    expect(screenshot(shot, OPTS)).toBe(renderSvg(shot, OPTS));
    const png = screenshot(shot, { ...OPTS, format: 'png' });
    expect(png).toBeInstanceOf(Uint8Array);
    expect(decodePng(png)).toEqual(rasterize(shot, OPTS));
  });

  it('should refuse a format it does not write', () => {
    expect(() =>
      screenshot(new CellBuffer(1, 1), { format: 'gif' } as unknown as SvgOptions)
    ).toThrow(/format/);
  });

  it('should take a testing Screen', () => {
    const screen = new Screen(10, 2);
    screen.write('$ sigil\r\nok');
    const svg = screenshot(screen, OPTS);
    expect(svg).toContain('>$ sigil</text>');
    expect(svg).toContain('>ok</text>');
  });
});

describe('determinism', () => {
  it('should write the same document every time', () => {
    expect(renderSvg(showcase(), OPTS)).toBe(renderSvg(showcase(), OPTS));
  });

  it('should match the golden showcase', () => {
    golden('showcase.svg', renderSvg(showcase(), { ...OPTS, padding: 8 }));
  });

  it('should match the golden showcase, light', () => {
    golden(
      'showcase-light.svg',
      renderSvg(showcase(), { ...OPTS, colorScheme: 'light', padding: 8 })
    );
  });
});
