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
  hunkPatch,
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
      { kind: 'remove', noNewline: true, oldNumber: 2, text: 'two' },
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

/** What `git diff` prints for three files: two hunks, no final newline, and a binary. */
const GIT_PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' 1',
  '-2',
  '+two',
  ' 3',
  '@@ -9,2 +9,2 @@ heading',
  ' 9',
  '-10',
  '+ten\r',
  'diff --git a/nn.txt b/nn.txt',
  'index 3333333..4444444 100644',
  '--- a/nn.txt',
  '+++ b/nn.txt',
  '@@ -1 +1 @@',
  '-no newline',
  '\\ No newline at end of file',
  '+no newline2',
  '\\ No newline at end of file',
  'diff --git a/logo.png b/logo.png',
  'index 5555555..6666666 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

describe('parsePatch() and what it keeps to write back', () => {
  it('should say which line has no newline after it, after the counts have run out too', () => {
    const [, file] = parsePatch(GIT_PATCH);

    expect(file!.hunks[0]!.lines).to.deep.equal([
      { kind: 'remove', noNewline: true, oldNumber: 1, text: 'no newline' },
      { kind: 'add', newNumber: 1, noNewline: true, text: 'no newline2' },
    ]);
  });

  it('should keep a carriage return in the source and out of the text', () => {
    const [file] = parsePatch(GIT_PATCH);

    expect(file!.hunks[1]!.lines.at(-1)!.text).to.equal('ten');
    expect(file!.hunks[1]!.source).to.deep.equal([
      '@@ -9,2 +9,2 @@ heading',
      ' 9',
      '-10',
      '+ten\r',
    ]);
  });

  it('should keep a file git began with no hunks, and say when it is binary', () => {
    const files = parsePatch(GIT_PATCH);

    expect(files.map((file) => [file.newName, file.hunks.length, file.binary])).to.deep.equal([
      ['b/a.txt', 2, undefined],
      ['b/nn.txt', 1, undefined],
      ['b/logo.png', 0, true],
    ]);
  });

  it('should keep the lines above the first hunk from diff --git, and no commit message', () => {
    const [file] = parsePatch(`commit 123\nAuthor: me\n\n    A message\n\n${GIT_PATCH}`);

    expect(file!.header).to.deep.equal([
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
    ]);
  });

  it('should give back the patch it read, file by file and hunk by hunk', () => {
    const written = parsePatch(GIT_PATCH)
      .map((file) => [...file.header!, ...file.hunks.flatMap((hunk) => hunk.source!)].join('\n'))
      .join('\n');

    expect(`${written}\n`).to.equal(GIT_PATCH);
  });

  it('should read the names of a file with no hunk off its diff --git line', () => {
    /** The names of a file that changed mode, which is one path on both sides. */
    const names = (line: string): (string | undefined)[] => {
      const [file] = parsePatch(`${line}\nold mode 100644\nnew mode 100755\n`);
      return [file?.oldName, file?.newName];
    };

    expect(names('diff --git a/x.txt b/x.txt')).to.deep.equal(['a/x.txt', 'b/x.txt']);
    expect(names('diff --git a/with space.txt b/with space.txt')).to.deep.equal([
      'a/with space.txt',
      'b/with space.txt',
    ]);
    // a prefix may hold a space too, which git leaves unquoted
    expect(names('diff --git src prefix/f.txt dst prefix/f.txt')).to.deep.equal([
      'src prefix/f.txt',
      'dst prefix/f.txt',
    ]);
    // with diff.noprefix the two halves are the path itself
    expect(names('diff --git my file my file')).to.deep.equal(['my file', 'my file']);
    // and a prefix need not be a directory's
    expect(names('diff --git a/x/f.txt b/y/f.txt')).to.deep.equal(['a/x/f.txt', 'b/y/f.txt']);
    expect(names('diff --git src:f.txt dst:f.txt')).to.deep.equal(['src:f.txt', 'dst:f.txt']);
    // quoted as a `---` line would quote it, which is the spelling the names have
    expect(names('diff --git "a/say \\"hi\\".txt" "b/say \\"hi\\".txt"')).to.deep.equal([
      '"a/say \\"hi\\".txt"',
      '"b/say \\"hi\\".txt"',
    ]);
    expect(names('diff --git a/plain.txt "b/tab\\there.txt"')).to.deep.equal([
      'a/plain.txt',
      '"b/tab\\there.txt"',
    ]);
  });

  it('should split a rename where its halves end in the paths its header names', () => {
    /** The names of a rename with no content changes, as git prints one. */
    const renamed = (from: string, to: string, prefixes = ['a/', 'b/']): (string | undefined)[] => {
      const [old, next] = [`${prefixes[0]}${from}`, `${prefixes[1]}${to}`];
      const [file] = parsePatch(
        `diff --git ${old} ${next}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n`
      );
      return [file?.oldName, file?.newName];
    };

    expect(renamed('old.txt', 'new.txt')).to.deep.equal(['a/old.txt', 'b/new.txt']);
    // the halves agree under their prefixes at the space before `file`, and are not the names
    expect(renamed('dir/my file', 'dir/my')).to.deep.equal(['a/dir/my file', 'b/dir/my']);
    expect(renamed('old.txt', 'new file.txt')).to.deep.equal(['a/old.txt', 'b/new file.txt']);
    // a path that holds what looks like the other prefix
    expect(renamed('x b/y z/x', 'y')).to.deep.equal(['a/x b/y z/x', 'b/y']);
    expect(renamed('dir/my file', 'other/new file', ['', ''])).to.deep.equal([
      'dir/my file',
      'other/new file',
    ]);
    expect(renamed('README.md', 'NOTES.md', ['src:', 'dst:'])).to.deep.equal([
      'src:README.md',
      'dst:NOTES.md',
    ]);
  });

  it('should split a binary file where its Binary files line says the same names', () => {
    /** The names of a binary file, as `git diff` prints one with no `---` or `+++`. */
    const binary = (old: string, next: string, said = [old, next]): (string | undefined)[] => {
      const [file] = parsePatch(
        `diff --git ${old} ${next}\nindex 1111111..2222222 100644\nBinary files ${said[0]} and ${said[1]} differ\n`
      );
      return [file?.oldName, file?.newName];
    };

    // two blobs, or two files outside a repository: two paths, and no rename lines
    expect(binary('a/4b60195c', 'b/390e34a6')).to.deep.equal(['a/4b60195c', 'b/390e34a6']);
    expect(binary('a/foo bar', 'b/foo')).to.deep.equal(['a/foo bar', 'b/foo']);
    expect(binary('src prefix/x.png', 'dst prefix/y.png')).to.deep.equal([
      'src prefix/x.png',
      'dst prefix/y.png',
    ]);
    // a file added, whose old side the sentence calls /dev/null
    expect(binary('a/x/i.png', 'b/y/i.png', ['/dev/null', 'b/y/i.png'])).to.deep.equal([
      'a/x/i.png',
      'b/y/i.png',
    ]);
  });

  it('should give a file no names where its diff --git line does not settle them', () => {
    const [file] = parsePatch('diff --git a/x b/y b/z\nold mode 100644\nnew mode 100755\n');

    expect([file!.oldName, file!.newName]).to.deep.equal([undefined, undefined]);

    // two binaries written with --binary, whose names are nowhere else: a split
    // after "Visual Studio" is the only one whose halves end alike, and is wrong
    const [binary] = parsePatch(
      'diff --git a/Visual Studio Code.app/Code Helper b/bin/echo\nindex 1..2 100755\nGIT binary patch\nliteral 1\n'
    );
    expect([binary!.oldName, binary!.newName]).to.deep.equal([undefined, undefined]);
  });

  it('should take the names from --- and +++ where a file has them', () => {
    const [file] = parsePatch(
      'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
    );

    expect([file!.oldName, file!.newName]).to.deep.equal(['a/gone.txt', '/dev/null']);
    expect(file!.header).to.have.length(4);
  });

  it('should read a patch with CRLF line endings throughout the same as one without', () => {
    const crlf = parsePatch(GIT_PATCH.replace(/\r?\n/g, '\r\n'));
    const lf = parsePatch(GIT_PATCH);

    const shape = (files: typeof lf): unknown =>
      files.map((file) => [file.newName, file.binary, file.hunks.map((hunk) => hunk.lines)]);
    expect(shape(crlf)).to.deep.equal(shape(lf));
    // and what it keeps to write back is what it read, every carriage return in place
    const crlfPatch = GIT_PATCH.replace(/\r?\n/g, '\r\n');
    const written = crlf
      .map((file) => [...file.header!, ...file.hunks.flatMap((hunk) => hunk.source!)].join('\n'))
      .join('\n');
    expect(`${written}\n`).to.equal(crlfPatch);
    expect(crlf[0]!.header![0]).to.equal('diff --git a/a.txt b/a.txt\r');
  });

  it('should draw the files it read the same as the patch, and nothing of a file with no hunk', () => {
    const drawn = lines({ patch: GIT_PATCH });

    expect(lines({ files: parsePatch(GIT_PATCH) })).to.deep.equal(drawn);
    expect(drawn.join('\n')).to.contain('b/nn.txt');
    expect(drawn.join('\n')).not.to.contain('logo.png');
  });
});

