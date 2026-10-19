import { PARSE_OPTIONS } from '../src/options.js';
import { candidates, reshape, shapeOf } from '../src/shape.js';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

/**
 * The shape and the layout detection, measured as what a **no-op write**
 * produces.
 *
 * Which is the one assertion worth making about either: the detection exists so
 * that re-rendering a document reproduces its own bytes, so the claim is the
 * bytes rather than the options. A test on the options would pass for a
 * detection that is right about the indent and wrong about everything else.
 */
describe('the shape and the layout', () => {
  /** What a no-op write of a document produces, with its shape put back. */
  const noop = (source: string): string => {
    const { body, shape } = shapeOf(source);
    const doc = parseDocument(body, PARSE_OPTIONS);
    return reshape(doc.toString(candidates(body)[0]), shape);
  };

  /** The same, trying every candidate rather than only the detected one. */
  const best = (source: string): string => {
    const { body, shape } = shapeOf(source);
    const doc = parseDocument(body, PARSE_OPTIONS);
    for (const style of candidates(body)) {
      const out = reshape(doc.toString(style), shape);
      if (out === source) {
        return out;
      }
    }
    return noop(source);
  };

  it('should reproduce a document the detection gets right on the first try', () => {
    // every one of these hit the **first** candidate when measured, which is
    // what makes the typical cost one `toString()` rather than a sweep
    for (const source of [
      'server:\n  port: 8080\n  host: h\n',
      'server:\n    port: 8080\n',
      'a:\n b: 1\n',
      'a:\n      b: 1\n',
      'a:\n        b: 1\n',
      'plugins:\n  - a\n  - b\n',
      'plugins:\n- a\n- b\n',
      'a:\n    - 1\n',
      'a: {b: 1}\n',
      'a: { b: 1 }\n',
      'a: [1, 2]\n',
      'a: {b: 1}\nc: [1]\n',
      'a: {}\n',
      '# top\nserver:\n  # inner\n  port: 8080 # tail\n',
      'base: &b\n  p: 1\nc:\n  <<: *b\n',
      'a: |\n  l1\n  l2\n',
      'a: \'x\'\nb: "y"\n',
      'a:\n  b:\n    c:\n      d: 1\n',
      '---\na: 1\n',
      `a: ${'word '.repeat(30).trim()}\n`,
    ]) {
      expect(noop(source), JSON.stringify(source)).toBe(source);
    }
  });

  describe('the three bytes a parser does not carry', () => {
    it('should put a byte order mark back', () => {
      // taken off before the parse rather than left for it, which is measured:
      // `yaml` reads `U+FEFF` at the start of a stream as a document separator,
      // so a marked file parses and the mark is gone from what it renders
      expect(noop('\uFEFFa: 1\n')).toBe('\uFEFFa: 1\n');
    });

    it('should put CRLF line endings back', () => {
      expect(noop('a: 1\r\nb: 2\r\n')).toBe('a: 1\r\nb: 2\r\n');
    });

    it('should put the trailing newline run back, whatever it is', () => {
      // one field for three cases rather than a flag each, which is what makes
      // all four of these the same question
      expect(noop('a: 1')).toBe('a: 1');
      expect(noop('a: 1\n')).toBe('a: 1\n');
      expect(noop('a: 1\n\n')).toBe('a: 1\n\n');
      expect(noop('a: 1\n\n\n')).toBe('a: 1\n\n\n');
      expect(noop('a: 1\r\n\r\n')).toBe('a: 1\r\n\r\n');
    });
  });

  it('should never fold a long line, which the default lineWidth does at 80', () => {
    // a long plain scalar comes back wrapped across lines it was never written
    // across, and a value long enough to fold is one somebody wrote on one line
    const long = `a: ${'word '.repeat(40).trim()}\n`;
    expect(noop(long)).toBe(long);
    expect(parseDocument(long, PARSE_OPTIONS).toString()).not.toBe(long);
  });

  it('should leave an empty flow collection out of the padding evidence', () => {
    // `{}` is `{}` either way, so reading it as tight made every document
    // holding one render its padded collections tight
    expect(noop('a: {}\nb: { c: 1 }\n')).toBe('a: {}\nb: { c: 1 }\n');
    expect(noop('a: []\nb: [ 1 ]\n')).toBe('a: []\nb: [ 1 ]\n');
  });

  it('should skip a comment when deciding whether a sequence is indented', () => {
    // a comment between a key and its first item is ordinary and carries no
    // indent worth reading, so the detection has to walk past it to find the
    // key that holds the sequence
    expect(noop('plugins:\n  # the list\n  - a\n')).toBe('plugins:\n  # the list\n  - a\n');
    expect(noop('plugins:\n# the list\n- a\n')).toBe('plugins:\n# the list\n- a\n');
    expect(noop('server:\n  # inner\n  port: 1\n')).toBe('server:\n  # inner\n  port: 1\n');
  });

  it('should offer the detected candidate first and a bounded sweep after it', () => {
    const style = candidates('server:\n    port: 1\n');
    expect(style[0]).toMatchObject({ indent: 4, indentSeq: true, lineWidth: 0 });
    // bounded rather than exhaustive: the first version swept 24 combinations
    // unconditionally, which is 20.37ms over a 900-line file against 1.22ms for
    // one `toString()`
    expect(style.length).toBeLessThanOrEqual(6);
    expect(new Set(style.map((it) => JSON.stringify(it))).size).toBe(style.length);
  });

  describe('the sweep, which is load bearing rather than belt and braces', () => {
    // the detection is a regex over the whole document, so a bracket **inside a
    // string or a comment** is evidence it should not have: the padding
    // detection reads it as tight, the detected candidate renders a padded
    // collection tight, and the document would be reported as lossy. Measured:
    // the **third** candidate is exact, so the sweep is what makes
    // `wouldLose` absent for these three
    for (const [name, source] of [
      ['a bracket in a double-quoted string', 'a: "[x]"\nb: { c: 1 }\n'],
      ['a brace in a single-quoted string', "a: '{x}'\nb: { c: 1 }\n"],
      ['a bracket in a comment', 'a: 1 # [x]\nb: { c: 1 }\n'],
    ] as const) {
      it(`should correct ${name}`, () => {
        expect(noop(source), 'the detection is expected to miss this').not.toBe(source);
        expect(best(source)).toBe(source);
      });
    }

    it('should not be fooled the same way about a sequence', () => {
      // the padding detection searches the whole document for a bracket, which
      // is what a string can fool. The sequence detection matches a line's own
      // **start**, so a `- ` inside a string is on a line that does not start
      // with one -- measured, this is exact on the first candidate
      const source = 'a: "- x"\nplugins:\n- b\n';
      expect(noop(source)).toBe(source);
    });
  });

  it('should answer with the default indent where nothing is nested', () => {
    // a flat document renders identically at any indent, so there is nothing
    // for the detection to be wrong about
    expect(candidates('a: 1\nb: 2\n')[0]).toMatchObject({ indent: 2 });
    expect(noop('a: 1\nb: 2\n')).toBe('a: 1\nb: 2\n');
  });
});
