import { highlight, THEME } from '../src/lib/highlight.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

/** Every token a line is drawn in, by its text. */
function colours(code: string, lang = 'ts'): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const token of (highlight(code, lang) ?? []).flat()) {
    out[token.text.trim()] = token.italic ? `${token.color} italic` : token.color;
  }
  return out;
}

describe('the sigil theme', () => {
  it('should name only colours globals.css declares, which is where they are', () => {
    const named = JSON.stringify(THEME).match(/var\(--color-[\w-]+\)/g) ?? [];

    assert.ok(named.length >= 6);
    for (const name of new Set(named)) {
      const token = name.slice('var('.length, -1);
      assert.match(css, new RegExp(`${token}:\\s*#`), `${token} is not declared in globals.css`);
    }
  });

  it('should colour the five kinds and leave everything else plain', () => {
    const drawn = colours("// note\nexport default command({ retries: 3, name: 'x' });");

    assert.equal(drawn['// note'], 'var(--color-syn-comment) italic');
    assert.equal(drawn.export, 'var(--color-syn-keyword)');
    assert.equal(drawn.default, 'var(--color-syn-keyword)');
    assert.equal(drawn.command, 'var(--color-syn-function)');
    assert.equal(drawn['3'], 'var(--color-syn-number)');
    assert.equal(drawn["'x'"], 'var(--color-syn-string)');
    assert.equal(drawn['retries:'], undefined);
  });

  it('should leave operators and the arrow plain, but colour the operators that are words', () => {
    const drawn = colours('const f = () => new Map();\ntypeof f;');

    assert.equal(drawn['='], undefined);
    assert.equal(drawn['=>'], undefined);
    assert.equal(drawn.new, 'var(--color-syn-keyword)');
    assert.equal(drawn.typeof, 'var(--color-syn-keyword)');
  });

  it('should leave a language it does not know uncoloured rather than guess', () => {
    assert.equal(highlight('my-cli/\n  src/', undefined), undefined);
    assert.equal(highlight('x', 'cobol'), undefined);
  });

  it('should keep every line, blank ones included', () => {
    assert.equal(highlight('a;\n\nb;', 'js')?.length, 3);
  });
});
