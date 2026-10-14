import { writeAtomic, writeAtomicSync } from '../../src/config/atomic.js';
import {
	createConfig,
	createConfigSync,
	json,
	object,
	type ConfigDocument,
	type ConfigStore,
	type WritableConfigStore,
	type WriteOptions,
} from '../../src/config/index.js';
import { editJsonc } from '../../src/config/jsonc-write.js';
import { scanJsonc } from '../../src/config/jsonc.js';
import { jsonCanHold } from '../../src/config/represent.js';
import { applyEdits, lineAt } from '../../src/config/spans.js';
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
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
	return editJsonc(source, next, { what: 'c.jsonc' });
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
	it('should count a line at every terminator, not at a newline alone', () => {
		// `LINE_END`'s own rule, met by the one function here that was not keeping
		// it: a `\r`-only file reported every diagnostic "on line 1", so a comment
		// the scanner correctly ended at a `\r` was named at a line it is not on.
		// Found by review
		expect(lineAt('a\rb\rc', 4)).to.equal(3);
		expect(lineAt('a\u2028b', 2)).to.equal(2);
		expect(lineAt('a\u2029b', 2)).to.equal(2);
		// a CRLF is one break rather than two
		expect(lineAt('a\r\nb', 3)).to.equal(2);
		expect(lineAt('a\nb', 2)).to.equal(2);
		// and the scan really does report a comment on that line, which is the claim
		// -- the vehicle used to be the strict reader's own message, and with one
		// forgiving reader the comment's recorded line is what carries it
		expect(scanJsonc('{\r// a note\r"a":1}', 'f').comments).to.deep.equal([
			{ line: 2, text: '// a note' },
		]);
	});

	it('should refuse an inverted span, which is the other half of its one rule', () => {
		// it threw for overlap and corrupted for this: `end` before `start` leaves the
		// cursor behind where the slice ended, so the text is duplicated rather than
		// replaced. A tripwire like its sibling -- no emitter here produces one
		expect(() => applyEdits('abc', [{ end: 1, start: 2, text: 'X' }])).toThrow(
			/Inverted config edit: \[2, 1\)/
		);
		// the shape it used to produce, so the refusal is pinned against what was
		// wrong rather than against the message alone
		expect(applyEdits('abc', [{ end: 2, start: 1, text: 'X' }])).to.equal('aXc');
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

	it('should keep a comment on the line of the comma it reuses', () => {
		// the comma is already there, so the insert goes past it **and** past the
		// comment after it -- where anchoring at the value put the new key in front
		// of the comment, which then read as a comment about the new key. The
		// trailing comma style survives by being written rather than by being left
		// where it was, because the anchor is past it now. Found by review
		expect(edit('{\n\t"a": 1, // comment on a\n}', { a: 1, b: 2 })).to.equal(
			'{\n\t"a": 1, // comment on a\n\t"b": 2,\n}'
		);
	});

	it('should keep a comment on that line where the comma goes with the tail', () => {
		// the same anchor, with the comma `cut` on its own rather than reused: the
		// comment is what made the gap unswallowable, so it is still there to go
		// past, and the separator is written back at the value
		expect(edit('{\n\t"a": 1, // comment on a\n\t"b": 2\n}', { a: 1, c: 3 })).to.equal(
			'{\n\t"a": 1, // comment on a\n\t"c": 3\n}'
		);
	});

	it('should not anchor past a comma a removal swallowed with its line', () => {
		// the other half of the pair: with no comment in the gap the comma is
		// `eaten` into the removal range, so anchoring past it would splice inside
		// that range -- which is an overlapping edit rather than a wrong byte
		expect(edit('{\n\t"a": 1,\n\t"b": 2\n}', { a: 1, c: 3 })).to.equal('{\n\t"a": 1,\n\t"c": 3\n}');
	});

	it('should not leave a comma alone on the line of a removal', () => {
		// the trailing comma the survivor above has no use for: left where it was it
		// sat on an indented line of its own. Found by review
		expect(edit('{\n\t"a": 1, // keep a\n\t"b": 2,\n}', { a: 1 })).to.equal(
			'{\n\t"a": 1 // keep a\n}'
		);
	});

	it('should take a dropped tail off as one run rather than one entry at a time', () => {
		// per entry, the first of the two ended just before the comma the second was
		// taking, so the line removal saw a comma rather than a line end and left an
		// indented blank line behind. Found by review
		expect(edit('{\n\t"a": 1, // keep a\n\t"b": 2,\n\t"c": 3\n}', { a: 1 })).to.equal(
			'{\n\t"a": 1 // keep a\n}'
		);
	});

	it('should not glue a comment onto the value a removal left in front of it', () => {
		// the space was the only thing keeping them apart, and swallowing it as the
		// run's own trailing whitespace made `1// on b` out of `1,\n\t"b": 2 // on b`.
		// The comment survives onto the line above, which is the residue rather than
		// the defect: preservation is the bias, and what is lost is that it now
		// reads as `a`'s. Found by review
		expect(edit('{\n\t"a": 1,\n\t"b": 2 // comment on b\n}', { a: 1 })).to.equal(
			'{\n\t"a": 1 // comment on b\n}'
		);
	});

	it('should keep every one of those parseable, which is the claim under them', () => {
		// each of the six above as JSON once the comments are blanked, because a
		// comment in the right place and a dangling comma are two different failures
		// and the pictures above only see the first
		const cases: Array<[string, unknown]> = [
			['{\n\t"a": 1, // comment on a\n}', { a: 1, b: 2 }],
			['{\n\t"a": 1, // comment on a\n\t"b": 2\n}', { a: 1, c: 3 }],
			['{\n\t"a": 1,\n\t"b": 2\n}', { a: 1, c: 3 }],
			['{\n\t"a": 1, // keep a\n\t"b": 2,\n}', { a: 1 }],
			['{\n\t"a": 1, // keep a\n\t"b": 2,\n\t"c": 3\n}', { a: 1 }],
			['{\n\t"a": 1,\n\t"b": 2 // comment on b\n}', { a: 1 }],
		];

		for (const [source, next] of cases) {
			const out = edit(source, next);
			expect(JSON.parse(scanJsonc(out, 'f').json), out).to.deep.equal(next);
		}
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
		expect(edit('{\n}', { b: 2 })).to.equal('{\n  "b": 2\n}');
		// the one place the default is **visible** next to the user's own bytes: a
		// container with no entries has nothing to copy a step from, so the new one
		// gets `DEFAULT_STEP` while the comment keeps the tab it was written with.
		// Mixed, and honest about which half is whose -- `detectStep()` reads
		// entries rather than trivia, and reading an indent off a comment would be
		// a new rule for the one shape that is a comment and nothing else
		expect(edit('{\n\t// todo\n}', { b: 2 })).to.equal('{\n\t// todo\n  "b": 2\n}');
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

	it('should keep the container padding a removal did not own', () => {
		// the space before the closing brace belongs to the container rather than to
		// the entry, so it survives whichever entry goes
		expect(edit('{ "a":1, "b":2, "c":3 }', { a: 1 })).to.equal('{ "a":1 }');
		expect(edit('{ "a":1, "b":2, "c":3 }', { c: 3 })).to.equal('{ "c":3 }');
	});

	it('should take a trailing comma when it empties the container', () => {
		// a trailing comma is blanked by the scan, so a forward walk over the blanked
		// text steps straight over it -- and the entry it followed is then removed
		// with the comma left behind. Every one of these came out with a dangling
		// comma before the scan reported where they are: `{ , }`, `{\n\t,\n}`, `[,]`.
		// Found by review
		expect(edit('{ "a": 1, }', {})).to.equal('{  }');
		expect(edit('{\n\t"a": 1,\n}', {})).to.equal('{\n}');
		expect(edit('{ "a": 1, "b": 2, }', {})).to.equal('{  }');
		expect(edit('[1, 2,]', [])).to.equal('[]');
		expect(edit('{\n\t"a": [1,]\n}', { a: [] })).to.equal('{\n\t"a": []\n}');
		expect(edit('{ "a": { "b": 1, } }', { a: {} })).to.equal('{ "a": {  } }');
	});

	it('should take a trailing comma and keep the comment in front of it', () => {
		// the comment is what makes the gap unswallowable, so the comma is removed on
		// its own -- which is the same rule a separator comma follows, reached through
		// the offsets rather than through the blanked text
		const out = edit('{ "a": 1 /* c */, }', {});
		expect(out).to.equal('{ /* c */ }');
		// and it is JSON once the comment is blanked, which is the claim that matters
		expect(JSON.parse(scanJsonc(out, 'f').json)).to.deep.equal({});
	});

	it('should leave a trailing comma trailing where something still follows it', () => {
		// it is the user's style rather than something to tidy away: what was the
		// trailing comma is still the trailing comma, with a different entry in front
		expect(edit('{\n\t"a": 1,\n\t"b": 2,\n}', { b: 2 })).to.equal('{\n\t"b": 2,\n}');
		expect(edit('[1, 2,]', [2])).to.equal('[2,]');
	});

	it('should lose a trailing comma where the only entry it followed is replaced', () => {
		// the one shape that does not keep it, and it was the second half of the test
		// above -- which claims the comma is kept and showed a case where it is not.
		// The comma followed `a`, `a` is gone, and the insertion is placed before it
		// rather than after: valid either way, and the user's style is not recovered
		// because there is no entry left for the comma to be trailing. Found by
		// review, as a name claiming more than its fixture showed
		expect(edit('{ "a": 1, }', { b: 2 })).to.equal('{ "b": 2  }');
		expect(JSON.parse(scanJsonc(edit('{ "a": 1, }', { b: 2 }), 'f').json)).to.deep.equal({
			b: 2,
		});
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

	it('should fall back to two spaces where there is nothing to read it off', () => {
		// what `npm init` writes and what every JSON file in this repository uses.
		// It was a tab, on the claim that npm writes one -- measured, `npm init -y`
		// indents with two spaces, so half the justification was simply false and
		// the other half was about how this package formats its own TypeScript
		expect(edit('{"a": 1}', { a: 1, b: { c: 2 } })).to.equal('{"a": 1, "b": {\n  "c": 2\n}}');
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
	it('should insert with the line ending the document uses, including a lone CR', () => {
		// a `\r`-only document got a `\n` spliced into it, which is a mixed ending
		// and is **silent** -- the combination `LINE_END` exists for, missing from
		// the one place that writes a line rather than reads one. Found by review
		expect(edit('{\r\t"a": 1\r}', { a: 1, b: 2 })).to.equal('{\r\t"a": 1,\r\t"b": 2\r}');
		expect(edit('{\r\n\t"a": 1\r\n}', { a: 1, b: 2 })).to.equal('{\r\n\t"a": 1,\r\n\t"b": 2\r\n}');
		expect(edit('{\n\t"a": 1\n}', { a: 1, b: 2 })).to.equal('{\n\t"a": 1,\n\t"b": 2\n}');
		// CRLF wins over the lone CR inside it, which is what makes the order the
		// rule rather than a coincidence of the test
		expect(edit('{\r\n\t"a": 1\r\n}', { a: 1, b: 2 })).to.not.include('\r\t');
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
		const store = json(join(root, 'c.jsonc'));
		expect(store.canRepresent?.(Infinity, 'a.b')).to.match(/no Infinity/);
		expect(store.canRepresent?.(1, 'a.b')).to.equal(true);
	});

	it('should refuse the value at the call that wrote it', () => {
		const config = createConfigSync({
			layers: [{ name: 'user', store: json(join(root, 'c.jsonc')) }],
			env: {},
		});

		expect(() => config.set('a', Number.NaN)).toThrow(/cannot hold the value at "a".*no NaN/s);
	});
	it('should refuse a hole in an array, which JSON writes as null', () => {
		// an array method skips a hole, so the walk reached one through `map()` and
		// destructured `undefined` -- a `TypeError` out of the one function whose job
		// is to name what cannot be written. `JSON.stringify` writes it as `null`,
		// which is the silent rewrite `NaN` is refused for. Found by review
		// eslint-disable-next-line no-sparse-arrays
		const sparse = [1, , 2] as unknown[];

		expect(jsonCanHold(sparse, '')).to.match(/hole in an array.*"1"/);
		expect(jsonCanHold({ a: sparse }, 'x')).to.match(/hole in an array.*"x\.a\.1"/);
		// and the thing it is refused for, so the refusal is pinned against what
		// JSON really does rather than against a sentence
		expect(JSON.stringify(sparse)).to.equal('[1,null,2]');
		// a dense array of the same length is fine, which is what says the refusal
		// is about the hole rather than about arrays
		expect(jsonCanHold([1, 2, 3], '')).to.equal(true);
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

	// POSIX permission bits, so not on Windows: `chmod` there only toggles the
	// read-only flag, so `chmodSync(path, 0o600)` leaves the file at 0o666 and
	// every row but that one compares the mode against something the platform
	// cannot hold. Skipped rather than loosened, because what these pin is that
	// a 600 config does not come back 644 -- which is a POSIX claim about a POSIX
	// mode. Found by review, as three Windows CI jobs
	it.skipIf(process.platform === 'win32').each([0o600, 0o640, 0o660, 0o666])(
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

	it.skipIf(process.platform === 'win32')(
		'should not carry the setuid, setgid or sticky bits over',
		() => {
			// re-creating one on a file this just wrote is a privilege decision a
			// config writer has no business making, so the permission bits are copied
			// exactly and these are not
			const path = file('c.jsonc', '{}');
			chmodSync(path, 0o1600);
			expect(statSync(path).mode & 0o7777).to.equal(0o1600);

			writeAtomicSync(path, 'a');
			expect(statSync(path).mode & 0o7777).to.equal(0o600);
		}
	);

	it('should write through a symlink rather than replacing it', async () => {
		// `rename()` replaces whatever is **at** the path, so a config that is a
		// symlink -- which is what every dotfile manager makes of one -- was replaced
		// by a plain file on the first save that changed anything: the link stopped
		// being a link, its location held the new contents, and the real file kept
		// the old ones, so every later edit went to a local copy nobody tracked.
		// Nothing reported it, because every other check reads *through* the link.
		// Found by review
		const target = file('real.jsonc', '{\n\t// keep me\n\t"a": 1\n}\n');
		const link = join(root, 'link.jsonc');
		symlinkSync(target, link);

		writeAtomicSync(link, '{\n\t// keep me\n\t"a": 2\n}\n');
		expect(lstatSync(link).isSymbolicLink(), 'sync kept the link').to.equal(true);
		expect(readFileSync(target, 'utf8')).to.contain('"a": 2');

		await writeAtomic(link, '{\n\t// keep me\n\t"a": 3\n}\n');
		expect(lstatSync(link).isSymbolicLink(), 'async kept the link').to.equal(true);
		expect(readFileSync(target, 'utf8')).to.contain('"a": 3');

		// and the comment the file was read for is still there, which is the whole
		// of what writing through it is worth
		expect(readFileSync(target, 'utf8')).to.contain('// keep me');
	});

	it('should write through a dangling symlink rather than replacing it', async () => {
		// `realpathSync()` refuses a chain that ends at nothing **whole** rather
		// than resolving as far as it can, so a link pointing at a file that does
		// not exist yet answers `ENOENT` exactly as a path with nothing at it does
		// -- and reading that as "a new file" wrote the plain file at the link's own
		// location after all. Which is the defect the test above is for, for the one
		// state a dotfile manager leaves behind before its target has been created,
		// and invisible to that test. Found by a second review round
		const target = join(root, 'dotfiles', 'real.jsonc');
		const link = join(root, 'link.jsonc');
		symlinkSync(target, link);

		writeAtomicSync(link, '{"a":1}\n');
		expect(lstatSync(link).isSymbolicLink(), 'sync kept the link').to.equal(true);
		// the directory the target names is created too, which is what a managed
		// file whose repository has not been laid out yet needs
		expect(readFileSync(target, 'utf8')).to.equal('{"a":1}\n');

		await writeAtomic(link, '{"a":2}\n');
		expect(lstatSync(link).isSymbolicLink(), 'async kept the link').to.equal(true);
		expect(readFileSync(target, 'utf8')).to.equal('{"a":2}\n');
	});

	it('should resolve a relative link target against the link, not the cwd', () => {
		// `readlinkSync()` hands back whatever was stored, and
		// `ln -s ../dotfiles/sigil.json config.json` is the ordinary spelling -- so
		// a cwd-relative resolve is wrong for every relative link there is, and
		// writes into whatever directory the process happened to start in
		mkdirSync(join(root, 'cfg'));
		mkdirSync(join(root, 'dots'));
		const link = join(root, 'cfg', 'c.jsonc');
		symlinkSync('../dots/real.jsonc', link);

		writeAtomicSync(link, '{"a":1}\n');
		expect(lstatSync(link).isSymbolicLink()).to.equal(true);
		expect(readFileSync(join(root, 'dots', 'real.jsonc'), 'utf8')).to.equal('{"a":1}\n');
		expect(existsSync(join(process.cwd(), 'dots')), 'nothing landed in the cwd').to.equal(false);
	});

	it('should follow a chain of dangling links to its end', () => {
		// `a -> b -> c` with nothing at `c` is one `ENOENT` for the whole of it, so
		// the end of the chain is the file to create and every link on the way is
		// left a link
		symlinkSync(join(root, 'b.jsonc'), join(root, 'a.jsonc'));
		symlinkSync(join(root, 'c.jsonc'), join(root, 'b.jsonc'));

		writeAtomicSync(join(root, 'a.jsonc'), '{"a":1}\n');
		expect(lstatSync(join(root, 'a.jsonc')).isSymbolicLink()).to.equal(true);
		expect(lstatSync(join(root, 'b.jsonc')).isSymbolicLink()).to.equal(true);
		expect(readFileSync(join(root, 'c.jsonc'), 'utf8')).to.equal('{"a":1}\n');
	});

	it('should refuse a cycle rather than walking it', () => {
		// which the file system answers before the walk is reached: `realpathSync()`
		// reports `ELOOP` for a cycle and for any chain of 31 or more links, so the
		// walk's input is a chain of at most thirty hops. Pinned so that following
		// the links by hand cannot come to swallow the one state that must not be
		// written to
		symlinkSync(join(root, 'b.jsonc'), join(root, 'a.jsonc'));
		symlinkSync(join(root, 'a.jsonc'), join(root, 'b.jsonc'));

		expect(() => writeAtomicSync(join(root, 'a.jsonc'), 'x')).toThrow(/ELOOP/);
		expect(readdirSync(root).sort()).to.deep.equal(['a.jsonc', 'b.jsonc']);
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
			layers: [{ name: 'user', store: json(path) }],
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
		const config = createConfigSync({ layers: [{ name: 'user', store: json(path) }], env: {} });

		config.set('a', 2);
		expect(config.saveSync()).to.deep.equal(['user']);
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2\n}\n');
	});

	it('should write a file that is not there yet', () => {
		const path = join(root, 'deep', 'c.jsonc');
		const config = createConfigSync({ layers: [{ name: 'user', store: json(path) }], env: {} });

		config.set('a', 1);
		config.saveSync();
		expect(readFileSync(path, 'utf8')).to.equal('{\n  "a": 1\n}\n');
	});

	it('should skip a layer nothing touched', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const before = statSync(path).mtimeMs;
		const config = await createConfig({ layers: [{ name: 'user', store: json(path) }], env: {} });

		expect(await config.save()).to.deep.equal([]);
		expect(await config.save('user')).to.deep.equal([]);
		expect(statSync(path).mtimeMs).to.equal(before);
	});

	it('should touch no file where the text comes out the same', async () => {
		// which keeps the mtime a watcher is reading, and is what makes `apply()`
		// of a freshly read value a no-op rather than a rewrite of the same bytes
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = await createConfig({ layers: [{ name: 'user', store: json(path) }], env: {} });
		const before = statSync(path).mtimeMs;

		config.set('a', 1);
		config.apply('user', { a: 1 });
		expect(await config.save()).to.deep.equal(['user']);
		expect(statSync(path).mtimeMs).to.equal(before);
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 1\n}\n');
	});

	it('should report whether a layer has changes it has not written', async () => {
		const config = await createConfig({
			layers: [{ name: 'user', store: json(join(root, 'c.jsonc')) }],
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
			layers: [{ name: 'user', store: json(join(root, 'c.jsonc')) }],
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
		const config = await createConfig({ layers: [{ name: 'user', store: json(path) }], env: {} });

		config.set('a', 2);
		writeFileSync(path, '{\n\t"a": 1,\n\t"b": 9\n}\n');
		await config.save();

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2,\n\t"b": 9\n}\n');
		// and the layer holds what the file holds afterwards, which is the file
		// being right about itself
		expect(config.get('b')).to.equal(9);
	});

	it('should keep another process key written inside the save window', async () => {
		// the half the test above cannot see: that one writes before `save()`, so the
		// re-read already holds `b`. This writes *between* the read `save()` stages
		// against and the read the store writes against, which is the only window
		// there is -- and a store handed a whole document diffs the whole of it, so
		// `b` was removed. Found by review
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const store = json(path);
		let reads = 0;
		const config = await createConfig({
			layers: [
				{
					name: 'user',
					store: {
						...store,
						async read() {
							const doc = await store.read();
							// the **second** read, which is `save()`'s: `createConfig()` reads
							// once at construction, so firing on the first put the concurrent
							// write before the read the merge stages against -- which is the
							// case the test above already covers, and is why this one passed
							// with the claim removed
							if (reads++ === 1) {
								writeFileSync(path, '{\n\t"a": 1,\n\t"b": 9\n}\n');
							}
							return doc;
						},
					},
				},
			],
			env: {},
		});

		config.set('a', 2);
		await config.save();

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2,\n\t"b": 9\n}\n');
	});

	it('should not revert a key it never touched', async () => {
		// the sharper half, and the one that makes the window a defect rather than a
		// narrowing: a full diff writes back what *it* read for every key, so another
		// process's change to a key this process never set is undone
		const path = file('c.jsonc', '{\n\t"a": 1,\n\t"b": 1\n}\n');
		const store = json(path);
		let reads = 0;
		const config = await createConfig({
			layers: [
				{
					name: 'user',
					store: {
						...store,
						async read() {
							const doc = await store.read();
							// the **second** read, which is `save()`'s: `createConfig()` reads
							// once at construction, so firing on the first put the concurrent
							// write before the read the merge stages against -- which is the
							// case the test above already covers, and is why this one passed
							// with the claim removed
							if (reads++ === 1) {
								writeFileSync(path, '{\n\t"a": 5,\n\t"b": 1\n}\n');
							}
							return doc;
						},
					},
				},
			],
			env: {},
		});

		config.set('b', 2);
		await config.save();

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 5,\n\t"b": 2\n}\n');
	});

	it('should leave the layer as stale about another key as the read it staged from', async () => {
		// the trade the claim buys, said as the thing a caller can see: the layer is
		// read #1 plus this process's changes and the file is read #2 plus them, so
		// `get()` answers 1 over a file that says 99. The agreement it gives up was
		// bought by *reverting* that key, which is the defect the claim fixes -- and
		// the doc claimed the opposite until this was measured
		const path = file('c.jsonc', '{"a":1,"b":1}');
		const store = json(path);
		let reads = 0;
		const config = await createConfig({
			layers: [
				{
					name: 'user',
					store: {
						...store,
						async read() {
							const doc = await store.read();
							if (reads++ === 1) {
								writeFileSync(path, '{"a":1,"b":99}');
							}
							return doc;
						},
					},
				},
			],
			env: {},
		});

		config.set('a', 2);
		await config.save();

		expect(readFileSync(path, 'utf8')).to.equal('{"a":2,"b":99}');
		expect(config.get('b')).to.equal(1);
	});

	it('should refuse a claim whose ancestor another process reshaped', async () => {
		// `set('a.b', 9)` is refused where this layer's own `a` is a scalar, and the
		// overlay **replaced** one -- so the same input answered differently through
		// a different door, and for an array that is three elements gone. A review
		// round found it in the direct-write form, which has no concurrency in it at
		// all; this is the save-window form of the same thing.
		//
		// Refused rather than replaced: nothing is written, the message names the
		// path that changed shape, and a re-run reads the new shape and refuses at
		// `set()` with the same words. Replacing destroys a structure nobody claimed
		// and dropping the claim loses this process's write in silence
		const path = file('c.jsonc', '{\n\t"a": { "b": 1 }\n}\n');
		const store = json(path);
		let reads = 0;
		const config = await createConfig({
			layers: [
				{
					name: 'user',
					store: {
						...store,
						async read() {
							const doc = await store.read();
							if (reads++ === 1) {
								writeFileSync(path, '{\n\t"a": [1, 2, 3]\n}\n');
							}
							return doc;
						},
					},
				},
			],
			env: {},
		});

		config.set('a.b', 9);
		await expect(config.save()).rejects.toThrow(/"a" in .*c\.jsonc is not an object/);
		// and the file is what the other process left, rather than half of either
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": [1, 2, 3]\n}\n');

		// the `set()` half, which is the same refusal at the door the caller is at
		expect(() => config.set('a.b.c', 1)).toThrow(/"a\.b" in user is not an object/);
	});

	it('should claim its paths from saveSync() too, which is a second write path', () => {
		// two real implementations of one loop, so the claim has to be passed in both
		// -- and `writeSync()` dropping it survived every test here, because nothing
		// drove the window synchronously
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const store = json(path);
		let reads = 0;
		const config = createConfigSync({
			layers: [
				{
					name: 'user',
					store: {
						...store,
						readSync() {
							const doc = store.readSync();
							if (reads++ === 1) {
								writeFileSync(path, '{\n\t"a": 1,\n\t"b": 9\n}\n');
							}
							return doc;
						},
					},
				},
			],
			env: {},
		});

		config.set('a', 2);
		config.saveSync();

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2,\n\t"b": 9\n}\n');
	});

	it('should let the last writer win on one key, which is documented rather than guarded', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const config = await createConfig({ layers: [{ name: 'user', store: json(path) }], env: {} });

		config.set('a', 2);
		writeFileSync(path, '{\n\t"a": 3\n}\n');
		await config.save();

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2\n}\n');
	});

	it('should persist a delete as a removal', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1,\n\t"b": 2\n}\n');
		const config = await createConfig({ layers: [{ name: 'user', store: json(path) }], env: {} });

		expect(config.delete('a')).to.equal(true);
		await config.save();
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"b": 2\n}\n');
	});

	it('should persist a push into a list', async () => {
		const path = file('c.jsonc', '{\n\t"plugins": ["a"]\n}\n');
		const config = await createConfig({
			layers: [{ name: 'user', store: json(path) }],
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
			layers: [{ name: 'user', store: json(path) }],
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
		const config = await createConfig({ layers: [{ name: 'user', store: json(path) }], env: {} });

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
			layers: [{ name: 'user', store: json(path) }],
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
		const config = await createConfig({ layers: [{ name: 'user', store: json(path) }], env: {} });

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
				{ name: 'low', store: json(low) },
				{ name: 'high', store: json(high) },
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
				{ name: 'low', store: json(low) },
				{ name: 'high', store: json(high) },
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
				{ name: 'system', readOnly: true, store: json(path) },
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
			layers: [{ name: 'user', store: json(path) }],
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
	it('should take only the paths it was given, leaving every other key alone', async () => {
		// `WriteOptions.paths` is published, so a caller reaching a store directly
		// gets the same three-way merge `save()` does -- and a write with no claim is
		// total, which is the only thing `write(value)` can mean on its own
		const path = file('c.jsonc', '{\n\t// kept\n\t"a": 1,\n\t"b": 2\n}\n');
		const store = json(path);

		await store.write({ a: 9 }, { paths: ['a'] });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t// kept\n\t"a": 9,\n\t"b": 2\n}\n');

		store.writeSync({ a: 9 }, { paths: ['b'] });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t// kept\n\t"a": 9\n}\n');

		await store.write({ a: 1 });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t// kept\n\t"a": 1\n}\n');
	});

	it('should refuse a claim over an ancestor that is there and is not an object', async () => {
		// no concurrency in this one at all, which is what makes it the sharper form:
		// one call, one file, and the same input `set('items.0', 9)` is refused for.
		// `writePath()` replaces a non-object on the way down, so the array was gone
		// and `{ "0": 9 }` was in its place. Found by review
		const path = file('c.jsonc', '{ "items": [1, 2, 3] }\n');
		const store = json(path);

		expect(() => store.writeSync({ items: { 0: 9 } }, { paths: ['items.0'] })).toThrow(
			/"items" in .*c\.jsonc is not an object/
		);
		expect(readFileSync(path, 'utf8')).to.equal('{ "items": [1, 2, 3] }\n');

		// a scalar is the same answer, because what is wrong is the shape rather than
		// how much it holds
		const flat = file('d.jsonc', '{ "a": 5 }\n');
		await expect(json(flat).write({ a: { b: 2 } }, { paths: ['a.b'] })).rejects.toThrow(
			/"a" in .*d\.jsonc is not an object/
		);

		// and a *total* write is untouched by it: with no claim the document replaces
		// the file, which is the only thing `write(value)` can mean
		await json(path).write({ items: { 0: 9 } });
		expect(JSON.parse(readFileSync(path, 'utf8')) as unknown).to.deep.equal({ items: { 0: 9 } });
	});

	it('should leave an array alone for a claimed delete, where a claimed set throws', async () => {
		// the asymmetry, and it is the right way round: a delete has nothing to
		// destroy, so `deletePath()` answers `false` and the file keeps what it had,
		// where a set in the same place would have to replace the ancestor to
		// proceed. Which is one rule -- a dotted path addresses object keys -- said
		// in the two directions rather than two answers to one question. Found by
		// review, which offered throwing as the other option
		const path = file('c.jsonc', '{ "items": [1, 2, 3] }\n');

		await json(path).write({}, { paths: ['items.0'] });
		expect(readFileSync(path, 'utf8')).to.equal('{ "items": [1, 2, 3] }\n');

		// and the set in the same place is the throw, which is what makes this a
		// pair rather than a gap
		expect(() => json(path).writeSync({ items: { 0: 9 } }, { paths: ['items.0'] })).toThrow(
			/is not an object/
		);
	});

	it('should create an ancestor the file is silent about, including a null one', async () => {
		// the two cases the refusal must not take with it -- a claim on a key the
		// file says nothing about is the ordinary case, and `null` reaches the
		// overlay as absent because that is what `null` means everywhere here
		const absent = file('c.jsonc', '{ "x": 1 }\n');
		await json(absent).write({ a: { b: 2 } }, { paths: ['a.b'] });
		expect(JSON.parse(readFileSync(absent, 'utf8')) as unknown).to.deep.equal({
			a: { b: 2 },
			x: 1,
		});

		const nulled = file('d.jsonc', '{ "a": null }\n');
		await json(nulled).write({ a: { b: 2 } }, { paths: ['a.b'] });
		expect(JSON.parse(readFileSync(nulled, 'utf8')) as unknown).to.deep.equal({ a: { b: 2 } });
	});

	it('should claim nothing for an empty path, which is no path into a document', async () => {
		// `segments('')` is no segments, which is the whole document rather than a
		// path into it -- and `#staged` really does hand `''` over, since `apply()`
		// puts it in `touched`. What stops that reaching a write is `#staged`
		// claiming no paths at all
		const path = file('c.jsonc', '{ "a": 1 }\n');
		await json(path).write({ a: 9 }, { paths: [''] });
		expect(readFileSync(path, 'utf8')).to.equal('{ "a": 1 }\n');
	});

	it('should claim a nested path over an object parent, which is the happy case', async () => {
		// every other claim test here is top level, so the ordinary nested one was
		// unasserted -- and it is what the refusal above has to leave working
		const path = file('c.jsonc', '{\n\t// kept\n\t"a": { "b": 1, "c": 2 },\n\t"d": 3\n}\n');
		await json(path).write({ a: { b: 9 } }, { paths: ['a.b'] });

		expect(readFileSync(path, 'utf8')).to.equal(
			'{\n\t// kept\n\t"a": { "b": 9, "c": 2 },\n\t"d": 3\n}\n'
		);
	});

	it('should overlay a claim onto nothing where the file is not there', async () => {
		// the `fresh` branch with a claim, which falls out of overlaying onto an
		// empty document rather than needing a case of its own: what the file holds
		// is nothing, so what it ends up holding is the claim and nothing else
		const path = join(root, 'new.jsonc');
		await json(path).write({ a: 1, b: 2 }, { paths: ['a'] });

		expect(readFileSync(path, 'utf8')).to.equal('{\n  "a": 1\n}\n');
	});

	it('should ask what JSON can hold of the merged document rather than of the value', async () => {
		// a part of `value` this write is not claiming is a part it never writes, so
		// refusing over it would be a guard firing on correct code. Reachable only
		// from a direct `write()`, because `set()` checks each value on the way in
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const store = json(path);

		await store.write({ a: 2, b: Number.NaN }, { paths: ['a'] });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 2\n}\n');

		// and the claimed path is still checked, which is what says the narrowing is
		// about what is written rather than about checking less
		await expect(store.write({ a: Number.NaN }, { paths: ['a'] })).rejects.toThrow(
			/JSON has no NaN/
		);
	});

	it('should work with nothing having read it first', async () => {
		// public API, so it reads the current bytes itself rather than keeping them
		// from the last `read()` -- which is what makes the read the merge is against
		// the same read the edit is computed from
		const path = file('c.jsonc', '{\n\t// kept\n\t"a": 1\n}\n');
		const store = json(path);

		await store.write({ a: 2 });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t// kept\n\t"a": 2\n}\n');

		store.writeSync({ a: 3 });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t// kept\n\t"a": 3\n}\n');
	});

	it('should edit against the bytes the file holds now rather than when it was read', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const store = json(path);

		await store.read();
		writeFileSync(path, '{\n\t"a": 1,\n\t"b": 2\n}\n');
		await store.write({ a: 1, b: 3 });

		expect(readFileSync(path, 'utf8')).to.equal('{\n\t"a": 1,\n\t"b": 3\n}\n');
	});

	it('should refuse a value JSON cannot hold, with the file untouched', async () => {
		const path = file('c.jsonc', '{\n\t"a": 1\n}\n');
		const store = json(path);

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

	it('should keep a comment in a .json through a write, not refuse it', () => {
		// the reversal: one reader for both extensions, so a `.json` is edited by
		// spans exactly as a `.jsonc` is and its comments survive the write. What
		// this replaces asserted the refusal that used to be here
		const path = file('c.json', '{\n\t// keep me\n\t"a": 1\n}\n');
		json(path).writeSync({ a: 2 });
		expect(readFileSync(path, 'utf8')).to.equal('{\n\t// keep me\n\t"a": 2\n}\n');
	});
});
