/**
 * The file system, as a context, and the rules for changing it.
 *
 * `App()` takes no props -- it is what `runApp()` and the examples' smoke test
 * mount as it is -- so what a test has to replace comes in through a context, the
 * way the git client's git does: here the directory the manager opens on and the
 * calls it makes. Outside a provider it is the working directory and `node:fs`.
 *
 * Everything that decides whether an operation is allowed -- a name with a
 * separator in it, a directory copied into itself, a destination already taken --
 * is a plain function below, so the model asks before it shows a confirm and the
 * tests can ask the same thing without an app.
 */

import { createContext, type Context } from '@ttylabs/sigil/renderer';
import { cp, lstat, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** What an entry is, following a symbolic link to what it points at. */
export type EntryKind = 'directory' | 'file' | 'other';

/** One name in a directory. */
export interface Entry {
  /** A directory, a regular file, or anything else: a socket, a device, a dangling link. */
  readonly kind: EntryKind;
  /** Whether the name is a symbolic link; {@link kind} is then what it points at. */
  readonly link: boolean;
  readonly name: string;
  /** Absolute: the directory it was listed in, joined with its name. */
  readonly path: string;
  /** In bytes, for a file. `0` for anything else. */
  readonly size: number;
}

/** What the manager does to the file system, replaceable in a test. */
export interface Files {
  /** Copies a file or a whole directory to a path that does not exist yet. */
  copy(from: string, to: string): Promise<void>;
  /** Lists a directory, in no particular order. */
  list(dir: string): Promise<Entry[]>;
  /** Moves or renames, across devices too. */
  move(from: string, to: string): Promise<void>;
  /**
   * Reads the start of a file.
   *
   * @param path - Absolute.
   * @param limit - The most bytes to read.
   * @returns At most `limit` bytes from the start of the file.
   */
  read(path: string, limit: number): Promise<Uint8Array>;
  /** Removes a file, a link, or a directory and everything in it. */
  remove(path: string): Promise<void>;
  /**
   * Whether two paths name one file: the same name in another case on a file
   * system that ignores case, or a hard link. `false` where either is missing.
   */
  same(a: string, b: string): Promise<boolean>;
  /** Where the manager opens: absolute. */
  readonly start: string;
  /** Whether something, even a dangling link, has this path. */
  taken(path: string): Promise<boolean>;
  /** The path with every link resolved, or the path itself where it cannot be. */
  real(path: string): Promise<string>;
}

/** What {@link createFiles} is told. */
export interface FilesOptions {
  /** Where the manager opens. Defaults to the working directory. */
  readonly start?: string;
}

/**
 * The real file system.
 *
 * @param opts - Where to open.
 * @returns The calls the manager makes.
 */
export function createFiles(opts: FilesOptions = {}): Files {
  return {
    copy: copyTree,
    async list(dir) {
      const names = await readdir(dir, { withFileTypes: true });
      return Promise.all(names.map((dirent) => describe(dir, dirent.name, dirent)));
    },
    async move(from, to) {
      try {
        await rename(from, to);
      } catch (err) {
        // another device: `rename()` cannot, so it is a copy and then a removal,
        // which is what `mv` does
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
          throw err;
        }
        await copyTree(from, to);
        await rm(from, { force: false, maxRetries: 2, recursive: true });
      }
    },
    async read(path, limit) {
      const handle = await open(path, 'r');
      try {
        const buffer = new Uint8Array(limit);
        let filled = 0;
        while (filled < limit) {
          const { bytesRead } = await handle.read(buffer, filled, limit - filled, null);
          if (bytesRead === 0) {
            break;
          }
          filled += bytesRead;
        }
        return buffer.subarray(0, filled);
      } finally {
        await handle.close();
      }
    },
    async real(path) {
      try {
        return await realpath(path);
      } catch {
        return path;
      }
    },
    async remove(path) {
      // `rm()` reads the path with `lstat`, so a link to a directory loses the
      // link and keeps the directory it pointed at
      await rm(path, { force: false, maxRetries: 2, recursive: true });
    },
    async same(a, b) {
      try {
        const [x, y] = await Promise.all([lstat(a, { bigint: true }), lstat(b, { bigint: true })]);
        return x.dev === y.dev && x.ino === y.ino;
      } catch {
        return false;
      }
    },
    start: resolve(opts.start ?? process.cwd()),
    async taken(path) {
      try {
        await lstat(path);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        // anything else -- a permission, a path through a file -- is not a
        // promise that writing there is safe
        return true;
      }
    },
  };
}

