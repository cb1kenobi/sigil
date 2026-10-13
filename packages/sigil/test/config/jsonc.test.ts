import { json, jsonc, createConfigSync } from '../../src/config/index.js';
import { lineAt, parseJsonc, scanJsonc } from '../../src/config/jsonc.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sigil-jsonc-'));
});

afterEach(() => {
	rmSync(root, { force: true, recursive: true });
});

/** Writes a file under the scratch root and answers with its path. */
function file(name: string, contents: string): string {
	const path = join(root, name);
	writeFileSync(path, contents);
	return path;
}

/** Reads a value out of a file through a store. */
function read(name: string, contents: string, strict = false): unknown {
	const path = file(name, contents);
	return createConfigSync({
		layers: [{ name: 'f', store: strict ? json(path) : jsonc(path) }],
	}).get();
}

describe('the scan', () => {
	it('should leave the source at its own offsets', () => {
		// the whole reason this strips rather than parses: `JSON.parse`'s own
		// message still points at the character it was about, and SIG-154's span
		// editor works over the original text with this same scan
		const source = '{\n\t// hi\n\t"a": 1,\n}';
		const { json: out } = scanJsonc(source, true, 'f');

		expect(out).to.have.lengthOf(source.length);
		expect(out.split('\n')).to.have.lengthOf(source.split('\n').length);
		expect(JSON.parse(out)).to.deep.equal({ a: 1 });
	});

	it('should keep a comment-looking run inside a string', () => {
		expect(read('c.jsonc', '{ "url": "https://x/y", "re": "a,b", "c": "/* no */" }')).to.deep.equal(
			{ c: '/* no */', re: 'a,b', url: 'https://x/y' }
		);
	});

	it('should keep an escaped quote inside a string', () => {
		expect(read('c.jsonc', '{ "a": "say \\" // not a comment" }')).to.deep.equal({
			a: 'say " // not a comment',
		});
	});

	it('should report every comment it found, with its line', () => {
		const { comments } = scanJsonc('{\n// one\n"a": 1 /* two */\n}', true, 'f');
		expect(comments).to.deep.equal([
			{ line: 2, text: '// one' },
			{ line: 3, text: '/* two */' },
		]);
	});

	it('should read a line comment that runs to the end of the file', () => {
		expect(read('c.jsonc', '{"a":1}\n// trailing')).to.deep.equal({ a: 1 });
	});

	it('should read a trailing comma in an object and in an array', () => {
		expect(read('c.jsonc', '{ "a": [1, 2,], }')).to.deep.equal({ a: [1, 2] });
	});

	it.each(['[,]', '{,}', '[[,]]', '[, /* c */]', '[,1]', '{,"a":1}'])(
		'should refuse %s, where the comma separated nothing',
		(text) => {
			// a trailing comma is one that **separated** something, and after an
			// opener or another comma there is nothing in front of it -- so `[,]` is
			// an elision, which this flavour does not have. Blanked, it read as `[]`
			// and `{,}` as `{}`, which is wider than the flavour this claims to be:
			// VS Code's own parser refuses both. Found by walking the comma shapes,
			// and the two it accepted were the only two
			expect(() => parseJsonc(text, true, 'f')).toThrow(/Failed to parse f/);
		}
	);

	it('should read a trailing comma with a comment between it and the brace', () => {
		// a comment is trivia, so it neither opens nor closes the window a pending
		// comma is waiting in
		expect(read('c.jsonc', '{ "a": [1, /* two */] }')).to.deep.equal({ a: [1] });
		expect(read('c.jsonc', '{ "a": 1,\n// note\n}')).to.deep.equal({ a: 1 });
	});

	it('should end a line comment at a lone carriage return', () => {
		// `\n` alone ran the comment to the end of the document, so a classic-Mac
		// file blanked every key after the first comment and `JSON.parse` succeeded
		// over what was left -- a key dropped with no error at all. Found by review
		expect(JSON.parse(scanJsonc('{ "a": 1 // c\r , "b": 2 }', true, 'f').json)).to.deep.equal({
			a: 1,
			b: 2,
		});
	});

	it.each([
		['\u2028', 'a line separator'],
		['\u2029', 'a paragraph separator'],
	])('should refuse rather than truncate at %j (%s)', (nl) => {
		// the other two JavaScript line terminators end a comment too, and what
		// follows is then a **syntax error** -- because neither is JSON whitespace,
		// so a document holding one outside a string was never valid JSON. Which is
		// the point: ending the comment there turns a silent truncation into a
		// refusal, and the refusal is the better of the two answers available
		expect(() => parseJsonc(`{ "a": 1 // c${nl} , "b": 2 }`, true, 'f')).toThrow(
			/Failed to parse f/
		);

		// and what the comment blanked is the comment, which is the half that
		// matters: `"b"` is still in the scanned output rather than blanked away,
		// where with `\n` alone it was gone and `JSON.parse` was perfectly happy
		// with the remains
		expect(scanJsonc(`{ "a": 1 // c${nl} , "b": 2 }`, true, 'f').json).to.contain('"b": 2');
	});

	it('should report that it found a trailing comma', () => {
		expect(scanJsonc('{"a":1,}', true, 'f').trailingCommas).to.equal(true);
		expect(scanJsonc('{"a":1}', true, 'f').trailingCommas).to.equal(false);
	});

	it('should leave a separating comma alone', () => {
		expect(read('c.jsonc', '{ "a": 1, "b": 2 }')).to.deep.equal({ a: 1, b: 2 });
	});

	it('should leave a comma alone that an empty structure follows', () => {
		// an open brace closes the window a pending comma is waiting in, and it is
		// the one character where that is not obvious -- `[1, []]` reaches a `]`
		// with the *outer* comma still pending if it does not, so the separator is
		// blanked and the document stops parsing. Found by the differential in
		// fuzz.test.ts, which is the one guard that met it
		expect(read('c.jsonc', '{ "a": [1, []], "b": [1, {}] }')).to.deep.equal({
			a: [1, []],
			b: [1, {}],
		});
	});

	it('should blank a byte order mark rather than trimming it', () => {
		// an editor writes one and `JSON.parse` refuses it, and it is not a
		// character the document holds -- blanked so that every offset after it
		// still means what it meant
		const source = '﻿{"a":1}';
		const { json: out } = scanJsonc(source, true, 'f');
		expect(out).to.have.lengthOf(source.length);
		expect(JSON.parse(out)).to.deep.equal({ a: 1 });
		expect(read('c.json', source, true)).to.deep.equal({ a: 1 });
	});

	it('should count a line only when something needs one', () => {
		expect(lineAt('a\nb\nc', 0)).to.equal(1);
		expect(lineAt('a\nb\nc', 2)).to.equal(2);
		expect(lineAt('a\nb\nc', 4)).to.equal(3);
		expect(lineAt('a', 99)).to.equal(1);
	});
});

