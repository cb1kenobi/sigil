import { mkdirOwnerSync } from '../util/mkdir-owner-sync.js';
import {
	chmodSync,
	chownSync,
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { chmod, chown, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writing a file without the window in which it is half written.
 *
 * A crash mid-write truncates a user's config, which for a file they
 * hand-edited is the worst thing this module can do to them. So: write a temp
 * file, flush it, and `rename()` it over the target, which is atomic -- a
 * reader sees the old file or the new one and never half of either.
 *
 * There is no temp-plus-rename precedent in this repository, so every decision
 * in here is new machinery and is written down.
 *
 * ## The temp file goes in the target's own directory
 *
 * `rename()` is only atomic **within one filesystem**, so a temp file in
 * `tmp()` is a copy and a delete rather than a rename -- which has the window
 * back, plus a cross-device failure on the platforms that refuse `EXDEV`. The
 * cost is a stray `.tmp` beside the config when a process is killed between the
 * write and the rename, which is litter rather than damage.
 *
 * ## The target's mode is preserved and its setuid bits are not
 *
 * A `600` config has to come back `600`, or writing a setting hands its
 * contents to every user on the machine. The permission bits are copied
 * exactly; the setuid, setgid and sticky bits are **not**, because re-creating
 * one on a file this just wrote is a privilege decision a config writer has no
 * business making. A file that did not exist gets whatever the umask says,
 * which is what every other new file on the system gets.
 *
 * ## And its owner, under sudo
 *
 * `sudo mycli config set` must not leave a root-owned config in somebody's home
 * directory, after which they cannot edit their own settings without sudo
 * again. So when the process is root the temp file is chowned before the
 * rename: to the target's own owner where there is one, and to the containing
 * directory's where the file is new. That is `mkdirOwnerSync()`'s rule -- apply
 * the parent directory's owner under sudo -- read one level down, which is what
 * makes the directory and the file it holds agree.
 *
 * ## It flushes, and it does not flush the directory
 *
 * Without an `fsync()` the rename can be visible after a power loss while the
 * data behind it is not, which is the truncated file this exists to prevent
 * arriving by the other road. The temp file is flushed before the rename;
 * the *directory* is not, which is where `write-file-atomic` -- the package npm
 * itself writes with -- draws the same line. What that gives up is durability
 * of the rename itself across a power loss, where what it buys is one fewer
 * disk round trip per save on every filesystem.
 *
 * A flush the filesystem **declined** is swallowed, because one that refuses the
 * operation refuses it always: `FLUSH_DECLINED` is the five codes that mean
 * that, and failing a save over a durability hint the kernel declined is
 * refusing to write a file that would have written perfectly. A flush that
 * **failed** is raised, which is the whole point of flushing -- see
 * `declinesFlush()` for which is which, and read the set there rather than a
 * list here: this comment named two of the five for a commit, and aligning the
 * catch with it would start failing saves on the other three.
 */

/** What the target has that the replacement should keep. */
interface Keep {
	gid?: number;
	mode?: number;
	uid?: number;
}

/** So that two saves in one process cannot pick the same temp name. */
let seq = 0;

/**
 * The errors that mean "this filesystem does not do flushes", rather than
 * "flushing this file failed".
 *
 * A bare `catch` here was wider than the documented set, which a review round
 * caught -- and the difference is the whole point of flushing: an `EIO` or an
 * `ENOSPC` out of `fsync()` says the bytes may not be on disk, which is the
 * truncated file this module exists to prevent arriving by the one road it was
 * meant to close. So those are raised and the five below are swallowed, each of
 * which is a filesystem declining the operation itself and declining it always.
 */
const FLUSH_DECLINED = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);

/**
 * Whether a failed flush is a filesystem that does not flush.
 *
 * @param e - What `fsync()` threw.
 * @returns Whether to carry on with the rename.
 */
function declinesFlush(e: unknown): boolean {
	return FLUSH_DECLINED.has((e as { code?: string }).code ?? '');
}

/** Whether this process can hand a file to somebody else. */
function isRoot(): boolean {
	return process.getuid !== undefined && process.getuid() === 0;
}

/** The temp file, beside the target so that the rename is a rename. */
function tempFor(path: string): string {
	return `${path}.${process.pid}-${seq++}.tmp`;
}

/**
 * Whether a failed read or stat means the path is simply not there.
 *
 * One predicate because there are two callers and they ask the same question:
 * a config file that does not exist yet is the ordinary state of one, and every
 * *other* reason a read can fail is something to report. `EISDIR` is
 * deliberately not in here -- a path that names a directory is an app pointing
 * at the wrong thing, and answering "there is nothing there" for it is the
 * silence that costs an afternoon.
 *
 * @param e - What the call threw.
 * @returns Whether to read it as nothing being there.
 */
export function isMissing(e: unknown): boolean {
	return (e as { code?: string }).code === 'ENOENT';
}

/**
 * The target's mode and owner, or nothing where there is no target yet.
 *
 * Only `ENOENT` is nothing: a new file has no mode to carry over, which is the
 * whole reason this may answer with nothing at all. Anything else is **raised**,
 * which took a review round -- a bare `catch` read an `EPERM` or an `EIO` as a
 * file that is not there, so the mode of a file that *is* there was silently not
 * carried and a `0o600` config came back world-readable. The open that follows
 * would very likely have failed anyway; what matters is that it fails saying
 * what went wrong rather than quietly writing the wrong permissions.
 *
 * @param path - The file.
 * @returns Its mode and owner, or nothing.
 * @throws If the stat failed for any reason but the file not being there.
 */
function statOf(path: string): { gid: number; mode: number; uid: number } | undefined {
	try {
		const it = statSync(path);
		return { gid: it.gid, mode: it.mode, uid: it.uid };
	} catch (e: unknown) {
		if (isMissing(e)) {
			return undefined;
		}
		throw e;
	}
}

/**
 * What to carry over from the file being replaced.
 *
 * @param path - The target.
 * @returns The mode and, under sudo, the owner.
 */
function keepOf(path: string): Keep {
	const target = statOf(path);
	const keep: Keep = {};

	if (target !== undefined) {
		// the permission bits and not the setuid ones, for the reason above
		keep.mode = target.mode & 0o777;
	}

	if (isRoot()) {
		// the target's own owner, or the directory's for a file that is new --
		// which is the only thing there is to go on, and is what the directory this
		// is writing into was itself given
		const owner = target ?? statOf(dirname(path));
		if (owner !== undefined) {
			keep.gid = owner.gid;
			keep.uid = owner.uid;
		}
	}

	return keep;
}

/**
 * Writes a file atomically.
 *
 * @param path - The file.
 * @param text - What it should hold.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
	// synchronous because there is no async twin of it, which is how `updates/`
	// already uses it. One directory creation per save is one `mkdir` syscall
	mkdirOwnerSync(dirname(path));

	const keep = keepOf(path);
	const temp = tempFor(path);
	const handle = await open(temp, 'w', keep.mode ?? 0o666);

	// one bracket around everything the temp file exists for, so that whatever
	// fails there is no temp file left behind -- which is the rule
	// `bundleApp()`'s own `finally` keeps about a handle it opened
	try {
		try {
			// `writeFile` rather than one `write`, because a `write` may be short
			// and a config half written into the temp file is the thing this is for
			await handle.writeFile(text, 'utf8');
			try {
				await handle.sync();
			} catch (e: unknown) {
				if (!declinesFlush(e)) {
					throw e;
				}
			}
		} finally {
			await handle.close();
		}

		// after the close rather than through the handle, because the mode the open
		// asked for went through the umask and this is the one that did not
		if (keep.mode !== undefined) {
			await chmod(temp, keep.mode);
		}
		if (keep.uid !== undefined && keep.gid !== undefined) {
			await chown(temp, keep.uid, keep.gid);
		}
		await rename(temp, path);
	} catch (e: unknown) {
		await unlink(temp).catch(() => undefined);
		throw e;
	}
}

/**
 * Writes a file atomically without awaiting anything.
 *
 * Beside the async one rather than instead of it, for the reason
 * `createConfigSync()` is: an exit or signal handler cannot await, and "read
 * the config on the way in and write it on the way out" is that shape exactly.
 *
 * @param path - The file.
 * @param text - What it should hold.
 */
export function writeAtomicSync(path: string, text: string): void {
	mkdirOwnerSync(dirname(path));

	const keep = keepOf(path);
	const temp = tempFor(path);
	const fd = openSync(temp, 'w', keep.mode ?? 0o666);

	try {
		try {
			writeFileSync(fd, text);
			try {
				fsyncSync(fd);
			} catch (e: unknown) {
				if (!declinesFlush(e)) {
					throw e;
				}
			}
		} finally {
			closeSync(fd);
		}

		if (keep.mode !== undefined) {
			chmodSync(temp, keep.mode);
		}
		if (keep.uid !== undefined && keep.gid !== undefined) {
			chownSync(temp, keep.uid, keep.gid);
		}
		renameSync(temp, path);
	} catch (e: unknown) {
		try {
			unlinkSync(temp);
		} catch {
			// nothing to clean up, which is the ordinary reason this fails
		}
		throw e;
	}
}
