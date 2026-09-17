import { parse } from '../../src/parser/parse.js';
import { ErrorState, type ParseState } from '../../src/types.js';
import { describe, it, expect } from 'vitest';

describe('error handling', () => {
	it('should error if parse options are invalid', async () => {
		await expect(parse('' as any)).rejects.toThrow(
			new TypeError('Expected parse options to be an object')
		);

		await expect(parse('foo' as any)).rejects.toThrow(
			new TypeError('Expected parse options to be an object')
		);

		await expect(parse(null as any)).rejects.toThrow(
			new TypeError('Expected parse options to be an object')
		);

		await expect(parse(123 as any)).rejects.toThrow(
			new TypeError('Expected parse options to be an object')
		);
	});

	it('should error if schema is invalid', async () => {
		await expect(parse({ schema: '' as any })).rejects.toThrow(
			new TypeError('Expected schema to be an object')
		);

		await expect(parse({ schema: 'foo' as any })).rejects.toThrow(
			new TypeError('Expected schema to be an object')
		);

		await expect(parse({ schema: null as any })).rejects.toThrow(
			new TypeError('Expected schema to be an object')
		);

		await expect(parse({ schema: 123 as any })).rejects.toThrow(
			new TypeError('Expected schema to be an object')
		);
	});

	it('should error if argv is invalid', async () => {
		await expect(parse({ argv: '' as any })).rejects.toThrow(
			new TypeError('Expected argv to be an array')
		);

		await expect(parse({ argv: 'foo' as any })).rejects.toThrow(
			new TypeError('Expected argv to be an array')
		);

		await expect(parse({ argv: null as any })).rejects.toThrow(
			new TypeError('Expected argv to be an array')
		);

		await expect(parse({ argv: 123 as any })).rejects.toThrow(
			new TypeError('Expected argv to be an array')
		);
	});

	it('should error if env is invalid', async () => {
		await expect(parse({ env: '' as any })).rejects.toThrow(
			new TypeError('Expected environment option to be an object')
		);

		await expect(parse({ env: 'foo' as any })).rejects.toThrow(
			new TypeError('Expected environment option to be an object')
		);

		await expect(parse({ env: null as any })).rejects.toThrow(
			new TypeError('Expected environment option to be an object')
		);

		await expect(parse({ env: 123 as any })).rejects.toThrow(
			new TypeError('Expected environment option to be an object')
		);
	});

	it('should carry the in-flight state on an error it throws', async () => {
		// the errors that most need a usage line are the ones that stop parse()
		// from returning, so the error is the only way the matched command gets
		// back out to whatever renders it
		const err = await parse({
			argv: ['build'],
			schema: { commands: { build: { options: { '--target <name>': 'Where to build to' } } } },
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe('Missing required options: --target');

		const state = (err as { [ErrorState]?: ParseState })[ErrorState];
		expect(state?.cmd?.name).toBe('build');
		expect(state?.contexts[0].name).toBe('build');

		// invisible to anything inspecting the error
		expect(Object.keys(err as object)).not.toContain('state');
		expect(Object.getOwnPropertyDescriptor(err, ErrorState)?.enumerable).toBe(false);
	});

	it('should not carry a state on an error thrown before there is one', async () => {
		const err = await parse({ schema: 'nope' as never }).catch((e: unknown) => e);

		expect((err as { [ErrorState]?: ParseState })[ErrorState]).toBeUndefined();
	});

	it('should error if schema has an invalid name', async () => {
		await expect(
			parse({
				schema: {
					name: 123 as any,
				},
			})
		).rejects.toThrow(new TypeError('Expected schema name to be a non-empty string'));
	});
});