describe('what it refuses', () => {
	it('should refuse an unterminated string, naming the line', () => {
		expect(() => scanJsonc('{\n"a": "oops\n}', true, 'f')).toThrow(
			/Unterminated string in f on line 2/
		);
	});

	it('should refuse an unterminated string that ends mid-escape', () => {
		expect(() => scanJsonc('{"a":"x\\', true, 'f')).toThrow(/Unterminated string/);
	});

	it('should refuse an unterminated block comment, naming the line', () => {
		expect(() => scanJsonc('{\n/* open\n}', true, 'f')).toThrow(
			/Unterminated comment in f on line 2/
		);
	});

	it('should refuse an unterminated block comment before it refuses the comment', () => {
		// an unterminated comment is a scan that cannot finish, so it is reported
		// whether or not comments were allowed -- naming what is wrong rather than
		// what would also have been wrong
		expect(() => scanJsonc('{\n/* open\n}', false, 'f')).toThrow(/Unterminated comment/);
	});

	it('should refuse a comment in a .json, naming the line', () => {
		// reported rather than left to `JSON.parse`, which is the one thing this
		// adds over calling it directly: the engine's answer is `Unexpected token /`
		expect(() => read('c.json', '{\n// nope\n"a":1}', true)).toThrow(
			/Comments are not allowed in .*c\.json, on line 2/
		);
	});

	it('should refuse a trailing comma in a .json, naming the line', () => {
		expect(() => read('c.json', '{\n"a":1,\n}', true)).toThrow(
			/Trailing commas are not allowed in .*c\.json, on line 3/
		);
	});

	it('should say which file failed to parse', () => {
		expect(() => read('c.json', '{ nope', true)).toThrow(/Failed to parse .*c\.json/);
		expect(() => read('c.jsonc', '{ nope')).toThrow(/Failed to parse .*c\.jsonc/);
	});

	it('should refuse a document whose root is not an object', () => {
		// merging it would make every key of every layer below it vanish
		expect(() => read('c.json', '42', true)).toThrow(/must hold an object/);
		expect(() => read('c.json', '[1,2]', true)).toThrow(/must hold an object/);
		expect(() => read('c.json', 'null', true)).toThrow(/must hold an object/);
	});
});

