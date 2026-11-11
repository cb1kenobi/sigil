/**
 * What git prints, read into data -- and a hunk written back as a patch.
 *
 * Every function here is pure, so `test/parse.test.ts` holds each one to git's
 * real output without a repository. The formats asked for are the machine ones:
 * `status --porcelain=v1 -z`, `for-each-ref` and `log` with NUL and unit
 * separators, so a path with a space or a subject with a `|` in it reads as
 * itself.
 */

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

/** One hunk of a patch, as git wrote it, line endings and `\ No newline` included. */
export interface PatchHunk {
  /** The `@@ -a,b +c,d @@` line. */
  readonly header: string;
  /** The lines after the header, each without its `\n` -- a `\r` stays, since it is content. */
  readonly lines: readonly string[];
}

/** One file of a patch: the lines before its first hunk, and the hunks. */
export interface PatchFile {
  /** Whether git said it was binary, which leaves no hunks to show or stage. */
  readonly binary: boolean;
  /** Whether the patch was cut short inside this file, so that hunks after the last are missing. */
  readonly cut?: boolean;
  /** `diff --git`, `index`, the mode lines, `---` and `+++`. */
  readonly header: readonly string[];
  readonly hunks: readonly PatchHunk[];
  /** The path the patch is about, read off the `diff --git` line. */
  readonly path: string;
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
 * Splits a patch git wrote into files and hunks, keeping every line as it was.
 * A second reader of the format `parsePatch()` reads, which SIG-370 is for.
 *
 * `parsePatch()` in `@ttylabs/sigil/components` reads a patch for showing it, and
 * drops what it does not draw -- `\ No newline at end of file` among it. Staging a
 * hunk writes the hunk back to `git apply`, and a hunk without that line is a
 * different hunk, so this keeps the text. It needs no line counts: inside a hunk
 * every line begins with a space, `+`, `-` or `\`, so a line that begins `@@` or
 * `diff --git` can only be the next hunk or the next file.
 *
 * @param patch - What `git diff` printed.
 * @returns The files, in order.
 */
export function splitPatch(patch: string): PatchFile[] {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const files: { binary: boolean; header: string[]; hunks: PatchHunk[]; path: string }[] = [];
  let hunk: { header: string; lines: string[] } | undefined;

  for (const line of lines) {
    const file = files.at(-1);
    if (line.startsWith('diff --git ')) {
      hunk = undefined;
      files.push({ binary: false, header: [line], hunks: [], path: pathOf(line) });
    } else if (file && line.startsWith('@@ ')) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      hunk.lines.push(line);
    } else if (file) {
      file.header.push(line);
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        file.binary = true;
      }
    }
  }
  return files;
}

/**
 * The path on a `diff --git a/x b/x` line: the `b` side, which is where the
 * change lands. Git quotes a path with unusual characters, and `core.quotepath`
 * is turned off where git is run, so only a path with a quote, a backslash or a
 * control character in it arrives quoted, and those escapes are undone here.
 *
 * @param line - The `diff --git` line.
 * @returns The path, without its `b/`.
 */
function pathOf(line: string): string {
  const rest = line.slice('diff --git '.length);
  const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) {
    const escapes: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t' };
    return (quoted[1] ?? '').replace(/\\(.)/g, (all, c: string) => escapes[c] ?? all);
  }
  const half = rest.lastIndexOf(' b/');
  return half === -1 ? rest : rest.slice(half + 3);
}

/**
 * One hunk as a patch of its own, which is what `git apply --cached` stages and
 * `git apply --cached --reverse` unstages.
 *
 * The file's header goes first, unchanged -- a new file's `new file mode` and
 * `--- /dev/null` are what make git create the path in the index rather than
 * look for it there -- and then the one hunk, its own counts unchanged, since
 * applying it alone is exactly what those counts describe.
 *
 * @param file - The file the hunk is in.
 * @param hunk - The hunk.
 * @returns The patch, ending in a newline as git's own do.
 */
export function hunkPatch(file: PatchFile, hunk: PatchHunk): string {
  return `${[...file.header, hunk.header, ...hunk.lines].join('\n')}\n`;
}

/**
 * The text of a patch file, for `diffView()`.
 *
 * @param file - The file.
 * @returns Its lines, as git wrote them.
 */
export function patchText(file: PatchFile): string {
  return [...file.header, ...file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines])].join('\n');
}
