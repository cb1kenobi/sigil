import { candidates, which, whichAll, whichAllSync, whichSync } from '../src/which.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `which`, over a real directory tree.
 *
 * Real files rather than a mocked `fs`, because what is being checked is what
 * the filesystem says: the mode bits, a directory that shares a name with an
 * executable, and a file that exists and is not runnable. A mock would be this
 * module's own beliefs about those, asserted against itself.
 *
 * Windows is emulated by redefining `process.platform`, which is what
 * `paths.test.ts` already does -- there is no other way to run the `PATHEXT`
 * half of this on the machine it is being written on, and leaving it to CI
 * means finding out a day later.
 */

let dir: string;
let origPlatform: PropertyDescriptor;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'sigil-which-'));
	origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
});

afterEach(() => {
	Object.defineProperty(process, 'platform', origPlatform);
	rmSync(dir, { force: true, recursive: true });
});

/** Pretends to be Windows for the length of one case. */
function asWindows(): void {
	Object.defineProperty(process, 'platform', { ...origPlatform, value: 'win32' });
}

/** Writes a file and makes it executable. */
function exe(...parts: string[]): string {
	const path = join(dir, ...parts);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, '#!/bin/sh\n');
	chmodSync(path, 0o755);
	return path;
}

/**
 * Whether this filesystem matches names case-insensitively.
 *
 * Asked rather than inferred from the platform: macOS is case-insensitive by
 * default and case-sensitive if somebody formatted it that way, so the platform
 * is a guess and a stat is the answer.
 */
function caseInsensitive(): boolean {
	const probe = join(dir, 'CaseProbe');
	writeFileSync(probe, '');
	return existsSync(join(dir, 'caseprobe'));
}

/** Writes a file and leaves it unexecutable. */
function plain(...parts: string[]): string {
	const path = join(dir, ...parts);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, 'not a program\n');
	chmodSync(path, 0o644);
	return path;
}

describe('resolving a name', () => {
	it('should find an executable on the path', async () => {
		const tool = exe('bin', 'tool');
		const path = join(dir, 'bin');

		expect(whichSync('tool', { path })).toBe(tool);
		expect(await which('tool', { path })).toBe(tool);
	});

	it('should answer undefined for a name that is not there', async () => {
		// the ordinary use is "is this installed", and a question whose usual
		// answer is no should not have to be asked with a try
		expect(whichSync('nope', { path: join(dir, 'bin') })).toBeUndefined();
		expect(await which('nope', { path: join(dir, 'bin') })).toBeUndefined();
	});

	it('should take the first of several, in path order', async () => {
		const first = exe('a', 'tool');
		exe('b', 'tool');
		const path = [join(dir, 'a'), join(dir, 'b')].join(':');

		expect(whichSync('tool', { path })).toBe(first);
		expect(await which('tool', { path })).toBe(first);
	});

	it('should answer nothing for an empty name', () => {
		expect(whichSync('', { path: join(dir, 'bin') })).toBeUndefined();
		expect([...candidates('', { path: join(dir, 'bin') })]).toStrictEqual([]);
	});
});

describe('what counts as executable', () => {
	it('should refuse a file of the right name that is not executable', async () => {
		plain('bin', 'tool');
		const path = join(dir, 'bin');

		expect(whichSync('tool', { path })).toBeUndefined();
		expect(await which('tool', { path })).toBeUndefined();
	});

	it('should refuse a directory of the right name', async () => {
		// a directory answers X_OK happily, because searching it is what the
		// execute bit means there -- so being a file is the other half of the test
		mkdirSync(join(dir, 'bin', 'tool'), { recursive: true });
		const path = join(dir, 'bin');

		expect(whichSync('tool', { path })).toBeUndefined();
		expect(await which('tool', { path })).toBeUndefined();
	});

	it('should walk past an unexecutable one to a real one further along', async () => {
		plain('a', 'tool');
		const real = exe('b', 'tool');
		const path = [join(dir, 'a'), join(dir, 'b')].join(':');

		expect(whichSync('tool', { path })).toBe(real);
		expect(await which('tool', { path })).toBe(real);
	});
});

describe('a name that is already a path', () => {
	it('should resolve it directly rather than searching', async () => {
		const tool = exe('tool');

		// the path is deliberately somewhere else: a path names one file, so
		// there is nothing to search
		expect(whichSync(tool, { path: '/nowhere' })).toBe(tool);
		expect(await which(tool, { path: '/nowhere' })).toBe(tool);
	});

	it('should resolve a relative one against cwd', async () => {
		const tool = exe('bin', 'tool');

		expect(whichSync('./bin/tool', { cwd: dir, path: '/nowhere' })).toBe(tool);
	});

	it('should not find a path-like name on the path', () => {
		exe('bin', 'tool');

		// `./tool` is not `tool`, and resolving it against every PATH entry until
		// one hits would make a path mean a search after all
		expect(whichSync('./tool', { cwd: dir, path: join(dir, 'bin') })).toBeUndefined();
	});

	it('should answer undefined for a path that is not executable', () => {
		const tool = plain('tool');
		expect(whichSync(tool, { path: '/nowhere' })).toBeUndefined();
	});
});

describe('the path itself', () => {
	it('should read an empty entry as the working directory', async () => {
		// POSIX says so, and it is how a PATH with a trailing colon behaves
		const tool = exe('tool');

		expect(whichSync('tool', { cwd: dir, path: `:${join(dir, 'nope')}` })).toBe(tool);
		expect(await which('tool', { cwd: dir, path: '' })).toBe(tool);
	});

	it('should resolve a relative entry against the working directory', () => {
		const tool = exe('bin', 'tool');
		expect(whichSync('tool', { cwd: dir, path: 'bin' })).toBe(tool);
	});

	it('should answer undefined when there is no path at all', () => {
		expect(whichSync('tool', { cwd: join(dir, 'empty'), path: '' })).toBeUndefined();
	});
});

