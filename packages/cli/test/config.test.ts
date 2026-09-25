import { CONFIG_FILE, readSigilConfig } from '../src/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `sigil.json`.
 *
 * One file rather than two: `sigil add` already read it for where ejected
 * components land, so a build option's question was never "config or flags" but
 * "this file or a second one".
 */

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sigil-config-'));
});

afterEach(() => {
	rmSync(root, { force: true, recursive: true });
});

/** Writes a config and reads it back. */
function withConfig(json: unknown) {
	writeFileSync(join(root, CONFIG_FILE), JSON.stringify(json));
	return readSigilConfig(root);
}

describe('reading it', () => {
	it('should answer empty when there is none', () => {
		expect(readSigilConfig(root)).toStrictEqual({});
	});

	it('should read the build section', () => {
		expect(
			withConfig({ build: { external: ['rolldown'], out: 'build', sourcemap: false } }).build
		).toStrictEqual({ external: ['rolldown'], name: undefined, out: 'build', sourcemap: false });
	});

	it('should read components beside it', () => {
		// the field that predates the rest of the file, still read by `add`
		expect(withConfig({ build: { out: 'x' }, components: 'src/ui' }).components).toBe('src/ui');
	});
});

describe('refusing what it cannot mean', () => {
	it('should refuse a string where a list of packages was meant', () => {
		// it would otherwise reach rolldown as a string and match something else
		expect(() => withConfig({ build: { external: 'rolldown' } })).toThrow(/array of package/);
	});

	it('should refuse an empty name in that list', () => {
		expect(() => withConfig({ build: { external: ['ok', ''] } })).toThrow(/array of package/);
	});

	it('should refuse a string where a boolean was meant', () => {
		// `"false"` is not `false`, and coercing it would turn a typo into a
		// setting nobody chose
		expect(() => withConfig({ build: { sourcemap: 'false' } })).toThrow(/must be true or false/);
	});

	it('should refuse a build section that is not an object', () => {
		expect(() => withConfig({ build: [] })).toThrow(/must be an object/);
	});

	it('should say which file failed to parse', () => {
		writeFileSync(join(root, CONFIG_FILE), '{ nope');
		expect(() => readSigilConfig(root)).toThrow(/Failed to parse sigil\.json/);
	});
});
