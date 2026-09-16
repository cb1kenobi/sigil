import main2, { options } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('options()', () => {
	// it is the identity function: everything it is for happens in the type system,
	// so what there is to test is that it changes nothing at runtime
	it('should hand back the object it was given', () => {
		const decl = { '-v, --verbose': 'Say more', '--port [n]': { type: 'int' } };
		expect(options(decl)).toBe(decl);
	});

	it('should declare the same options as a literal would', async () => {
		const group = options({ '-v, --verbose': 'Say more', '--port [n]': { type: 'int' } });
		const state = await main2({
			argv: ['--verbose', '--port', '8080'],
			schema: { help: false, name: 'mycli', options: group },
		});

		expect(state).toMatchObject({ argv: { port: 8080, verbose: true } });
	});

	it('should declare the same group in more than one place', async () => {
		const group = options({ '--force': 'Do it anyway' });
		const state = await main2({
			argv: ['build', '--force'],
			schema: {
				help: false,
				name: 'mycli',
				commands: {
					build: { options: group },
					clean: { options: group },
				},
			},
		});

		expect(state).toMatchObject({ argv: { force: true } });
	});
});
