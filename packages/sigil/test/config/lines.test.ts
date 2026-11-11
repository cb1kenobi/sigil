import { editJsonc } from '../../src/config/jsonc-write.js';
import { scanJsonc } from '../../src/config/jsonc.js';
import {
  LINE_END,
  lineAt,
  lineCounter,
  lineStartAt,
  lineStarts,
  ownLineIndent,
} from '../../src/config/spans.js';
import { describe, expect, it } from 'vitest';

/** xorshift32, the generator the layout fuzzer and the scan fuzzer already use. */
function seeded(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** One of a list. */
function pick<T>(rnd: () => number, from: readonly T[]): T {
  return from[Math.floor(rnd() * from.length)] as T;
}

/**
 * The line an offset is on, counted a different way from `lineAt()`: split
 * what comes before it on every terminator, a CRLF being one. An oracle that
 * shares no code with the thing it checks, so the two cannot be wrong together.
 */
function oracle(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/).length;
}

const EOL = ['\n', '\r\n', '\r'] as const;

/**
 * A JSONC document with its comments' offsets, as written rather than as found.
 *
 * Line endings are mixed per break. Strings hold comment markers and the two
 * terminators JSON allows only inside one, a comment sits flush against a string
 * on either side, and block comments run over lines in every ending and hold the
 * same two terminators -- the places a line count can go wrong. A U+2028 or a
 * U+2029 is never put where the scan refuses one, since a refusal has no
 * comments to check.
 */
function generate(rnd: () => number): { offsets: number[]; text: string } {
  let text = '';
  const offsets: number[] = [];

  const comment = () => {
    offsets.push(text.length);
    if (rnd() < 0.5) {
      // a line comment ends at the break, which is then written
      text += `// note ${pick(rnd, ['', '"', '/*', '*/', '//'])}`;
      text += pick(rnd, EOL);
    } else {
      const lines = Math.floor(rnd() * 3);
      let body = '/* c';
      for (let i = 0; i < lines; i++) {
        body += pick(rnd, [...EOL, '\u2028', '\u2029']) + pick(rnd, ['x', '//', '"', '*']);
      }
      text += `${body} */`;
    }
  };

  const string = () =>
    JSON.stringify(
      pick(rnd, ['a', '//', '/* no */', 'x\u2028y', '\u2029', 'line\nbreak', '\\', '"', 'cr\r'])
    );

  text += '[';
  const count = 5 + Math.floor(rnd() * 20);
  for (let i = 0; i < count; i++) {
    if (rnd() < 0.4) {
      text += pick(rnd, EOL);
    }
    if (rnd() < 0.4) {
      comment();
    }
    // a string with a comment flush against it, either side
    text += string();
    if (rnd() < 0.4) {
      comment();
    }
    if (rnd() < 0.3) {
      text += pick(rnd, [...EOL, ' ']);
    }
    text += i < count - 1 ? ',' : '';
  }
  text += ']';

  return { offsets, text };
}

describe('SIG-371: counting lines', () => {
  it('should name every comment at the line lineAt() names, over mixed line endings', () => {
    // the counter resumes rather than restarting, so the thing to pin is that
    // resuming never drifts from a count from the start -- across a CRLF split
    // by nothing, a lone `\r`, a block comment holding a break, and a string
    // holding a terminator the scan has to step over without ending anything
    let comments = 0;
    let crlf = 0;
    let lone = 0;
    let spanning = 0;
    let separators = 0;

    for (let seed = 1; seed <= 300; seed++) {
      const { offsets, text } = generate(seeded(seed * 2654435761));
      const scan = scanJsonc(text, 'f');

      expect(
        scan.comments.map((c) => c.text.slice(0, 2)),
        `seed ${seed}: the comments, and no more`
      ).to.deep.equal(offsets.map((at) => text.slice(at, at + 2)));

      for (const [k, at] of offsets.entries()) {
        const line = scan.comments[k]?.line;
        expect(line, `seed ${seed}: comment ${k} at ${at}`).to.equal(lineAt(text, at));
        expect(line, `seed ${seed}: comment ${k} at ${at}, by the oracle`).to.equal(
          oracle(text, at)
        );
      }

      comments += offsets.length;
      if (text.includes('\r\n')) crlf++;
      if (/\r(?!\n)/.test(text)) lone++;
      if (scan.comments.some((c) => c.text.startsWith('/*') && LINE_END.test(c.text))) spanning++;
      if (/[\u2028\u2029]/.test(text)) separators++;
    }

    // a corpus that never met the shape it is about is a green test about
    // nothing, which is the rule the scan's own fuzzer records
    expect(comments).to.be.greaterThan(2000);
    expect(crlf).to.be.greaterThan(200);
    expect(lone).to.be.greaterThan(200);
    expect(spanning).to.be.greaterThan(200);
    expect(separators).to.be.greaterThan(200);
  });

  it('should name the line of a refusal after many comments', () => {
    // the error paths ask the same counter, after it has moved on
    const notes = '// a note\r\n'.repeat(40);
    expect(() => scanJsonc(`[${notes}"open`, 'f')).toThrow(/Unterminated string in f on line 41/);
    expect(() => scanJsonc(`[${notes}/* open`, 'f')).toThrow(
      /Unterminated comment in f on line 41/
    );
    expect(() => scanJsonc(`[${notes}1\u2028]`, 'f')).toThrow(/U\+2028 in f on line 41/);
  });

  it('should answer lineAt() from a counter asked in any order', () => {
    // backwards is a restart rather than a wrong answer
    const text = 'a\r\nb\rc\nd\u2028e\u2029f\r\n';
    const ask = lineCounter(text);
    const order = [3, 3, 9, 0, 2, 4, 1, 14, 14, 7, 99];
    for (const at of order) {
      expect(ask(at), `offset ${at}`).to.equal(lineAt(text, at));
    }
  });

  it('should answer lineStartAt() from the index at every offset', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { text } = generate(seeded(seed * 40503));
      const index = lineStarts(text);
      for (let at = 0; at <= text.length; at++) {
        expect(index(at), `seed ${seed}: offset ${at}`).to.equal(lineStartAt(text, at));
      }
    }
  });

  it('should answer what ownLineIndent() answered when it walked to the line start', () => {
    // the old definition, as the oracle: the run back to the line's start, if
    // it is blank. Every whitespace `trim()` takes, including the ones that
    // are not a space or a tab
    const before = (text: string, at: number) => {
      const run = text.slice(lineStartAt(text, at), at);
      return run.trim() === '' ? run : undefined;
    };
    const text = '{\n\t"a": 1,\r\n  \u00a0"b": 2, "c": 3\r\u2028\v\f"d" \t\n"e"';
    for (let at = 0; at <= text.length; at++) {
      expect(ownLineIndent(text, at), `offset ${at}`).to.equal(before(text, at));
    }
  });
});

