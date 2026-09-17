import { chownSync, lchownSync, lstatSync, mkdirSync } from 'node:fs';
import type { MakeDirectoryOptions } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
		// the deepest directory that already exists is the last one this call did not
		// make, so it is both where an owner is read from when the caller named none
		// and where the chown pass below has to stop. It was only looked for in the
		// first case; the second was given the file system root instead, which is no
		// ceiling at all -- that pass climbs until it meets a directory already owned
		// by the target, so `mkdirOwnerSync('/var/lib/app/cache', { uid, gid })` run
		// as root handed `/var` away along with what it had just made
		//
		// `0` is root's uid and gid, and it is falsy: `uid && gid` read a caller
		// asking for group `0` -- `wheel`, and the group of every ancestor under
		// `/var` -- as a caller who asked for nothing, and `gid ||= st.gid` then put
		// the same `0` back. Whether an owner was given is a question about
		// `undefined`, so that is what is asked
		for (origin = dest; ;) {
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

			// the walk ends at the root whether or not it found a directory there. It
			// relies on finding one in order to stop, and `dirname('/')` is `'/'`, so on
			// a path whose every ancestor `lstatSync()` refuses it had nothing left to
			// climb and no reason to stop climbing
			const parent = dirname(origin);
			if (parent === origin) {
				break;
			}
			origin = parent;
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
		// that climbs until it recognizes where it is should not depend on arriving.
		// The group is asked about as well as the owner, because the two are one
		// answer: a directory `mkdirSync()` has just made as root is `0:0`, so a
		// caller asking for `{ uid: 0, gid: 1000 }` matched on `uid` alone and the
		// group it asked for was never applied
		while (dest !== origin && dest !== dirname(dest) && (st.uid !== uid || st.gid !== gid)) {
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
