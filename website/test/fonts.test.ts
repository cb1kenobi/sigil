import { terminalText, unicodeRange } from '../src/fonts/terminal-glyphs.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('the terminal glyph face', () => {
  it('should be declared over exactly the ranges fetch-fonts.ts asks Google Fonts for', () => {
    // `next/font` takes only literals, so layout.tsx writes the range out
    const layout = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
    const declared = /prop: 'unicode-range',\s*value: '([^']+)'/u.exec(layout)?.[1];

    assert.equal(declared, unicodeRange());
  });

  it('should come first in the mono stack, ahead of the latin face and its Arial fallback', () => {
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
    assert.match(css, /--font-mono:\s*var\(--font-jetbrains-terminal\), var\(--font-jetbrains\)/u);
  });

  it('should hold the box drawing and block elements a banner is drawn with', () => {
    for (const glyph of '─│╭╮╰╯█▀▄▌▐░◆▲') {
      assert.ok(terminalText().includes(glyph), glyph);
    }
  });
});
