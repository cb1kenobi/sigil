import {
  diffHunks,
  type DiffFile,
  type DiffHunk,
  hunkLinesPatch,
  hunkPatch,
  parsePatch,
} from '../../src/components/diff.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `hunkLinesPatch()`: some of a hunk's lines as a patch, which is only right if
 * `git apply --cached` takes it and the index ends up holding exactly the lines
 * that were chosen. So every case that stages is run against a real git in a
 * repository of its own, and what is asserted is `git show :f.txt` -- the same
 * way the git client's tests ask.
 */

/** Every directory this file made, removed when it is done. */
const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 5, recursive: true });
  }
});

/** A repository holding `f.txt` as `committed`, and the git that runs in it. */
interface Repo {
  /** Runs git in the repository and hands back what it printed. */
  git(args: string[], input?: string): string;
  /** Writes `f.txt` of the working tree, byte for byte. */
  write(content: string): void;
}

/**
 * A repository with `f.txt` committed as `committed`.
 *
 * Git is told nothing about the machine it is on, as the git client's tests do:
 * no system config, a global config of this test's own with `autocrlf` off, an
 * identity in the environment, and a ceiling at the temp directory.
 */
function repository(committed: string): Repo {
  const home = mkdtempSync(join(tmpdir(), 'sigil-lines-patch-'));
  made.push(home);
  const dir = join(home, 'repo');
  const config = join(home, 'gitconfig');
  writeFileSync(
    config,
    '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n\tsafecrlf = false\n[commit]\n\tgpgsign = false\n'
  );
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_')) {
      env[name] = value;
    }
  }
  Object.assign(env, {
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_NAME: 'Ada',
    GIT_CEILING_DIRECTORIES: home,
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
  });
  const git = (args: string[], input?: string): string =>
    execFileSync(
      'git',
      [
        '-c',
        'diff.noprefix=false',
        '-c',
        'diff.mnemonicPrefix=false',
        '-c',
        'color.ui=false',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8', env, input, stdio: 'pipe' }
    );
  execFileSync('git', ['init', '-q', dir], { env, stdio: 'pipe' });
  const write = (content: string): void => writeFileSync(join(dir, 'f.txt'), content);
  write(committed);
  git(['add', 'f.txt']);
  git(['commit', '-q', '-m', 'first']);
  return { git, write };
}

/** Which of `hunk`'s lines are changes, by their text with a sign: `+x` or `-x`. */
function pick(hunk: DiffHunk, ...signed: string[]): number[] {
  return signed.map((want) => {
    const at = hunk.lines.findIndex(
      (line) => line.kind !== 'context' && `${line.kind === 'add' ? '+' : '-'}${line.text}` === want
    );
    if (at < 0) {
      throw new Error(`no line ${want}`);
    }
    return at;
  });
}

/**
 * Stages some lines of the one hunk `committed` to `edited` makes, with git, and
 * hands back what the index then holds.
 *
 * @param committed - What is in HEAD and the index.
 * @param edited - What the working tree holds.
 * @param signed - The lines to stage, as `+text` and `-text`.
 * @returns The index's `f.txt`, and what is still unstaged.
 */
function staged(
  committed: string,
  edited: string,
  ...signed: string[]
): { index: string; patch: string; rest: string } {
  const repo = repository(committed);
  repo.write(edited);
  const [file] = parsePatch(repo.git(['diff']));
  const hunk = file!.hunks[0]!;
  const patch = hunkLinesPatch(file!, hunk, pick(hunk, ...signed))!;
  repo.git(['apply', '--cached', '--whitespace=nowarn', '-'], patch);
  return { index: repo.git(['show', ':f.txt']), patch, rest: repo.git(['diff']) };
}

