/**
 * What git prints, read into data. A patch is read by `parsePatch()` and a hunk
 * written back by `hunkPatch()`, both from `@ttylabs/sigil/components`.
 *
 * Every function here is pure, so `test/parse.test.ts` holds each one to git's
 * real output without a repository. The formats asked for are the machine ones:
 * `status --porcelain=v1 -z`, `for-each-ref` and `log` with NUL and unit
 * separators, so a path with a space or a subject with a `|` in it reads as
 * itself.
 */

import type { DiffFile } from '@ttylabs/sigil/components';

/** One path `git status` reports, and which of its two sides have changed. */
export interface FileChange {
  /** Whether the path has a merge conflict in it, which is neither side alone. */
  readonly conflicted: boolean;
  /** For a rename or a copy in the index, the path it came from. */
  readonly from?: string;
  /** The index's letter in `git status --short`: `M`, `A`, `D`, `R`, ` `... */
  readonly index: string;
  /** The path, from the top of the repository, with forward slashes on every platform. */
  readonly path: string;
  /** Whether the index differs from `HEAD` for this path: something to unstage. */
  readonly staged: boolean;
  /** Whether git does not track the path at all. */
  readonly untracked: boolean;
  /** Whether the working tree differs from the index: something to stage. */
  readonly unstaged: boolean;
  /** The working tree's letter. */
  readonly worktree: string;
}

/** Where `HEAD` is. */
export interface Head {
  /** Commits on the branch its upstream does not have. */
  readonly ahead: number;
  /** Commits on the upstream the branch does not have. */
  readonly behind: number;
  /** The branch, or nothing for a detached `HEAD`. */
  readonly branch?: string;
  /** Whether the branch has no commit yet, which is a repository just made. */
  readonly unborn: boolean;
  /** The branch it tracks, if it tracks one. */
  readonly upstream?: string;
}

/** What `git status` says: where `HEAD` is, and the paths that differ. */
export interface Status {
  readonly files: readonly FileChange[];
  readonly head: Head;
}

/** One local branch. */
export interface Branch {
  /** Whether it is the branch checked out. */
  readonly current: boolean;
  readonly name: string;
  /** The tip's abbreviated hash. */
  readonly sha: string;
  /** The tip's subject line. */
  readonly subject: string;
  /** How it stands against its upstream, as git words it: `[ahead 1]`, `[gone]`. */
  readonly track: string;
  readonly upstream: string;
}

/** One commit of the log. */
export interface Commit {
  readonly author: string;
  /** The full hash, which is what is asked about it later. */
  readonly sha: string;
  /** The abbreviated hash, which is what is shown. */
  readonly short: string;
  readonly subject: string;
  /** When, as git says it relative to now: `3 hours ago`. */
  readonly when: string;
}

/** The `XY` pairs that mean a merge left the path in conflict. */
const CONFLICTS = new Set(['AA', 'AU', 'DD', 'DU', 'UA', 'UD', 'UU']);

/**
 * Reads `git status --porcelain=v1 --branch -z`.
 *
 * Records are separated by NUL, and a rename's record is followed by one more
 * that is the path it came from -- which is why this walks the records by hand
 * rather than mapping them. The first record is the `##` branch line.
 *
 * @param out - What git printed.
 * @returns Where `HEAD` is, and every path that differs.
 */
export function parseStatus(out: string): Status {
  const records = out.split('\0');
  let head: Head = { ahead: 0, behind: 0, unborn: false };
  const files: FileChange[] = [];

  for (let at = 0; at < records.length; at++) {
    const record = records[at] ?? '';
    if (record === '') {
      continue;
    }
    if (record.startsWith('## ')) {
      head = parseHead(record.slice(3));
      continue;
    }
    const index = record[0] ?? ' ';
    const worktree = record[1] ?? ' ';
    const path = record.slice(3);
    // a rename or a copy names where it came from in the record after it
    const from = index === 'R' || index === 'C' ? records[++at] : undefined;
    const untracked = index === '?';
    const conflicted = CONFLICTS.has(`${index}${worktree}`);
    files.push({
      conflicted,
      from,
      index,
      path,
      staged: !untracked && !conflicted && index !== ' ' && index !== '!',
      untracked,
      unstaged: untracked || conflicted || (worktree !== ' ' && worktree !== '!'),
      worktree,
    });
  }

  return { files, head };
}

