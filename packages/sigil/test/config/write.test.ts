import { writeAtomic, writeAtomicSync } from '../../src/config/atomic.js';
import {
	createConfig,
	createConfigSync,
	json,
	jsonc,
	object,
	type ConfigDocument,
	type ConfigStore,
	type WritableConfigStore,
	type WriteOptions,
} from '../../src/config/index.js';
import { editJsonc } from '../../src/config/jsonc-write.js';
import { jsonCanHold } from '../../src/config/represent.js';
import { applyEdits } from '../../src/config/spans.js';
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sigil-write-'));
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

/** The one call this module's writer is reached by. */
function edit(source: string, next: unknown): string {
	return editJsonc(source, next, { allow: true, what: 'c.jsonc' });
}

describe('the edit applier', () => {
	it('should splice in order whatever order it was handed', () => {
		const edits = [
			{ end: 7, start: 6, text: 'Z' },
			{ end: 1, start: 0, text: 'A' },
			{ end: 4, start: 3, text: 'M' },
		];

		expect(applyEdits('abcdefgh', edits)).to.equal('AbcMefZh');
	});

	it('should answer with the source untouched where there is nothing to do', () => {
		// the property `write()` rests on: a save that changes nothing has to come
		// out byte for byte, because that is what makes it skippable
		const source = 'abc';
		expect(applyEdits(source, [])).to.equal(source);
	});

	it('should keep two insertions at one offset in the order they were emitted', () => {
		// load bearing rather than tidy: adding a key to an object with no trailing
		// comma needs a `,` after the last value *and* a new member after the
		// line's trivia, and with no trivia both land on the same offset
		const at = { end: 3, start: 3 };
		expect(
			applyEdits('abc', [
				{ ...at, text: ',' },
				{ ...at, text: 'd' },
			])
		).to.equal('abc,d');
		expect(
			applyEdits('abc', [
				{ ...at, text: 'd' },
				{ ...at, text: ',' },
			])
		).to.equal('abcd,');
	});

	it('should put an insertion before a replacement that starts where it does', () => {
		// which is what lets a new key be spliced in at the offset a removed one
		// starts at, rather than every emitter having to get that order right
		const out = applyEdits('abc', [
			{ end: 2, start: 1, text: '' },
			{ end: 1, start: 1, text: 'X' },
		]);
		expect(out).to.equal('aXc');
	});

	it('should refuse two edits that overlap', () => {
		expect(() =>
			applyEdits('abcdef', [
				{ end: 4, start: 1, text: 'X' },
				{ end: 5, start: 3, text: 'Y' },
			])
		).toThrow(/Overlapping config edits/);
	});
});

