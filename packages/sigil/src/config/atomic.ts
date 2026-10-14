import { mkdirOwnerSync } from '../util/mkdir-owner-sync.js';
import {
	chmodSync,
	chownSync,
	closeSync,
	fsyncSync,
	openSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { chmod, chown, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

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

/**
 * How far a chain of links is followed, which the file system itself bounds.
 *
 * The walk in `realPathOf()` only runs once `realpathSync()` has answered
 * `ENOENT`, and a chain of **31 or more** dangling links answers `ELOOP`
 * instead -- measured, which is `MAXSYMLINKS` being 32 on the kernels this runs
 * on. So the walk's input is a chain of at most thirty hops and no state the
 * file system can be in reaches this bound: what it bounds is a link that
 * changed between the two calls, which is a race rather than a shape, and a
 * config in a dotfiles repo something else is re-linking is where one comes
 * from. Kept rather than left to the file system because a loop with no bound
 * in a save is a hang, which is the rule `mkdirOwnerSync()`'s own climb already
 * follows: a loop that relies on finding something is one that can run off the
 * top of the file system.
 */
const MAX_LINKS = 32;

/**
 * The errors that mean "there is no link at this path to follow".
 *
 * `ENOENT` is nothing there, which is the end of a dangling chain and the
 * ordinary new-file case. `EINVAL` is something there that is **not** a link,
 * which `realpathSync()` would have resolved rather than refusing -- so it is
 * the same race the bound above is for, and the end of the walk either way.
 *
 * Everything else is raised, for the reason `realPathOf()` raises one: an
 * `ENOTDIR`, an `EACCES` or an `ELOOP` means the write cannot land, and saying
 * so beats writing somewhere else.
 */
const NO_LINK = new Set(['EINVAL', 'ENOENT']);

/**
 * Whether a failed `readlink()` is the end of the chain rather than a failure.
 *
 * @param e - What `readlinkSync()` threw.
 * @returns Whether the path it was asked about is where the write lands.
 */
function endsChain(e: unknown): boolean {
	return NO_LINK.has((e as { code?: string }).code ?? '');
}

/**
 * Two path pieces joined with **nothing normalized**, which is the whole point.
 *
 * `join()` and `resolve()` collapse a `..` lexically, and the kernel resolves one
 * against the directory that **physically** holds it -- so handing either of them
 * a link target is how the answer comes to differ from where the write lands.
 * This hands the un-collapsed path to `physicalPath()`, which asks the kernel.
 *
 * @param dir - The directory the second piece is relative to.
 * @param rest - The relative piece, exactly as it was stored.
 * @returns The two with one separator between them and no `..` resolved.
 */
function rawJoin(dir: string, rest: string): string {
	return dir.endsWith(sep) ? dir + rest : `${dir}${sep}${rest}`;
}

/**
 * The physical path a file names, which it does not have to exist to have.
 *
 * `realpath` needs the whole path to exist and answers `ENOENT` otherwise, and
 * what this is asked about is a link target that by definition does not. So the
 * deepest ancestor that **does** exist is resolved by the kernel and the rest is
 * joined back on -- which is exact rather than a best effort, because the part
 * that does not exist cannot hold a symlink, and a lexical `..` over a path that
 * is already physical is the physical one.
 *
 * It is `realpathSync.native` rather than `realpathSync`, and that is not a
 * preference: node's own `realpathSync` begins with `path.resolve()`, so it
 * collapses `..` **lexically** and disagrees with the kernel for a path whose
 * `..` follows a symlinked directory. Measured, over a link whose target walks
 * through a symlinked directory and back up: the kernel opens `far/other`, which
 * `.native` and `realpath(3)` both answer, while `realpathSync` answers
 * `real/other` -- a different file, which is the silent wrong write this whole
 * function exists to prevent. Every error code the walk above reads is the same
 * from both, checked rather than assumed: `ENOENT` for a dangling link and for
 * nothing there, `ELOOP` for a cycle and for a chain of 31 or more, `ENOTDIR`
 * under a file, and the same spelling for an ordinary file.
 *
 * @param raw - A path, which may hold a `..` and need not exist.
 * @returns What the kernel would resolve it to.
 * @throws If a resolution failed for any reason but something not being there.
 */
function physicalPath(raw: string): string {
	let rest = '';
	let at = raw;

	for (;;) {
		try {
			const real = realpathSync.native(at);
			return rest === '' ? real : join(real, rest);
		} catch (e: unknown) {
			if (!isMissing(e)) {
				throw e;
			}
		}

		const up = dirname(at);
		if (up === at) {
			// the file system root, which always exists -- so the return above has
			// already answered and nothing reaches this. It is here because a loop
			// that relies on finding something is one that can run off the top of
			// the file system, which is the rule `mkdirOwnerSync()`'s own climb
			// already follows
			return raw;
		}

		rest = rest === '' ? basename(at) : join(basename(at), rest);
		at = up;
	}
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
 * The path a write should land on, with a symlink followed to what it points at.
 *
 * `rename()` replaces whatever is **at** the path, so a config that is a symlink
 * -- which is what every dotfile manager makes of one, `stow` and `chezmoi`
 * among them -- is replaced by a plain file on the first `save()` that changes
 * anything. Measured before it was fixed: the link stopped being a link, the
 * link's location held the new contents, and the real file in the dotfiles repo
 * kept the old ones, so every later edit went to a local copy nobody was
 * tracking. Nothing reported it, because `keepOf()` and the lossless check both
 * read the path **through** the link and see a file that is perfectly fine.
 * That is the damage-to-somebody's-setup this module exists to prevent, arriving
 * by the one road it was not watching. Found by review.
 *
 * So the write resolves first and the temp file is a sibling of the **real**
 * file, which also keeps the rename on one filesystem -- `write-file-atomic`
 * does the same. A symlinked parent needs nothing, since the temp file then
 * lands in the directory the link points at and the rename creates the file
 * there. Anything other than missing is raised, because a loop or a permission
 * failure means the write cannot land and saying so beats writing somewhere
 * else.
 *
 * ## A link whose target is not there yet is followed by hand
 *
 * `realpathSync()` refuses a chain that ends at nothing **whole** rather than
 * resolving as far as it can: a link pointing at a file that does not exist
 * answers `ENOENT`, exactly as a path with nothing at it does. So resolving and
 * then reading `ENOENT` as "this is a new file" wrote the plain file at the
 * link's own location after all -- the same defect as above, for the one state a
 * dotfile manager leaves behind before its target has been created, and
 * invisible to the test for the resolved case. Measured: the link stopped being
 * a link, its location held the new contents, and the target was **never
 * created**. Found by a second review round, on the fix for the first.
 *
 * Hence the walk. Two things about it are not what a reader guesses, and each is
 * the commoner half of its pair:
 *
 * - A target is resolved against the **link's own directory** rather than the
 *   working directory, because `readlinkSync()` hands back whatever was stored
 *   and `ln -s ../dotfiles/sigil.json config.json` is the ordinary spelling. A
 *   cwd-relative resolve is wrong for every relative link there is.
 * - A **chain** of dangling links is followed to its end, because `a -> b -> c`
 *   with nothing at `c` is one `ENOENT` for the whole of it, and `c` is the file
 *   to create.
 *
 * ## And a relative target is resolved by the kernel rather than by string work
 *
 * The first version of the walk joined the target with `resolve()`, which is
 * **lexical**: it collapses a `..` against the path as written, where the kernel
 * resolves one against the directory that physically holds it. So a link in a
 * directory reached through a symlink -- a `~/.config` pointing at a synced
 * folder, which is the ordinary setup, with a `stow`-style relative link inside
 * it -- resolved to a sibling of the **named** directory rather than of the real
 * one. Measured: the correct target was never written, a `home/dots/` the kernel
 * would never resolve to was **created**, the link stayed dangling and the
 * settings were lost. Found by review, and invisible to the test above because
 * that one puts its link in a plain directory.
 *
 * So the pieces are joined with `rawJoin()`, which collapses nothing, and
 * `physicalPath()` asks the kernel -- which also settles the same mistake one
 * level in, a `..` inside the target that follows a symlinked directory of its
 * own. Both are the one defect rather than two: a lexical `..` where the kernel's
 * is physical.
 *
 * What it does not do is normalize the answer when the walk stops at a path that
 * is not a link, because `keepOf()`, `tempFor()`, `mkdirOwnerSync()` and the
 * `rename` are each resolved by the kernel when they run -- so what the answer
 * has to do is name the right file, which it does, rather than spell it
 * physically. And a parent component that is itself a dangling link fails at
 * `mkdirOwnerSync()` naming that path, which is the right answer rather than
 * creating a directory where somebody put a link.
 *
 * @param path - The file, as the caller named it.
 * @returns What it resolves to, or where the chain of links ends, or itself
 *   where there is nothing there at all.
 * @throws If a resolution failed for any reason but the file not being there.
 */
function realPathOf(path: string): string {
	try {
		return realpathSync.native(path);
	} catch (e: unknown) {
		if (!isMissing(e)) {
			throw e;
		}
	}

	let at = path;
	for (let hops = 0; hops < MAX_LINKS; hops++) {
		let target: string;
		try {
			target = readlinkSync(at);
		} catch (e: unknown) {
			if (endsChain(e)) {
				// where the write lands -- which for a parent component that is not
				// there is the error `mkdirOwnerSync()` is about to name
				return at;
			}
			throw e;
		}

		// the base is resolved **first**, because a relative target is read from the
		// directory that physically holds the link -- and then the pieces are joined
		// un-collapsed, so that each platform's own `..` rule is the one applied.
		// Both halves are load bearing and on different platforms: see below
		at = physicalPath(
			isAbsolute(target) ? target : rawJoin(realpathSync.native(dirname(at)), target)
		);
	}

	// unreachable through any state the file system can be in, for the reason
	// `MAX_LINKS` gives, so this is a tripwire rather than a case anybody has --
	// and it is English rather than a catalog key for the same reason: what it
	// stands in for is the `ELOOP` the file system itself would have raised, and
	// node's own errors on this path are not translated either
	throw new Error(`Too many levels of symbolic links: ${path}`);
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
	// resolved first, so a symlinked config is written **through** rather than
	// replaced -- `realPathOf()` has the measurement. Synchronous for the reason
	// `mkdirOwnerSync()` is: there is no async twin of that one, so the pair is
	// two syscalls on the way in either way
	const real = realPathOf(path);

	// synchronous because there is no async twin of it, which is how `updates/`
	// already uses it. One directory creation per save is one `mkdir` syscall
	mkdirOwnerSync(dirname(real));

	const keep = keepOf(real);
	const temp = tempFor(real);
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
		await rename(temp, real);
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
	const real = realPathOf(path);

	mkdirOwnerSync(dirname(real));

	const keep = keepOf(real);
	const temp = tempFor(real);
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
		renameSync(temp, real);
	} catch (e: unknown) {
		try {
			unlinkSync(temp);
		} catch {
			// nothing to clean up, which is the ordinary reason this fails
		}
		throw e;
	}
}
