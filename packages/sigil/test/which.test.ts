import { candidates, which, whichAll, whichAllSync, whichSync } from '../src/which.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
 *
 * The cases that are *not* emulating run on whatever platform they are on, so
 * their fixtures have to be executable there: `EXT` puts a `.cmd` on the end on
 * Windows, where an extensionless file is not a program, and `DELIM` is the
 * real separator, because a `PATH` of `C:\a:C:\b` is four entries rather than
 * two. Writing them as `tool` and `:` is how ten of these came to pass
 * everywhere except the platform half of them were written for.
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

/** Pretends to be Linux, for a case that is about `PATH` rather than about files. */
function asPosix(): void {
	Object.defineProperty(process, 'platform', { ...origPlatform, value: 'linux' });
}

/** Whether the tests that need an execute bit have one to work with. */
const WINDOWS = process.platform === 'win32';

/** What makes a file a program here: a mode bit on POSIX, a name on Windows. */
const EXT = WINDOWS ? '.cmd' : '';

/**
 * Passed wherever a case builds its own `PATH`.
 *
 * Ignored outright on POSIX, where the extension list is one empty string, and
 * on Windows it pins the spelling: the answer carries the *candidate's* case,
 * so a bare lookup against the machine's own `PATHEXT` would come back
 * `TOOL.CMD` against a file written as `tool.cmd`.
 */
const PATHEXT = '.cmd';

/** The real `PATH` separator, which is not `:` everywhere. */
const DELIM = WINDOWS ? ';' : ':';

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
		const tool = exe('bin', `tool${EXT}`);
		const path = join(dir, 'bin');

		expect(whichSync('tool', { path, pathExt: PATHEXT })).toBe(tool);
		expect(await which('tool', { path, pathExt: PATHEXT })).toBe(tool);
	});

	it('should answer undefined for a name that is not there', async () => {
		// the ordinary use is "is this installed", and a question whose usual
		// answer is no should not have to be asked with a try
		expect(whichSync('nope', { path: join(dir, 'bin'), pathExt: PATHEXT })).toBeUndefined();
		expect(await which('nope', { path: join(dir, 'bin'), pathExt: PATHEXT })).toBeUndefined();
	});

	it('should take the first of several, in path order', async () => {
		const first = exe('a', `tool${EXT}`);
		exe('b', `tool${EXT}`);
		const path = [join(dir, 'a'), join(dir, 'b')].join(DELIM);

		expect(whichSync('tool', { path, pathExt: PATHEXT })).toBe(first);
		expect(await which('tool', { path, pathExt: PATHEXT })).toBe(first);
	});

	it('should answer nothing for an empty name', () => {
		expect(whichSync('', { path: join(dir, 'bin'), pathExt: PATHEXT })).toBeUndefined();
		expect([...candidates('', { path: join(dir, 'bin'), pathExt: PATHEXT })]).toStrictEqual([]);
	});
});

describe('what counts as executable', () => {
	it.skipIf(WINDOWS)('should refuse a file of the right name that is not executable', async () => {
		// Windows has no execute bit to refuse it with, which is its own case in
		// the emulated block below
		plain('bin', 'tool');
		const path = join(dir, 'bin');

		expect(whichSync('tool', { path })).toBeUndefined();
		expect(await which('tool', { path })).toBeUndefined();
	});

	it('should refuse a directory of the right name', async () => {
		// a directory answers X_OK happily, because searching it is what the
		// execute bit means there -- so being a file is the other half of the test
		mkdirSync(join(dir, 'bin', `tool${EXT}`), { recursive: true });
		const path = join(dir, 'bin');

		expect(whichSync('tool', { path, pathExt: PATHEXT })).toBeUndefined();
		expect(await which('tool', { path, pathExt: PATHEXT })).toBeUndefined();
	});

	it.skipIf(WINDOWS)(
		'should walk past an unexecutable one to a real one further along',
		async () => {
			plain('a', 'tool');
			const real = exe('b', 'tool');
			const path = [join(dir, 'a'), join(dir, 'b')].join(DELIM);

			expect(whichSync('tool', { path })).toBe(real);
			expect(await which('tool', { path })).toBe(real);
		}
	);
});

