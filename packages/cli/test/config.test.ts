import { CONFIG_FILE, readSigilConfig } from '../src/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `sigil.json`, now read through `@ttylabs/sigil/config`.
 *
 * One file rather than two: `sigil add` already read it for where ejected
 * components land, so a build option's question was never "config or flags" but
 * "this file or a second one".
 *
 * This is the acceptance test for the config module, and what it had to change
 * is the honest cost of sharing a validator. Two things moved and nothing else:
 * a **string where a boolean was declared is coerced** now, because
 * `transformValue()`'s vocabulary is what `--shake=off` and `SHAKE=off` already
 * read -- and it is strict and symmetric, so `"nope"` still throws and no typo
 * becomes a setting nobody chose. And the **type messages are the shared
 * ones**, which name the file, the setting and what was wrong.
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
		// only the keys the file said something about, where the hand-written
		// reader set every one of them to `undefined`. The merged view holds what
		// the layers hold, which is the better answer: a reader cannot tell
		// "absent" from "present and undefined" and does not have to
		expect(
			withConfig({ build: { external: ['rolldown'], out: 'build', sourcemap: false } }).build
		).toStrictEqual({
			external: ['rolldown'],
			out: 'build',
			sourcemap: false,
		});
	});

	it('should read a file holding nothing the same way as no file at all', () => {
		// the two really are the same state, and the old reader distinguished them
		// only by returning early
		expect(withConfig({})).toStrictEqual({});
		expect(withConfig({ build: {} })).toStrictEqual({});
	});

	it('should coerce a value written as a string', () => {
		// which is the whole point of sharing the parser's vocabulary: `"off"`
		// means in this file what it already means to `--shake=off`
		expect(withConfig({ build: { shake: 'off', sourcemap: '1' } }).build).toStrictEqual({
			shake: false,
			sourcemap: true,
		});
		expect(withConfig({ build: { out: 'x' } }).build?.out).to.equal('x');
	});

	it('should read the shaking fields', () => {
		expect(withConfig({ build: { safelist: ['p-2'], shake: false } }).build).toMatchObject({
			safelist: ['p-2'],
			shake: false,
		});
	});

	it('should read components beside it', () => {
		// the field that predates the rest of the file, still read by `add`
		expect(withConfig({ build: { out: 'x' }, components: 'src/ui' }).components).toBe('src/ui');
	});
});

describe('refusing what it cannot mean', () => {
	it('should refuse a string where a list of packages was meant', () => {
		// it would otherwise reach rolldown as a string and match something else.
		// The message is the shared one now, and it names the setting and the file
		expect(() => withConfig({ build: { external: 'rolldown' } })).toThrow(
			/Invalid value for "build\.external" in .*sigil\.json: Expected a list of values/
		);
	});

	it('should refuse an empty name in that list', () => {
		expect(() => withConfig({ build: { external: ['ok', ''] } })).toThrow(/array of package/);
	});

	it('should refuse a string where a list of classes was meant', () => {
		// the same reader as `external`, and it names the field it was asked
		// about rather than saying "a list": a message that names the wrong field
		// sends the reader to the wrong line
		expect(() => withConfig({ build: { safelist: 'p-2' } })).toThrow(
			/Invalid value for "build\.safelist" in/
		);
	});

	it('should refuse an empty name in a list of classes', () => {
		// the one thing a data type cannot say about a list of names
		expect(() => withConfig({ build: { safelist: ['p-2', ''] } })).toThrow(
			/"build\.safelist" must be an array of class names/
		);
	});

	it('should refuse a string a boolean cannot mean', () => {
		// `"off"` is coerced because the vocabulary knows it; `"nope"` is not in
		// the vocabulary, so there is no silent wrong answer available
		expect(() => withConfig({ build: { sourcemap: 'nope' } })).toThrow(/Invalid boolean/);
		expect(() => withConfig({ build: { sourcemap: 42 } })).toThrow(/Invalid boolean/);
	});

	it('should refuse a build section that is not an object', () => {
		// a config schema declares settings by dotted path and has no nested
		// object shapes, so `build.external` is typed and `build` itself is not --
		// which leaves this a mistake nothing in the schema would report
		expect(() => withConfig({ build: [] })).toThrow(/"build" must be an object/);
		expect(() => withConfig({ build: 'nope' })).toThrow(/"build" must be an object/);
	});

	it('should read a default locale', () => {
		// top level rather than under `build`, because it is a fact about the app
		// rather than a bundler knob: the build writes it into the schema it
		// generates, and the runtime cannot read this file for itself
		expect(withConfig({ locale: 'de' }).locale).to.equal('de');
	});

	it('should refuse a locale that is not a non-empty string', () => {
		// the type is the schema's and the non-emptiness is this tool's: `""`
		// passes `type: 'string'` and is right to, because a key written `""` is
		// an empty string somebody chose
		expect(() => withConfig({ locale: 42 })).toThrow(/Invalid value for "locale" in/);
		expect(() => withConfig({ locale: '' })).toThrow(/"locale" must be a non-empty string/);
	});

	it('should refuse an empty components, and an absolute one', () => {
		expect(() => withConfig({ components: '' })).toThrow(/"components" must be a non-empty string/);
		expect(() => withConfig({ components: '/etc' })).toThrow(/must be relative to the app/);
	});

	it('should leave a locale it was not given undefined', () => {
		expect(withConfig({ build: {} }).locale).to.equal(undefined);
	});

	it('should say which file failed to parse, by its path', () => {
		// the path rather than the file name, which is what the shared reader
		// gives and is what somebody can open
		writeFileSync(join(root, CONFIG_FILE), '{ nope');
		expect(() => readSigilConfig(root)).toThrow(
			new RegExp(`Failed to parse .*${CONFIG_FILE.replace('.', '\\.')}`)
		);
	});

	it('should refuse a comment in it, naming the line', () => {
		// a `.json` rather than a `.jsonc`, and the refusal is a sentence somebody
		// can act on where `JSON.parse`'s is `Unexpected token /`
		writeFileSync(join(root, CONFIG_FILE), '{\n// a note\n"components":"x"}');
		expect(() => readSigilConfig(root)).toThrow(/Comments are not allowed in .*on line 2/);
	});
});