describe('hunkPatch()', () => {
  it('should write one hunk back under its file header, as git wrote both', () => {
    const [file] = parsePatch(GIT_PATCH);

    expect(hunkPatch(file!, file!.hunks[1]!)).to.equal(
      [
        'diff --git a/a.txt b/a.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -9,2 +9,2 @@ heading',
        ' 9',
        '-10',
        '+ten\r',
        '',
      ].join('\n')
    );
  });

  it('should keep the no newline lines of a hunk at the end of a file', () => {
    const [, file] = parsePatch(GIT_PATCH);

    expect(hunkPatch(file!, file!.hunks[0]!)).to.equal(
      `${GIT_PATCH.split('\n').slice(13, 22).join('\n')}\n`
    );
  });

  it('should write a new file under the header that makes git create it', () => {
    const patch = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..3b18e51',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '',
    ].join('\n');
    const [file] = parsePatch(patch);

    expect(hunkPatch(file!, file!.hunks[0]!)).to.equal(patch);
  });

  it('should write a hunk no patch was read for from its lines, and read back the same', () => {
    const hunks = diffHunks('one\ntwo\nthree\n', 'one\n2\nthree\n');
    const file = { hunks, newName: 'b/x.txt', oldName: 'a/x.txt' };
    const written = hunkPatch(file, hunks[0]!);

    expect(written).to.equal(
      ['--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+2', ' three', ''].join(
        '\n'
      )
    );
    expect(parsePatch(written)[0]!.hunks[0]!.lines).to.deep.equal(hunks[0]!.lines);
  });

  it('should write a line with no newline after it the way git does', () => {
    const file = {
      hunks: [],
      newName: 'b/x',
      oldName: 'a/x',
    };
    const hunk = {
      lines: [
        { kind: 'remove' as const, noNewline: true, oldNumber: 1, text: 'x' },
        { kind: 'add' as const, newNumber: 1, text: 'x' },
      ],
      newLines: 1,
      newStart: 1,
      oldLines: 1,
      oldStart: 1,
    };

    expect(hunkPatch(file, hunk)).to.equal(
      '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+x\n'
    );
    expect(parsePatch(hunkPatch(file, hunk))[0]!.hunks[0]!.lines).to.deep.equal(hunk.lines);
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

  describe('wrap', () => {
    const at = (text: string, width: number, opts: DiffOptions): string[] =>
      lines({ new: text, old: '' }, { lineNumbers: false, width, ...opts }).slice(1);

    it('should fold by columns unless it is asked otherwise, every space kept', () => {
      expect(at('ab      cd', 6, {})).to.deep.equal(['+ab', '    cd']);
      expect(at('ab      cd', 6, { wrap: 'columns' })).to.deep.equal(at('ab      cd', 6, {}));
    });

    it('should fold at words, and drop the spaces a fold lands in', () => {
      // the padding of a Markdown table's row: ten rows of nothing by columns
      const row = `| name${' '.repeat(60)}| value${' '.repeat(60)}|`;

      expect(at(row, 20, { wrap: 'words' })).to.deep.equal(['+| name', ' | value', ' |']);
      expect(at('one two three', 10, { wrap: 'words' })).to.deep.equal(['+one two', ' three']);
    });

    it('should keep the spaces that fit, and add no row for spaces that end a line', () => {
      expect(at('a  b', 10, { wrap: 'words' })).to.deep.equal(['+a  b']);
      expect(at(`abc${' '.repeat(30)}`, 10, { wrap: 'words' })).to.have.length(1);
    });

    it('should keep the indentation that starts a line, folding it by columns where it is wider', () => {
      expect(at('    if (x) return', 12, { wrap: 'words' })).to.deep.equal([
        '+    if (x)',
        ' return',
      ]);
      expect(at(`${' '.repeat(12)}x`, 6, { wrap: 'words' })).to.deep.equal(['+', '', '   x']);
      // after a character with no width, such as the byte order mark a file can start with
      expect(at(`\uFEFF${' '.repeat(8)}code`, 8, { wrap: 'words' })).to.deep.equal(['+', '  code']);
    });

    it('should not start a row for a character wider than the room after one with no width', () => {
      // a tab is a cell of four columns, wider than this room of three; a byte order
      // mark before it is no width, so the tab is the first row's, as without the mark
      for (const wrap of ['columns', 'words'] as const) {
        expect(at('\uFEFF\tcode', 4, { wrap }), wrap).to.deep.equal(at('\tcode', 4, { wrap }));
      }
    });

    it('should fold at a space or a tab and nowhere else, so a no-break space is kept', () => {
      // the break spaces wrap() breaks at: a no-break space is part of its word
      expect(at('hello\u00A0world', 6, { wrap: 'words' })).to.deep.equal([
        '+hello',
        ' \u00A0worl',
        ' d',
      ]);
      // an ideographic space too, which is two columns: kept, and folded with its word
      expect(at('語\u3000句', 4, { wrap: 'words' })).to.deep.equal(['+語', ' \u3000', ' 句']);
    });

    it('should fold a word longer than a row by columns, from where it is', () => {
      expect(at(`ab ${'x'.repeat(12)}`, 6, { wrap: 'words' })).to.deep.equal([
        '+ab xx',
        ' xxxxx',
        ' xxxxx',
      ]);
      // and move one that fits on a row of its own to the next
      expect(at('ab xxxxx', 6, { wrap: 'words' })).to.deep.equal(['+ab', ' xxxxx']);
    });

    it('should keep a line on one row with none, cut at the edge with an ellipsis', () => {
      expect(at('abcdefghij', 6, { wrap: 'none' })).to.deep.equal(['+abcd…']);
      expect(at('abcde', 6, { wrap: 'none' })).to.deep.equal(['+abcde']);
      // a room of one is the ellipsis alone
      expect(at('abc', 2, { wrap: 'none' })).to.deep.equal(['+…']);
      expect(
        diffView({ new: 'abcdefghij\nab', old: '' }, { lineNumbers: false, width: 6, wrap: 'none' })
          .overflow
      ).to.equal(5);
    });

    it('should scroll every line by the offset, and leave the gutter and the marker where they are', () => {
      const text = 'abcdefghij\nklmnopqrst';

      expect(
        lines({ new: text, old: '' }, { offset: 3, width: 11, wrap: 'none' }).slice(1)
      ).to.deep.equal(['  1 +defgh…', '  2 +nopqr…']);
      // as far as the overflow, the end of the widest line is in view and not cut
      expect(at('abcdefghij', 6, { offset: 5, wrap: 'none' })).to.deep.equal(['+fghij']);
      expect(at('abcdefghij', 6, { offset: 99, wrap: 'none' })).to.deep.equal(['+']);
    });

    it('should draw the half of a wide character the offset leaves in view as a space', () => {
      // 日 is two columns: an offset of one leaves its second half
      expect(at('日本語', 5, { offset: 1, wrap: 'none' })).to.deep.equal(['+ 本…']);
      // and one the edge falls inside is left off, the ellipsis after what fits
      expect(at('日本語', 4, { offset: 1, wrap: 'none' })).to.deep.equal(['+ …']);
    });

    it('should cut each half on its own when side by side, and report the wider', () => {
      const tree = diffView(
        { new: 'x'.repeat(60), old: 'short' },
        { layout: 'side-by-side', width: DIFF_SIDE_BY_SIDE_MIN_WIDTH, wrap: 'none' }
      );

      expect(tree.layout).to.equal('side-by-side');
      // the halves' rooms are 25 and 26 columns, and the sixty are on the wider
      expect(tree.overflow).to.equal(34);
      expect(
        lines(
          { new: 'x'.repeat(60), old: 'short' },
          { layout: 'side-by-side', width: DIFF_SIDE_BY_SIDE_MIN_WIDTH, wrap: 'none' }
        ).slice(1)
      ).to.have.length(1);
    });

    it('should say how far each row runs past its room, beside the rows', () => {
      const tree = diffView(
        { new: 'abcdefghij\nab\n', newName: 'b.txt', old: 'ab\n', oldName: 'a.txt' },
        { lineNumbers: false, width: 6, wrap: 'none' }
      );

      // ---, +++, @@, then +abcdefghij, then the context line ab
      expect(tree.rowOverflow).to.deep.equal([0, 0, 0, 5, 0]);
      expect(tree.rowOverflow).to.have.length(tree.element.children.length);
      // and how wide each row's line is, whatever the room
      expect(tree.rowWidth).to.deep.equal([0, 0, 0, 10, 2]);
      const folded = diffView({ new: 'abcdefghij', old: '' }, { lineNumbers: false, width: 6 });
      expect(folded.rowOverflow.every((run) => run === 0)).to.equal(true);
      expect(folded.rowOverflow).to.have.length(folded.element.children.length);
      // every row of a folded line is its whole line's width
      expect(folded.rowWidth).to.deep.equal([0, 10, 10]);
      const sides = diffView(
        { new: 'x'.repeat(60), old: 'short' },
        { layout: 'side-by-side', width: DIFF_SIDE_BY_SIDE_MIN_WIDTH, wrap: 'none' }
      );
      expect(sides.rowWidth).to.deep.equal([0, 60]);
    });

    it('should report no overflow while folding', () => {
      expect(diffView({ new: 'x'.repeat(60), old: '' }, { width: 20 }).overflow).to.equal(0);
      expect(
        diffView({ new: 'x'.repeat(60), old: '' }, { width: 20, wrap: 'words' }).overflow
      ).to.equal(0);
    });

    it('should refuse a wrap it does not know', () => {
      expect(() => diffView({ new: 'a', old: '' }, { wrap: 'word' as never })).to.throw(
        /columns, words or none/
      );
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