describe('every match', () => {
	it('should answer in path order', async () => {
		const first = exe('a', 'tool');
		const second = exe('b', 'tool');
		const path = [join(dir, 'a'), join(dir, 'b')].join(':');

		expect(whichAllSync('tool', { path })).toStrictEqual([first, second]);
		expect(await whichAll('tool', { path })).toStrictEqual([first, second]);
	});

	it('should count one installation once however often the path names it', async () => {
		// a shell profile sourced twice is a PATH with a directory in it twice,
		// and a caller counting the answers would be told it had two of them
		const tool = exe('bin', 'tool');
		const path = [join(dir, 'bin'), join(dir, 'bin')].join(':');

		expect(whichAllSync('tool', { path })).toStrictEqual([tool]);
		expect(await whichAll('tool', { path })).toStrictEqual([tool]);
	});

	it('should answer an empty list rather than undefined', () => {
		expect(whichAllSync('nope', { path: join(dir, 'bin') })).toStrictEqual([]);
	});
});

describe('on Windows', () => {
	it('should split the path on semicolons', () => {
		asWindows();
		const tool = exe('bin', 'tool.EXE');

		expect(
			whichSync('tool', { cwd: dir, path: [join(dir, 'a'), join(dir, 'bin')].join(';') })
		).toBe(tool);
	});

	it('should try each PATHEXT extension in order', () => {
		asWindows();
		exe('bin', 'tool.CMD');
		const com = exe('bin', 'tool.COM');

		// .COM before .CMD in the list, so .COM is the answer even though both
		// are there -- the order is the whole of what PATHEXT is
		expect(whichSync('tool', { cwd: dir, path: join(dir, 'bin'), pathExt: '.COM;.CMD' })).toBe(com);
	});

	it('should not append a second extension to a name that has one', () => {
		asWindows();
		const cmd = exe('bin', 'tool.cmd');
		exe('bin', 'tool.cmd.EXE');

		expect(whichSync('tool.cmd', { cwd: dir, path: join(dir, 'bin'), pathExt: '.EXE;.CMD' })).toBe(
			cmd
		);
	});

	it('should still try the list for a dotted name that is not an executable', () => {
		asWindows();
		const exact = exe('bin', 'my.tool.EXE');

		// `my.tool` holds a dot and is not itself a program, so the empty
		// extension misses and the list is still there to be tried
		expect(whichSync('my.tool', { cwd: dir, path: join(dir, 'bin'), pathExt: '.EXE' })).toBe(exact);
	});

	it('should not find an extensionless file', () => {
		asWindows();
		exe('bin', 'tool');

		// nothing on Windows runs a file with no extension, and answering with
		// one would be reporting something that cannot be executed
		expect(
			whichSync('tool', { cwd: dir, path: join(dir, 'bin'), pathExt: '.EXE' })
		).toBeUndefined();
	});

	it('should ignore the execute bit', () => {
		asWindows();
		const tool = plain('bin', 'tool.EXE');

		// there is no execute bit there, so requiring one would refuse every
		// executable on the platform
		expect(whichSync('tool', { cwd: dir, path: join(dir, 'bin'), pathExt: '.EXE' })).toBe(tool);
	});

	it('should search the working directory first', () => {
		asWindows();
		const here = exe('tool.EXE');
		exe('bin', 'tool.EXE');

		// what the shell does, and a caller asking what would run has to get the
		// same answer
		expect(whichSync('tool', { cwd: dir, path: join(dir, 'bin'), pathExt: '.EXE' })).toBe(here);
	});

	it('should strip the quotes off a path entry', () => {
		asWindows();
		const tool = exe('Program Files', 'tool.EXE');

		// PATH holds whatever somebody pasted into it, and a quoted entry with
		// the quotes left on resolves to a directory that is not there
		expect(
			whichSync('tool', {
				cwd: dir,
				path: `"${join(dir, 'Program Files')}"`,
				pathExt: '.EXE',
			})
		).toBe(tool);
	});

	it('should answer with the candidate spelling rather than the file name', () => {
		// PATHEXT is conventionally upper case and almost nothing on disk is, so
		// on Windows -- where the filesystem is case-insensitive -- this is the
		// ordinary case rather than an edge one: `tool.exe` is found by the
		// candidate `tool.EXE`, and that is the string handed back. Learning the
		// real spelling means a readdir per directory, which is a lot of syscalls
		// to make a path that already spawns look tidier.
		asWindows();
		exe('bin', 'tool.exe');

		const found = whichSync('tool', { cwd: dir, path: join(dir, 'bin'), pathExt: '.EXE' });

		if (caseInsensitive()) {
			expect(found).toBe(join(dir, 'bin', 'tool.EXE'));
		} else {
			expect(found).toBeUndefined();
		}
	});
});

describe('the candidates', () => {
	it('should be the same order the walks take', () => {
		// the sync and async walks share this, which is what stops them coming
		// to disagree about PATHEXT
		asWindows();
		const list = [...candidates('tool', { cwd: '/w', path: 'a;b', pathExt: '.EXE;.CMD' })];

		expect(list).toStrictEqual([
			'/w/tool.EXE',
			'/w/tool.CMD',
			'/w/a/tool.EXE',
			'/w/a/tool.CMD',
			'/w/b/tool.EXE',
			'/w/b/tool.CMD',
		]);
	});

	it('should be one per directory on posix', () => {
		expect([...candidates('tool', { cwd: '/w', path: '/a:/b' })]).toStrictEqual([
			'/a/tool',
			'/b/tool',
		]);
	});
});