/**
 * Copies a file or a directory whole to a path nothing has.
 *
 * `errorOnExist` with `force: false` is what stops a copy writing over a file
 * that appeared between the check and the copy. A link is copied as the link, the
 * way `cp -R` and every file manager do, rather than as what it points at -- which
 * for a link to `/` would be the whole disk.
 */
async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    recursive: true,
    verbatimSymlinks: true,
  });
}

/** Reads what one name in a directory is, following a link for its kind. */
async function describe(
  dir: string,
  name: string,
  dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }
): Promise<Entry> {
  const path = join(dir, name);
  const link = dirent.isSymbolicLink();
  let kind: EntryKind = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other';
  let size = 0;
  try {
    // `stat` follows a link, so a link to a directory is entered like one; a
    // dangling link, or one this process may not follow, stays `other`
    const info = await stat(path);
    kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    size = kind === 'file' ? info.size : 0;
  } catch {
    if (link) {
      kind = 'other';
    }
  }
  return { kind, link, name, path, size };
}

/** Where the manager opens, and how it reaches the disk. `provideContext()` another in a test. */
export const FilesContext: Context<Files> = createContext(createFiles(), 'files');

// -- the rules ------------------------------------------------------------------

/**
 * Whether a name is a dot file, which is what "hidden" means here on every
 * platform. Windows also has a hidden _attribute_, which Node does not read, so a
 * file Explorer hides is shown unless its name starts with a dot.
 *
 * @param name - The name.
 * @returns Whether it is hidden.
 */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/** One collator for every listing, so the order does not move with the machine's locale. */
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * A listing in the order the columns show it: directories first, then by name,
 * with numbers compared as numbers (`2` before `10`) and case set aside, and a
 * byte order to break a tie so the order is total.
 *
 * @param entries - The listing.
 * @returns A sorted copy.
 */
export function sortEntries(entries: readonly Entry[]): Entry[] {
  return entries.toSorted((a, b) => {
    const dirs = Number(b.kind === 'directory') - Number(a.kind === 'directory');
    return (
      dirs || COLLATOR.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
  });
}

/**
 * Narrows a listing to what is shown: dot files only when asked, and only names
 * that contain the filter. The filter ignores case unless it has a capital in it,
 * which is the pager's rule and `less`'s.
 *
 * @param entries - The listing, sorted.
 * @param opts - Whether hidden names are shown, and the filter.
 * @returns What the column shows.
 */
export function visibleEntries(
  entries: readonly Entry[],
  opts: { filter: string; hidden: boolean }
): Entry[] {
  const query = opts.filter;
  const fold = query === query.toLowerCase();
  const needle = fold ? query.toLowerCase() : query;
  return entries.filter(
    (entry) =>
      (opts.hidden || !isHidden(entry.name)) &&
      (needle === '' || (fold ? entry.name.toLowerCase() : entry.name).includes(needle))
  );
}

/**
 * Why a name cannot be given to a file, or `undefined` when it can.
 *
 * A name is one path segment: not empty, not `.` or `..`, and with no separator
 * in it -- `/` everywhere and `\` too on Windows, where both separate. A NUL is
 * refused because no file system takes one. Anything else is the file system's to
 * refuse, and its error is what the manager shows.
 *
 * @param name - What was typed.
 * @param platform - Whose separators. Defaults to this one.
 * @returns The reason, or `undefined`.
 */
export function nameProblem(
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (name === '') {
    return 'A name cannot be empty';
  }
  if (name === '.' || name === '..') {
    return `"${name}" is not a name a file can have`;
  }
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    return 'A name cannot have a path separator in it: move it instead';
  }
  if (name.includes('\0')) {
    return 'A name cannot have a NUL in it';
  }
  return undefined;
}

/**
 * Whether `child` is `parent` or somewhere under it, read off the paths alone.
 * Both should already have their links resolved, which {@link Files.real} does.
 *
 * Case is set aside on Windows and macOS, whose file systems ignore it by default,
 * so `C:\Work` is inside `c:\work`. On a case-sensitive volume of either that
 * refuses a copy that would have been fine, which is the safe way to be wrong.
 *
 * @param child - The path that may be inside.
 * @param parent - The directory.
 * @returns Whether it is.
 */
