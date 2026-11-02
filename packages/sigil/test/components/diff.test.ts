import { strip } from '../../src/ansi/index.js';
import {
  DIFF_SIDE_BY_SIDE_MIN_WIDTH,
  diff,
  type DiffChange,
  diffHunks,
  diffInline,
  diffLines,
  type DiffOptions,
  diffSequence,
  diffView,
  parsePatch,
} from '../../src/components/diff.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);

/**
 * A diff as the plain lines it prints.
 *
 * `env` is pinned so a developer's own `TERM` cannot decide the separator, and the
 * colour level to none so the output is plain unless a test asks for colour.
 */
function lines(input: Parameters<typeof diff>[0], opts: DiffOptions = {}): string[] {
  return diff(input, { colorLevel: 0, env: {}, platform: 'linux', width: 40, ...opts }).split('\n');
}

/** A diff with colour, for the tests about what is drawn in which role. */
function coloured(input: Parameters<typeof diff>[0], opts: DiffOptions = {}): string {
  return diff(input, { colorLevel: 3, env: {}, platform: 'linux', width: 40, ...opts });
}

/** Replays a script over one side, to prove it describes both. */
function replay(script: readonly DiffChange[], side: 'new' | 'old'): string[] {
  return script
    .filter((change) => change.op === 'equal' || change.op === (side === 'old' ? 'remove' : 'add'))
    .map((change) => change.value);
}

/** The length of the longest common subsequence, by the quadratic table. */
function lcs(a: readonly string[], b: readonly string[]): number {
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0)
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i]![j] =
        a[i - 1] === b[j - 1]
          ? table[i - 1]![j - 1]! + 1
          : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }
  return table[a.length]![b.length]!;
}

describe('diffSequence()', () => {
  it('should be empty for two empty lists', () => {
    expect(diffSequence([], [])).to.deep.equal([]);
  });

  it('should call identical lists equal throughout', () => {
    expect(diffSequence(['a', 'b'], ['a', 'b'])).to.deep.equal([
      { op: 'equal', value: 'a' },
      { op: 'equal', value: 'b' },
    ]);
  });

  it('should add everything to an empty list and remove everything from a list that ends empty', () => {
    expect(diffSequence([], ['x', 'y']).map((change) => change.op)).to.deep.equal(['add', 'add']);
    expect(diffSequence(['x', 'y'], []).map((change) => change.op)).to.deep.equal([
      'remove',
      'remove',
    ]);
  });

  it('should find the one line that changed in the middle', () => {
    expect(diffSequence(['a', 'b', 'c'], ['a', 'x', 'c'])).to.deep.equal([
      { op: 'equal', value: 'a' },
      { op: 'remove', value: 'b' },
      { op: 'add', value: 'x' },
      { op: 'equal', value: 'c' },
    ]);
  });

  it('should keep what moved as the shortest script rather than the first one found', () => {
    // 'a b c' -> 'c a b' is one removal and one addition, not three of each
    const script = diffSequence(['a', 'b', 'c'], ['c', 'a', 'b']);
    expect(script.filter((change) => change.op !== 'equal')).to.have.length(2);
  });

  it('should be the shortest script and replay to both sides, over every small pair', () => {
    const alphabet = ['a', 'b', 'c'];
    // every word of up to four letters, a length at a time
    let level: string[][] = [[]];
    const words: string[][] = [[]];
    for (let length = 1; length <= 4; length++) {
      level = level.flatMap((word) => alphabet.map((letter) => [...word, letter]));
      words.push(...level);
    }

    for (const a of words) {
      for (const b of words) {
        const script = diffSequence(a, b);
        expect(replay(script, 'old'), `${a} -> ${b}`).to.deep.equal(a);
        expect(replay(script, 'new'), `${a} -> ${b}`).to.deep.equal(b);
        expect(script.filter((change) => change.op !== 'equal').length, `${a} -> ${b}`).to.equal(
          a.length + b.length - 2 * lcs(a, b)
        );
      }
    }
  });

  it('should still describe two lists with nothing in common past the length it searches', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    const script = diffSequence(a, b);

    expect(replay(script, 'old')).to.deep.equal(a);
    expect(replay(script, 'new')).to.deep.equal(b);
  });

  it('should trim a long common head and tail rather than searching them', () => {
    const body = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const edited = [...body.slice(0, 25_000), 'changed', ...body.slice(25_001)];
    const script = diffSequence(body, edited);

    expect(script.filter((change) => change.op !== 'equal')).to.have.length(2);
  });
});

