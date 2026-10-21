/**
 * Writing a reference, and checking that the one on disk is current.
 *
 * One function decides whether a file is current and one decides what to do
 * about it, so `--check` and a plain write cannot come to disagree: a check
 * that asked a different question from the write would pass over a file the
 * write was about to change, which is the whole failure a committed artifact
 * exists to prevent.
 */

import { displayPath } from '../build/diagnostic.ts';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One file a reference comes to. */
export interface ReferenceFile {
  /** Its content, ending in exactly one newline. */
  readonly body: string;
  /** Its name, relative to the destination and always forward-slashed. */
  readonly file: string;
}

/** What a destination does not already say. */
export interface Change {
  /** The path, as a reader should see it. */
  readonly path: string;
  /**
   * `added` for a file that is not there, `changed` for one whose content
   * moved, and `stale` for one in the destination that this would not have
   * written.
   */
  readonly kind: 'added' | 'changed' | 'stale';
}

/**
 * Two bodies compared with their line endings normalized.
 *
 * `.gitattributes` says `text=auto` and lists no `*.md`, so git checks a
 * markdown file out with CRLF on Windows -- and a reference is always written
 * with LF. A byte comparison would therefore fail `--check` on all three Windows
 * jobs over a tree with nothing wrong with it, which is the fifth time this
 * repository has been bitten by exactly that.
 *
 * So what is compared is the content rather than the bytes, which is also the
 * more honest question: what a check is about is whether the *surface* moved,
 * and a line ending is not part of it.
 *
 * Normalizing here rather than forcing `eol=lf` in `.gitattributes`, which
 * would fix this repository and not an app's -- and which is a **global** turbo
 * input, so editing it invalidates every task's hash for a gain that is a quiet
 * `git status` on one platform.
 *
 * @param a - One body.
 * @param b - The other.
 * @returns Whether they say the same thing.
 */
function same(a: string, b: string): boolean {
  return a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');
}

/**
 * Reads a file, or nothing where there is none.
 *
 * `ENOENT` alone is nothing, which is the rule `isMissing()` keeps one package
 * along: reading every error as absence is how a file that exists and cannot be
 * read comes to be reported as a file to write.
 *
 * @param path - The file.
 * @returns Its content, or `undefined`.
 * @throws If it is there and cannot be read.
 */
function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/**
 * What one file's destination does not already say.
 *
 * @param path - Where it goes.
 * @param body - What it should hold.
 * @returns The change, or nothing where the file is current.
 */
function compare(path: string, body: string): Change | undefined {
  const held = read(path);

  if (held === undefined) {
    return { kind: 'added', path: displayPath(path) };
  }
  if (!same(held, body)) {
    return { kind: 'changed', path: displayPath(path) };
  }
}

/**
 * Writes one file, making the directory it goes in.
 *
 * @param path - Where it goes.
 * @param body - What it holds.
 */
function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

/**
 * One file's identity, or nothing where it is not there.
 *
 * `dev:ino` rather than the path, because the question a sweep asks is whether
 * a directory entry **is** a file this run wrote -- and a name cannot answer
 * that on the filesystem this whole feature is read on. The default volume on
 * macOS and Windows is case-insensitive, so `DB.md` and `db.md` are one file
 * there and two on Linux; a name comparison therefore has to be the fold in one
 * place and exact in the other, which is two readers of one rule. The
 * filesystem answers it in one, correctly on both.
 *
 * @param path - The file.
 * @returns Its identity, or `undefined`.
 * @throws If it is there and cannot be read.
 */
function identity(path: string): string | undefined {
  try {
    const it = statSync(path);
    return `${it.dev}:${it.ino}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/**
 * The files in a directory this generator would not have written.
 *
 * Only the top level and only the extensions a reference writes, because a
 * docs directory legitimately holds other things -- an image, a nested guide --
 * and a reference has no business having an opinion about them.
 *
 * A name this run wrote is not stale, and neither is one that **is** a file it
 * wrote under another spelling. The second half was missing and it made a
 * case-only rename unfixable: `listed()` folds the case when it refuses two
 * pages that want one file, this compared names exactly, and on a
 * case-insensitive volume -- which is the one the fold was added for -- renaming
 * a command `DB` to `db` wrote the new bytes into the entry still called
 * `DB.md`, after which every `--check` reported it stale for ever and the
 * diagnostic told the reader to delete the only copy of the page. Measured.
 * Found by review.
 *
 * @param dir - The destination.
 * @param ours - The files this run produced.
 * @returns The stale ones, sorted.
 */
function stale(dir: string, ours: readonly ReferenceFile[]): Change[] {
  const written = new Set(ours.map((it) => it.file));
  const mine = new Set(
    ours.map((it) => identity(join(dir, it.file))).filter((it) => it !== undefined)
  );
  let held: string[];

  try {
    held = readdirSync(dir, { withFileTypes: true })
      .filter((it) => it.isFile() && it.name.endsWith('.md'))
      .map((it) => it.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  return held
    .filter((name) => !written.has(name) && !mine.has(identity(join(dir, name)) ?? ''))
    .sort()
    .map((name) => ({ kind: 'stale' as const, path: displayPath(join(dir, name)) }));
}

/** What to do about a destination. */
export interface SyncOptions {
  /** Compare rather than write. */
  readonly check?: boolean;
  /**
   * Whether to report a file in the destination this would not have written.
   *
   * A directory of pages has them -- a renamed command leaves its old page
   * behind -- and a single JSON file cannot.
   */
  readonly sweep?: boolean;
}

/**
 * Brings a destination up to date, or says what it would take.
 *
 * Nothing is ever deleted, which is the one place this parts from
 * `sigil build --out`. That directory is the build's: it created it and
 * `clean()` empties it. A reference is written into a directory a docs site
 * owns as well, where a hand-written page sits beside the generated ones -- so a
 * stale page is **reported** and left, and a `--check` fails over it. Reporting
 * costs the author one `rm`; deleting costs them a file they wrote, and the
 * guard that would make deleting safe does not exist: `sigil build`'s own
 * refusal is of the app root and above, and a destination typed one directory
 * wrong is below it.
 *
 * @param dir - The destination directory, or the file's own directory.
 * @param files - What the reference comes to.
 * @param opts - Whether to compare, and whether to sweep.
 * @returns Everything the destination did not already say.
 */
export function syncReference(
  dir: string,
  files: readonly ReferenceFile[],
  opts: SyncOptions = {}
): Change[] {
  const changes: Change[] = [];

  for (const { body, file } of files) {
    const path = join(dir, file);
    const change = compare(path, body);

    if (change) {
      changes.push(change);
    }
    if (!opts.check && change) {
      write(path, body);
    }
  }

  if (opts.sweep) {
    changes.push(...stale(dir, files));
  }

  return changes;
}
