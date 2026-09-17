import { chownSync, lchownSync, lstatSync, mkdirSync } from 'node:fs';
import type { MakeDirectoryOptions } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';

interface MkdirOwnerOptions extends MakeDirectoryOptions {
	gid?: number;
	uid?: number;
}

const changeOwner = lchownSync || chownSync;

export function mkdirOwnerSync(dest: string, opts: MkdirOwnerOptions = {}): void {
	dest = resolve(dest);

	let { gid, uid } = opts;
	const applyOwner = !!process.getuid && process.getuid() === 0;
	let origin: string | undefined;

	if (applyOwner) {
		// `0` is root's uid and gid, and it is falsy: `uid && gid` read a caller
		// asking for root ownership as a caller who asked for nothing, and
		// `uid ||= st.uid` then threw away the `0` it had been given. The same
		// falsiness reached the chown pass below, where an ancestor owned by root --
		// which is every ancestor under `/var`, `/usr`, and `/root` -- left `uid` at
		// `0` and skipped the pass altogether. A uid is a number that was either
		// given or not, so it is asked for that way
		if (uid !== undefined && gid !== undefined) {
			origin = parse(dest).root;
		} else {
			for (origin = dest; gid === undefined || uid === undefined;) {
				try {
					const st = lstatSync(origin);
					if (st.isDirectory()) {
						gid ??= st.gid;
						uid ??= st.uid;
						break;
					}
				} catch {
					// continue
				}

				// the walk ends at the root whether or not it found an owner there. It
				// is a loop that relies on finding something in order to stop, and
				// `dirname('/')` is `'/'`, so on a path whose every ancestor
				// `lstatSync()` refuses there was nothing left to climb and no reason to
				// stop climbing
				const parent = dirname(origin);
				if (parent === origin) {
					break;
				}
				origin = parent;
			}
		}
	}

	mkdirSync(dest, {
		mode: 0o7777,
		recursive: true,
		...opts,
	});

	if (applyOwner && uid !== undefined && gid !== undefined) {
		let st = lstatSync(dest);
		// `origin` is an ancestor of `dest`, so it is what ends this walk -- and the
		// root ends it too, for the reason the walk above has the same guard: a loop
		// that climbs until it recognizes where it is should not depend on arriving
		while (dest !== origin && dest !== dirname(dest) && st.uid !== uid) {
			try {
				changeOwner(dest, uid, gid);
				dest = dirname(dest);
				st = lstatSync(dest);
			} catch {
				break;
			}
		}
	}
}
