/**
 * `trash()`: moving a file or a directory to the trash, the way a desktop does.
 *
 * Written here rather than taken as a dependency, which is what the
 * zero-dependency constraint means in practice: each platform is reached with
 * what it already has. macOS through `NSFileManager`, by way of `osascript`;
 * Windows through the shell's `IFileOperation`, by way of PowerShell; and Linux
 * and every other Unix by the freedesktop.org spec, written out in
 * `freedesktop.ts` with nothing but `node:fs`.
 *
 * ## What it promises
 *
 * The item goes to the trash, or stays where it was and this throws. It never
 * deletes anything, as a fallback or otherwise: where the platform would delete an
 * item rather than keep it -- Windows, for one too large for its bin or on a drive
 * without one -- that is refused, and where the trash is on another device than
 * the item -- Linux, with no trash of its own on the item's mount -- it is not
 * copied there either. A delete the user can take back is the whole point, so
 * the one failure that cannot happen is a delete they cannot.
 *
 * `AGENTS.md` beside this file says why each platform is reached the way it is.
 */

import { __ } from '../i18n/index.js';
import { baseDir } from '../paths.js';
import { trashFreedesktop } from './freedesktop.js';
import { trashMacos } from './macos.js';
import { trashWindows } from './windows.js';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Moves a file or a directory to the trash.
 *
 * A symbolic link is moved as a link: what it points at is never touched. On
 * Linux the trash is the freedesktop.org one -- `$XDG_DATA_HOME/Trash`, or the
 * trash at the top of the item's own mount -- so pointing `XDG_DATA_HOME`
 * somewhere else points it at another trash, which is how a test keeps out of
 * the user's.
 *
 * The platform is read per call rather than when the module loads, the way
 * `which()` reads it.
 *
 * @param path - What to move, relative to the working directory or absolute.
 * @returns Where it is now, inside the trash -- for a message, or for a test to
 *   take it out again. Not a way to restore it: each platform keeps where it came
 *   from beside it, and only its own file manager reads that back. Empty on
 *   Windows, in the rare case the shell recycled the item without saying where.
 * @throws If it is not there, or the trash will not take it. Either way nothing
 *   was moved or deleted, and the message says why.
 */
export async function trash(path: string): Promise<string> {
  // `resolve('')` is the working directory, which is not what an empty string
  // asked for and is the last thing to move by accident
  if (typeof path !== 'string' || path === '') {
    throw new TypeError(__`Expected a path to move to the trash`);
  }
  const absolute = resolve(path);
  try {
    // the link, never what it points at, and the same error for a missing path
    // on every platform rather than three phrasings of it
    await lstat(absolute);
    if (process.platform === 'darwin') {
      return await trashMacos(absolute);
    }
    if (process.platform === 'win32') {
      return await trashWindows(absolute);
    }
    // the spec's default spelled as `paths.ts` spells it, through the same rule:
    // a `~` with no home to put over it is not absolute, so it is no trash
    const dataHome = baseDir(process.env.XDG_DATA_HOME) ?? baseDir('~/.local/share');
    if (!dataHome) {
      throw new Error(__`there is no home directory to keep a trash in`);
    }
    return (await trashFreedesktop(absolute, { dataHome })).path;
  } catch (err) {
    throw new Error(__`Could not move ${absolute} to the trash: ${(err as Error).message}`, {
      cause: err,
    });
  }
}