describe('SIG-371: what a large file costs', () => {
  /**
   * How many characters a run looked at, as the number of times it asked
   * whether one ends a line -- which every walk over a line in this module
   * does, so a walk from the start per item shows up as a count that grows
   * with the square of the size rather than with the size.
   *
   * Counted by hand rather than through `vi.spyOn()`, which keeps every call's
   * arguments: the quadratic version makes millions of calls, so a spy turned
   * a failing assertion into a heap exhausted before it could fail.
   */
  function cost(run: () => unknown): number {
    const test = RegExp.prototype.test;
    let calls = 0;
    Object.defineProperty(LINE_END, 'test', {
      configurable: true,
      value(this: RegExp, input: string) {
        calls++;
        return test.call(this, input);
      },
    });
    try {
      run();
      return calls;
    } finally {
      Reflect.deleteProperty(LINE_END, 'test');
    }
  }

  /**
   * The cost at twice the size over the cost at the size. A linear walk is 2,
   * a quadratic one 4, so 3 is the line between them with room either side for
   * a constant that does not scale.
   */
  function growth(make: (n: number) => () => unknown, n: number): number {
    return cost(make(2 * n)) / cost(make(n));
  }

  it('should read a file of comment lines in time linear in its size', () => {
    // the ticket's own shape: 40,000 of these took 92 seconds to load
    const ratio = growth(
      (n) => () => scanJsonc(`{\n${'  // a note\n'.repeat(n)}  "a": 1\n}`, 'f'),
      500
    );
    expect(ratio).to.be.lessThan(3);
  });

  it('should refuse a file of repeated comment openers in time linear in its size', () => {
    // `/*/*/*` is a run of short block comments, each closed by the next
    // opener's star, and then one that never closes: 400 KB took 118 seconds
    // to say so, for the same reason as above
    const make = (n: number) => () => {
      expect(() => scanJsonc('/*'.repeat(n), 'f')).toThrow(/Unterminated comment/);
    };
    expect(growth(make, 1000)).to.be.lessThan(3);
  });

  /** A one-line object of `n` members, each made by `member`. */
  const minified = (n: number, member: (i: number) => unknown) =>
    JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, member(i)])));

  it('should save a minified file in time linear in its size', () => {
    // every save walks every entry asking whether it owns its line, and that
    // was a walk back to the line's start -- the whole document, on one line
    const scalar = (n: number) => () =>
      editJsonc(
        minified(n, (i) => i),
        JSON.parse(`${minified(n, (i) => i).slice(0, -1)},"z":1}`),
        {
          what: 'f',
        }
      );
    expect(growth(scalar, 500)).to.be.lessThan(3);

    const nested = (n: number) => {
      const source = minified(n, (i) => ({ x: i }));
      const next = { ...(JSON.parse(source) as object), z: 1 };
      return () => editJsonc(source, next, { what: 'f' });
    };
    expect(growth(nested, 500)).to.be.lessThan(3);
  });

  it('should add to every object of a minified file in time linear in its size', () => {
    // one insertion per container, and each asked its container's indentation
    // by walking back to the line's start
    const each = (n: number) => {
      const source = minified(n, (i) => ({ x: i }));
      const next = JSON.parse(minified(n, (i) => ({ x: -i, y: 1 }))) as unknown;
      return () => editJsonc(source, next, { what: 'f' });
    };
    expect(growth(each, 500)).to.be.lessThan(3);
  });
});