describe('the JSONC writer', () => {
	it('should leave every byte it was not asked to change', () => {
		// the round trip this whole ticket is for, asserted as the thing it claims
		// rather than as a picture: one value moves and the rest of the file is
		// compared character for character
		const source = [
			'// what this app is configured with',
			'{',
			'\t/* the server block */',
			'\t"server": {',
			'\t\t"host": "localhost",',
			'\t\t"port": 8080, // not 80, which needs root',
			'\t},',
			'',
			'\t"plugins": ["a", "b"],',
			'}',
			'',
		].join('\n');

		const out = edit(source, {
			server: { host: 'localhost', port: 9090 },
			plugins: ['a', 'b'],
		});

		expect(out).to.equal(source.replace('8080', '9090'));
	});

	it('should change nothing at all where nothing changed', () => {
		const source = '{\n\t// a note\n\t"a": 1,\n}\n';
		expect(edit(source, { a: 1 })).to.equal(source);
	});

	it('should replace a scalar in place', () => {
		expect(edit('{\n\t"a": 1\n}', { a: 2 })).to.equal('{\n\t"a": 2\n}');
		expect(edit('{\n\t"a": 1\n}', { a: 'two' })).to.equal('{\n\t"a": "two"\n}');
		expect(edit('{\n\t"a": 1\n}', { a: null })).to.equal('{\n\t"a": null\n}');
	});

	it('should add a key after the last one, with a comma it did not have', () => {
		expect(edit('{\n\t"a": 1\n}', { a: 1, b: 2 })).to.equal('{\n\t"a": 1,\n\t"b": 2\n}');
	});

	it('should put a trailing comma back where the file had one', () => {
		// the user's trailing-comma style is one more thing a write is not being
		// asked to change
		expect(edit('{\n\t"a": 1,\n}', { a: 1, b: 2 })).to.equal('{\n\t"a": 1,\n\t"b": 2,\n}');
	});

	it('should add every new key in one go, with one separating comma', () => {
		// one edit rather than one each, which is the comma rule rather than a
		// saving: two insertions that each asked whether a comma already followed
		// the last entry would each answer no and each add one
		expect(edit('{\n\t"a": 1\n}', { a: 1, b: 2, c: 3 })).to.equal(
			'{\n\t"a": 1,\n\t"b": 2,\n\t"c": 3\n}'
		);
	});

	it('should keep a comment that follows the last value on its line', () => {
		// the comma goes directly after the value and the new member after the
		// comment, because a comma written after a line comment is *inside* it
		expect(edit('{\n\t"a": 1 // why\n}', { a: 1, b: 2 })).to.equal(
			'{\n\t"a": 1, // why\n\t"b": 2\n}'
		);
	});

	it('should not splice inside a block comment that holds a line break', () => {
		const source = '{\n\t"a": 1 /* long\n\t comment */\n}';
		expect(edit(source, { a: 1, b: 2 })).to.equal(
			'{\n\t"a": 1, /* long\n\t comment */\n\t"b": 2\n}'
		);
	});

	it('should insert into an object that is empty, behind a comment in it', () => {
		expect(edit('{}', { b: 2 })).to.equal('{ "b": 2 }');
		expect(edit('{ }', { b: 2 })).to.equal('{ "b": 2 }');
		expect(edit('{\n}', { b: 2 })).to.equal('{\n\t"b": 2\n}');
		expect(edit('{\n\t// todo\n}', { b: 2 })).to.equal('{\n\t// todo\n\t"b": 2\n}');
	});

	it('should insert inline where the object is on one line', () => {
		expect(edit('{ "a": 1 }', { a: 1, b: 2 })).to.equal('{ "a": 1, "b": 2 }');
	});

	it('should take a removed key off with its own line', () => {
		expect(edit('{\n\t"a": 1,\n\t"b": 2\n}', { b: 2 })).to.equal('{\n\t"b": 2\n}');
		expect(edit('{\n\t"a": 1,\n\t"b": 2\n}', { a: 1 })).to.equal('{\n\t"a": 1\n}');
	});

	it('should take one comma per removal, whichever side survives', () => {
		// the half that cannot be done one entry at a time: dropping the last two
		// of three has each of them reach for the comma in front of it
		const source = '{\n\t"a": 1,\n\t"b": 2,\n\t"c": 3\n}';
		expect(edit(source, { a: 1 })).to.equal('{\n\t"a": 1\n}');
		expect(edit(source, { c: 3 })).to.equal('{\n\t"c": 3\n}');
		expect(edit(source, { b: 2 })).to.equal('{\n\t"b": 2\n}');
	});

	it('should keep the space before a closing brace it emptied on one line', () => {
		expect(edit('{ "a":1, "b":2, "c":3 }', { a: 1 })).to.equal('{ "a":1 }');
		expect(edit('{ "a":1, "b":2, "c":3 }', { c: 3 })).to.equal('{ "c":3 }');
	});

	it('should write valid JSON where every key is replaced', () => {
		// the comma rule's sharpest edge: an insertion anchored on an entry that is
		// being removed lands inside the removal, which is a dangling comma
		expect(edit('{\n\t"a": 1\n}', { b: 2 })).to.equal('{\n\t"b": 2\n}');
		expect(JSON.parse(edit('{\n\t"a": 1,\n\t"b": 2\n}', { c: 3 }))).to.deep.equal({ c: 3 });
		expect(JSON.parse(edit('{ "a": 1, "b": 2 }', { c: 3, d: 4 }))).to.deep.equal({
			c: 3,
			d: 4,
		});
	});

	it('should not reuse a comma that is being removed with the entry after it', () => {
		// the insertion anchors on the last entry that is **staying**, and the comma
		// after it has gone with the tail -- so there is none to reuse. Reusing it
		// splices at an offset inside the removal, which is an overlapping edit
		expect(edit('{\n\t"a": 1,\n\t"b": 2\n}', { a: 1, c: 3 })).to.equal('{\n\t"a": 1,\n\t"c": 3\n}');
		expect(edit('{\n\t"a": 1,\n\t"b": 2,\n\t"c": 3\n}', { a: 1, d: 4 })).to.equal(
			'{\n\t"a": 1,\n\t"d": 4\n}'
		);
		expect(edit('{ "a": 1, "b": 2 }', { a: 1, c: 3 })).to.equal('{ "a": 1, "c": 3 }');
	});

	it('should keep a comment that sits between a value and its own comma', () => {
		// the comma is found over the **blanked** text, where the comment is
		// whitespace, and then removed on its own because the gap is not whitespace
		// in the source. Both halves are one input: reading the source for the
		// comma finds none and leaves a dangling one, and swallowing the gap eats
		// the comment
		const out = edit('{\n\t"a": 1 /* x */,\n\t"b": 2\n}', { b: 2 });
		expect(out).to.contain('/* x */');
		expect(JSON.parse(out.replace(/\/\*[^]*?\*\//g, ''))).to.deep.equal({ b: 2 });
	});

	it('should insert after the value where the closing brace is on its line', () => {
		// there is no line to end, so a scan for the next line terminator would run
		// past the brace and splice at it
		expect(edit('{\n\t"a": 1 }', { a: 1, b: 2 })).to.equal('{\n\t"a": 1,\n\t"b": 2 }');
	});

	it('should read an escaped quote inside a string as content', () => {
		// `\\` escapes whatever follows, which is the only rule the scan needs --
		// without it the string ends at the escaped quote and the `}` after it
		// closes the object
		const source = '{\n\t"a": "x\\"}y",\n\t"b": 1\n}';
		expect(JSON.parse(source) as unknown).to.deep.equal({ a: 'x"}y', b: 1 });
		expect(edit(source, { a: 'x"}y', b: 2 })).to.equal('{\n\t"a": "x\\"}y",\n\t"b": 2\n}');
	});

	it('should keep a comment that sits between a comma and the key it precedes', () => {
		// the comma is removed on its own where the gap is not whitespace, which is
		// what keeps the comment -- at the cost of the whitespace around it
		const out = edit('{\n\t"a": 1,\n\t// about b\n\t"b": 2\n}', { a: 1 });
		expect(out).to.contain('// about b');
		expect(JSON.parse(out.replace(/\/\/[^\n]*/g, ''))).to.deep.equal({ a: 1 });
	});

	it('should walk into a nested object rather than reprinting it', () => {
		expect(edit('{\n\t"a": {\n\t\t"b": 1 // k\n\t}\n}', { a: { b: 2 } })).to.equal(
			'{\n\t"a": {\n\t\t"b": 2 // k\n\t}\n}'
		);
		expect(edit('{\n\t"a": {\n\t\t"b": 1\n\t}\n}', { a: { b: 1, c: 2 } })).to.equal(
			'{\n\t"a": {\n\t\t"b": 1,\n\t\t"c": 2\n\t}\n}'
		);
	});

	it('should append to an array element-wise rather than reprinting it', () => {
		expect(edit('{\n\t"a": [1, 2]\n}', { a: [1, 2, 3] })).to.equal('{\n\t"a": [1, 2, 3]\n}');
		expect(edit('{\n\t"a": [\n\t\t1,\n\t\t2\n\t]\n}', { a: [1, 2, 3] })).to.equal(
			'{\n\t"a": [\n\t\t1,\n\t\t2,\n\t\t3\n\t]\n}'
		);
	});

	it('should keep a comment inside a list it shortened', () => {
		const out = edit('{\n\t"a": [\n\t\t1,\n\t\t// two\n\t\t2\n\t]\n}', { a: [1] });
		expect(out).to.contain('// two');
		expect(JSON.parse(out.replace(/\/\/[^\n]*/g, ''))).to.deep.equal({ a: [1] });
	});

	it('should rewrite every element where a list was prepended to', () => {
		// by index rather than by identity, which makes an `unshift` a rewrite of
		// every element plus one -- correct, and what it keeps is everything
		// between them
		expect(edit('{\n\t"a": [2, 3]\n}', { a: [1, 2, 3] })).to.equal('{\n\t"a": [1, 2, 3]\n}');
	});

	it('should replace a value whose kind changed', () => {
		expect(edit('{\n\t"a": 1\n}', { a: { b: [1, 2] } })).to.equal(
			'{\n\t"a": {\n\t\t"b": [\n\t\t\t1,\n\t\t\t2\n\t\t]\n\t}\n}'
		);
		expect(edit('{\n\t"a": [1]\n}', { a: 'x' })).to.equal('{\n\t"a": "x"\n}');
	});

	it('should read the indentation off the document rather than choosing one', () => {
		expect(edit('{\n  "a": 1\n}', { a: 1, b: { c: 2 } })).to.equal(
			'{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}'
		);
		expect(edit('{\n    "a": 1\n}', { a: 1, b: { c: 2 } })).to.equal(
			'{\n    "a": 1,\n    "b": {\n        "c": 2\n    }\n}'
		);
	});

	it('should fall back to a tab where there is nothing to read it off', () => {
		// npm's own `package.json` and this repository's formatter both write one
		expect(edit('{"a": 1}', { a: 1, b: { c: 2 } })).to.equal('{"a": 1, "b": {\n\t"c": 2\n}}');
	});

	it('should match the line ending the document uses', () => {
		expect(edit('{\r\n\t"a": 1\r\n}', { a: 1, b: 2 })).to.equal('{\r\n\t"a": 1,\r\n\t"b": 2\r\n}');
		expect(edit('{\r\n\t"a": 1,\r\n\t"b": 2\r\n}', { b: 2 })).to.equal('{\r\n\t"b": 2\r\n}');
	});

	it('should edit the live one of two duplicate keys and remove them both', () => {
		// `JSON.parse` answers with the last, so a change edits that one and leaves
		// the shadowed ones shadowed -- and a removal has to take every one of them
		// or a shadowed value becomes live, which would change a value nobody
		// touched
		expect(edit('{\n\t"a": 1,\n\t"a": 2\n}', { a: 3 })).to.equal('{\n\t"a": 1,\n\t"a": 3\n}');
		expect(JSON.parse(edit('{\n\t"a": 1,\n\t"a": 2\n}', { a: 3 }))).to.deep.equal({ a: 3 });
		expect(JSON.parse(edit('{\n\t"a": 1,\n\t"a": 2\n}', { b: 1 }))).to.deep.equal({ b: 1 });
	});

	it('should write a key whose name needs escaping', () => {
		expect(JSON.parse(edit('{}', { 'a "b"': 1, 'c\nd': 2 }))).to.deep.equal({
			'a "b"': 1,
			'c\nd': 2,
		});
	});

	it('should read a key whose name was escaped in the source', () => {
		expect(edit('{\n\t"a\\nb": 1\n}', { 'a\nb': 2 })).to.equal('{\n\t"a\\nb": 2\n}');
	});

	it('should leave a comment that holds a brace or a comma alone', () => {
		// the structure is scanned over the blanked text, where a comment is
		// whitespace -- so nothing in one can be mistaken for the grammar
		const source = '{\n\t// } , "x": 9\n\t"a": 1 /* ] */\n}';
		expect(edit(source, { a: 2 })).to.equal(source.replace('"a": 1', '"a": 2'));
	});

	it('should read a brace or a comma inside a string as content', () => {
		const source = '{\n\t"a": "} , //"\n}';
		expect(edit(source, { a: '} , //', b: 1 })).to.equal('{\n\t"a": "} , //",\n\t"b": 1\n}');
	});
});

describe('what JSON cannot hold', () => {
	it('should refuse what JSON.stringify answers undefined for', () => {
		expect(jsonCanHold(undefined, 'x')).to.match(/no undefined/);
		expect(jsonCanHold(() => 1, 'x')).to.match(/no function/);
		expect(jsonCanHold(Symbol('s'), 'x')).to.match(/no symbol/);
		expect(jsonCanHold(1n, 'x')).to.match(/no bigint/);
	});

	it('should refuse what JSON.stringify rewrites silently', () => {
		// the reason this exists: a throw is loud and an `undefined` is broken
		// output, where `NaN` becoming `null` and a `Map` becoming `{}` are the
		// silent-loss class every other decision in this module refuses
		expect(jsonCanHold(Number.NaN, 'x')).to.match(/no NaN/);
		expect(jsonCanHold(Infinity, 'x')).to.match(/no Infinity/);
		expect(jsonCanHold(new Map([['a', 1]]), 'x')).to.match(/as \{\}/);
		expect(jsonCanHold(new Set([1]), 'x')).to.match(/as \{\}/);
	});

	it('should take a value that says what it is in JSON', () => {
		expect(jsonCanHold(new Date(0), 'x')).to.equal(true);
		expect(jsonCanHold({ toJSON: (): number => 1 }, 'x')).to.equal(true);
	});

	it('should name the path rather than the value it was handed', () => {
		// `set('server', { retries: Infinity })` is a plain object holding
		// something JSON turns into `null`, and a refusal naming `server` would be
		// pointing at the thing that is fine
		expect(jsonCanHold({ retries: Infinity }, 'server')).to.match(/at "server\.retries"/);
		expect(jsonCanHold([1, [2, undefined]], 'list')).to.match(/at "list\.1\.1"/);
		expect(jsonCanHold(Number.NaN, '')).to.not.match(/at /);
	});

	it('should take a value referenced twice and refuse one that refers to itself', () => {
		const shared = { a: 1 };
		expect(jsonCanHold({ x: shared, y: shared }, '')).to.equal(true);

		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(jsonCanHold(cycle, '')).to.match(/refers back to itself/);
	});

	it('should be what the store answers canRepresent with', () => {
		const store = jsonc(join(root, 'c.jsonc'));
		expect(store.canRepresent?.(Infinity, 'a.b')).to.match(/no Infinity/);
		expect(store.canRepresent?.(1, 'a.b')).to.equal(true);
	});

	it('should refuse the value at the call that wrote it', () => {
		const config = createConfigSync({
			layers: [{ name: 'user', store: jsonc(join(root, 'c.jsonc')) }],
			env: {},
		});

		expect(() => config.set('a', Number.NaN)).toThrow(/cannot hold the value at "a".*no NaN/s);
	});
});

describe('the atomic write', () => {
	it('should leave the file holding what it was handed', async () => {
		const path = join(root, 'deep', 'c.jsonc');
		await writeAtomic(path, 'one');
		expect(readFileSync(path, 'utf8')).to.equal('one');

		writeAtomicSync(path, 'two');
		expect(readFileSync(path, 'utf8')).to.equal('two');
	});

	it('should leave no temp file behind', async () => {
		const path = join(root, 'c.jsonc');
		await writeAtomic(path, 'x');
		writeAtomicSync(path, 'y');
		expect(readdirSync(root)).to.deep.equal(['c.jsonc']);
	});

	it.each([0o600, 0o640, 0o660, 0o666])(
		'should keep the mode %s the file already had',
		async (mode) => {
			// or a 600 config comes back 644, which hands its contents to every user
			// on the machine. Several modes rather than one, because the mode the
			// `open` asks for goes through the **umask** and the `chmod` after the
			// close is the one that does not: at 0o600 under the usual 022 the open
			// already gets it right, so a test of that alone says nothing about the
			// chmod
			const path = file('c.jsonc', '{}');
			chmodSync(path, mode);

			await writeAtomic(path, 'a');
			expect(statSync(path).mode & 0o777).to.equal(mode);

			writeAtomicSync(path, 'b');
			expect(statSync(path).mode & 0o777).to.equal(mode);
		}
	);

	it('should not carry the setuid, setgid or sticky bits over', () => {
		// re-creating one on a file this just wrote is a privilege decision a
		// config writer has no business making, so the permission bits are copied
		// exactly and these are not
		const path = file('c.jsonc', '{}');
		chmodSync(path, 0o1600);
		expect(statSync(path).mode & 0o7777).to.equal(0o1600);

		writeAtomicSync(path, 'a');
		expect(statSync(path).mode & 0o7777).to.equal(0o600);
	});

	it('should report a failure the file system refused rather than swallowing it', () => {
		// a directory where a file was named, which `mkdirOwnerSync()` refuses
		// before any temp file exists. Where the temp file goes and what happens
		// to it when a *later* call fails is `atomic-temp.test.ts`'s, because the
		// only moment it exists is between the open and the rename and nothing
		// outside can look
		writeFileSync(join(root, 'c.jsonc'), 'x');

		expect(() => writeAtomicSync(join(root, 'c.jsonc', 'under-a-file'), 'y')).toThrow();
		expect(readdirSync(root)).to.deep.equal(['c.jsonc']);
	});
});

describe('save', () => {
	/** A schema both halves of these tests read. */
	const schema = { 'server.port': { type: 'int' as const }, plugins: { multiple: true } };

	it('should persist what set changed and nothing else', async () => {
		const path = file('c.jsonc', '{\n\t// a note\n\t"server": { "port": 8080 }\n}\n');
		const config = await createConfig({
			layers: [{ name: 'user', store: jsonc(path) }],
			schema,
			env: {},
		});

		config.set('server.port', 9090);
		expect(await config.save()).to.deep.equal(['user']);
		expect(readFileSync(path, 'utf8')).to.equal(
			'{\n\t// a note\n\t"server": { "port": 9090 }\n}\n'
		);
	});

	it('should do the same without awaiting anything', () => {
		// which is what an exit or signal handler needs, and is the reason
		// `createConfigSync()` exists one call earlier
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = createConfigSync({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });

		config.set('a', 2);
		expect(config.saveSync()).to.deep.equal(['user']);
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2\n}\n');
	});

	it('should write a file that is not there yet', () => {
		const path = join(root, 'deep', 'c.jsonc');
		const config = createConfigSync({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });

		config.set('a', 1);
		config.saveSync();
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 1\n}\n');
	});

	it('should skip a layer nothing touched', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const before = statSync(path).mtimeMs;
		const config = await createConfig({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });

		expect(await config.save()).to.deep.equal([]);
		expect(await config.save('user')).to.deep.equal([]);
		expect(statSync(path).mtimeMs).to.equal(before);
	});

	it('should touch no file where the text comes out the same', async () => {
		// which keeps the mtime a watcher is reading, and is what makes `apply()`
		// of a freshly read value a no-op rather than a rewrite of the same bytes
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = await createConfig({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });
		const before = statSync(path).mtimeMs;

		config.set('a', 1);
		config.apply('user', { a: 1 });
		expect(await config.save()).to.deep.equal(['user']);
		expect(statSync(path).mtimeMs).to.equal(before);
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 1\n}\n');
	});

	it('should report whether a layer has changes it has not written', async () => {
		const config = await createConfig({
			layers: [{ name: 'user', store: jsonc(join(root, 'c.jsonc')) }],
			env: {},
		});

		expect(config.layers[0]?.dirty).to.equal(false);
		config.set('a', 1);
		expect(config.layers[0]?.dirty).to.equal(true);
		await config.save();
		expect(config.layers[0]?.dirty).to.equal(false);
	});

	it('should not mark a layer a refused mutation never changed', async () => {
		const config = await createConfig({
			layers: [{ name: 'user', store: jsonc(join(root, 'c.jsonc')) }],
			schema: { a: { type: 'int' } },
			env: {},
		});

		expect(() => config.set('a', 'nope')).toThrow();
		expect(config.layers[0]?.dirty).to.equal(false);
	});

	it('should keep another process key it never touched', async () => {
		// the common cross-process case: two invocations setting two *different*
		// keys both survive, where a blind write loses one of them
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = await createConfig({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });

		config.set('a', 2);
		writeFileSync(path, '{\n\t"a": 1,\n\t"b": 9\n}\n');
		await config.save();

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2,\n\t"b": 9\n}\n');
		// and the layer holds what the file holds afterwards, which is the file
		// being right about itself
		expect(config.get('b')).to.equal(9);
	});

	it('should let the last writer win on one key, which is documented rather than guarded', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = await createConfig({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });

		config.set('a', 2);
		writeFileSync(path, '{\n\t"a": 3\n}\n');
		await config.save();

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2\n}\n');
	});

	it('should persist a delete as a removal', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1,\n\t"b": 2\n}\n');
		const config = await createConfig({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });

		expect(config.delete('a')).to.equal(true);
		await config.save();
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"b": 2\n}\n');
	});

	it('should persist a push into a list', async () => {
		const path = file('c.jsonc', '{\n\t"plugins": ["a"]\n}\n');
		const config = await createConfig({
			layers: [{ name: 'user', store: jsonc(path) }],
			schema,
			env: {},
		});

		config.push('plugins', 'b');
		await config.save();
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"plugins": ["a", "b"]\n}\n');
	});

	it('should persist a pop out of a list', async () => {
		const path = file('c.jsonc', '{\n\t"plugins": ["a", "b"]\n}\n');
		const config = await createConfig({
			layers: [{ name: 'user', store: jsonc(path) }],
			schema,
			env: {},
		});

		expect(config.pop('plugins')).to.equal('b');
		expect(await config.save()).to.deep.equal(['user']);
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"plugins": ["a"]\n}\n');
	});

	it('should keep a null the file holds and nobody touched', async () => {
		// `null` is "not configured" to this module and is a value in the file, so
		// dropping it on the way to the writer would delete the line -- and with it
		// whatever comment sits above it
		const path = file(
			'c.jsonc',
			'{\n\t// theme is deliberately unset\n\t"theme": null,\n\t"a": 1\n}\n'
		);
		const config = await createConfig({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });

		expect(config.has('theme')).to.equal(false);
		config.set('a', 2);
		await config.save();

		expect(readFileSync(path, 'utf8')).to.equal(
			'{\n\t// theme is deliberately unset\n\t"theme": null,\n\t"a": 2\n}\n'
		);
	});

	it('should write the spelling the file used for a value nobody changed', async () => {
		// a layer holds `false` where the file says `"off"`, because the schema
		// coerces -- so writing the coerced value back would rewrite a spelling
		// nobody asked to change
		const path = file('c.jsonc', '{\n\t"shake": "off",\n\t"a": 1\n}\n');
		const config = await createConfig({
			layers: [{ name: 'user', store: jsonc(path) }],
			schema: { shake: { type: 'bool' }, a: { type: 'int' } },
			env: {},
		});

		expect(config.get('shake')).to.equal(false);
		config.set('a', 2);
		await config.save();
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"shake": "off",\n\t"a": 2\n}\n');
	});

	it('should write a layer apply() replaced wholesale', async () => {
		// `apply()` is replace rather than merge, which is that method's own rule
		// read from the write side: the other process's keys are not honoured
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = await createConfig({ layers: [{ name: 'user', store: jsonc(path) }], env: {} });

		config.apply('user', { b: 2 });
		writeFileSync(path, '{\n\t"a": 1,\n\t"c": 3\n}\n');
		await config.save();

		expect(JSON.parse(readFileSync(path, 'utf8')) as unknown).to.deep.equal({ b: 2 });
	});

	it('should write only the layer that was named', async () => {
		const low = file('low.jsonc', '{\n\t"a": 1\n}\n');
		const high = file('high.jsonc', '{\n\t"b": 1\n}\n');
		const config = await createConfig({
			layers: [
				{ name: 'low', store: jsonc(low) },
				{ name: 'high', store: jsonc(high) },
			],
			env: {},
		});

		config.set('a', 2, 'low');
		config.set('b', 2, 'high');
		expect(await config.save('low')).to.deep.equal(['low']);
		expect(readFileSync(low, 'utf8')).to.equal('{\n\t"a": 2\n}\n');
		expect(readFileSync(high, 'utf8')).to.equal('{\n\t"b": 1\n}\n');

		expect(await config.save()).to.deep.equal(['high']);
		expect(readFileSync(high, 'utf8')).to.equal('{\n\t"b": 2\n}\n');
	});

	it('should write every dirty layer in stack order', async () => {
		const low = file('low.jsonc', '{\n\t"a": 1\n}\n');
		const high = file('high.jsonc', '{\n\t"b": 1\n}\n');
		const config = await createConfig({
			layers: [
				{ name: 'low', store: jsonc(low) },
				{ name: 'high', store: jsonc(high) },
			],
			env: {},
		});

		config.set('b', 2, 'high');
		config.set('a', 2, 'low');
		expect(await config.save()).to.deep.equal(['low', 'high']);
	});

	it('should skip a read-only layer and refuse a named one', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = await createConfig({
			layers: [
				{ name: 'system', readOnly: true, store: jsonc(path) },
				{ name: 'user', store: object() },
			],
			env: {},
		});

		config.apply('system', { a: 2 });
		expect(await config.save()).to.deep.equal([]);
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 1\n}\n');
		await expect(config.save('system')).rejects.toThrow(/"system": it is read-only/);
	});

	it('should refuse a named layer whose store has no writer at all', async () => {
		// the two refusals the types already distinguish, said in the message: a
		// format that cannot be written, and a layer that is not this app's
		const store: ConfigStore = {
			format: 'odd',
			read: (): Promise<ConfigDocument> => Promise.resolve({ value: {} }),
			readSync: (): ConfigDocument => ({ value: {} }),
		};
		const config = await createConfig({
			layers: [
				{ name: 'system', store },
				{ name: 'user', store: object() },
			],
			env: {},
		});

		await expect(config.save('system')).rejects.toThrow(/odd store cannot write/);
	});

	it('should write nothing to a layer over an object store, which holds in memory', async () => {
		const config = await createConfig({ layers: [{ name: 'runtime', store: object() }], env: {} });

		config.set('a', 1);
		expect(await config.save()).to.deep.equal(['runtime']);
		expect(config.get('a')).to.equal(1);
	});

	it('should refuse a document the schema cannot hold without writing it', async () => {
		// built before the write, so a file another process left in a state this
		// schema refuses is a refusal rather than a file already on disk
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = await createConfig({
			layers: [{ name: 'user', store: jsonc(path) }],
			schema: { a: { type: 'int' }, b: { type: 'int' } },
			env: {},
		});

		config.set('a', 2);
		writeFileSync(path, '{\n\t"a": 1,\n\t"b": "nope"\n}\n');
		await expect(config.save()).rejects.toThrow(/Invalid value for "b"/);
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 1,\n\t"b": "nope"\n}\n');
	});
});