describe('diffLines()', () => {
  it('should read a final line ending as the end of the last line', () => {
    expect(diffLines('a\nb\n', 'a\nb')).to.deep.equal([
      { op: 'equal', value: 'a' },
      { op: 'equal', value: 'b' },
    ]);
  });

  it('should read CRLF the same as LF', () => {
    expect(diffLines('a\r\nb', 'a\nb').every((change) => change.op === 'equal')).to.equal(true);
  });

  it('should have no lines for an empty text', () => {
    expect(diffLines('', 'a')).to.deep.equal([{ op: 'add', value: 'a' }]);
  });
});

describe('diffHunks()', () => {
  const old = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].join('\n');

  it('should be empty where the texts are the same', () => {
    expect(diffHunks(old, old)).to.deep.equal([]);
  });

  it('should keep three lines of context either side of a change', () => {
    const [hunk, ...rest] = diffHunks(old, old.replace('\n6\n', '\nsix\n'));

    expect(rest).to.deep.equal([]);
    expect(hunk!.lines.map((line) => line.text)).to.deep.equal([
      '3',
      '4',
      '5',
      '6',
      'six',
      '7',
      '8',
      '9',
    ]);
    expect([hunk!.oldStart, hunk!.oldLines, hunk!.newStart, hunk!.newLines]).to.deep.equal([
      3, 7, 3, 7,
    ]);
  });

  it('should number lines on the side that has them', () => {
    const [hunk] = diffHunks('a\nb', 'a\nx\nb', { context: 1 });

    expect(hunk!.lines).to.deep.equal([
      { kind: 'context', newNumber: 1, oldNumber: 1, text: 'a' },
      { kind: 'add', newNumber: 2, text: 'x' },
      { kind: 'context', newNumber: 3, oldNumber: 2, text: 'b' },
    ]);
  });

  it('should make one hunk of two changes whose context meets, and two otherwise', () => {
    const close = old.replace('\n3\n', '\nthree\n').replace('\n8\n', '\neight\n');
    const far = old.replace('\n2\n', '\ntwo\n').replace('\n11\n', '\neleven\n');

    expect(diffHunks(old, close, { context: 2 })).to.have.length(1);
    expect(diffHunks(old, far, { context: 2 })).to.have.length(2);
  });

  it('should show only the changed lines with no context', () => {
    const [hunk] = diffHunks(old, old.replace('\n6\n', '\nsix\n'), { context: 0 });

    expect(hunk!.lines.map((line) => line.kind)).to.deep.equal(['remove', 'add']);
  });

  it('should start an empty side at the line before, as a patch writes it', () => {
    const [hunk] = diffHunks('', 'a\nb');

    expect([hunk!.oldStart, hunk!.oldLines, hunk!.newStart, hunk!.newLines]).to.deep.equal([
      0, 0, 1, 2,
    ]);
  });

  it('should start the new side at the line before when it is the one that is empty', () => {
    const [hunk] = diffHunks('a\nb', '');

    expect([hunk!.oldStart, hunk!.oldLines, hunk!.newStart, hunk!.newLines]).to.deep.equal([
      1, 2, 0, 0,
    ]);
  });
});