export function isInside(child: string, parent: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const a = fold ? child.toLowerCase() : child;
  const b = fold ? parent.toLowerCase() : parent;
  const rel = relative(b, a);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * The name a copy gets in a directory where its own is taken: `a copy.txt`, then
 * `a copy 2.txt`, and so on, which is Finder's spelling. A dot file's dot is part
 * of its name rather than an extension, so `.env` becomes `.env copy`.
 *
 * @param name - The name being copied.
 * @param n - Which copy: `1` is `copy`, and above that the number is written.
 * @returns The name.
 */
export function copyName(name: string, n: number): string {
  const ext = extname(name);
  const stem = ext === '' || ext === name ? name : name.slice(0, -ext.length);
  const suffix = ext === name ? '' : ext;
  return `${stem} copy${n > 1 ? ` ${n}` : ''}${suffix}`;
}

/** What pasting is going to do, or why it will not. */
export type PastePlan =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly to: string };

/**
 * Works out where a paste goes, and refuses what it must.
 *
 * A copy into a directory that already has the name takes the next free
 * {@link copyName}, so copying a file beside itself makes a copy of it. A move
 * never takes another name: one onto a taken name is refused rather than written
 * over, and one into the directory it is already in is nothing to do. And neither
 * puts a directory inside itself, which would copy forever or move it out of
 * reach.
 *
 * @param files - The file system, to ask what is taken.
 * @param mode - Copy or move.
 * @param from - What was yanked. A link is copied or moved as the link, so only a
 *   real directory can be put inside itself.
 * @param dir - Where it is going: absolute.
 * @returns Where it goes, or why it does not.
 */
export async function planPaste(
  files: Files,
  mode: 'copy' | 'move',
  from: Pick<Entry, 'kind' | 'link' | 'path'>,
  dir: string
): Promise<PastePlan> {
  const name = basename(from.path);
  if (!(await files.taken(from.path))) {
    return { ok: false, reason: `${name} is not there any more` };
  }
  const [source, target, home] = await Promise.all([
    files.real(from.path),
    files.real(dir),
    files.real(dirname(from.path)),
  ]);
  if (from.kind === 'directory' && !from.link && isInside(target, source)) {
    return { ok: false, reason: `Cannot ${mode} ${name} into itself` };
  }
  if (mode === 'move') {
    if (isInside(home, target) && isInside(target, home)) {
      return { ok: false, reason: `${name} is already here` };
    }
    const to = join(dir, name);
    if (await files.taken(to)) {
      return { ok: false, reason: `${name} is already taken here: rename one of them first` };
    }
    return { ok: true, to };
  }
  for (let n = 0; n < 1000; n++) {
    const to = join(dir, n === 0 ? name : copyName(name, n));
    if (!(await files.taken(to))) {
      return { ok: true, to };
    }
  }
  return { ok: false, reason: `No free name for a copy of ${name}` };
}

/**
 * Works out where a rename goes, and refuses what it must: a bad name, or one
 * already taken by another file. A name that differs only in case is taken by the
 * file itself on a file system that ignores case, and is still a rename.
 *
 * @param files - The file system.
 * @param from - The file: absolute.
 * @param name - The new name.
 * @returns Where it goes, or why not.
 */
export async function planRename(files: Files, from: string, name: string): Promise<PastePlan> {
  const problem = nameProblem(name);
  if (problem !== undefined) {
    return { ok: false, reason: problem };
  }
  const to = join(dirname(from), name);
  if (await files.taken(to)) {
    // taken by the file itself is a case-only rename on a file system that
    // ignores case, where the directory lists the old spelling and not the new
    // one. Two names of one hard link are taken by the same file too, and a
    // rename of one onto the other does nothing -- so a name the directory
    // already lists, exactly as typed, is taken whatever file it is
    const caseOnly = basename(from) !== name && basename(from).toLowerCase() === name.toLowerCase();
    const listed =
      caseOnly && (await files.list(dirname(from))).some((entry) => entry.name === name);
    if (!caseOnly || listed || !(await files.same(from, to))) {
      return { ok: false, reason: `${name} is already taken` };
    }
  }
  return { ok: true, to };
}

/**
 * A size as a person reads it: bytes up to a kilobyte, then one decimal while it
 * is a single digit -- `512 B`, `4.2 KB`, `38 KB`, `1.1 MB` -- in powers of 1024,
 * as `ls -h` counts them.
 *
 * @param bytes - The size.
 * @returns The label.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes;
  let unit = '';
  for (const next of ['KB', 'MB', 'GB', 'TB', 'PB']) {
    value /= 1024;
    unit = next;
    if (value < 1024) {
      break;
    }
  }
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${shown} ${unit}`;
}
