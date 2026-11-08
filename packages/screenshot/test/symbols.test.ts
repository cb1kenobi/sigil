import { loadFaces } from '../src/fonts.js';
import { isGeometry } from '../src/geometry.js';
import { readShot } from '../src/grid.js';
import { findGlyph } from '../src/rasterize.js';
import { frame } from './helpers.js';
import { ATTR } from '@ttylabs/sigil/canvas';
import * as components from '@ttylabs/sigil/components';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAst } from 'vitest/node';

/**
 * The guard: every character `@ttylabs/sigil`'s components can draw comes out
 * of a screenshot as itself -- from a bundled face, as geometry, or by the
 * fullwidth rule -- and never as the tofu box.
 *
 * The characters come from two places, and the first is the one that matters.
 *
 * - **What the components export.** Every data export of
 *   `@ttylabs/sigil/components` is walked for its strings -- the spinner sets,
 *   `OUTCOME_SYMBOLS`, `PROMPT_SYMBOLS`, `LOG_SYMBOLS`, decrypt's `CP437` and
 *   `ASCII`, `SPARK_BLOCKS` -- along with `treeGlyphs()` in every style, and the
 *   registry's `spinner-frames.ts`, the long tail of spinner sets that ships as a
 *   file for `sigil add` rather than as an export. Walked rather than named, so a
 *   new export is covered without anybody remembering to list it here.
 * - **The string literals of `packages/sigil/src/components/`**, because some of
 *   what a component draws is a module-private constant no import can reach:
 *   `markdown.ts`'s task-list boxes `☐` and `☒`, `group-multiselect.ts`'s
 *   partial `◐`, `group.ts`'s intro and outro marks. The alternative is driving
 *   every component through a renderer into every state it has, which is a
 *   test of the components rather than of the fonts. Narrowed to string and
 *   template literals by parsing, with vitest's own `parseAst()`: a comment's
 *   prose and a regex's character class are never drawn.
 *
 * Each character is then painted into a canvas and read back the way a
 * screenshot reads it, so the clusters and widths are the canvas's own: a
 * control is refused and a zero-width character never becomes a drawn cell,
 * and that is the canvas's decision rather than a list kept here.
 */

const sigil = dirname(createRequire(import.meta.url).resolve('@ttylabs/sigil/package.json'));

/** Every string inside a value: objects, arrays, maps and sets, recursively. */
function stringsIn(value: unknown, out: Set<string>, seen = new Set<unknown>()): void {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  const children =
    value instanceof Map
      ? [...value.keys(), ...value.values()]
      : value instanceof Set || Array.isArray(value)
        ? [...value]
        : Object.values(value);
  for (const child of children) {
    stringsIn(child, out, seen);
  }
}

/** The strings the components export, by import. */
async function exported(): Promise<Map<string, Set<string>>> {
  const sources = new Map<string, Set<string>>();
  const add = (name: string, value: unknown): void => {
    const strings = new Set<string>();
    stringsIn(value, strings);
    if (strings.size > 0) {
      sources.set(name, strings);
    }
  };
  for (const [name, value] of Object.entries(components)) {
    if (typeof value !== 'function') {
      add(name, value);
    }
  }
  for (const guide of ['plain', 'rounded'] as const) {
    for (const ascii of [false, true]) {
      add(`treeGlyphs('${guide}', ${String(ascii)})`, components.treeGlyphs(guide, ascii));
    }
  }
  const registry: Record<string, unknown> = await import(
    pathToFileURL(join(sigil, 'registry', 'spinner-frames.ts')).href
  );
  for (const [name, value] of Object.entries(registry)) {
    add(`spinner-frames ${name}`, value);
  }
  return sources;
}

/** The string literals of the components' source, by parsing it. */
function literals(): Map<string, Set<string>> {
  const dir = join(sigil, 'src', 'components');
  const sources = new Map<string, Set<string>>();
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .toSorted()) {
    const strings = new Set<string>();
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const record = node as Record<string, unknown>;
      if (record.type === 'Literal' && typeof record.value === 'string') {
        strings.add(record.value);
      } else if (record.type === 'TemplateElement') {
        const cooked = (record.value as { cooked?: string | null }).cooked;
        if (typeof cooked === 'string') {
          strings.add(cooked);
        }
      }
      for (const [key, child] of Object.entries(record)) {
        if (key !== 'type') {
          visit(child);
        }
      }
    };
    visit(parseAst(readFileSync(join(dir, file), 'utf8'), { lang: 'ts' }));
    if (strings.size > 0) {
      sources.set(`src/components/${file}`, strings);
    }
  }
  return sources;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * What a screenshot would draw as the tofu box, from a set of strings: each
 * cluster painted alone and read back as `rasterize()` reads it.
 */