describe('parsePatch()', () => {
  const patch = [
    'diff --git a/x.ts b/x.ts',
    'index 83db48f..bf2a3c1 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,4 +1,4 @@ function main()',
    ' one',
    '-two',
    '\\ No newline at end of file',
    '+TWO',
    ' ',
    ' four',
  ].join('\n');

  it('should read the names, the hunk and its lines with their numbers', () => {
    const [file] = parsePatch(patch);

    expect(file!.oldName).to.equal('a/x.ts');
    expect(file!.newName).to.equal('b/x.ts');
    expect(file!.hunks[0]!.heading).to.equal('function main()');
    expect(file!.hunks[0]!.lines).to.deep.equal([
      { kind: 'context', newNumber: 1, oldNumber: 1, text: 'one' },
      { kind: 'remove', oldNumber: 2, text: 'two' },
      { kind: 'add', newNumber: 2, text: 'TWO' },
      { kind: 'context', newNumber: 3, oldNumber: 3, text: '' },
      { kind: 'context', newNumber: 4, oldNumber: 4, text: 'four' },
    ]);
  });

  it('should read a blank context line whose space an editor stripped', () => {
    const [file] = parsePatch('--- a\n+++ b\n@@ -1,2 +1,2 @@\n x\n\n');

    expect(file!.hunks[0]!.lines.map((line) => line.text)).to.deep.equal(['x', '']);
  });

  it('should not take a removed line that starts with dashes for a file header', () => {
    const [file, ...rest] = parsePatch(
      ['--- a', '+++ b', '@@ -1,2 +1,2 @@', '--- not a header', '+++ not either', ' kept'].join(
        '\n'
      )
    );

    // the first removed line is "-- not a header", the second "++ ..." is an add
    expect(rest).to.deep.equal([]);
    expect(file!.hunks[0]!.lines.map((line) => line.kind)).to.deep.equal([
      'remove',
      'add',
      'context',
    ]);
  });

  it('should read the files of a patch that holds more than one', () => {
    const files = parsePatch(
      [
        '--- a/1',
        '+++ b/1',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '--- a/2',
        '+++ b/2',
        '@@ -1 +1 @@',
        '-p',
        '+q',
      ].join('\n')
    );

    expect(files.map((file) => file.newName)).to.deep.equal(['b/1', 'b/2']);
  });

  it('should drop the timestamp some tools put after a tab', () => {
    const [file] = parsePatch('--- a.txt\t2024-01-01\n+++ b.txt\t2024-01-02\n@@ -1 +1 @@\n-x\n+y');

    expect(file!.oldName).to.equal('a.txt');
  });

  it('should read a hunk with no file header', () => {
    const [file] = parsePatch('@@ -1 +1 @@\n-x\n+y');

    expect(file!.oldName).to.equal(undefined);
    expect(file!.hunks[0]!.lines).to.have.length(2);
  });

  it('should find nothing in text that is not a patch', () => {
    expect(parsePatch('just some words\nand more')).to.deep.equal([]);
    expect(parsePatch('')).to.deep.equal([]);
  });
});

describe('diffInline()', () => {
  it('should mark the words that changed on each side', () => {
    expect(diffInline('const x = foo(1, 2);', 'const x = bar(1, 3);')).to.deep.equal({
      new: [
        [10, 13],
        [17, 18],
      ],
      old: [
        [10, 13],
        [17, 18],
      ],
    });
  });

  it('should mark an inserted word on the side that has it only', () => {
    expect(diffInline('run the tests', 'run all the tests')).to.deep.equal({
      new: [[4, 8]],
      old: [],
    });
  });

  it('should make one stretch of changed words with only space between them', () => {
    const { old } = diffInline('call one two three now', 'call 1 2 3 now');

    expect(old).to.deep.equal([[5, 18]]);
  });

  it('should mark nothing when the lines share too little to be edits of each other', () => {
    expect(diffInline('alpha beta gamma', 'zzz yyy xxx')).to.deep.equal({ new: [], old: [] });
  });

  it('should count astral characters as one code point when it finds the words', () => {
    const { old } = diffInline('say 😀 now please', 'say 😁 now please');

    expect(old).to.deep.equal([[4, 6]]);
  });
});

