import { yaml } from '../src/index.js';
import { file, read } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * The figures this package's README and AGENTS.md both quote, asserted rather
 * than measured once and written down.
 *
 * Which is this repository's own standard: a figure nobody can re-derive is the
 * stale snapshot it keeps recording -- the store kit's own "102 bytes" moved
 * four times and had to be swept out of seven places. So the corpus is here, the
 * counts are assertions, and a `yaml` upgrade that changes what `toString()`
 * renormalizes fails this file rather than leaving two documents claiming a
 * number nobody checked.
 */

/** Every document the counts below are over, named for what it is in play for. */
const CORPUS: ReadonlyMap<string, string> = new Map([
  ['two-space map', 'server:\n  port: 8080\n  host: h\n'],
  ['four-space map', 'server:\n    port: 8080\n'],
  ['one-space map', 'a:\n b: 1\n'],
  ['six-space map', 'a:\n      b: 1\n'],
  ['eight-space map', 'a:\n        b: 1\n'],
  ['indented sequence', 'plugins:\n  - a\n  - b\n'],
  ['unindented sequence', 'plugins:\n- a\n- b\n'],
  ['four-space sequence', 'a:\n    - 1\n'],
  ['tight flow map', 'a: {b: 1}\n'],
  ['padded flow map', 'a: { b: 1 }\n'],
  ['tight flow sequence', 'a: [1, 2]\n'],
  ['empty flow collections', 'a: {}\nb: []\n'],
  ['comments', '# top\nserver:\n  # inner\n  port: 8080 # tail\n'],
  ['anchor, alias and merge', 'base: &b\n  p: 1\nc:\n  <<: *b\nd: *b\n'],
  ['CRLF', 'a: 1\r\nb: 2\r\n'],
  ['byte order mark', '\uFEFFa: 1\n'],
  ['no final newline', 'a: 1'],
  ['trailing blank line', 'a: 1\n\n'],
  ['long plain scalar', `a: ${'word '.repeat(30).trim()}\n`],
  ['literal block scalar', 'a: |\n  l1\n  l2\n'],
  ['quoting styles', 'a: \'x\'\nb: "y"\n'],
  ['nested deeply', 'a:\n  b:\n    c:\n      d: 1\n'],
  ['document marker', '---\na: 1\n'],
  ['integer key', '1: a\n'],
  // and the nine the residual table is about
  ['inline comment spacing', 'a: 1   # c\n'],
  ['tab before a comment', 'a: 1\t# c\n'],
  ['blank line run', 'a: 1\n\n\nb: 2\n'],
  ['comment at the end', 'a: 1\n# tail\n'],
  ['explicit key', '? a\n: 1\n'],
  ['folded block scalar', 'a: >\n  l1\n  l2\n'],
  ['tagged scalar', 'a: !!str 5\n'],
  ['comment above an unindented item', 'plugins:\n  # the list\n- a\n'],
  ['flow across lines', 'a: [\n  1,\n  2,\n]\n'],
  ['block scalar past the step', 'a:\n    b: |\n          text\n'],
  ['four-space with an unindented sequence', 'server:\n    plugins:\n    - a\n'],
]);

describe('the corpus the quoted figures are over', () => {
  /** Which documents round-trip and which report a residual. */
  const split = (): { clean: string[]; lossy: string[] } => {
    const clean: string[] = [];
    const lossy: string[] = [];

    for (const [name, body] of CORPUS) {
      if (yaml(file(body)).readSync().wouldLose) {
        lossy.push(name);
      } else {
        clean.push(name);
      }
    }

    return { clean, lossy };
  };

  it('should round-trip all but the eleven the residual table names', () => {
    const { clean, lossy } = split();

    // the figure both documents quote, which is why it is asserted rather than
    // written down: it read "nineteen of twenty-seven" until this file existed,
    // then 24 of 33 within the hour, and then 24 of 35 when the sabotage pass
    // turned up two more residual shapes. Which is exactly the hazard, met three
    // times by the one measurement written to close it
    expect(clean.length + lossy.length).toBe(CORPUS.size);
    expect(lossy.sort()).toStrictEqual([
      'blank line run',
      'block scalar past the step',
      'comment above an unindented item',
      'comment at the end',
      'explicit key',
      'flow across lines',
      'folded block scalar',
      'four-space with an unindented sequence',
      'inline comment spacing',
      'tab before a comment',
      'tagged scalar',
    ]);
    expect(clean).toHaveLength(CORPUS.size - 11);
  });

  it('should read every document in it, which is what makes the counts mean anything', () => {
    // a corpus entry that threw would be counted as neither, so the split above
    // would be a statement about a smaller corpus than it names
    for (const [name, body] of CORPUS) {
      expect(() => yaml(file(body)).readSync(), name).not.toThrow();
    }
  });

  it('should write every one of them back, lossy or not', () => {
    // the other half: a document that reads cleanly and cannot be written is the
    // shape a residual table would not catch
    for (const [name, body] of CORPUS) {
      const path = file(body);
      const before = yaml(path).readSync().value as Record<string, unknown>;

      expect(() => yaml(path).writeSync(before), name).not.toThrow();
      expect(yaml(path).readSync().value, name).toStrictEqual(before);
    }
  });

  it('should keep every clean document byte for byte through a no-op write', () => {
    // which is the claim "round-trips" makes, asserted as the bytes rather than
    // as the absence of a report: a store that answered `undefined` and then
    // rewrote the file would satisfy the split above
    const { clean } = split();

    for (const name of clean) {
      const body = CORPUS.get(name) as string;
      const path = file(body);
      yaml(path).writeSync(yaml(path).readSync().value);

      expect(read(path), name).toBe(body);
    }
  });
});
