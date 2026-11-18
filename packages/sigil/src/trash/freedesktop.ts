/**
 * The freedesktop.org trash, written out from the spec rather than handed to
 * `gio`, which a server or a container does not have.
 *
 * spec: https://specifications.freedesktop.org/trash-spec/latest/
 *
 * A trash is a directory holding `files/` and `info/`: the item goes into
 * `files/` under a name that is free, and `info/<that name>.trashinfo` says where
 * it came from and when. The home trash is `$XDG_DATA_HOME/Trash`, and it is the
 * one used for anything on the same device. Anything on another device goes to
 * that device's own trash at the top of its mount -- `.Trash/$uid` where the
 * administrator made a sticky `.Trash`, or `.Trash-$uid` otherwise -- because a
 * trash is a `rename()`, and a `rename()` across devices is a copy and a delete.
 * Where neither can be used, the item stays where it is and this throws.
 */

import { __ } from '../i18n/index.js';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

/** What {@link trashFreedesktop} is told: the parts of the environment it reads. */
export interface FreedesktopOptions {
  /** `$XDG_DATA_HOME`, already read, where the home trash lives. Absolute. */
  readonly dataHome: string;
  /**
   * The device a path is on, as a string. `lstat()`'s `dev` by default; a test
   * replaces it to make one directory another device, since it cannot mount one.
   */
  readonly device?: (path: string) => Promise<string>;
  /** When the item was trashed. Now, by default. */
  readonly now?: Date;
  /** The user's id, which names a trash at the top of a mount. `process.getuid()` by default. */
  readonly uid?: number;
}

/** Where an item went: the item itself, and the `.trashinfo` that describes it. */
export interface Trashed {
  /** The `.trashinfo` file. */
  readonly info: string;
  /** Where the item is now, inside the trash's `files/`. */
  readonly path: string;
}

/**
 * Moves a file or a directory into the freedesktop trash for the device it is on.
 *
 * @param path - Absolute. What a symbolic link points at is never touched: the link is what moves.
 * @param opts - The environment.
 * @returns Where it went.
 * @throws If the item cannot be read, or no trash on its device can be used --
 *   it is never copied, and never deleted.
 */
export async function trashFreedesktop(path: string, opts: FreedesktopOptions): Promise<Trashed> {
  const device = opts.device ?? lstatDevice;
  // the link, never what it points at: `lstat()` throws for a path that is not
  // there, which is the error a caller should see
  await lstat(path);
  // the parent's links resolved, so the walk up to the mount follows the real
  // directories and the path written down is one the item can go back to
  const parent = await realpath(dirname(path));
  const item = join(parent, basename(path));
  const dev = await device(item);
  // a file is on the device of the directory it is listed in; only the root of
  // a mount is not, and moving that is unmounting it
  if ((await device(parent)) !== dev) {
    throw new Error(__`it is the top of a mount`);
  }

  const home = join(opts.dataHome, 'Trash');
  if ((await device(await nearest(home))) === dev) {
    await mkdir(join(home, 'files'), { mode: 0o700, recursive: true });
    await mkdir(join(home, 'info'), { mode: 0o700, recursive: true });
    if (!(await realDirs(home))) {
      throw new Error(__`its trash at ${home} holds a link where a directory should be`);
    }
    // the home trash records an absolute path: the spec allows a relative one
    // only from `$XDG_DATA_HOME`, and a file under it is the rare case
    return move(item, home, item, opts.now);
  }

  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error(__`it is on another device, and there is no user id to name a trash there`);
  }
  const top = await mountOf(parent, dev, device);
  const trash = await topTrash(top, uid);
  if (trash === undefined) {
    throw new Error(__`it is on another device, whose trash at ${top} cannot be used`);
  }
  // relative to the top of the mount, which is what the spec asks of a trash
  // there: the mount can be somewhere else next time
  return move(item, trash, relative(top, item), opts.now);
}

/** `lstat()`'s device, as a string so that a 64-bit one survives. */
async function lstatDevice(path: string): Promise<string> {
  return String((await lstat(path, { bigint: true })).dev);
}

/**
 * The closest directory at or above `path` that exists: the home trash, before
 * anything has been trashed, is not there yet, and the device it will be on is
 * the device of what it will be made in.
 */
async function nearest(path: string): Promise<string> {
  let dir = path;
  for (;;) {
    try {
      await lstat(dir);
      return dir;
    } catch {
      const up = dirname(dir);
      if (up === dir) {
        return dir;
      }
      dir = up;
    }
  }
}

/**
 * The top of the mount `dir` is on: the highest directory above it on the same
 * device. Read by walking up rather than from `/proc/mounts`, which is Linux's
 * alone and lists a bind mount under a name the walk would never reach.
 */
async function mountOf(
  dir: string,
  dev: string,
  device: (path: string) => Promise<string>
): Promise<string> {
  let top = dir;
  for (;;) {
    const up = dirname(top);
    if (up === top || (await device(up)) !== dev) {
      return top;
    }
    top = up;
  }
}

/**
 * The sticky bit, written out because `fs.constants` does not export `S_ISVTX`:
 * `mode & constants.S_ISVTX` is `mode & undefined`, which is `0`, so every
 * `.Trash` failed it -- which is how the first run of the tests found it.
 */