describe('the lossless rule', () => {
	/**
	 * A store that reprints, which is what a sibling package's YAML or XML store
	 * is -- and is the only thing that can trip the guard, because the stores in
	 * here never report a loss.
	 */
	function reprinting(losses: ConfigDocument['wouldLose']): WritableConfigStore & {
		readonly wrote: unknown[];
	} {
		const wrote: unknown[] = [];
		return {
			format: 'yamlish',
			read: (): Promise<ConfigDocument> => Promise.resolve({ value: { a: 1 }, wouldLose: losses }),
			readSync: (): ConfigDocument => ({ value: { a: 1 }, wouldLose: losses }),
			source: '/etc/app/config.yaml',
			write: (value: unknown, _opts?: WriteOptions): Promise<void> => {
				wrote.push(value);
				return Promise.resolve();
			},
			writeSync: (value: unknown, _opts?: WriteOptions): void => {
				wrote.push(value);
			},
			wrote,
		};
	}

	it('should refuse a write that would lose something, naming it and both ways out', async () => {
		const store = reprinting([
			{ kind: 'comment', line: 4 },
			{ kind: 'comment', line: 11 },
			{ kind: 'anchor', detail: '&defaults', line: 22 },
		]);
		const config = await createConfig({ layers: [{ name: 'user', store }], env: {} });

		config.set('a', 2);
		await expect(config.save()).rejects.toThrow(
			/Refusing to write user: comment:4, comment:11, anchor:22 \(&defaults\) would be lost/
		);
		await expect(config.save()).rejects.toThrow(/Pass lossy: true to write anyway/);
		await expect(config.save()).rejects.toThrow(/a store that can keep what is there/);
		expect(store.wrote).to.deep.equal([]);
	});

	it('should write anyway where the call said lossy', async () => {
		const store = reprinting([{ kind: 'comment', line: 4 }]);
		const config = await createConfig({ layers: [{ name: 'user', store }], env: {} });

		config.set('a', 2);
		expect(await config.save({ lossy: true })).to.deep.equal(['user']);
		expect(store.wrote).to.deep.equal([{ a: 2 }]);
	});

	it('should write anyway where the layer said lossy', async () => {
		// the per-layer half, for the legitimate case: this file is generated, so
		// clobber it freely
		const store = reprinting([{ kind: 'comment', line: 4 }]);
		const config = await createConfig({
			layers: [{ lossy: true, name: 'generated', store }],
			env: {},
		});

		config.set('a', 2);
		expect(await config.save()).to.deep.equal(['generated']);
		expect(store.wrote).to.deep.equal([{ a: 2 }]);
	});

	it('should take lossy from either of the two spellings of save', async () => {
		const store = reprinting([{ kind: 'comment', line: 4 }]);
		const config = await createConfig({ layers: [{ name: 'user', store }], env: {} });

		config.set('a', 2);
		expect(config.saveSync('user', { lossy: true })).to.deep.equal(['user']);
		config.set('a', 3);
		expect(config.saveSync({ lossy: true })).to.deep.equal(['user']);
		expect(store.wrote).to.deep.equal([{ a: 2 }, { a: 3 }]);
	});

	it('should say nothing about a store that reports no loss', async () => {
		// asked of the **document** rather than of the store, which is the whole
		// shape of it: a reprinting store writing a file with no comments in it
		// loses nothing, and refusing that write would be a guard firing on
		// correct code
		const store = reprinting(undefined);
		const config = await createConfig({ layers: [{ name: 'user', store }], env: {} });

		config.set('a', 2);
		expect(await config.save()).to.deep.equal(['user']);

		const empty = reprinting([]);
		const other = await createConfig({ layers: [{ name: 'user', store: empty }], env: {} });
		other.set('a', 2);
		expect(await other.save()).to.deep.equal(['user']);
	});

	it('should cap what it lists rather than printing five hundred of them', async () => {
		const store = reprinting(
			Array.from({ length: 12 }, (_, i) => ({ kind: 'comment', line: i + 1 }))
		);
		const config = await createConfig({ layers: [{ name: 'user', store }], env: {} });

		config.set('a', 2);
		await expect(config.save()).rejects.toThrow(/comment:10, \.\.\. would be lost/);
	});

	it('should report a loss on the layer it was read from', async () => {
		const store = reprinting([{ kind: 'comment', line: 4 }]);
		const config = await createConfig({ layers: [{ name: 'user', store }], env: {} });

		expect(config.layers[0]?.wouldLose).to.deep.equal([{ kind: 'comment', line: 4 }]);
	});
});