describe('a name that is already a path', () => {
	it('should resolve it directly rather than searching', async () => {
		const tool = exe(`tool${EXT}`);

		// the path is deliberately somewhere else: a path names one file, so
		// there is nothing to search
		expect(whichSync(tool, { path: '/nowhere', pathExt: PATHEXT })).toBe(tool);
		expect(await which(tool, { path: '/nowhere', pathExt: PATHEXT })).toBe(tool);
	});

	it('should resolve a relative one against cwd', async () => {
		const tool = exe('bin', `tool${EXT}`);

		expect(whichSync(`./bin/tool${EXT}`, { cwd: dir, path: '/nowhere', pathExt: PATHEXT })).toBe(
			tool
		);
	});

	it('should not find a path-like name on the path', () => {
		exe('bin', `tool${EXT}`);

		// `./tool` is not `tool`, and resolving it against every PATH entry until
		// one hits would make a path mean a search after all
		expect(
			whichSync('./tool', { cwd: dir, path: join(dir, 'bin'), pathExt: PATHEXT })
		).toBeUndefined();
	});

	it.skipIf(WINDOWS)('should answer undefined for a path that is not executable', () => {
		const tool = plain('tool');
		expect(whichSync(tool, { path: '/nowhere' })).toBeUndefined();
	});
});

describe('the path itself', () => {
	it('should read an empty entry as the working directory', async () => {
		// POSIX says so, and it is how a PATH with a trailing colon behaves
		const tool = exe(`tool${EXT}`);

		expect(
			whichSync('tool', { cwd: dir, path: `${DELIM}${join(dir, 'nope')}`, pathExt: PATHEXT })
		).toBe(tool);
		expect(await which('tool', { cwd: dir, path: '', pathExt: PATHEXT })).toBe(tool);
	});

	it('should resolve a relative entry against the working directory', () => {
		const tool = exe('bin', `tool${EXT}`);
		expect(whichSync('tool', { cwd: dir, path: 'bin', pathExt: PATHEXT })).toBe(tool);
	});

	it('should answer undefined when there is no path at all', () => {
		expect(
			whichSync('tool', { cwd: join(dir, 'empty'), path: '', pathExt: PATHEXT })
		).toBeUndefined();
	});
});

describe('every match', () => {
	it('should answer in path order', async () => {
		const first = exe('a', `tool${EXT}`);
		const second = exe('b', `tool${EXT}`);
		const path = [join(dir, 'a'), join(dir, 'b')].join(DELIM);

		expect(whichAllSync('tool', { path, pathExt: PATHEXT })).toStrictEqual([first, second]);
		expect(await whichAll('tool', { path, pathExt: PATHEXT })).toStrictEqual([first, second]);
	});

	it('should count one installation once however often the path names it', async () => {
		// a shell profile sourced twice is a PATH with a directory in it twice,
		// and a caller counting the answers would be told it had two of them
		const tool = exe('bin', `tool${EXT}`);
		const path = [join(dir, 'bin'), join(dir, 'bin')].join(DELIM);

		expect(whichAllSync('tool', { path, pathExt: PATHEXT })).toStrictEqual([tool]);
		expect(await whichAll('tool', { path, pathExt: PATHEXT })).toStrictEqual([tool]);
	});

	it('should answer an empty list rather than undefined', () => {
		expect(whichAllSync('nope', { path: join(dir, 'bin'), pathExt: PATHEXT })).toStrictEqual([]);
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
	// these two are about ordering rather than about files, so they name the
	// platform outright and build what they expect with `resolve()` -- a literal
	// '/w/tool.EXE' is a path on one platform and most of a path on the other
	it('should be the same order the walks take', () => {
		// the sync and async walks share this, which is what stops them coming
		// to disagree about PATHEXT
		asWindows();
		const list = [...candidates('tool', { cwd: '/w', path: 'a;b', pathExt: '.EXE;.CMD' })];

		expect(list).toStrictEqual([
			join(resolve('/w'), 'tool.EXE'),
			join(resolve('/w'), 'tool.CMD'),
			join(resolve('/w'), 'a', 'tool.EXE'),
			join(resolve('/w'), 'a', 'tool.CMD'),
			join(resolve('/w'), 'b', 'tool.EXE'),
			join(resolve('/w'), 'b', 'tool.CMD'),
		]);
	});

	it('should be one per directory on posix', () => {
		asPosix();

		expect([...candidates('tool', { cwd: '/w', path: '/a:/b' })]).toStrictEqual([
			join(resolve('/a'), 'tool'),
			join(resolve('/b'), 'tool'),
		]);
	});
});
