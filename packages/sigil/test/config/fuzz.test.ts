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

describe('the jsonc scan, differentially', () => {
	it('should answer what JSON.parse answers for the same document', () => {
		let checked = 0;
		let withComments = 0;
		let withTrailing = 0;

		for (let seed = 1; seed <= 400; seed++) {
			const rnd = seeded(seed * 2654435761);
			const v = value(rnd, 0);
			const text = jsoncify(v, rnd);
			const scan = scanJsonc(text, true, 'f');

			expect(scan.json, `seed ${seed}: length`).to.have.lengthOf(text.length);
			expect(scan.json.split('\n').length, `seed ${seed}: lines`).to.equal(text.split('\n').length);
			expect(JSON.parse(scan.json), `seed ${seed}: ${text}`).to.deep.equal(v);

			checked++;
			if (scan.comments.length > 0) withComments++;
			if (scan.trailingCommas) withTrailing++;
		}

		// a corpus that never met the thing it is checking is a green test about
		// nothing, which is the rule the composite fuzzer records
		expect(checked).to.equal(400);
		expect(withComments).to.be.greaterThan(200);
		expect(withTrailing).to.be.greaterThan(100);
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
