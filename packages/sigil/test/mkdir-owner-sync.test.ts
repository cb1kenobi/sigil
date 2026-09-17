import { mkdirOwnerSync } from '../src/util/mkdir-owner-sync.js';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A file system small enough to reason about: a directory set with an owner
 * each, and a log of what was asked about. `lstatSync()` is what the owner walk
 * climbs with, so the log is also a record of how far it climbed.
 */
const fs = vi.hoisted(() => {
	const dirs = new Map<string, { gid: number; uid: number }>();
	const statted: string[] = [];

	return {
		chownSync: vi.fn(),
		dirs,
		lchownSync: vi.fn((path: string, uid: number, gid: number) => {
			dirs.set(path, { gid, uid });
		}),
		lstatSync: vi.fn((path: string) => {
			statted.push(path);
			const owner = dirs.get(path);
			if (!owner) {
				// a loop that does not end cannot be caught by a test timeout -- it is
				// synchronous and holds the worker -- so past a bound the walk is handed
				// something that ends it, and the call count is what is asserted on
				if (statted.length > 64) {
					return { gid: 0, isDirectory: () => true, uid: 0 };
				}
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
			}
			return { ...owner, isDirectory: () => true };
		}),
		mkdirSync: vi.fn((path: string) => {
			// recursive, and a directory made by root is owned by root -- which is the
			// case the owner lookup exists to correct
			for (let p = path; !dirs.has(p); p = dirname(p)) {
				dirs.set(p, { gid: 0, uid: 0 });
				if (p === dirname(p)) {
					break;
				}
			}
		}),
		reset(): void {
			dirs.clear();
			statted.length = 0;
		},
		statted,
	};
});

vi.mock('node:fs', () => fs);

const root = parse(resolve(sep)).root;
const ancestor = join(root, 'var');
const dest = join(ancestor, 'lib', 'app', 'cache');

describe('mkdirOwnerSync', () => {
	let getuid: typeof process.getuid;

	beforeEach(() => {
		fs.reset();
		fs.chownSync.mockClear();
		fs.lchownSync.mockClear();
		fs.lstatSync.mockClear();
		fs.mkdirSync.mockClear();
		getuid = process.getuid;
		// the owner lookup only runs as root, and the defect is about what root is
		// numbered, so there is nothing for this to do but say so
		process.getuid = () => 0;
	});

	afterEach(() => {
		process.getuid = getuid;
	});

	// `uid && gid` read a caller who asked for group 0 -- `wheel`, and the group of
	// every ancestor under `/var` -- as a caller who asked for nothing, so the walk
	// ran, `gid ||= st.gid` put the same `0` back, and the falsy `gid` then failed
	// the guard on the chown pass: what the caller asked for was never applied
	it('should treat a uid or gid of 0 as one that was given', () => {
		fs.dirs.set(root, { gid: 0, uid: 0 });
		fs.dirs.set(ancestor, { gid: 0, uid: 0 });

		mkdirOwnerSync(dest, { gid: 0, uid: 1000 });

		expect(fs.lchownSync).toHaveBeenCalledWith(dest, 1000, 0);
		// what it made, and not a directory that was already there
		expect(fs.lchownSync).toHaveBeenCalledWith(dirname(dirname(dest)), 1000, 0);
		expect(fs.dirs.get(ancestor)).to.deep.equal({ gid: 0, uid: 0 });
	});

	// a directory `mkdirSync()` has just made as root is `0:0`, so a caller asking
	// for `{ uid: 0, gid: 1000 }` matched on the uid and stopped, and the group it
	// asked for was never applied: the pair is one answer, not two
	it('should apply a group the owner already matches', () => {
		fs.dirs.set(root, { gid: 0, uid: 0 });
		fs.dirs.set(ancestor, { gid: 0, uid: 0 });

		mkdirOwnerSync(dest, { gid: 1000, uid: 0 });

		expect(fs.lchownSync).toHaveBeenCalledWith(dest, 0, 1000);
		expect(fs.dirs.get(ancestor)).to.deep.equal({ gid: 0, uid: 0 });
	});

	// an owner given outright is the answer, and `||=` read one off an ancestor over
	// the top of it: `uid: 0` is a caller asking for root, not a caller asking for
	// whatever is there
	it('should not replace an explicit uid of 0 with an ancestor owner', () => {
		fs.dirs.set(root, { gid: 0, uid: 0 });
		fs.dirs.set(ancestor, { gid: 501, uid: 501 });

		mkdirOwnerSync(dest, { gid: 0, uid: 0 });

		// what the call made is owned by root already, so there is nothing to change
		// -- what matters is that it was not handed to 501
		expect(fs.lchownSync).not.toHaveBeenCalled();
		expect(fs.dirs.get(dest)).to.deep.equal({ gid: 0, uid: 0 });
	});

	// the walk climbed until it found a directory, and `dirname('/')` is `'/'`: on a
	// path whose every ancestor `lstatSync()` refuses it had nothing left to climb
	// and no reason to stop climbing
	it('should stop the owner walk at the root', () => {
		mkdirOwnerSync(dest);

		// one `lstatSync()` for each path from `dest` up to and including the root
		expect(fs.statted).to.deep.equal([dest, dirname(dest), dirname(dirname(dest)), ancestor, root]);
		expect(fs.mkdirSync).toHaveBeenCalled();
		expect(fs.lchownSync).not.toHaveBeenCalled();
	});

	// the control: the ancestor of a cache directory under `/var` is owned by root,
	// so `0` is the uid the walk is there to find -- it stops at the first directory
	// either way, and what it found must not turn on that `0` being truthy
	it('should read a root-owned ancestor as an owner', () => {
		fs.dirs.set(root, { gid: 0, uid: 0 });
		fs.dirs.set(ancestor, { gid: 0, uid: 0 });

		mkdirOwnerSync(dest);

		expect(fs.statted.slice(0, 4)).to.deep.equal([
			dest,
			dirname(dest),
			dirname(dirname(dest)),
			ancestor,
		]);
		expect(fs.dirs.get(dest)).to.deep.equal({ gid: 0, uid: 0 });
	});
});
