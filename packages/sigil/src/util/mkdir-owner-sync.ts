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
		if (uid && gid) {
			origin = parse(dest).root;
		} else {
			for (origin = dest; !gid || !uid; origin = dirname(origin)) {
				try {
					const st = lstatSync(origin);
					if (st.isDirectory()) {
						gid ||= st.gid;
						uid ||= st.uid;
						break;
					}
				} catch {
					// continue
				}
			}
		}
	}

	mkdirSync(dest, {
		mode: 0o7777,
		recursive: true,
		...opts,
	});

	if (applyOwner && uid && gid) {
		let st = lstatSync(dest);
		while (dest !== origin && st.uid !== uid) {
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
