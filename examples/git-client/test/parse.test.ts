import {
  hunkPatch,
  parseBranches,
  parseLog,
  parseStatus,
  patchText,
  splitPatch,
} from '../src/parse.ts';
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

const PATCH = [
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

describe('splitPatch', () => {
  it('should split files and hunks, keeping every line as git wrote it', () => {
    const files = splitPatch(PATCH);
    expect(files.map((file) => [file.path, file.hunks.length, file.binary])).toStrictEqual([
      ['a.txt', 2, false],
      ['nn.txt', 1, false],
      ['logo.png', 0, true],
    ]);
    // the carriage return is content, and staging a hunk without it is a different hunk
    expect(files[0]?.hunks[1]?.lines.at(-1)).toBe('+ten\r');
    // and so is the line git adds for a file with no final newline
    expect(files[1]?.hunks[0]?.lines).toContain('\\ No newline at end of file');
  });

  it('should write one hunk back as a patch of its own', () => {
    const [file] = splitPatch(PATCH);
    expect(file && hunkPatch(file, file.hunks[1]!)).toBe(
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

  it('should give back the text it was given, file by file', () => {
    expect(
      splitPatch(PATCH)
        .map((file) => `${patchText(file)}\n`)
        .join('')
    ).toBe(PATCH);
  });

  it('should read a quoted path off the diff line', () => {
    const [file] = splitPatch('diff --git "a/say \\"hi\\".txt" "b/say \\"hi\\".txt"\n');
    expect(file?.path).toBe('say "hi".txt');
  });
});
