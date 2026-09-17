// spec: https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html

import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, normalize } from 'node:path';

const paths = {
	darwin: {
		cache: '~/Library/Caches',
		config: '~/Library/Preferences',
		data: '~/Library/Application Support',
		state: '~/Library/state',
	},
	linux: {
		cache: '~/.cache',
		config: '~/.config',
		data: '~/.local/share',
		state: '~/.local/state',
	},
	win32: {
		cache: ['%LOCALAPPDATA%', '~/AppData/Local'],
		config: '~\\.config',
		data: ['%APPDATA%', '~/AppData/Roaming'],
		state: ['%LOCALAPPDATA%', '~/AppData/Local'],
	},
} as const;

let _cache: string | undefined;
let _config: string | undefined;
let _configDirs: string[] | undefined;
let _data: string | undefined;
let _dataDirs: string[] | undefined;
let _home: string | undefined;
let _state: string | undefined;
let _tmp: string | undefined;

export function cache(...paths: string[]): string | undefined {
	if (!_cache) {
		_cache = resolvePath('XDG_CACHE_HOME', 'cache');
	}
	return _cache && paths ? join(_cache, ...paths) : _cache;
}

export function config(...paths: string[]): string | undefined {
	if (!_config) {
		_config = resolvePath('XDG_CONFIG_HOME', 'config');
	}
	return _config && paths ? join(_config, ...paths) : _config;
}

export function configDirs(): string[] | undefined {
	if (!_configDirs) {
		_configDirs = combinePaths(config(), splitDirs(process.env.XDG_CONFIG_DIRS));
	}
	return _configDirs;
}

export function data(...paths: string[]): string | undefined {
	if (!_data) {
		_data = resolvePath('XDG_DATA_HOME', 'data');
	}
	return _data && paths ? join(_data, ...paths) : _data;
}

export function dataDirs(): string[] | undefined {
	if (!_dataDirs) {
		_dataDirs = combinePaths(
			// `data()`, not `config()`: copied from `configDirs()` above, this put
			// the config home at the head of the data search path
			data(),
			splitDirs(process.env.XDG_DATA_DIRS)
		);
	}
	return _dataDirs;
}

const homeDirRegExp = /^~([\\|/].*)?$/;
const winEnvVarRegExp = /(%([^%]*)%)/g;

/**
 * Resolves a path into an absolute path.
 *
 * @param segments - The path segments to join and resolvePath.
 * @returns the expanded path.
 */
export function expand(...segments: string[]): string {
	const dir = home();
	if (dir) {
		// a `~` with no home to put over it stays a `~`. Interpolating the
		// `undefined` wrote that word into the path, which is a directory name
		// rather than an error, while a literal `~` is at least refused by
		// `baseDir()` and falls back
		segments[0] = segments[0].replace(homeDirRegExp, `${dir}$1`);
	}

	if (process.platform === 'win32') {
		return normalize(
			join(...segments).replace(winEnvVarRegExp, (s, m, n) => {
				return process.env[n] || m;
			})
		);
	}

	return normalize(join(...segments));
}

export function home(...paths: string[]): string | undefined {
	if (!_home) {
		_home = homedir();
	}
	return paths ? join(_home, ...paths) : _home;
}

export function runtime(...paths: string[]): string | undefined {
	const dir = resolvePath('XDG_RUNTIME_DIR');
	return dir && paths ? join(dir, ...paths) : dir;
}

export function state(...paths: string[]): string | undefined {
	if (!_state) {
		_state = resolvePath('XDG_STATE_HOME', 'state');
	}
	return _state && paths ? join(_state, ...paths) : _state;
}

export function tmp(...paths: string[]): string | undefined {
	if (!_tmp) {
		_tmp = tmpdir();
	}
	return _tmp && paths ? join(_tmp, ...paths) : _tmp;
}

function combinePaths(
	primary: string | undefined,
	additional: (string | undefined)[] | undefined
): string[] | undefined {
	const paths = new Set<string>();
	if (primary) {
		paths.add(primary);
	}

	if (additional) {
		for (const path of additional) {
			if (path) {
				paths.add(path);
			}
		}
	}

	return Array.from(paths);
}

function resolvePath(env: string, type?: string) {
	return baseDir(process.env[env]) ?? (type && resolveTypePath(type));
}

/**
 * Reads one candidate base directory -- an XDG environment variable, a segment
 * of one of the `_DIRS` lists, or an entry from the table above -- and answers
 * with it only if it survives.
 *
 * The spec says a base directory must be absolute and that a relative one is to
 * be ignored, so `XDG_CACHE_HOME=./.cache` falls back instead of putting a
 * cache in whatever directory the app was started from. `~` is expanded before
 * that is asked, which is what makes the whole module agree on one spelling:
 * the table's own entries are written `~/...`, `XDG_CONFIG_DIRS` has always
 * expanded its segments, and only the environment variables read here were
 * taken literally -- so `XDG_CACHE_HOME=~/.cache` reached `mkdir` as a
 * directory named `~`, which is the defect the table entries were fixed for one
 * round earlier.
 *
 * The absoluteness is `node:path`'s, so it is the running platform's: a
 * drive-relative `C:foo` is not absolute on Windows and neither is a bare
 * `C:\foo` anywhere else, and each is right for the platform it is asked on.
 */
function baseDir(value: string | undefined): string | undefined {
	// a missing, empty, or whitespace-only value is one nobody configured, and
	// none of them is absolute -- the blank ones fall out of `isAbsolute()`
	// rather than being trimmed, since leading whitespace in a real path is the
	// caller's
	if (!value) {
		return;
	}

	const dir = expand(value);
	return isAbsolute(dir) ? dir : undefined;
}

/**
 * Splits an `XDG_*_DIRS` value into the base directories it names.
 *
 * An empty segment -- `XDG_CONFIG_DIRS=:/etc/xdg`, or a list written with a
 * trailing separator -- is a hole in the list rather than a directory, and
 * `expand('')` is `'.'`: truthy, so `combinePaths()` could not tell it from a
 * real entry and the working directory joined the config search path.
 */
function splitDirs(value: string | undefined): (string | undefined)[] | undefined {
	return value?.split(delimiter).map((dir) => baseDir(dir));
}

function resolveTypePath(type: string) {
	// every platform that is not Windows or macOS follows the XDG spec this file
	// is written from, so Linux is what they get rather than a crash: the table
	// has three keys and `process.platform` has nine values, and `paths.freebsd`
	// is `undefined`, so indexing it threw
	const dirs = (paths[process.platform] ?? paths.linux)[type];

	if (Array.isArray(dirs)) {
		// a candidate that does not expand is not a candidate. `expand()` leaves
		// `%LOCALAPPDATA%` as it found it when the variable is unset, and the
		// literal is truthy -- so the array stopped at its first entry and
		// `~/AppData/Local`, the fallback the array exists for, was unreachable
		for (const dir of dirs) {
			const path = baseDir(dir);
			if (path) {
				return path;
			}
		}
		return;
	}

	// the string entries are `~`-relative too. Only the win32 array fallbacks
	// were expanded, so `cache()` on macOS and Linux answered with a literal
	// `'~/Library/Caches'` -- not a path anything can open, and one that
	// `mkdirSync` turns into a directory named `~` in the working directory
	return dirs && baseDir(dirs);
}