describe('hunkLinesPatch()', () => {
  describe('staged with git', () => {
    it('should stage only the added lines it was given, and drop the others', () => {
      const got = staged('a\nb\nc\n', 'a\nX\nb\nY\nc\n', '+X');

      expect(got.index).to.equal('a\nX\nb\nc\n');
      // what was left out is still there to stage
      expect(got.rest).toContain('+Y');
      expect(got.rest).not.toContain('+X');
      expect(got.patch).toContain('@@ -1,3 +1,4 @@');
    });

    it('should stage only the removed lines it was given, and keep the others as context', () => {
      const got = staged('a\nb\nc\nd\ne\n', 'a\nc\ne\n', '-b');

      expect(got.index).to.equal('a\nc\nd\ne\n');
      expect(got.rest).toContain('-d');
      // the unselected deletion is written as the line it is, which is context
      expect(got.patch).toContain('@@ -1,5 +1,4 @@');
      expect(got.patch).toContain('\n d\n');
    });

    it('should stage half of a replacement, whichever half', () => {
      expect(staged('one\ntwo\nthree\n', 'one\n2\nthree\n', '+2').index).to.equal(
        'one\ntwo\n2\nthree\n'
      );
      expect(staged('one\ntwo\nthree\n', 'one\n2\nthree\n', '-two').index).to.equal('one\nthree\n');
      expect(staged('one\ntwo\nthree\n', 'one\n2\nthree\n', '-two', '+2').index).to.equal(
        'one\n2\nthree\n'
      );
    });

    it('should count a hunk of only additions and one of only removals', () => {
      const added = staged('a\nb\n', 'a\nX\nY\nb\n', '+Y');
      expect(added.index).to.equal('a\nY\nb\n');
      expect(added.patch).toContain('@@ -1,2 +1,3 @@');

      const removed = staged('a\nb\nc\n', 'a\n', '-c');
      expect(removed.index).to.equal('a\nb\n');
      expect(removed.patch).toContain('@@ -1,3 +1,2 @@');
    });

    it('should stage a line far down a file after one earlier lines left unstaged', () => {
      const lines = Array.from({ length: 40 }, (_, at) => `line ${at + 1}`);
      const edited = [...lines];
      edited.splice(30, 0, 'late');
      edited.splice(2, 0, 'early 1', 'early 2');
      const repo = repository(`${lines.join('\n')}\n`);
      repo.write(`${edited.join('\n')}\n`);
      const [file] = parsePatch(repo.git(['diff']));
      expect(file!.hunks).toHaveLength(2);
      const second = file!.hunks[1]!;

      repo.git(
        ['apply', '--cached', '--whitespace=nowarn', '-'],
        hunkLinesPatch(file!, second, pick(second, '+late'))!
      );
      const index = repo.git(['show', ':f.txt']).split('\n');
      expect(index).toContain('late');
      expect(index).not.toContain('early 1');

      // and the first hunk's one line, with the index now a line longer below it
      const first = file!.hunks[0]!;
      repo.git(
        ['apply', '--cached', '--whitespace=nowarn', '-'],
        hunkLinesPatch(file!, first, pick(first, '+early 2'))!
      );
      expect(repo.git(['show', ':f.txt']).split('\n').slice(0, 5)).to.deep.equal([
        'line 1',
        'line 2',
        'early 2',
        'line 3',
        'line 4',
      ]);
    });

    it('should keep a carriage return, which is a different line without it', () => {
      const got = staged('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\nd\r\n', '+d');

      expect(got.index).to.equal('a\r\nb\r\nc\r\nd\r\n');
      expect(got.patch).toContain('+d\r\n');
    });

    it('should stage a line added at the end of a file that has no final newline', () => {
      const got = staged('a\nb\n', 'a\nb\nc', '+c');

      expect(got.index).to.equal('a\nb\nc');
      expect(got.patch).toContain('+c\n\\ No newline at end of file\n');
    });

    it('should keep the no newline of a context line it leaves alone', () => {
      const got = staged('x\ny', 'w\nx\ny', '+w');

      expect(got.index).to.equal('w\nx\ny');
    });

    it('should stage removing the last line of a file that has no final newline', () => {
      expect(staged('a\nb', 'a\nB', '-b').index).to.equal('a\n');
    });

    it('should stage a line that gains its newline, with the line it replaces', () => {
      expect(staged('a\nb', 'a\nb\nc\n', '-b', '+b').index).to.equal('a\nb\n');
      expect(staged('a\nb', 'a\nb\nc\n', '-b', '+b', '+c').index).to.equal('a\nb\nc\n');
    });

    it('should stage some of the lines of a new file under the header that creates it', () => {
      const repo = repository('seed\n');
      writeFileSync(join(made.at(-1)!, 'repo', 'new.txt'), 'one\ntwo\nthree\n');
      repo.git(['add', 'new.txt']);
      const [file] = parsePatch(repo.git(['diff', '--cached', '--', 'new.txt']));
      repo.git(['rm', '-q', '--cached', 'new.txt']);
      const hunk = file!.hunks[0]!;

      const patch = hunkLinesPatch(file!, hunk, pick(hunk, '+one', '+three'))!;
      expect(patch).toContain('new file mode');
      expect(patch).toContain('@@ -0,0 +1,2 @@');
      repo.git(['apply', '--cached', '--whitespace=nowarn', '-'], patch);
      expect(repo.git(['show', ':new.txt'])).to.equal('one\nthree\n');
    });
  });

  describe('unstaged with git', () => {
    /** Stages the whole edit, then unstages some lines of it. */
    function unstaged(committed: string, edited: string, ...signed: string[]): string {
      const repo = repository(committed);
      repo.write(edited);
      repo.git(['add', 'f.txt']);
      const [file] = parsePatch(repo.git(['diff', '--cached']));
      const hunk = file!.hunks[0]!;
      const patch = hunkLinesPatch(file!, hunk, pick(hunk, ...signed), { reverse: true })!;
      repo.git(['apply', '--cached', '--reverse', '--whitespace=nowarn', '-'], patch);
      return repo.git(['show', ':f.txt']);
    }

    it('should unstage the lines it was given and leave the rest staged', () => {
      const before = 'a\nb\nc\nd\ne\n';
      const after = 'a\nB\nc\nD\ne\n';

      expect(unstaged(before, after, '-b', '+B')).to.equal('a\nb\nc\nD\ne\n');
      // an added line left out stays: it is context to what is applied to
      expect(unstaged(before, after, '-b')).to.equal('a\nb\nB\nc\nD\ne\n');
      expect(unstaged(before, after, '+B')).to.equal('a\nc\nD\ne\n');
    });

    it('should unstage added lines of a hunk with nothing removed', () => {
      expect(unstaged('a\nb\n', 'a\nX\nY\nb\n', '+Y')).to.equal('a\nX\nb\n');
    });
  });

  describe('what the patch says', () => {
    const PATCH = [
      'diff --git a/f.txt b/f.txt',
      'index 1111111..2222222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -3,4 +3,4 @@ heading',
      ' c',
      '-d',
      '+D',
      ' e',
      '-f',
      '+F',
      '',
    ].join('\n');

    it('should write the header as it was read, and counts from the lines it kept', () => {
      const [file] = parsePatch(PATCH);
      const hunk = file!.hunks[0]!;

      expect(hunkLinesPatch(file!, hunk, pick(hunk, '-d', '+D'))).to.equal(
        [
          'diff --git a/f.txt b/f.txt',
          'index 1111111..2222222 100644',
          '--- a/f.txt',
          '+++ b/f.txt',
          '@@ -3,4 +3,4 @@ heading',
          ' c',
          '-d',
          '+D',
          ' e',
          ' f',
          '',
        ].join('\n')
      );
      expect(hunkLinesPatch(file!, hunk, pick(hunk, '+D'))).toContain('@@ -3,4 +3,5 @@ heading');
      expect(hunkLinesPatch(file!, hunk, pick(hunk, '+D'))).toContain('\n d\n+D\n e\n f\n');
    });

    it('should write every line of a hunk the way hunkPatch() does', () => {
      const [file] = parsePatch(PATCH);
      const hunk = file!.hunks[0]!;

      expect(hunkLinesPatch(file!, hunk, pick(hunk, '-d', '+D', '-f', '+F'))).to.equal(
        hunkPatch(file!, hunk)
      );
    });

    it('should read back as a hunk whose counts say what it holds', () => {
      const [file] = parsePatch(PATCH);
      const hunk = file!.hunks[0]!;
      const back = parsePatch(hunkLinesPatch(file!, hunk, pick(hunk, '+F'))!)[0]!.hunks[0]!;

      expect(back.lines.map((line) => `${line.kind}:${line.text}`)).to.deep.equal([
        'context:c',
        'context:d',
        'context:e',
        'context:f',
        'add:F',
      ]);
      expect(back).toMatchObject({ newLines: 5, newStart: 3, oldLines: 4, oldStart: 3 });
    });

    it('should write a hunk no patch was read for, from its lines', () => {
      const hunks = diffHunks('one\ntwo\nthree\n', 'one\n2\nthree\n');
      const file = { hunks, newName: 'b/x.txt', oldName: 'a/x.txt' };
      const hunk = hunks[0]!;

      expect(hunkLinesPatch(file, hunk, pick(hunk, '+2'))).to.equal(
        ['--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,4 @@', ' one', ' two', '+2', ' three', ''].join(
          '\n'
        )
      );
    });

    it('should anchor an empty side on the line before, as a patch does', () => {
      const lines = [
        { kind: 'remove' as const, oldNumber: 1, text: 'gone' },
        { kind: 'add' as const, newNumber: 1, text: 'new' },
      ];
      const file: DiffFile = { hunks: [], newName: 'b/x', oldName: 'a/x' };
      const hunk: DiffHunk = { lines, newLines: 1, newStart: 1, oldLines: 1, oldStart: 1 };

      expect(hunkLinesPatch(file, hunk, [0])).toContain('@@ -1 +0,0 @@');
      expect(hunkLinesPatch(file, hunk, [1])).toContain('@@ -1 +1,2 @@');
      expect(hunkLinesPatch(file, hunk, [0], { reverse: true })).toContain('@@ -1,2 +1 @@');
    });

    it('should ignore a context line in the selection, and write nothing for no changes', () => {
      const [file] = parsePatch(PATCH);
      const hunk = file!.hunks[0]!;

      expect(hunkLinesPatch(file!, hunk, [])).toBeUndefined();
      expect(hunkLinesPatch(file!, hunk, [0, 3])).toBeUndefined();
      expect(hunkLinesPatch(file!, hunk, [0, ...pick(hunk, '+D')])).to.equal(
        hunkLinesPatch(file!, hunk, pick(hunk, '+D'))
      );
    });

    it('should keep the carriage return of a patch that has one on every row', () => {
      const [file] = parsePatch(PATCH.replaceAll('\n', '\r\n'));
      const hunk = file!.hunks[0]!;

      const written = hunkLinesPatch(file!, hunk, pick(hunk, '+D'))!;
      expect(written).toContain('@@ -3,4 +3,5 @@ heading\r\n');
      expect(written).toContain('\n d\r\n+D\r\n');
    });

    it('should write a blank context line that lost its space with one, and keep what follows it', () => {
      const patch = ['--- a/f', '+++ b/f', '@@ -1,3 +1,2 @@', ' a', '', '-c', ''].join('\n');
      const [file] = parsePatch(patch);
      const hunk = file!.hunks[0]!;

      expect(hunkLinesPatch(file!, hunk, pick(hunk, '-c'))).to.equal(
        '--- a/f\n+++ b/f\n@@ -1,3 +1,2 @@\n a\n \n-c\n'
      );
    });

    it('should write the no newline row the patch had, not a spelling of its own', () => {
      const patch = [
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,3 @@',
        ' a',
        ' b',
        '+c',
        '\\ No newline at end of file (odd)',
        '',
      ].join('\n');
      const [file] = parsePatch(patch);
      const hunk = file!.hunks[0]!;

      expect(hunkLinesPatch(file!, hunk, pick(hunk, '+c'))).toContain(
        '+c\n\\ No newline at end of file (odd)\n'
      );
    });

    it("should anchor an unstaging patch at the hunk's new side, which a later hunk moves", () => {
      const patch = [
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,4 @@',
        ' a',
        '+x',
        '+y',
        ' b',
        '@@ -20,2 +22,3 @@',
        ' t',
        '+z',
        ' u',
        '',
      ].join('\n');
      const [file] = parsePatch(patch);
      const hunk = file!.hunks[1]!;

      expect(hunkLinesPatch(file!, hunk, pick(hunk, '+z'), { reverse: true })).toContain(
        '@@ -22,2 +22,3 @@'
      );
      expect(hunkLinesPatch(file!, hunk, pick(hunk, '+z'))).toContain('@@ -20,2 +20,3 @@');
    });

    it('should refuse a position that is not a line of the hunk', () => {
      const [file] = parsePatch(PATCH);
      const hunk = file!.hunks[0]!;

      for (const bad of [-1, 6, 1.5, Number.NaN]) {
        expect(() => hunkLinesPatch(file!, hunk, [bad])).toThrow(RangeError);
      }
    });
  });

  describe('what a patch cannot say', () => {
    /** A parsed file and its first hunk, from `git diff` of two texts. */
    function hunkOf(committed: string, edited: string): { file: DiffFile; hunk: DiffHunk } {
      const repo = repository(committed);
      repo.write(edited);
      const [file] = parsePatch(repo.git(['diff']));
      return { file: file!, hunk: file!.hunks[0]! };
    }

    it('should refuse a line added after one with no newline that was not chosen', () => {
      const { file, hunk } = hunkOf('a\nb', 'a\nb\nc\n');

      // `-b` is context now, the last line of a side that has no newline
      expect(() => hunkLinesPatch(file, hunk, pick(hunk, '+c'))).toThrow(/no newline/);
      expect(() => hunkLinesPatch(file, hunk, pick(hunk, '+b'))).toThrow(/no newline/);
      expect(hunkLinesPatch(file, hunk, pick(hunk, '-b'))).toBeDefined();
    });

    it('should refuse part of a deleted file, and write all of it', () => {
      const repo = repository('x\ny\nz\n');
      repo.git(['rm', '-q', 'f.txt']);
      const [file] = parsePatch(repo.git(['diff', '--cached']));
      const hunk = file!.hunks[0]!;

      expect(() => hunkLinesPatch(file!, hunk, pick(hunk, '-x'))).toThrow(/deleted file/);
      expect(hunkLinesPatch(file!, hunk, pick(hunk, '-x', '-y', '-z'))).to.equal(
        hunkPatch(file!, hunk)
      );
      // unstaging part of a deletion is a smaller file coming back, which is fine
      const patch = hunkLinesPatch(file!, hunk, pick(hunk, '-x', '-z'), { reverse: true })!;
      repo.git(['apply', '--cached', '--reverse', '--whitespace=nowarn', '-'], patch);
      expect(repo.git(['show', ':f.txt'])).to.equal('x\nz\n');
    });

    it('should refuse unstaging part of a new file', () => {
      const repo = repository('seed\n');
      writeFileSync(join(made.at(-1)!, 'repo', 'new.txt'), 'one\ntwo\n');
      repo.git(['add', 'new.txt']);
      const [file] = parsePatch(repo.git(['diff', '--cached', '--', 'new.txt']));
      const hunk = file!.hunks[0]!;

      expect(() => hunkLinesPatch(file!, hunk, pick(hunk, '+one'), { reverse: true })).toThrow(
        /new file/
      );
    });
  });
});
