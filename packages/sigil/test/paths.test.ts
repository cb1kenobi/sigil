import {
	cache,
	config,
	configDirs,
	data,
	dataDirs,
	expand,
	home,
	runtime,
	state,
	tmp,
} from '../src/paths.js';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, normalize } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

type Paths = typeof import('../src/paths.js');

// every variable the module reads, so a case starts from an environment that
// configured nothing rather than from whatever the machine running the suite
// happens to export
const vars = [
	'APPDATA',
	'LOCALAPPDATA',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_DIRS',
	'XDG_CONFIG_HOME',
	'XDG_DATA_DIRS',
	'XDG_DATA_HOME',
	'XDG_RUNTIME_DIR',
	'XDG_STATE_HOME',
];

/**
 * Asks a fresh copy of the module what `env` resolves to.
 *
 * Every base directory but the runtime one is memoized on first read, so a case
 * that says what the environment held has to be given a module that has not
 * answered yet. `fn` is synchronous and the environment and the platform are
 * put back the moment it returns, which keeps the window in which this process
 * is lying about either of them inside one tick.
 */
async function withPaths<T>(
	env: Record<string, string | undefined>,
	fn: (paths: Paths) => T,
	{ platform, home }: { platform?: NodeJS.Platform; home?: string } = {}
): Promise<T> {
	vi.resetModules();
	const origEnv = new Map(vars.map((name) => [name, process.env[name]]));
	const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

	// the mock and the import are inside the `try` so that a case that cannot
	// even load the module still puts `node:os` back
	try {
		if (home !== undefined) {
			vi.doMock('node:os', async (importOriginal) => ({
				...(await importOriginal<typeof import('node:os')>()),
				homedir: () => home,
			}));
		}
		const paths = await import('../src/paths.js');
		for (const name of vars) {
			delete process.env[name];
		}
		for (const [name, value] of Object.entries(env)) {
			if (value !== undefined) {
				process.env[name] = value;
			}
		}
		if (platform) {
			Object.defineProperty(process, 'platform', { ...origPlatform, value: platform });
		}
		return fn(paths);
	} finally {
		vi.doUnmock('node:os');
		Object.defineProperty(process, 'platform', origPlatform);
		for (const [name, value] of origEnv) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
}

describe('paths', () => {
	describe('cache()', () => {
		it('should get the cache directory', () => {
			expect(cache()).toBeTruthy();
		});

		it('should get the cache directory plus additional paths', () => {
			let dir = cache('foo', 'bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));

			dir = cache('foo/', '/bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));
		});
	});

	describe('config()', () => {
		it('should get the config directory', () => {
			expect(config()).toBeTruthy();
		});

		it('should get the config directory plus additional paths', () => {
			let dir = config('foo', 'bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));

			dir = config('foo/', '/bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));
		});
	});

	describe('configDirs()', () => {
		it('should get the config directories', () => {
			expect(configDirs()).toBeTruthy();
		});
	});

	describe('data()', () => {
		it('should get the data directory', () => {
			expect(data()).toBeTruthy();
		});

		it('should get the data directory plus additional paths', () => {
			let dir = data('foo', 'bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));

			dir = data('foo/', '/bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));
		});
	});

	describe('dataDirs()', () => {
		it('should get the data directories', () => {
			expect(dataDirs()).toBeTruthy();
		});
	});

	describe('expand()', () => {
		it('should expand home directory', () => {
			expect(expand('~')).toBe(homedir());
		});

		it('should expand home directory plus additional paths', () => {
			let dir = expand('~', 'foo', 'bar');
			expect(dir).toBe(join(homedir(), 'foo', 'bar'));

			dir = expand('~', 'foo/', '/bar');
			expect(dir).toBe(join(homedir(), 'foo', 'bar'));
		});
	});

	describe('home()', () => {
		it('should get the home directory', () => {
			expect(home()).toBe(homedir());
		});

		it('should get the home directory plus additional paths', () => {
			let dir = home('foo', 'bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));

			dir = home('foo/', '/bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));
		});
	});

	describe('runtime()', () => {
		// XDG_RUNTIME_DIR is the one base directory the spec gives no fallback
		// for, so it is genuinely undefined unless the environment sets it.
		it('should get the runtime directory', () => {
			const orig = process.env.XDG_RUNTIME_DIR;
			try {
				process.env.XDG_RUNTIME_DIR = tmpdir();
				expect(runtime()).to.equal(tmpdir());
			} finally {
				if (orig === undefined) {
					delete process.env.XDG_RUNTIME_DIR;
				} else {
					process.env.XDG_RUNTIME_DIR = orig;
				}
			}
		});

		it('should get the runtime directory plus additional paths', () => {
			const orig = process.env.XDG_RUNTIME_DIR;
			try {
				process.env.XDG_RUNTIME_DIR = tmpdir();

				let dir = runtime('foo', 'bar');
				expect(dir).toBeTruthy();
				expect(dir).toContain(join('foo', 'bar'));

				dir = runtime('foo/', '/bar');
				expect(dir).toBeTruthy();
				expect(dir).toContain(join('foo', 'bar'));
			} finally {
				if (orig === undefined) {
					delete process.env.XDG_RUNTIME_DIR;
				} else {
					process.env.XDG_RUNTIME_DIR = orig;
				}
			}
		});

		it('should be undefined when XDG_RUNTIME_DIR is not set', () => {
			const orig = process.env.XDG_RUNTIME_DIR;
			try {
				delete process.env.XDG_RUNTIME_DIR;
				expect(runtime()).to.equal(undefined);
			} finally {
				if (orig !== undefined) {
					process.env.XDG_RUNTIME_DIR = orig;
				}
			}
		});
	});

	describe('state()', () => {
		it('should get the state directory', () => {
			expect(state()).toBeTruthy();
		});

		it('should get the state directory plus additional paths', () => {
			let dir = state('foo', 'bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));

			dir = state('foo/', '/bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));
		});
	});

	// only the win32 array fallbacks were expanded, so every macOS and Linux entry
	// came back as a literal `'~/...'` -- not a path anything can open, and one
	// `mkdirSync` turns into a directory named `~` in the working directory
	describe('~ expansion', () => {
		it.each([
			['cache', cache],
			['config', config],
			['data', data],
			['state', state],
		])('should return an expanded path from %s()', (_name, fn) => {
			const dir = fn();
			expect(dir).toBeTruthy();
			expect(dir).not.toContain('~');
			expect(dir!.startsWith(homedir()) || !dir!.includes(homedir())).to.equal(true);
		});

		it('should not put a literal ~ in a search path', () => {
			for (const dir of [...(configDirs() ?? []), ...(dataDirs() ?? [])]) {
				expect(dir).not.toContain('~');
			}
		});
	});

	// `dataDirs()` was copied from `configDirs()` and kept its `config()` call, so
	// the data search path was headed by the config home
	describe('dataDirs() head', () => {
		it('should start at the data directory, not the config directory', () => {
			const dirs = dataDirs();
			expect(dirs).toBeTruthy();
			expect(dirs![0]).to.equal(data());
			if (data() !== config()) {
				expect(dirs![0]).to.not.equal(config());
			}
		});
	});

	// `resolvePath()` was `process.env[env] || fallback`, so a value the spec says
	// to ignore was taken as written and `XDG_CACHE_HOME=./.cache` put the cache
	// in whatever directory the app was started from
	describe('a relative XDG value', () => {
		it.each([
			['./.cache'],
			['.cache'],
			['..'],
			// blank is not a path, and it is not absolute either, so it falls out
			// of the same check rather than needing one of its own
			['   '],
			// drive-relative, which is not absolute on Windows and not a Windows
			// path anywhere else
			['C:foo'],
			// `~user` is a shell convention `expand()` does not implement, so it
			// stays literal rather than becoming a directory named `~nobody`
			['~nobody/.cache'],
		])('should be ignored, so %s falls back', async (value) => {
			const fallback = await withPaths({}, (paths) => paths.cache());
			const dir = await withPaths({ XDG_CACHE_HOME: value }, (paths) => paths.cache());

			expect(fallback).toBeTruthy();
			expect(dir).to.equal(fallback);
		});

		// a UNC share is absolute on Windows and a relative filename anywhere else,
		// which is `node:path`'s answer and so is this module's
		it.runIf(process.platform === 'win32')('should keep a UNC path', async () => {
			const value = '\\\\server\\share\\cache';
			const dir = await withPaths({ XDG_CACHE_HOME: value }, (paths) => paths.cache());
			expect(dir).to.equal(value);
		});

		it('should be ignored for the runtime directory, which has no fallback', async () => {
			const dir = await withPaths({ XDG_RUNTIME_DIR: './run' }, (paths) => paths.runtime());
			expect(dir).to.equal(undefined);
		});
	});

	// `XDG_CONFIG_DIRS` entries went through `expand()` and the four `_HOME`
	// variables did not, so one half of the module expanded a `~` and the other
	// handed the literal to `mkdir`
	describe('~ in an XDG value', () => {
		it('should expand, the way a search path entry always has', async () => {
			const dir = await withPaths({ XDG_CACHE_HOME: '~/.sigil' }, (paths) => paths.cache());
			expect(dir).to.equal(join(homedir(), '.sigil'));
		});

		it('should expand when it is the whole value', async () => {
			const dir = await withPaths({ XDG_CACHE_HOME: '~' }, (paths) => paths.cache());
			expect(dir).to.equal(homedir());
		});

		it.each([
			['XDG_CACHE_HOME', (paths: Paths) => paths.cache()],
			['XDG_CONFIG_HOME', (paths: Paths) => paths.config()],
			['XDG_DATA_HOME', (paths: Paths) => paths.data()],
			['XDG_STATE_HOME', (paths: Paths) => paths.state()],
			['XDG_RUNTIME_DIR', (paths: Paths) => paths.runtime()],
		])('should expand for %s', async (name, read) => {
			const dir = await withPaths({ [name]: '~/.sigil' }, read);
			expect(dir).to.equal(join(homedir(), '.sigil'));
		});

		it('should expand the same in the home and the dirs of one pair', async () => {
			const dirs = await withPaths(
				{ XDG_CONFIG_HOME: '~/.sigil', XDG_CONFIG_DIRS: '~/.sigil-etc' },
				(paths) => paths.configDirs()
			);
			expect(dirs).to.deep.equal([join(homedir(), '.sigil'), join(homedir(), '.sigil-etc')]);
		});
	});

	// `expand('')` is `'.'` and `combinePaths()` skips only falsy entries, so a
	// list written with a hole in it put the working directory on the search path
	describe('an empty XDG_*_DIRS segment', () => {
		const configHome = join(homedir(), '.sigil');
		const etc = normalize('/etc/xdg');

		it.each([
			[`${delimiter}/etc/xdg`],
			[`/etc/xdg${delimiter}`],
			[`${delimiter}/etc/xdg${delimiter}`],
			[`/etc/xdg${delimiter}${delimiter}`],
		])('should be dropped from %s', async (value) => {
			const dirs = await withPaths(
				{ XDG_CONFIG_HOME: configHome, XDG_CONFIG_DIRS: value },
				(paths) => paths.configDirs()
			);
			expect(dirs).to.deep.equal([configHome, etc]);
		});

		it.each([[delimiter], [`${delimiter}${delimiter}`]])(
			'should leave nothing behind when the value is only separators: %s',
			async (value) => {
				const dirs = await withPaths(
					{ XDG_CONFIG_HOME: configHome, XDG_CONFIG_DIRS: value },
					(paths) => paths.configDirs()
				);
				expect(dirs).to.deep.equal([configHome]);
			}
		);

		it('should drop a relative entry and keep the absolute ones', async () => {
			const dirs = await withPaths(
				{ XDG_DATA_HOME: configHome, XDG_DATA_DIRS: `etc${delimiter}/etc/xdg` },
				(paths) => paths.dataDirs()
			);
			expect(dirs).to.deep.equal([configHome, etc]);
		});

		it('should never answer with the working directory', async () => {
			const dirs = await withPaths(
				{ XDG_CONFIG_DIRS: `${delimiter}.${delimiter}..`, XDG_DATA_DIRS: `.${delimiter}` },
				(paths) => [...(paths.configDirs() ?? []), ...(paths.dataDirs() ?? [])]
			);
			for (const dir of dirs) {
				expect(isAbsolute(dir)).to.equal(true);
			}
		});
	});

	// `expand()` leaves `%LOCALAPPDATA%` as it found it when the variable is
	// unset, and the literal is truthy -- so the array stopped at its first entry
	// and `~/AppData/Local`, the fallback the array exists for, was unreachable
	describe('an unexpanded %VAR% in a Windows fallback', () => {
		it('should fall through to the next entry', async () => {
			const dir = await withPaths({ LOCALAPPDATA: undefined }, (paths) => paths.cache(), {
				platform: 'win32',
			});
			expect(dir).to.equal(join(homedir(), 'AppData', 'Local'));
		});

		it('should still take the variable when it is set', async () => {
			const local = join(homedir(), 'AppData', 'Sigil');
			const dir = await withPaths({ LOCALAPPDATA: local }, (paths) => paths.cache(), {
				platform: 'win32',
			});
			expect(dir).to.equal(local);
		});

		it('should fall through a variable set to something relative', async () => {
			const dir = await withPaths({ APPDATA: 'AppData' }, (paths) => paths.data(), {
				platform: 'win32',
			});
			expect(dir).to.equal(join(homedir(), 'AppData', 'Roaming'));
		});

		// the one win32 entry that is a bare string rather than an array, and so
		// the one that reaches `baseDir()` by the other branch of `resolveTypePath()`
		it('should expand the ~ of the entry that is not an array', async () => {
			const dir = await withPaths({}, (paths) => paths.config(), { platform: 'win32' });
			expect(dir).toBeTruthy();
			expect(dir).to.not.contain('~');
			expect(dir!.startsWith(homedir())).to.equal(true);
			expect(isAbsolute(dir!)).to.equal(true);
		});
	});

	// `home()` was `paths ? join(_home, ...paths) : _home`, and an array is always
	// truthy -- so a bare `home()` went through `join()`, `join('')` is `'.'`, and
	// a home the platform could not name came back as the working directory. The
	// `~` guard in `expand()` was reading a value that could never be falsy
	describe('a home directory the platform cannot name', () => {
		it('should leave a ~ alone rather than answering with the working directory', async () => {
			const dir = await withPaths({}, (paths) => paths.expand('~'), { home: '' });
			expect(dir).to.equal('~');
		});

		it('should report the empty home rather than a path built from it', async () => {
			const dir = await withPaths({}, (paths) => paths.home(), { home: '' });
			expect(dir).to.equal('');
		});

		it('should leave every base directory unanswered rather than relative', async () => {
			const dirs = await withPaths(
				{},
				(paths) => [paths.cache(), paths.config(), paths.data(), paths.state()],
				{ home: '' }
			);
			expect(dirs).to.deep.equal([undefined, undefined, undefined, undefined]);
		});
	});

	describe('tmp()', () => {
		it('should get the tmp directory', () => {
			expect(tmp()).toBeTruthy();
		});

		it('should get the tmp directory plus additional paths', () => {
			let dir = tmp('foo', 'bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));

			dir = tmp('foo/', '/bar');
			expect(dir).toBeTruthy();
			expect(dir).toContain(join('foo', 'bar'));
		});
	});
});
