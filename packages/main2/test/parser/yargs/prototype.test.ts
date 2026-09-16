import { parse } from '../../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * Ported from yargs-parser's "prototype collisions" block.
 *
 * A destination such as `toString` — which `--to-string` produces — is an
 * inherited member of every plain object, so a naive `argv[dest] !== undefined`
 * check answers "defined" for an option nobody supplied. That silently
 * suppressed defaults, environment fallbacks and required-option checks until
 * these tests were ported; `resolved()` in parse.ts is the guard.
 */
describe('yargs: prototype collisions', () => {
	const colliding = [
		'toString',
		'valueOf',
		'constructor',
		'hasOwnProperty',
		'isPrototypeOf',
		'toLocaleString',
		'propertyIsEnumerable',
	];

	it.each(colliding)('should parse an undeclared --%s', async (name) => {
		const result = await parse({ argv: [`--${name}`] });
		expect(Object.hasOwn(result.argv, name)).to.equal(true);
		expect(result.argv[name]).to.equal(true);
	});

	it.each(colliding)('should parse a declared --%s flag', async (name) => {
		const result = await parse({ argv: [`--${name}`], schema: { options: { [name]: {} } } });
		expect(result.argv[name]).to.equal(true);
	});

	it.each(colliding)('should apply a default for --%s', async (name) => {
		const result = await parse({
			schema: { options: { [`--${name} [v]`]: { default: 'D' } } },
		});
		expect(result.argv[name]).to.equal('D');
	});

	it.each(colliding)('should apply an environment fallback for --%s', async (name) => {
		const result = await parse({
			env: { COLLIDE: 'fromEnv' },
			schema: { options: { [`--${name} [v]`]: { env: 'COLLIDE' } } },
		});
		expect(result.argv[name]).to.equal('fromEnv');
	});

	it.each(colliding)('should still require --%s when it is required', async (name) => {
		await expect(parse({ schema: { options: { [`--${name} <v>`]: {} } } })).rejects.toThrow(
			`Missing required options: --${name}`
		);
	});

	it('should apply a default for a colliding argument name', async () => {
		const result = await parse({ schema: { args: [{ name: '[to-string]', default: 'D' }] } });
		expect(result.argv.toString).to.equal('D');
	});

	it('should require a colliding argument name', async () => {
		await expect(parse({ schema: { args: ['<to-string>'] } })).rejects.toThrow(
			'Missing required arguments: <to-string>'
		);
	});

	it('should count a colliding destination from one', async () => {
		const result = await parse({
			argv: ['--to-string'],
			schema: { options: { '--to-string': { type: 'count' } } },
		});
		expect(result.argv.toString).to.equal(1);
	});

	it('should collect a colliding multiple option', async () => {
		const result = await parse({
			argv: ['--to-string', 'a', '--to-string', 'b'],
			schema: { options: { '--to-string <v>': { multiple: true } } },
		});
		expect(result.argv.toString).to.deep.equal(['a', 'b']);
	});

	it('should validate choices for a colliding destination', async () => {
		await expect(
			parse({
				argv: ['--to-string', 'xl'],
				schema: { options: { '--to-string <v>': { choices: ['sm'] } } },
			})
		).rejects.toThrow('Invalid value "xl" for option --to-string');
	});

	it('should not let __proto__ reach the prototype of argv', async () => {
		const result = await parse({ argv: ['--__proto__={"polluted":true}'] });
		expect(Object.getPrototypeOf(result.argv)).to.equal(Object.prototype);
		expect((result.argv as Record<string, unknown>).polluted).to.equal(undefined);
		expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
	});

	it('should not let a declared __proto__ option reach the prototype of argv', async () => {
		const result = await parse({
			argv: ['--__proto__', '{"polluted":true}'],
			schema: { options: { '--__proto__ [v]': { type: 'json' } } },
		});
		expect(Object.getPrototypeOf(result.argv)).to.equal(Object.prototype);
		expect((result.argv as Record<string, unknown>).polluted).to.equal(undefined);
	});
});
