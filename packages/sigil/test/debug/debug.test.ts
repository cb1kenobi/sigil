import { enable, isEnabled } from '../../src/debug/index.js';
import { describe, it, expect, vi } from 'vitest';

/**
 * Asks the pattern language the only question it is for: with `DEBUG` set to
 * this, does that namespace log?
 */
function on(pattern: string | RegExp | undefined, ns: string | undefined) {
	return isEnabled(ns, enable(pattern));
}

/**
 * Re-imports the module with `DEBUG` set to a value, since the matchers are
 * built once at module load -- which is the thing several of these test.
 */
async function loadWith(value: string | undefined) {
	const orig = process.env.DEBUG;
	if (value === undefined) {
		delete process.env.DEBUG;
	} else {
		process.env.DEBUG = value;
	}
	try {
		vi.resetModules();
		return await import('../../src/debug/index.js');
	} finally {
		if (orig === undefined) {
			delete process.env.DEBUG;
		} else {
			process.env.DEBUG = orig;
		}
	}
}

describe('debug', () => {
	describe('enabling', () => {
		it('should log nothing when DEBUG is unset or empty', () => {
			expect(on(undefined, 'sigil')).toBe(false);
			expect(on('', 'sigil')).toBe(false);
		});

		it('should log everything for *', () => {
			expect(on('*', 'sigil')).toBe(true);
			expect(on('*', 'anything at all')).toBe(true);
		});

		it('should log a namespace by name', () => {
			expect(on('sigil', 'sigil')).toBe(true);
			expect(on('sigil', 'sigil:parser')).toBe(false);
			expect(on('sigil', 'other')).toBe(false);
		});

		it('should log every namespace in a list', () => {
			expect(on('sigil, other', 'sigil')).toBe(true);
			expect(on('sigil other', 'other')).toBe(true);
			expect(on('sigil, other', 'third')).toBe(false);
		});

		it('should log a namespace a glob covers', () => {
			expect(on('sigil:*', 'sigil:parser')).toBe(true);
			expect(on('sigil:*', 'sigil:')).toBe(true);
			expect(on('sigil:*', 'sigil')).toBe(false);
			expect(on('*:parser', 'sigil:parser')).toBe(true);
			expect(on('si*l', 'sigil')).toBe(true);
		});

		it('should take a regular expression as the whole pattern', () => {
			expect(on(/^sigil:/, 'sigil:parser')).toBe(true);
			expect(on(/^sigil:/, 'other')).toBe(false);
		});

		it('should log an unnamespaced logger whenever DEBUG names anything', () => {
			expect(on('sigil', undefined)).toBe(true);
			expect(on(undefined, undefined)).toBe(false);
		});
	});

	describe('negation', () => {
		it('should log everything but what a lone exclusion names', () => {
			expect(on('-sigil', 'other')).toBe(true);
			expect(on('-sigil', 'sigil')).toBe(false);
		});

		it('should subtract an exclusion from what the rest allows', () => {
			expect(on('sigil:*, -sigil:updates', 'sigil:parser')).toBe(true);
			expect(on('sigil:*, -sigil:updates', 'sigil:updates')).toBe(false);
		});

		it('should exclude what a glob covers', () => {
			expect(on('*, -sigil:*', 'sigil:parser')).toBe(false);
			expect(on('*, -sigil:*', 'other')).toBe(true);
		});

		it('should read a dash inside a name as part of the name', () => {
			expect(on('sigil-parser', 'sigil-parser')).toBe(true);
			expect(on('sigil-parser', 'parser')).toBe(false);
		});
	});

	// `enable()` dropped each token into `new RegExp()` after turning `*` into
	// `.*?` and escaping nothing, so a metacharacter either changed what the
	// pattern matched or threw a `SyntaxError` out of module initialization --
	// and every entry point of the library imports this module
	describe('metacharacters', () => {
		it('should read a dot as a dot', () => {
			expect(on('sigil.updates', 'sigil.updates')).toBe(true);
			expect(on('sigil.updates', 'sigilXupdates')).toBe(false);
			expect(on('sigil.*', 'sigil.updates')).toBe(true);
			expect(on('sigil.*', 'sigilXupdates')).toBe(false);
		});

		it.each(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])(
			'should read %s as itself',
			(meta) => {
				expect(on(`a${meta}b`, `a${meta}b`)).toBe(true);
				expect(on(`a${meta}b`, 'aXb')).toBe(false);
				expect(on(`a${meta}b`, 'ab')).toBe(false);
			}
		);

		it.each(['(', ')', '[', ']', '\\', '*)', 'a{2', '?', '+', 'a|b', '(?<'])(
			'should not throw on the pattern %s',
			(pattern) => {
				expect(() => enable(pattern)).not.toThrow();
				expect(() => enable(`-${pattern}`)).not.toThrow();
			}
		);

		it('should keep the wildcard next to an escaped metacharacter', () => {
			expect(on('a+*', 'a+b')).toBe(true);
			expect(on('a+*', 'aab')).toBe(false);
			expect(on('(*)', '(anything)')).toBe(true);
			expect(on('(*)', 'anything')).toBe(false);
		});

		it('should escape an exclusion too', () => {
			expect(on('sigil*, -sigil.updates', 'sigilXupdates')).toBe(true);
			expect(on('sigil*, -sigil.updates', 'sigil.updates')).toBe(false);
		});
	});

	// a pattern of nothing but separators named no namespace and excluded none,
	// and the `/./` that stands in for "everything the exclusions left" turned
	// every logger in the process on
	describe('a pattern that names nothing', () => {
		it.each([',', ',,', '   ', ' , ', '-'])('should log nothing for %s', (pattern) => {
			expect(on(pattern, 'sigil')).toBe(false);
			expect(on(pattern, undefined)).toBe(false);
		});
	});

	describe('module initialization', () => {
		it('should import with a DEBUG that is not a regular expression', async () => {
			const mod = await loadWith('(');
			expect(mod.isEnabled('(')).toBe(true);
			expect(mod.isEnabled('sigil')).toBe(false);
		});

		it('should import with a DEBUG of only separators', async () => {
			const mod = await loadWith(',,');
			expect(mod.isEnabled('sigil')).toBe(false);
		});

		it('should write only what DEBUG names', async () => {
			const mod = await loadWith('sigil:parser');
			const written: string[] = [];
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
				written.push(String(chunk));
				return true;
			});

			try {
				mod.default('sigil:parser').log('allowed');
				mod.default('sigil:updates').log('silenced');
				await new Promise((resolve) => setImmediate(resolve));
			} finally {
				spy.mockRestore();
			}

			const out = written.join('');
			expect(out).toContain('allowed');
			expect(out).not.toContain('silenced');
		});
	});
});