describe('writing a store directly', () => {
	it('should work with nothing having read it first', async () => {
		// public API, so it reads the current bytes itself rather than keeping them
		// from the last `read()`: a cache would splice at the wrong offsets the
		// moment the file moved under it
		const path = file('c.jsonc', '{\n\t// kept\n\t"a": 1\n}\n');
		const store = jsonc(path);

		await store.write({ a: 2 });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t// kept\n\t"a": 2\n}\n');

		store.writeSync({ a: 3 });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t// kept\n\t"a": 3\n}\n');
	});

	it('should edit against the bytes the file holds now rather than when it was read', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const store = jsonc(path);

		await store.read();
		writeFileSync(path, '{\n\t"a": 1,\n\t"b": 2\n}\n');
		await store.write({ a: 1, b: 3 });

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 1,\n\t"b": 3\n}\n');
	});

	it('should refuse a value JSON cannot hold, with the file untouched', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const store = jsonc(path);

		await expect(store.write({ a: Infinity })).rejects.toThrow(/Cannot write .*no Infinity/s);
		expect(() => store.writeSync({ a: Infinity })).toThrow(/Cannot write .*no Infinity/s);
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 1\n}\n');
	});

	it('should write a strict .json file the same way', async () => {
		const path = file('c.json', '{\n\t"a": 1\n}\n');
		const store = json(path);

		await store.write({ a: 2, b: 3 });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2,\n\t"b": 3\n}\n');
	});

	it('should report a comment in a strict .json file rather than writing past it', () => {
		const path = file('c.json', '{\n\t// not allowed here\n\t"a": 1\n}\n');
		expect(() => json(path).writeSync({ a: 2 })).toThrow(/Comments are not allowed/);
	});
});
