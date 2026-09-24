/**
 * `which`: resolving an executable name against `PATH`.
 *
 * Written here rather than taken as a dependency, which is what the
 * zero-dependency constraint means in practice. The shape waited for a caller,
 * and the caller is `sigil new` asking which package managers are installed
 * before it offers a choice between them.
 *
 * ## What it answers
 *
 * `undefined` for a name that does not resolve, rather than throwing. The
 * ordinary use is "is this installed", and a question whose usual answer is no
 * should not be asked with a `try`. A caller that wants an error writes one, and
 * it can say what the executable was *for* -- which is a better message than
 * anything this could raise.
 *
 * ## Sync and async
 *
 * Both, because the parser's own paths are async while a `run()` handler is
 * often somewhere a single blocking `stat` is fine. They share `candidates()`,
 * which is pure and does the whole platform argument in one place; only the
 * existence check differs. Two implementations of where to look is how the two
 * come to disagree about `PATHEXT`.
 *
 * The async one walks the candidates in order rather than in parallel, because
 * *first* means first in `PATH` -- and a `PATH` is a few dozen entries, so
 * racing them would buy microseconds in exchange for having to sort the winners
 * back into the order they were already in.
 */

import { accessSync, constants, promises as fs, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Where to look, when the environment is not the answer. */
export interface WhichOptions {
	/**
	 * What a relative `PATH` entry, and a relative name, resolve against.
	 * Defaults to the working directory.
	 */
	readonly cwd?: string;
	/** The search path. Defaults to `PATH`. */
	readonly path?: string;
	/** The Windows extension list. Defaults to `PATHEXT`. */
	readonly pathExt?: string;
}

/**
 * What Windows tries when `PATHEXT` says nothing, which is node's own list.
 *
 * `.COM` before `.EXE` because that is the order the shell uses, and the order
 * is the whole of what this list is for.
 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Whether a name is a path rather than something to look up.
 *
 * `./pnpm` and `/usr/local/bin/pnpm` are not `PATH` lookups and never have
 * been: they name one file, which either is an executable or is not. Windows
 * adds the backslash and the drive-relative `C:pnpm`, which is a path with no
 * separator in it at all.
 *
 * @param name - What was asked for.
 * @param windows - Whether this is Windows.
 * @returns Whether it names a path.
 */
function isPathLike(name: string, windows: boolean): boolean {
	return name.includes('/') || (windows && (name.includes('\\') || /^[a-z]:/i.test(name)));
}

/**
 * The extensions to try, in order.
 *
 * POSIX has none: a file is executable because of its mode, not its name, so
 * the list is one empty string and the loop below runs once.
 *
 * Windows is the whole problem. A bare `pnpm` has to be tried as `pnpm.COM`,
 * `pnpm.EXE`, `pnpm.CMD` and the rest in `PATHEXT` order -- and `pnpm.cmd`,
 * which already carries one, must not come out as `pnpm.cmd.EXE`. The rule that
 * covers both is to put the empty extension *first* when the name already holds
 * a dot, so the exact spelling wins and the list is still there for a name like
 * `my.tool` that really does want `my.tool.EXE`.
 *
 * @param name - What was asked for.
 * @param windows - Whether this is Windows.
 * @param pathExt - The override, if any.
 * @returns The extensions, in the order to try them.
 */
function extensions(name: string, windows: boolean, pathExt: string | undefined): string[] {
	if (!windows) {
		return [''];
	}

	const list = (pathExt ?? process.env.PATHEXT ?? DEFAULT_PATHEXT)
		.split(';')
		.filter((ext) => ext !== '');

	return name.includes('.') ? ['', ...list] : list;
}

/**
 * The directories to look in, in order.
 *
 * An empty entry is the working directory, which is what POSIX says it means --
 * a `PATH` of `:/usr/bin` searches here first, and a trailing separator searches
 * here last. A relative entry means the same thing one directory along, so both
 * go through `resolve()` rather than only the empty one being special-cased.
 *
 * Windows differs twice. The working directory is searched *first*, ahead of
 * `PATH`, because that is what the shell does and a caller asking "what would
 * run" has to get the same answer. And an entry may be quoted -- `PATH` holds
 * whatever somebody pasted into it, and a `"C:\Program Files\nodejs"` with the
 * quotes left on resolves to a directory that does not exist.
 *
 * @param windows - Whether this is Windows.
 * @param cwd - What a relative entry resolves against.
 * @param path - The override, if any.
 * @returns The directories, in the order to search them.
 */
function directories(windows: boolean, cwd: string, path: string | undefined): string[] {
	const raw = (path ?? process.env.PATH ?? '').split(windows ? ';' : ':');
	const dirs = windows ? [cwd, ...raw] : raw;

	return dirs.map((dir) => resolve(cwd, windows ? dir.replace(/^"|"$/g, '') : dir));
}

/**
 * Every path that could be the answer, in the order to try them.
 *
 * Pure, and the whole of the platform argument: the sync and async walks below
 * differ only in how they ask whether a file is there. A generator rather than
 * an array so that the common case -- the first candidate in the first
 * directory -- does no work for the ninety entries after it.
 *
 * @param name - What was asked for.
 * @param opts - Where to look.
 * @yields Each candidate path.
 */
export function* candidates(name: string, opts: WhichOptions = {}): Generator<string> {
	if (name === '') {
		return;
	}

	const windows = process.platform === 'win32';
	const cwd = opts.cwd ?? process.cwd();
	const exts = extensions(name, windows, opts.pathExt);

	// a path names one file, so there is nowhere to search: it is its own base,
	// and the extensions still apply because `./build` may be `./build.CMD`
	const bases = isPathLike(name, windows)
		? [resolve(cwd, name)]
		: directories(windows, cwd, opts.path).map((dir) => resolve(dir, name));

	for (const base of bases) {
		for (const ext of exts) {
			yield base + ext;
		}
	}
}

/**
 * Whether a path is a file this process could execute.
 *
 * Both halves matter. A directory called `node` sitting in a `PATH` entry
 * answers `X_OK` happily, because searching a directory is what the execute bit
 * means there -- so it has to be a file as well.
 *
 * `access()` rather than the mode bits read by hand: the question is whether
 * *this* process may execute it, which is the effective uid and gid against
 * three sets of bits, plus whatever ACLs the filesystem adds on top. The kernel
 * already knows. Doing the arithmetic here also gets root wrong in the
 * direction that matters -- root may execute a file only if some execute bit is
 * set, and a hand-rolled check that sees uid 0 and says yes reports every text
 * file in `/etc` as a program.
 *
 * Windows has no execute bit to consult, so existing as a file is the whole
 * test; the extension is what decided it, and that already happened.
 */
function executableSync(path: string, windows: boolean): boolean {
	try {
		if (!statSync(path).isFile()) {
			return false;
		}
		if (windows) {
			return true;
		}
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The asynchronous twin of `executableSync()`, which is the same rule. */
async function executable(path: string, windows: boolean): Promise<boolean> {
	try {
		if (!(await fs.stat(path)).isFile()) {
			return false;
		}
		if (windows) {
			return true;
		}
		await fs.access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves an executable name against `PATH`, synchronously.
 *
 * @param name - The name, or a path.
 * @param opts - Where to look.
 * @returns The first match, or `undefined`.
 */
export function whichSync(name: string, opts: WhichOptions = {}): string | undefined {
	const windows = process.platform === 'win32';

	for (const candidate of candidates(name, opts)) {
		if (executableSync(candidate, windows)) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * Resolves an executable name against `PATH`.
 *
 * @param name - The name, or a path.
 * @param opts - Where to look.
 * @returns The first match, or `undefined`.
 */
export async function which(name: string, opts: WhichOptions = {}): Promise<string | undefined> {
	const windows = process.platform === 'win32';

	for (const candidate of candidates(name, opts)) {
		if (await executable(candidate, windows)) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * Every match, which is what `which -a` is for.
 *
 * Deduplicated, because a `PATH` that names one directory twice -- which is
 * what a shell profile sourced twice produces -- is not two installations, and
 * a caller counting the answers would be told there were.
 *
 * @param name - The name, or a path.
 * @param opts - Where to look.
 * @returns Every match, in `PATH` order.
 */
export function whichAllSync(name: string, opts: WhichOptions = {}): string[] {
	const windows = process.platform === 'win32';
	const found = new Set<string>();

	for (const candidate of candidates(name, opts)) {
		if (executableSync(candidate, windows)) {
			found.add(candidate);
		}
	}

	return [...found];
}

/**
 * Every match, which is what `which -a` is for.
 *
 * @param name - The name, or a path.
 * @param opts - Where to look.
 * @returns Every match, in `PATH` order.
 */
export async function whichAll(name: string, opts: WhichOptions = {}): Promise<string[]> {
	const windows = process.platform === 'win32';
	const found = new Set<string>();

	for (const candidate of candidates(name, opts)) {
		if (await executable(candidate, windows)) {
			found.add(candidate);
		}
	}

	return [...found];
}