function uncovered(sources: Map<string, Set<string>>): string[] {
  const faces = loadFaces();
  const clusters = new Map<string, string>();
  for (const [source, strings] of sources) {
    for (const text of strings) {
      for (const { segment } of segmenter.segment(text)) {
        // ASCII is the bundled face's by construction, and checked below anyway
        if (!clusters.has(segment) && /[^\x20-\x7e]/u.test(segment)) {
          clusters.set(segment, source);
        }
      }
    }
  }
  const out: string[] = [];
  for (const [cluster, source] of clusters) {
    let shot: ReturnType<typeof readShot>;
    try {
      shot = readShot(frame(4, 1, (p) => p.text(0, 0, cluster)));
    } catch (err) {
      // a control character is refused by the canvas rather than painted, so a
      // screenshot can never meet one: a newline in a message, the C1 range in
      // a sanitizer's own literals
      if (err instanceof RangeError && /control character/.test(err.message)) {
        continue;
      }
      throw err;
    }
    for (const cell of shot.cells) {
      if (cell.width === 0 || cell.char === ' ' || cell.char === '') {
        continue;
      }
      const base = cell.char.codePointAt(0) ?? 0;
      if (isGeometry(base)) {
        continue;
      }
      for (const attrs of [0, ATTR.bold, ATTR.italic, ATTR.bold | ATTR.italic]) {
        if (!findGlyph(faces, base, attrs)) {
          const hex = base.toString(16).toUpperCase().padStart(4, '0');
          out.push(`${cell.char} U+${hex} (attrs ${attrs}) from ${source}`);
        }
      }
    }
  }
  return out;
}

describe('the characters sigil draws', () => {
  it('should draw every character the components export without a box', async () => {
    const sources = await exported();
    // the walk has to have found what it is for, or it would pass on nothing
    expect([...sources.keys()]).toEqual(
      expect.arrayContaining([
        'ARC',
        'CIRCLE',
        'CP437',
        'DOTS',
        'OUTCOME_SYMBOLS',
        'PROMPT_SYMBOLS',
        'spinner-frames STAR',
        'spinner-frames TOGGLE',
        "treeGlyphs('rounded', false)",
      ])
    );
    expect(uncovered(sources)).toEqual([]);
  });

  it("should draw every character in the components' string literals without a box", () => {
    const sources = literals();
    const all = new Set([...sources.values()].flatMap((strings) => [...strings]).join(''));
    // the private constants this half exists for
    for (const char of ['☐', '☒', '◐', '✔', '✖']) {
      expect(all.has(char), char).toBe(true);
    }
    expect(uncovered(sources)).toEqual([]);
  });

  it('should draw all of printable ASCII from the bundled faces', () => {
    const ascii = String.fromCodePoint(...Array.from({ length: 95 }, (_, i) => 0x20 + i));
    const faces = loadFaces();
    for (const attrs of [0, ATTR.bold, ATTR.italic, ATTR.bold | ATTR.italic]) {
      for (const char of ascii.slice(1)) {
        const found = findGlyph(faces, char.codePointAt(0) ?? 0, attrs);
        // from a JetBrains Mono face, never the fallback
        expect(found?.face.id, char).toBeLessThan(4);
      }
    }
  });

  it('should report a character no bundled face has', () => {
    // the guard's own premise: a CJK ideograph is in none of the bundled fonts
    expect(uncovered(new Map([['test', new Set(['漢'])]]))).toEqual([
      '漢 U+6F22 (attrs 0) from test',
      `漢 U+6F22 (attrs ${ATTR.bold}) from test`,
      `漢 U+6F22 (attrs ${ATTR.italic}) from test`,
      `漢 U+6F22 (attrs ${ATTR.bold | ATTR.italic}) from test`,
    ]);
  });
});