describe('diff()', () => {
  const OLD = 'one\ntwo\nthree';
  const NEW = 'one\n2\nthree';

  describe('unified', () => {
    it('should show a changed line removed and then added, in a numbered gutter', () => {
      expect(lines({ new: NEW, old: OLD })).to.deep.equal([
        '@@ -1,3 +1,3 @@',
        '1 1  one',
        '2   -two',
        '  2 +2',
        '3 3  three',
      ]);
    });

    it('should put the file names above the hunks when it is given them', () => {
      expect(
        lines({ new: NEW, newName: 'b.txt', old: OLD, oldName: 'a.txt' }).slice(0, 3)
      ).to.deep.equal(['--- a.txt', '+++ b.txt', '@@ -1,3 +1,3 @@']);
    });

    it('should print nothing where nothing changed', () => {
      expect(diff({ new: OLD, old: OLD }, { colorLevel: 0, width: 40 })).to.equal('');
    });

    it('should drop the gutter on request', () => {
      expect(lines({ new: NEW, old: OLD }, { lineNumbers: false }).slice(1)).to.deep.equal([
        ' one',
        '-two',
        '+2',
        ' three',
      ]);
    });

    it('should keep the indentation of a line of code', () => {
      expect(
        lines({ new: 'a\n    b\n\t\tc', old: 'a' }, { lineNumbers: false }).slice(1)
      ).to.deep.equal([
        ' a',
        '+    b',
        // a tab is four columns, wherever it is
        '+        c',
      ]);
    });

    it('should fold a line wider than the room onto rows that hang under the code', () => {
      expect(
        lines({ new: 'abcdefghij', old: '' }, { lineNumbers: false, width: 6 }).slice(1)
      ).to.deep.equal(['+abcde', ' fghij']);
    });

    it('should leave the gutter blank on the rows a fold added', () => {
      expect(lines({ new: 'abcdefghij', old: '' }, { width: 10 }).slice(1)).to.deep.equal([
        '  1 +abcde',
        '     fghij',
      ]);
    });

    it('should never draw a row wider than the width, whatever the characters', () => {
      const wide = '日本語のテキスト'.repeat(4);
      const out = lines({ new: `${wide}\n👨‍👩‍👧‍👦 family ${wide}`, old: 'x' }, { width: 17 });

      expect(Math.max(...out.map((row) => stringWidth(row)))).to.be.at.most(17);
      // and nothing was lost in the folding
      expect(out.join('').replaceAll(/[\s@+\-\d,]/g, '')).to.include(wide.slice(0, 4));
    });

    it('should draw a character wider than the room rather than loop on it', () => {
      expect(() => lines({ new: '日', old: '' }, { lineNumbers: false, width: 1 })).to.not.throw();
    });
  });

  describe('side by side', () => {
    const opts: DiffOptions = { layout: 'side-by-side', width: DIFF_SIDE_BY_SIDE_MIN_WIDTH };

    it('should set the old line beside the one that replaced it', () => {
      const out = lines({ new: NEW, old: OLD }, opts);

      expect(out[1]).to.match(/^1 {2}one +│ 1 {2}one$/);
      expect(out[2]).to.match(/^2 -two +│ 2 \+2$/);
    });

    it('should leave a blank half where one side has a line the other lacks', () => {
      const out = lines({ new: 'a\nb\nc', old: 'a\nc' }, opts);

      expect(out.find((row) => row.includes('+b'))).to.match(/^ +│ 2 \+b$/);
    });

    it('should split the width between the halves and the separator', () => {
      const out = lines({ new: NEW, old: OLD }, opts);

      expect(out[1]!.indexOf('│')).to.equal(29);
      expect(Math.max(...out.map((row) => stringWidth(row)))).to.be.at.most(
        DIFF_SIDE_BY_SIDE_MIN_WIDTH
      );
    });

    it('should draw the separator as ASCII where the terminal cannot draw boxes', () => {
      expect(lines({ new: NEW, old: OLD }, { ...opts, env: { TERM: 'linux' } })[1]).to.include(
        ' | '
      );
    });

    it('should be unified below the minimum width, and say so', () => {
      const narrow = DIFF_SIDE_BY_SIDE_MIN_WIDTH - 1;

      expect(diffView({ new: NEW, old: OLD }, { ...opts, width: narrow }).layout).to.equal(
        'unified'
      );
      expect(diffView({ new: NEW, old: OLD }, opts).layout).to.equal('side-by-side');
      expect(lines({ new: NEW, old: OLD }, { ...opts, width: narrow })).to.deep.equal(
        lines({ new: NEW, old: OLD }, { width: narrow })
      );
    });

    it('should be unified unless it is asked for', () => {
      expect(diffView({ new: NEW, old: OLD }, { width: 120 }).layout).to.equal('unified');
    });

    it('should fold each half on its own and keep the halves lined up', () => {
      const out = lines(
        { new: 'x'.repeat(60), old: 'short' },
        { layout: 'side-by-side', width: DIFF_SIDE_BY_SIDE_MIN_WIDTH }
      );

      expect(out.length).to.be.greaterThan(3);
      for (const row of out.slice(1)) {
        expect(row.indexOf('│')).to.equal(29);
      }
    });
  });

  describe('a patch', () => {
    it('should draw the same as the two texts it was made from', () => {
      const patch = [
        '--- a.txt',
        '+++ b.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+2',
        ' three',
      ].join('\n');

      expect(lines({ patch })).to.deep.equal(
        lines({ new: NEW, newName: 'b.txt', old: OLD, oldName: 'a.txt' })
      );
    });

    it('should draw nothing for text that is not a patch', () => {
      expect(diff({ patch: 'nothing to see' }, { colorLevel: 0 })).to.equal('');
    });
  });

  describe('colour', () => {
    it('should draw removed lines in the error role, added in the success role and context muted', () => {
      const out = coloured({ new: NEW, old: OLD });

      expect(out).to.match(new RegExp(`${ESC}\\[[\\d;]*31m-two`));
      expect(out).to.match(new RegExp(`${ESC}\\[[\\d;]*32m\\+2`));
      expect(out).to.match(new RegExp(`${ESC}\\[2m1 1  one`));
    });

    it('should set the edited words in bold and leave the rest of the line as it was', () => {
      const out = coloured({
        new: 'const x = bar(1);',
        old: 'const x = foo(1);',
      });

      expect(out).to.include(`${ESC}[1mfoo${ESC}[22m`);
      expect(out).to.include(`${ESC}[1mbar${ESC}[22m`);
      expect(out).to.not.include(`${ESC}[1mconst`);
    });

    it('should not set anything in bold when asked not to compare', () => {
      const out = coloured(
        { new: 'const x = bar(1);', old: 'const x = foo(1);' },
        { intraline: false }
      );

      expect(out).to.not.include(`${ESC}[1m`);
    });

    it('should let a theme restyle the edited words and the lines by class', () => {
      const out = coloured(
        { new: 'const x = bar(1);', old: 'const x = foo(1);' },
        { theme: '.sigil-diff-change { underline: true } .sigil-diff-add { color: magenta }' }
      );

      expect(out).to.match(new RegExp(`${ESC}\\[[\\d;]*4m`));
      expect(out).to.match(new RegExp(`${ESC}\\[[\\d;]*35m`));
    });

    it('should leave the text and the markers alone at colour level 0', () => {
      const out = diff(
        { new: 'const x = bar(1);', old: 'const x = foo(1);' },
        { colorLevel: 0, width: 40 }
      );

      expect(out).to.equal(strip(out));
      expect(out).to.include('-const x = foo(1);');
    });
  });

  describe('highlight', () => {
    const keywords = (value: string) =>
      [...value.matchAll(/\bconst\b/g)].map((match) => ({
        end: match.index + match[0].length,
        start: match.index,
        token: 'keyword',
      }));

    it('should draw a token in its role on an added line', () => {
      const out = coloured({ new: 'const a = 1;', old: '' }, { highlight: keywords });

      // the accent is cyan, where the added line is green
      expect(out).to.match(new RegExp(`${ESC}\\[[\\d;]*36mconst`));
      expect(out).to.match(new RegExp(`${ESC}\\[[\\d;]*32ma = 1;`));
    });

    it('should leave a token muted on a context line', () => {
      const out = coloured(
        { new: 'const a = 1;\nx', old: 'const a = 1;\ny' },
        { context: 1, highlight: keywords }
      );

      expect(out).to.not.match(new RegExp(`${ESC}\\[[\\d;]*36m`));
    });

    it('should hand the hook the whole of a side, so a span can run over lines', () => {
      const seen: string[] = [];
      diff(
        { new: '/* a\nb */\nz', old: '/* a\nb */\ny' },
        {
          colorLevel: 0,
          highlight: (value) => {
            seen.push(value);
            return [];
          },
          width: 40,
        }
      );

      expect(seen).to.deep.equal(['/* a\nb */\ny', '/* a\nb */\nz']);
    });

    it('should paint the second line of a span that began on the first', () => {
      const out = coloured(
        { new: '/* a\nb */\nz', old: '/* a\nb */\ny' },
        {
          context: 2,
          highlight: (value) => [{ end: value.indexOf('*/') + 2, start: 0, token: 'comment' }],
        }
      );

      expect(out).to.include('b */');
      expect(out).to.not.match(new RegExp(`${ESC}\\[[\\d;]*3[0-7]mz`));
    });

    it('should carry a span from the lines between two hunks into the second', () => {
      const body = Array.from({ length: 12 }, (_, i) => `line ${i}`);
      const old = ['first', '/* a comment', ...body, '*/'].join('\n');
      const next = ['FIRST', '/* a comment', ...body.slice(0, 11), 'CHANGED', '*/'].join('\n');
      // a comment is only one where its opener is in the text the hook was handed
      const highlight = (value: string) =>
        value.includes('/*')
          ? [{ end: value.indexOf('*/') + 2, start: value.indexOf('/*'), token: 'comment' }]
          : [];
      const out = coloured({ new: next, old }, { context: 1, highlight });

      expect(out.match(/@@/g)).to.have.length(4);
      // the added line is inside a comment that began above the hunk it is in, so it
      // is muted rather than the added line's green
      expect(out).to.not.match(new RegExp(`${ESC}\\[[\\d;]*32m\\+?CHANGED`));
      expect(out).to.match(new RegExp(`${ESC}\\[[\\d;]*2m[^\\n]*CHANGED`));
    });

    it('should use the tokens of the hunk it was given when the input is a patch', () => {
      const seen: string[] = [];
      diff(
        { patch: '--- a\n+++ b\n@@ -1,2 +1,2 @@\n keep\n-old\n+new' },
        {
          colorLevel: 0,
          highlight: (value) => {
            seen.push(value);
            return [];
          },
        }
      );

      expect(seen).to.deep.equal(['keep\nold', 'keep\nnew']);
    });

    it('should refuse a token no class can carry', () => {
      expect(() =>
        diff(
          { new: 'a', old: '' },
          { colorLevel: 0, highlight: () => [{ end: 1, start: 0, token: 'a b' }] }
        )
      ).to.throw(/token/);
    });

    it('should carry the token as a class on the cells for an app sheet', () => {
      const out = coloured(
        { new: 'let a', old: '' },
        {
          highlight: () => [{ end: 3, start: 0, token: 'binding' }],
          theme: '.sigil-token-binding { color: magenta }',
        }
      );

      expect(out).to.match(new RegExp(`${ESC}\\[[\\d;]*35mlet`));
    });
  });

  describe('the width', () => {
    it('should span the terminal when no width is given', () => {
      expect(diffView({ new: 'a', old: '' }, { env: { COLUMNS: '33' } }).width).to.equal(33);
    });

    it('should read a width that is not a number as no width', () => {
      expect(
        diffView({ new: 'a', old: '' }, { env: { COLUMNS: '17' }, width: Number.NaN }).width
      ).to.equal(17);
    });
  });
});
