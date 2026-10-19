import { lossesOf } from '../src/fidelity.js';
import { yaml } from '../src/index.js';
import { file } from './helpers.js';
import type { Loss } from '@ttylabs/sigil/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('what a write would lose', () => {
  /** What the store reports about a document, read through the real store. */
  const losses = (body: string): readonly Loss[] | undefined =>
    yaml(file(body)).readSync().wouldLose;

  it('should be absent for a document that round-trips, which is the normal case', () => {
    // **absent** rather than empty, which is the field's own contract and is
    // what `layer.wouldLose?.length` is the way to read: a caller who reads
    // `.length` off an empty array would get `0` from a store that answered one
    for (const body of [
      '# top\nserver:\n  # inner\n  port: 8080 # tail\n  host: h\n',
      'base: &b\n  p: 1\nc:\n  <<: *b\n  q: 2\nd: *b\n',
      'server:\n    port: 8080\n',
      'plugins:\n- a\n- b\n',
      'a: |\n  l1\n  l2\n',
      'a: \'x\'\nb: "y"\nc: {d: 1}\n',
      '\uFEFFa: 1\r\n\r\n',
      'a: 1',
    ]) {
      expect(losses(body), JSON.stringify(body)).toBeUndefined();
    }
  });

  describe('the residual, one test per row of the table', () => {
    /** The first loss, which is what a reader is pointed at. */
    const first = (body: string): Loss => {
      const found = losses(body);
      expect(found, JSON.stringify(body)).toBeDefined();
      return (found as readonly Loss[])[0] as Loss;
    };

    it('should name the whitespace before an inline comment', () => {
      expect(first('a: 1\nb: 2   # c\n')).toStrictEqual({
        detail: 'the whitespace before an inline comment is normalized to one space',
        kind: 'comment',
        line: 2,
      });
      expect(first('a: 1\t# c\n').detail).toMatch(/inline comment/);
    });

    it('should name an explicit "? key"', () => {
      expect(first('? a\n: 1\n')).toMatchObject({ kind: 'formatting', line: 1 });
      expect(first('? a\n: 1\n').detail).toMatch(/explicit "\? key"/);
    });

    it('should name a tagged scalar that gains quotes', () => {
      expect(first('a: !!str 5\n').detail).toMatch(/tagged scalar is rewritten with quotes/);
    });

    it('should name a folded block scalar', () => {
      expect(first('a: >\n  l1\n  l2\n').detail).toMatch(/folded block scalar/);
    });

    it('should name the blank line added before a trailing comment', () => {
      expect(first('a: 1\n# tail\n').detail).toMatch(/blank line is added before a comment/);
    });

    it('should name a collapsed run of blank lines', () => {
      expect(first('a: 1\n\n\nb: 2\n').detail).toMatch(/run of blank lines/);
    });

    it('should not call a shorter rendering a collapsed run of blank lines', () => {
      // the row's first rule was `was === '' || now === ''`, which fires on any
      // rendering shorter than the source: the tail compares against nothing.
      // Measured on two documents with no blank line in either, which is this
      // module's own claim that a line diff cannot produce a false positive
      // falsified -- the **line** was right and the **detail** named a cause
      // that is not there
      expect(lossesOf('a: 1\nb: 2\n', 'a: 1\n')?.map((it) => it.detail)).not.toContain(
        'a run of blank lines is collapsed to one'
      );
      expect(
        lossesOf('a: [\n  1,\n  2,\n]\n', 'a: [1, 2]\n')?.map((it) => it.detail)
      ).not.toContain('a run of blank lines is collapsed to one');
    });

    it('should name a flow collection written across lines', () => {
      expect(first('a: [\n  1,\n  2,\n]\n').detail).toMatch(/flow collection written across/);
    });

    it('should name a block scalar indented past the step', () => {
      // `yaml` renormalizes a block scalar's own indentation to the step, which
      // falls under the indentation row: the cause really is that this layout
      // cannot be rendered
      expect(first('a:\n    b: |\n          text\n').detail).toMatch(/indentation is rewritten/);
    });

    it('should name a comment moved to an unindented sequence item', () => {
      expect(first('plugins:\n  # the list\n- a\n')).toStrictEqual({
        detail: "a comment above an unindented sequence item is moved to the item's own indent",
        kind: 'comment',
        line: 2,
      });
    });

    it('should name an indentation this parser cannot render', () => {
      // `{ indent: 4, indentSeq: false }` does not reproduce a four-space
      // document with an unindented sequence: measured, `yaml` indents the
      // sequence by the step whatever `indentSeq` says once the step is not two.
      // Which is the parser's own limitation rather than a detection failure
      expect(first('server:\n    plugins:\n    - a\n').detail).toMatch(/indentation is rewritten/);
    });
  });

  it('should report one entry per kind rather than one per differing line', () => {
    // a reindented file differs on every line, and ten entries all saying so is
    // a wall nobody reads to the end of
    const body = `server:\n    plugins:\n    - a\n    - b\n    - c\n    - d\n`;
    const found = losses(body) as readonly Loss[];
    expect(found).toBeDefined();
    expect(found.length).toBeLessThan(4);
    expect(new Set(found.map((it) => it.detail)).size).toBe(found.length);
  });

  it('should be bounded by the table rather than by a cap', () => {
    // there **was** a cap of ten and it could never bind: `seen` is keyed by
    // the sentence and the table has nine possible answers -- the rows plus the
    // per-line fallback -- so it is deleted and this is the bound that makes it
    // unnecessary. Read off the module rather than written down, so a tenth row
    // added without a cap fails here
    const rows = (
      readFileSync(join(import.meta.dirname, '../src/fidelity.ts'), 'utf8').match(/^    say: /gm) ??
      []
    ).length;

    expect(rows).toBeGreaterThan(5);

    const was = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const now = Array.from({ length: 40 }, (_, i) => `other ${i}`).join('\n');
    expect(lossesOf(was, now)).toHaveLength(1);

    // and the real bound, over every residual this package knows about at once
    const everything = 'a: 1   # c\n\n\n? b\n: >\n   l1\n   l2\nc: !!str 5\n# tail\n';
    expect((lossesOf(everything, everything.replace('1', '2')) ?? []).length).toBeLessThanOrEqual(
      rows + 1
    );
  });

  it('should answer nothing where the two are equal', () => {
    expect(lossesOf('a: 1\n', 'a: 1\n')).toBeUndefined();
  });

  it('should always name a line, which is why there is no document-level fallback', () => {
    // a proof rather than a hope: `split('\n')` is injective, so two strings
    // that differ have line arrays that differ, so some index is reached and the
    // per-line fallback records something. Which is what made the sibling
    // store's document-level fallback unreachable here, so it is deleted rather
    // than kept -- walked over a corpus so that the claim is the property
    for (const [was, now] of [
      ['a: 1\n', 'a: 1\n\n'],
      ['a: 1\n', 'a: 1'],
      ['a: 1\n', ''],
      ['', 'a: 1\n'],
      ['a: 1\nb: 2\n', 'a: 1\n'],
      ['a: 1\n', 'b: 2\n'],
    ] as const) {
      const found = lossesOf(was, now) as readonly Loss[];
      expect(found, JSON.stringify([was, now])).not.toHaveLength(0);
      for (const loss of found) {
        expect(loss.line, JSON.stringify([was, now])).toBeGreaterThan(0);
      }
    }
  });

  it('should name the line for a difference it cannot otherwise explain', () => {
    // which is the whole advantage over a table of patterns matched against the
    // source: a per-line fallback still carries a line, where XML's can only
    // say that the document differs
    const found = lossesOf('a: 1\nb: 2\n', 'a: 1\nb: 3\n') as readonly Loss[];
    expect(found).toStrictEqual([
      {
        detail: 'this line does not survive a round trip through this parser unchanged',
        kind: 'formatting',
        line: 2,
      },
    ]);
  });
});
