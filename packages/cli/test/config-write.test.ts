import { CONFIG_FILE, CONFIG_SCHEMA, readSigilConfig } from '../src/config.js';
import { createConfigSync, jsonc } from '@ttylabs/sigil/config';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The write half's acceptance test: this repository's **own** config file,
 * read, changed and written back.
 *
 * `sigil.json` became `sigil.jsonc` with comments in it, which is what makes
 * the span writer dogfood rather than a feature with a test of its own -- and
 * it is the one file in here nobody can claim was written to be easy. Over the
 * real `CONFIG_SCHEMA` rather than a copy of it, so that what is asserted is
 * that the writer preserves the file the toolchain actually reads.
 *
 * There is deliberately **no** `saveSigilConfig()`. The toolchain has no
 * setting it persists -- every one of them is a literal somebody edits -- and a
 * function with no caller is the dead code AGENTS.md has a whole entry about,
 * where the exported half outlived the script it told the reader to run. A
 * `sigil config set` is where one would get a caller.
 */

/** This repository's own, which is the file under test. */
const real = join(import.meta.dirname, '..', 'sigil.jsonc');

let root: string;
let path: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sigil-own-config-'));
	path = join(root, CONFIG_FILE);
	copyFileSync(real, path);
});

afterEach(() => {
	rmSync(root, { force: true, recursive: true });
});

/** A config over the copy, declared the way the toolchain declares its own. */
function open(): ReturnType<typeof createConfigSync> {
	return createConfigSync({
		layers: [{ name: CONFIG_FILE, store: jsonc(path) }],
		schema: CONFIG_SCHEMA,
		env: {},
	});
}

describe("the toolchain's own config file", () => {
	it('should have comments in it, or this test is about nothing', () => {
		// the fixture is the repository's own file, so a commit that took the
		// comments out would leave every assertion below true and empty
		const source = readFileSync(real, 'utf8');
		expect(source).to.contain('//');
		expect(source.split('//').length - 1).toBeGreaterThan(1);
	});

	it('should read exactly what the toolchain reads from it', () => {
		const config = readSigilConfig(root);

		expect(config.build?.external).to.deep.equal(['@ttylabs/sigil', 'oxc-parser', 'rolldown']);
		expect(config.build?.sourcemap).to.equal(false);
	});

	it('should survive a set with every other byte identical', () => {
		// the round trip this whole ticket is for, asserted as the thing it claims:
		// one token moves and the rest of the file is compared character for
		// character, comments and blank lines and trailing newline included
		const before = readFileSync(path, 'utf8');
		const config = open();

		config.set('build.sourcemap', true);
		expect(config.saveSync()).to.deep.equal([CONFIG_FILE]);

		const after = readFileSync(path, 'utf8');
		expect(after).to.equal(before.replace('"sourcemap": false', '"sourcemap": true'));
		expect(after).to.not.equal(before);
	});

	it('should still be a file the toolchain reads back', () => {
		// the half a byte comparison cannot make: what was written has to parse as
		// the same schema, through the same reader, with the change in it
		const config = open();
		config.set('build.sourcemap', true);
		config.push('build.external', 'typescript');
		config.saveSync();

		const read = readSigilConfig(root);
		expect(read.build?.sourcemap).to.equal(true);
		expect(read.build?.external).to.deep.equal([
			'@ttylabs/sigil',
			'oxc-parser',
			'rolldown',
			'typescript',
		]);
		// and the comment that explains why those three are external is still
		// above them
		expect(readFileSync(path, 'utf8')).to.contain('nothing inlines one of those');
	});

	it('should add a key it never had, where the file says nothing', () => {
		const config = open();
		config.set('locale', 'de');
		config.saveSync();

		expect(readSigilConfig(root).locale).to.equal('de');
		expect(readFileSync(path, 'utf8')).to.contain('203 kB of maps');
	});

	it('should remove a key and leave the comment above the one beside it', () => {
		const config = open();
		expect(config.delete('build.sourcemap')).to.equal(true);
		config.saveSync();

		const after = readFileSync(path, 'utf8');
		expect(readSigilConfig(root).build?.sourcemap).to.equal(undefined);
		expect(after).to.contain('nothing inlines one of those');
		expect(after).to.not.contain('"sourcemap"');
	});

	it('should touch no file where nothing changed', () => {
		const before = statSync(path).mtimeMs;
		const config = open();

		expect(config.saveSync()).to.deep.equal([]);
		config.set('build.sourcemap', false);
		expect(config.saveSync()).to.deep.equal([CONFIG_FILE]);
		expect(statSync(path).mtimeMs).to.equal(before);
	});
});
