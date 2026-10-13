/**
 * Where the temp file goes, and what happens to it when the write fails.
 *
 * `writeAtomic()` names its own temp file and renames it over the target, so
 * nothing outside can see it -- the file exists only between the open and the
 * rename, and both halves are synchronous enough that no caller can look. The
 * alternative to wrapping `fs` is a seam whose only reader would be this file,
 * which is the shape AGENTS.md argues against.
 *
 * So `node:fs` and `node:fs/promises` are wrapped the way `bundle-close.test.ts`
 * wraps `rolldown`: the real calls run, the real files are written, and the one
 * thing the wrapper adds is a record of which paths were opened, renamed and
 * unlinked, plus a way to make one of them fail. Nothing here is a fake
 * filesystem.
 *
 * A file of its own rather than a `describe` inside `write.test.ts`, because
 * `vi.mock` is hoisted and module-wide: every test in the file it sits in would
 * run through the wrapper, which is a thing nobody reading those tests would
 * expect.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** One entry per call the write made, in order, as `verb path`. */
const calls: string[] = [];

/** Which call should fail next, so that the cleanup path is reachable. */
let fail: 'close' | 'fsync' | 'rename' | undefined;

vi.mock('node:fs', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs')>();

	return {
		...real,
		closeSync(fd: number): void {
			real.closeSync(fd);
			if (fail === 'close') {
				throw new Error('close refused');
			}
		},
		fsyncSync(fd: number): void {
			if (fail === 'fsync') {
				// what a network mount or a container layer answers, and what every
				// atomic writer swallows: failing a save over a durability hint the
				// kernel declined is refusing to write a file that would have written
				throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
			}
			real.fsyncSync(fd);
		},
		openSync(path: string, flags: string, mode?: number): number {
			calls.push(`open ${path}`);
			return real.openSync(path, flags, mode);
		},
		renameSync(from: string, to: string): void {
			calls.push(`rename ${from} -> ${to}`);
			if (fail === 'rename') {
				throw new Error('rename refused');
			}
			real.renameSync(from, to);
		},
		unlinkSync(path: string): void {
			calls.push(`unlink ${path}`);
			real.unlinkSync(path);
		},
	};
});

const { writeAtomicSync } = await import('../../src/config/atomic.js');

let root: string;

beforeEach(() => {
	calls.length = 0;
	fail = undefined;
	root = mkdtempSync(join(tmpdir(), 'sigil-atomic-'));
});

afterEach(() => {
	rmSync(root, { force: true, recursive: true });
});

/** The path the one `open` was given. */
function opened(): string {
	const call = calls.find((it) => it.startsWith('open '));
	return call === undefined ? '' : call.slice('open '.length);
}

describe('where the temp file goes', () => {
	it('should be in the target own directory rather than in tmp', () => {
		// `rename()` is only atomic **within one filesystem**, so a temp file in
		// `tmp()` is a copy and a delete rather than a rename -- which has the
		// half-written window back, plus a cross-device failure on the platforms
		// that refuse `EXDEV`
		const path = join(root, 'c.jsonc');
		writeAtomicSync(path, 'x');

		expect(dirname(opened())).to.equal(root);
		expect(dirname(opened())).to.not.equal(tmpdir());
		expect(opened()).to.not.equal(path);
		expect(calls).to.deep.equal([`open ${opened()}`, `rename ${opened()} -> ${path}`]);
	});

	it('should pick a name no other save in this process can pick', () => {
		// two saves in one process is ordinary -- a run that sets five keys and
		// saves two layers -- and a shared temp name would have them overwrite each
		// other's bytes
		writeAtomicSync(join(root, 'a.jsonc'), 'x');
		const first = opened();
		calls.length = 0;
		writeAtomicSync(join(root, 'a.jsonc'), 'y');

		expect(opened()).to.not.equal(first);
	});

	it('should leave nothing behind where the rename failed', () => {
		const path = join(root, 'c.jsonc');
		writeFileSync(path, 'old');
		fail = 'rename';

		expect(() => writeAtomicSync(path, 'new')).toThrow(/rename refused/);
		// the old file is still the old file, which is what atomic means
		expect(readFileSync(path, 'utf8')).to.equal('old');
		expect(readdirSync(root)).to.deep.equal(['c.jsonc']);
		expect(calls.at(-1)).to.equal(`unlink ${opened()}`);
	});

	it('should leave nothing behind where the close failed', () => {
		// the one failure that happens with the temp file already written and the
		// handle already gone, which is why the cleanup brackets the whole use of
		// it rather than only the rename
		const path = join(root, 'c.jsonc');
		fail = 'close';

		expect(() => writeAtomicSync(path, 'new')).toThrow(/close refused/);
		expect(readdirSync(root)).to.deep.equal([]);
	});

	it('should write anyway where the filesystem declined to flush', () => {
		// swallowed, because the filesystems that refuse one refuse it always:
		// `EINVAL` is what a network mount answers
		const path = join(root, 'c.jsonc');
		fail = 'fsync';

		writeAtomicSync(path, 'new');
		expect(readFileSync(path, 'utf8')).to.equal('new');
	});
});