/**
 * Reads the text after `## `: `main...origin/main [ahead 1, behind 2]`, `No
 * commits yet on main`, or `HEAD (no branch)`.
 *
 * @param line - The branch line, without its `## `.
 * @returns Where `HEAD` is.
 */
function parseHead(line: string): Head {
  const unbornAt = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(line);
  if (unbornAt) {
    return { ahead: 0, behind: 0, branch: unbornAt[1], unborn: true };
  }
  if (line.startsWith('HEAD (no branch)')) {
    return { ahead: 0, behind: 0, unborn: false };
  }
  const match = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(line);
  const track = match?.[3] ?? '';
  return {
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    branch: match?.[1] ?? line,
    unborn: false,
    upstream: match?.[2],
  };
}

/** The `for-each-ref` format `parseBranches()` reads: six fields, NUL between them. */
export const BRANCH_FORMAT =
  '%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)';

/**
 * Reads `git for-each-ref --format=<BRANCH_FORMAT> refs/heads`.
 *
 * @param out - What git printed: a line a branch.
 * @returns The branches, in git's order, which is by name.
 */
export function parseBranches(out: string): Branch[] {
  return out
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [head = '', name = '', upstream = '', track = '', sha = '', subject = ''] =
        line.split('\0');
      return { current: head === '*', name, sha, subject, track, upstream };
    });
}

/** The `log` format `parseLog()` reads: five fields, a unit separator between them. */
export const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ar%x1f%s';

/**
 * Reads `git log -z --format=<LOG_FORMAT>`.
 *
 * @param out - What git printed: a NUL after each commit.
 * @returns The commits, newest first.
 */
export function parseLog(out: string): Commit[] {
  return out
    .split('\0')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', short = '', author = '', when = '', subject = ''] = record.split('\x1f');
      return { author, sha, short, subject, when };
    });
}

/**
 * The path a file of a patch is about, from the names `parsePatch()` read: the
 * new side, which is where the change lands, or the old one for a deletion.
 *
 * What is read here is the client's own choice rather than the format: every
 * patch is asked for with `--src-prefix=a/ --dst-prefix=b/`, so the prefix is
 * known, and `core.quotepath` is turned off where git is run, so only a path with
 * a quote, a backslash or a control character in it arrives quoted -- in C's
 * escapes, a control character as `\r` or in octal -- and those are undone.
 *
 * @param file - The file.
 * @returns The path, or nothing where the patch did not name it.
 */
export function pathOf(file: DiffFile): string | undefined {
  const name = file.newName === '/dev/null' ? file.oldName : (file.newName ?? file.oldName);
  if (name === undefined) {
    return undefined;
  }
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(name);
  return (quoted ? unquote(quoted[1] ?? '') : name).replace(/^[ab]\//, '');
}

/** What each of C's one-letter escapes stands for. */
const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };

/**
 * The text between the quotes of a name git quoted. An octal escape is a byte of
 * the name's UTF-8, so the bytes are gathered and decoded together.
 *
 * @param text - The name, without its quotes.
 * @returns The name.
 */
function unquote(text: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  // by code point, so a character outside the BMP is encoded whole
  const chars = [...text];
  for (let at = 0; at < chars.length; at++) {
    const c = chars[at] ?? '';
    if (c !== '\\') {
      bytes.push(...encoder.encode(c));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(chars.slice(at + 1, at + 4).join(''));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      at += 3;
    } else {
      const next = chars[at + 1] ?? '';
      bytes.push(...(ESCAPES[next] === undefined ? encoder.encode(next) : [ESCAPES[next]]));
      at += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
