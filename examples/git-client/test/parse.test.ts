import { parseBranches, parseLog, parseStatus, pathOf } from '../src/parse.ts';
import { parsePatch } from '@ttylabs/sigil/components';
import { describe, expect, it } from 'vitest';

/**
 * The parsers, against what git 2.54 printed for each format -- copied from a
 * terminal rather than written from the documentation, NULs and all.
 */

describe('parseStatus', () => {
  it('should read the branch line and every kind of path', () => {
    const out = [
      '## main...origin/main [ahead 2, behind 1]',
      ' M two.txt',
      'R  uno.txt',
      'one.txt',
      'MM both.txt',
      'A  added.txt',
      '?? dir/new file.txt',
      'UU conflict.txt',
      '',
    ].join('\0');
    const { files, head } = parseStatus(out);

    expect(head).toStrictEqual({
      ahead: 2,
      behind: 1,
      branch: 'main',
      unborn: false,
      upstream: 'origin/main',
    });
    expect(files.map((file) => [file.path, file.staged, file.unstaged])).toStrictEqual([
      ['two.txt', false, true],
      ['uno.txt', true, false],
      ['both.txt', true, true],
      ['added.txt', true, false],
      ['dir/new file.txt', false, true],
      ['conflict.txt', false, true],
    ]);
    // a rename's source is the record after it, not a path of its own
    expect(files[1]?.from).toBe('one.txt');
    expect(files[4]?.untracked).toBe(true);
    expect(files[5]?.conflicted).toBe(true);
  });

  it('should read a branch with no commits, a detached HEAD, and no upstream', () => {
    expect(parseStatus('## No commits yet on main\0').head).toStrictEqual({
      ahead: 0,
      behind: 0,
      branch: 'main',
      unborn: true,
    });
    expect(parseStatus('## HEAD (no branch)\0').head.branch).toBeUndefined();
    expect(parseStatus('## feature/x\0').head).toStrictEqual({
      ahead: 0,
      behind: 0,
      branch: 'feature/x',
      unborn: false,
      upstream: undefined,
    });
  });
});

describe('parseBranches', () => {
  it('should read the six fields, and which one is checked out', () => {
    const out = [
      ['*', 'main', 'origin/main', '[ahead 1]', '875221c', 'first'].join('\0'),
      [' ', 'topic', '', '', 'abc1234', 'a | b'].join('\0'),
      '',
    ].join('\n');
    expect(parseBranches(out)).toStrictEqual([
      {
        current: true,
        name: 'main',
        sha: '875221c',
        subject: 'first',
        track: '[ahead 1]',
        upstream: 'origin/main',
      },
      { current: false, name: 'topic', sha: 'abc1234', subject: 'a | b', track: '', upstream: '' },
    ]);
  });
});

describe('parseLog', () => {
  it('should read a commit a record, with the newline git puts between records', () => {
    const out =
      'aaaa\x1faa\x1fAda\x1f2 hours ago\x1fsecond\0\nbbbb\x1fbb\x1fBo\x1f3 days ago\x1ffirst\0';
    expect(parseLog(out)).toStrictEqual([
      { author: 'Ada', sha: 'aaaa', short: 'aa', subject: 'second', when: '2 hours ago' },
      { author: 'Bo', sha: 'bbbb', short: 'bb', subject: 'first', when: '3 days ago' },
    ]);
  });
});

/** The first file of a patch, as `parsePatch()` reads it. */
function fileOf(patch: string) {
  const [file] = parsePatch(patch);
  if (!file) {
    throw new Error('no file in the patch');
  }
  return file;
}

// the patch itself is read and written back by `parsePatch()` and `hunkPatch()`,
// whose tests are in `packages/sigil/test/components/diff.test.ts`
describe('pathOf', () => {
  it('should read the new side without its prefix', () => {
    expect(pathOf(fileOf('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n'))).toBe('a.txt');
  });

  it('should read the old side of a deletion', () => {
    expect(
      pathOf(fileOf('diff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n'))
    ).toBe('gone.txt');
  });

  it('should read a file with no hunks off its diff line, a rename to where it went', () => {
    expect(
      pathOf(
        fileOf(
          'diff --git a/a.txt b/moved.txt\nsimilarity index 100%\nrename from a.txt\nrename to moved.txt\n'
        )
      )
    ).toBe('moved.txt');
    expect(
      pathOf(
        fileOf('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n')
      )
    ).toBe('logo.png');
  });

  it('should undo every escape git quotes a path with', () => {
    expect(pathOf(fileOf('diff --git "a/a\\r.txt" "b/a\\r.txt"\n'))).toBe('a\r.txt');
    expect(pathOf(fileOf('diff --git "a/\\033[31m" "b/\\033[31m"\n'))).toBe('\x1b[31m');
    // an octal escape is a byte of the name's UTF-8, and a run of them is one character
    expect(pathOf(fileOf('diff --git "a/\\303\\251\\a" "b/\\303\\251\\a"\n'))).toBe('é\x07');
  });

  it('should read a rename with spaces in its names off the diff line', () => {
    expect(
      pathOf(
        fileOf(
          'diff --git a/dir/my file b/dir/my\nsimilarity index 100%\nrename from dir/my file\nrename to dir/my\n'
        )
      )
    ).toBe('dir/my');
  });

  it('should read a quoted path off the diff line', () => {
    expect(pathOf(fileOf('diff --git "a/say \\"hi\\".txt" "b/say \\"hi\\".txt"\n'))).toBe(
      'say "hi".txt'
    );
  });
});
