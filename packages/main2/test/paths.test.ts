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
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

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
