import { scanJsonc } from '../../src/config/jsonc.js';
import { describe, expect, it } from 'vitest';

/** xorshift32, the generator the layout fuzzer already uses. */
function seeded(seed: number): () => number {
	let s = seed || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x100000000;
	};
}

const COMMENTS = ['// c', '/* c */', '//', '/**/', '// } ] , "', '/* } ] , " */', '/*\n*/'];
const STRINGS = [
	'"a"',
	'"//"',
	'"/*"',
	'","',
	'"}"',
	'"]"',
	'"\\""',
	'"\\\\"',
	'"\\\\\\""',
	'"é"',
	'""',
];

function value(rnd: () => number, depth: number): unknown {
	const r = rnd();
	if (depth > 2 || r < 0.3) {
		// no `-0`: `JSON.stringify(-0)` is "0", so a round trip through this
		// generator loses the sign -- which is `JSON.stringify`'s business rather
		// than the scan's, and is covered by name in jsonc.test.ts
		const prims = [1, 1.5, 1e3, true, false, null, 'x', '', '//', '/*', ',', '}'];
		return prims[Math.floor(rnd() * prims.length)];
	}
	if (r < 0.65) {
		const n = Math.floor(rnd() * 4);
		return Array.from({ length: n }, () => value(rnd, depth + 1));
	}
	const n = Math.floor(rnd() * 4);
	const out: Record<string, unknown> = {};
	for (let i = 0; i < n; i++) {
		out[`k${i}${rnd() < 0.3 ? '//' : ''}`] = value(rnd, depth + 1);
	}
	return out;
}

/** Re-prints a value as JSONC, scattering comments and trailing commas. */
function jsoncify(v: unknown, rnd: () => number): string {
	const triv = () => (rnd() < 0.35 ? ` ${COMMENTS[Math.floor(rnd() * COMMENTS.length)]}\n` : ' ');

	if (Array.isArray(v)) {
		if (v.length === 0) {
			return `[${triv()}]`;
		}
		const items = v.map((item) => `${triv()}${jsoncify(item, rnd)}${triv()}`);
		return `[${items.join(',')}${rnd() < 0.5 ? `,${triv()}` : ''}]`;
	}
	if (v !== null && typeof v === 'object') {
		const keys = Object.keys(v as Record<string, unknown>);
		if (keys.length === 0) {
			return `{${triv()}}`;
		}
		const items = keys.map(
			(k) =>
				`${triv()}${JSON.stringify(k)}${triv()}:${triv()}${jsoncify(
					(v as Record<string, unknown>)[k],
					rnd
				)}${triv()}`
		);
		return `{${items.join(',')}${rnd() < 0.5 ? `,${triv()}` : ''}}`;
	}
	return JSON.stringify(v) ?? 'null';
}

/**
 * Whether a value holds a string the scanner must not act on, and how deep it
 * nests.
 *
 * Counted because the corpus met both all along and said so about neither: the
 * floors below were comments and trailing commas only, so dropping `','`,
 * `'}'`, `'//'` and `'/*'` from `prims` -- one line -- left a corpus that never
 * puts a comment marker inside a string, with both counters still passing and
 * the differential still green. Measured before they were added: 181 of 400
 * documents hold such a string and 170 nest, so the generator was sound and the
 * **test** could not say it. The rule the composite fuzzer records, met from the
 * other side: a counter is what distinguishes "no counterexample exists" from
 * "no example was generated".
 *
 * @param v - The generated value.
 * @returns What it holds, for the floors.
 */
function reach(v: unknown): { depth: number; tricky: boolean } {
	if (typeof v === 'string') {
		return { depth: 0, tricky: /\/\/|\/\*|[,}\]]/.test(v) };
	}
	if (v === null || typeof v !== 'object') {
		return { depth: 0, tricky: false };
	}

	const inner = Object.values(v as Record<string, unknown>).map(reach);
	return {
		depth: 1 + Math.max(0, ...inner.map((it) => it.depth)),
		tricky: inner.some((it) => it.tricky),
	};
}

describe('the jsonc scan, differentially', () => {
	it('should answer what JSON.parse answers for the same document', () => {
		let checked = 0;
		let withComments = 0;
		let withTrailing = 0;
		let withTrickyString = 0;
		let nested = 0;
		let withBlockNewline = 0;

		for (let seed = 1; seed <= 400; seed++) {
			const rnd = seeded(seed * 2654435761);
			const v = value(rnd, 0);
			const text = jsoncify(v, rnd);
			const scan = scanJsonc(text, true, 'f');

			expect(scan.json, `seed ${seed}: length`).to.have.lengthOf(text.length);
			expect(scan.json.split('\n').length, `seed ${seed}: lines`).to.equal(text.split('\n').length);
			expect(JSON.parse(scan.json), `seed ${seed}: ${text}`).to.deep.equal(v);

			const held = reach(v);

			checked++;
			if (scan.comments.length > 0) withComments++;
			if (scan.trailing.length > 0) withTrailing++;
			if (held.tricky) withTrickyString++;
			if (held.depth > 1) nested++;
			// the one that makes the line-count assertion above mean something: a
			// block comment holding a newline is the only shape where blanking has
			// to keep a line terminator it is deleting the rest of
			if (text.includes('/*\n')) withBlockNewline++;
		}

		// a corpus that never met the thing it is checking is a green test about
		// nothing, which is the rule the composite fuzzer records. Floors well
		// under what is measured -- 181, 170 and 132 of 400 -- so ordinary
		// generator churn never touches them and a narrowed `prims` or a shallower
		// depth cap does
		expect(checked).to.equal(400);
		expect(withComments).to.be.greaterThan(200);
		expect(withTrailing).to.be.greaterThan(100);
		expect(withTrickyString, 'strings holding a comment marker or a separator').to.be.greaterThan(
			100
		);
		expect(nested, 'documents that nest').to.be.greaterThan(100);
		expect(withBlockNewline, 'block comments holding a newline').to.be.greaterThan(50);
	});

	it('should keep every string literal shape intact', () => {
		for (const s of STRINGS) {
			const text = `{ "k": [${s}, ${s},] /* x */ }`;
			const scan = scanJsonc(text, true, 'f');
			expect(scan.json).to.have.lengthOf(text.length);
			expect(JSON.parse(scan.json), text).to.deep.equal({ k: [JSON.parse(s), JSON.parse(s)] });
		}
	});
});