describe('a file that is not there', () => {
	it('should read as an empty document', () => {
		// the ordinary state of a config file: an app ships defaults and the user
		// has written nothing yet
		expect(
			createConfigSync({
				layers: [{ name: 'f', store: jsonc(join(root, 'nope.jsonc')) }],
			}).get()
		).to.deep.equal({});
	});

	it('should read a file holding nothing but whitespace the same way', () => {
		// `JSON.parse('')` is a syntax error, and reporting one over `touch
		// config.json` would be refusing to start over an empty file
		expect(read('c.json', '', true)).to.deep.equal({});
		expect(read('c.json', '  \n\t ', true)).to.deep.equal({});
	});

	it('should report every other reason a read failed', () => {
		// a directory where a file was named is an app pointing at the wrong
		// thing, and answering "there is no config" for it is the silence that
		// costs an afternoon
		const dir = join(root, 'adir');
		mkdirSync(dir);
		expect(() => createConfigSync({ layers: [{ name: 'f', store: json(dir) }] })).toThrow(
			/Failed to read/
		);
	});

	it('should report every other reason an async read failed', async () => {
		const dir = join(root, 'adir');
		mkdirSync(dir);
		const { createConfig } = await import('../../src/config/index.js');
		await expect(createConfig({ layers: [{ name: 'f', store: json(dir) }] })).rejects.toThrow(
			/Failed to read/
		);
	});
});

describe('both halves of a file store', () => {
	it('should answer the same', async () => {
		const path = file('c.jsonc', '{ /* hi */ "a": 1, }');
		const store = jsonc(path);
		const { createConfig } = await import('../../src/config/index.js');

		expect(store.readSync().value).to.deep.equal({ a: 1 });
		expect((await store.read()).value).to.deep.equal({ a: 1 });
		expect((await createConfig({ layers: [{ name: 'f', store }] })).get()).to.deep.equal({
			a: 1,
		});
	});

	it('should report its format and its source', () => {
		const path = file('c.jsonc', '{}');
		expect(jsonc(path).format).to.equal('jsonc');
		expect(json(path).format).to.equal('json');
		expect(jsonc(path).source).to.equal(path);
	});

	it('should say nothing about losing anything, because it edits rather than reprints', () => {
		// empty even over a comment-rich file, which is the contract rather than an
		// omission: this is the store SIG-154 gives a span writer to
		const path = file('c.jsonc', '{\n// a note\n"a": 1\n}');
		expect(jsonc(path).readSync().wouldLose).to.equal(undefined);
	});

	it('should expand a ~ rather than taking the path literally', () => {
		// a `~` is the single most likely thing an app writes by hand, and
		// `readFileSync` of one is an `ENOENT` naming a path with a `~` still in it
		const store = jsonc('~/sigil-config-does-not-exist.jsonc');
		expect(store.source).to.not.contain('~');
		expect(store.readSync().value).to.deep.equal({});
	});
});

describe('what JSONC is not', () => {
	// not JSON5: widening it would be inventing a dialect other tools cannot read
	it.each([
		["{ 'a': 1 }", 'a single-quoted string'],
		['{ a: 1 }', 'an unquoted key'],
		['{ "a": +1 }', 'a leading plus'],
		['{ "a": 0x10 }', 'a hex number'],
		['{ "a": NaN }', 'NaN'],
		['{ "a": .5 }', 'a bare fraction'],
	])('should refuse %s (%s)', (source) => {
		expect(() => parseJsonc(source, true, 'f')).toThrow(/Failed to parse f/);
	});

	it('should leave the JSON value grammar to JSON.parse', () => {
		// `-0`, a surrogate pair and an exponent past the float range are the
		// reason this does not re-implement the value grammar
		const { value } = parseJsonc('{"neg":-0,"big":1e400,"pair":"\\uD83D\\uDE00"}', true, 'f');
		const got = value as Record<string, unknown>;
		expect(Object.is(got.neg, -0)).to.equal(true);
		expect(got.big).to.equal(Infinity);
		expect(got.pair).to.equal('\u{1F600}');
	});
});