const STICKY = 0o1000;

/**
 * The trash at the top of a mount the user may use, made if it has to be, or
 * nothing.
 *
 * The spec's two methods in its order. `$top/.Trash/$uid` where an administrator
 * made `.Trash`, which must be a real directory with the sticky bit -- a link or a
 * directory anyone can rename things out of is one somebody else controls, and
 * the spec says it must not be used. Then `$top/.Trash-$uid`, made here if it is
 * not there, which must be a real directory and the user's own.
 */
async function topTrash(top: string, uid: number): Promise<string | undefined> {
  const shared = join(top, '.Trash');
  const info = await lstat(shared).catch(() => undefined);
  // owned by root or by the user: the sticky bit stops other users renaming what
  // is inside, but never the directory's owner, so a `.Trash` another user made
  // is one they can empty by renaming `$uid` out of it
  if (info?.isDirectory() && info.mode & STICKY && (info.uid === 0 || info.uid === uid)) {
    const own = await ownDir(join(shared, String(uid)), uid);
    if (own) {
      return own;
    }
  }
  return ownDir(join(top, `.Trash-${uid}`), uid);
}

/**
 * A trash directory that is the user's, with its `files/` and `info/`, made where
 * it is missing. Nothing for one that is a link, not a directory, someone else's,
 * or cannot be made -- a read-only mount, a directory the user cannot write.
 */
async function ownDir(dir: string, uid: number): Promise<string | undefined> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return;
    }
  }
  const info = await lstat(dir).catch(() => undefined);
  if (!info?.isDirectory() || info.uid !== uid) {
    return;
  }
  try {
    await mkdir(join(dir, 'files'), { mode: 0o700, recursive: true });
    await mkdir(join(dir, 'info'), { mode: 0o700, recursive: true });
  } catch {
    return;
  }
  return (await realDirs(dir)) ? dir : undefined;
}

/**
 * Whether a trash's `files/` and `info/` are directories rather than links to
 * one: `mkdir()` and `rename()` follow a link in the middle of a path, so a
 * `files` that points somewhere else -- somewhere a cleaner empties -- would take
 * the item there and report it trashed.
 */
async function realDirs(trash: string): Promise<boolean> {
  for (const sub of ['files', 'info']) {
    const info = await lstat(join(trash, sub)).catch(() => undefined);
    if (!info?.isDirectory()) {
      return false;
    }
  }
  return true;
}

/**
 * Reserves a name in a trash, writes the `.trashinfo`, then moves the item in.
 *
 * The info file is made first, exclusively, because that is what reserves the
 * name: the spec has two programs trashing at once agree through it. A name whose
 * `files/` entry is taken anyway -- left behind by a program that died between
 * the two steps -- is skipped like one whose info file is.
 */
async function move(
  item: string,
  trash: string,
  recorded: string,
  now = new Date()
): Promise<Trashed> {
  const name = basename(item);
  const body = `[Trash Info]\nPath=${encodePath(recorded)}\nDeletionDate=${deletionDate(now)}\n`;
  for (let n = 1; ; n++) {
    const candidate = trashName(name, n);
    const info = join(trash, 'info', `${candidate}.trashinfo`);
    const to = join(trash, 'files', candidate);
    let handle;
    try {
      handle = await open(info, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw err;
    }
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    try {
      if (await exists(to)) {
        // not ours to remove, and not ours to write over: the next name
        await unlink(info);
        continue;
      }
      await rename(item, to);
    } catch (err) {
      await unlink(info).catch(() => {});
      throw err;
    }
    return { info, path: to };
  }
}

/** Whether anything, even a dangling link, has this path. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The name an item takes in a trash: its own, then `name.2.ext`, `name.3.ext`.
 * The number goes before the extension so the copy still opens with what the
 * original did, and a dot file -- whose dot is not an extension -- gets it at the
 * end.
 *
 * @param name - The item's own name.
 * @param n - Which try this is, from 1.
 * @returns The name.
 */
export function trashName(name: string, n: number): string {
  if (n === 1) {
    return name;
  }
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)}.${n}${ext}`;
}

/**
 * A path as a `.trashinfo` writes it: escaped as in a URL (RFC 2396), so a
 * newline in a name cannot end the line and a `%` cannot be read as an escape.
 * Each segment is escaped and the separators kept, which is what
 * `encodeURIComponent()` does with its unreserved set -- the RFC's exactly.
 *
 * @param path - Absolute, or relative to the top of a mount.
 * @returns The value of `Path=`.
 */
export function encodePath(path: string): string {
  return path.split(sep).map(encodeURIComponent).join('/');
}

/**
 * When, as a `.trashinfo` writes it: `YYYY-MM-DDThh:mm:ss`, in local time and
 * with no zone, which is the spec's own format and what every file manager reads.
 *
 * @param date - The moment.
 * @returns The value of `DeletionDate=`.
 */
export function deletionDate(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(date.getFullYear()).padStart(4, '0')}-${two(date.getMonth() + 1)}-` +
    `${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:` +
    `${two(date.getSeconds())}`
  );
}
