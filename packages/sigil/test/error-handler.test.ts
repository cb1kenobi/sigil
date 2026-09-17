import { errorExitCode, errorHandler, renderError } from '../src/error-handler.js';
import type { ErrorContext, ParseState } from '../src/types.js';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Collects everything written to it so a test can assert on the rendered text
 * without touching the real stderr.
 */
function sink() {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(chunk.toString());
			cb();
		},
	}) as unknown as NodeJS.WritableStream;
	return {
		stream,
		get text() {
			return chunks.join('');
		},
	};
}

describe('errorHandler', () => {
	let exitCode: typeof process.exitCode;

	beforeEach(() => {
		exitCode = process.exitCode;
	});

	afterEach(() => {
		// a leaked exit code would fail the entire test run
		process.exitCode = exitCode;
	});

	it('should render an error message without a stack trace', () => {
		const out = sink();
		errorHandler(new Error('Missing required options: --foo'), { stderr: out.stream });

		expect(out.text).toBe('Error: Missing required options: --foo\n');
		expect(out.text).not.toContain('at ');
		expect(process.exitCode).toBe(1);
	});

	it('should render a TypeError by its message', () => {
		const out = sink();
		errorHandler(new TypeError('Expected schema to be an object'), { stderr: out.stream });

		expect(out.text).toBe('Error: Expected schema to be an object\n');
	});

	it('should render an error with no message by its name', () => {
		const out = sink();
		errorHandler(new RangeError(), { stderr: out.stream });

		expect(out.text).toBe('Error: RangeError\n');
	});

	it('should render values that are not errors', () => {
		expect(renderError('boom')).toBe('Error: boom');
		expect(renderError({ message: 'plain object' })).toBe('Error: plain object');
		expect(renderError(123)).toBe('Error: 123');
		expect(renderError(null)).toBe('Error: Unknown error');
		expect(renderError(undefined)).toBe('Error: Unknown error');
		expect(renderError('')).toBe('Error: Unknown error');
		expect(renderError({})).toBe('Error: [object Object]');
		expect(renderError([])).toBe('Error: Unknown error');
		expect(renderError(Symbol('nope'))).toBe('Error: Symbol(nope)');
	});

	it('should render a null prototype object that cannot be stringified', () => {
		expect(renderError(Object.create(null))).toBe('Error: Unknown error');
	});

	it('should survive a message getter that throws', () => {
		const err = new Error('never read');
		Object.defineProperty(err, 'message', {
			get() {
				throw new Error('getter exploded');
			},
		});

		// `name` is the next best thing it has to say for itself
		expect(renderError(err)).toBe('Error: Error');
	});

	it('should survive message and name getters that both throw', () => {
		const err = new Error('never read');
		for (const key of ['message', 'name']) {
			Object.defineProperty(err, key, {
				get() {
					throw new Error('getter exploded');
				},
			});
		}

		expect(renderError(err)).toBe('Error: Unknown error');
	});

	it('should survive a toString that throws', () => {
		expect(
			renderError({
				toString() {
					throw new Error('toString exploded');
				},
			})
		).toBe('Error: Unknown error');
	});

	it('should not be stopped by a value that cannot be inspected', () => {
		const out = sink();
		const err = {
			message: 'the real error',
			exitCode: 6,
			[Symbol.for('nodejs.util.inspect.custom')]() {
				throw new Error('inspect exploded');
			},
		};

		expect(() => errorHandler(err, { stderr: out.stream })).not.toThrow();
		expect(out.text).toBe('Error: the real error\n');
		expect(process.exitCode).toBe(6);
	});

	it('should write exactly one trailing newline', () => {
		const out = sink();
		errorHandler(new Error('trailing'), {
			render: () => 'already newlined\n\n',
			stderr: out.stream,
		});

		expect(out.text).toBe('already newlined\n');
	});

	it('should honor an exit code on the error', () => {
		const out = sink();
		errorHandler(Object.assign(new Error('nope'), { exitCode: 7 }), { stderr: out.stream });

		expect(process.exitCode).toBe(7);
	});

	it('should honor an explicit exit code of zero', () => {
		const out = sink();
		errorHandler(Object.assign(new Error('help'), { exitCode: 0 }), { stderr: out.stream });

		expect(process.exitCode).toBe(0);
	});

	it('should honor an exit code on a value that is not an error', () => {
		const out = sink();
		errorHandler({ message: 'nope', exitCode: 3 }, { stderr: out.stream });

		expect(out.text).toBe('Error: nope\n');
		expect(process.exitCode).toBe(3);
	});

	it('should ignore an exit code that a process cannot carry', () => {
		expect(errorExitCode(Object.assign(new Error('a'), { exitCode: '2' }))).toBe(1);
		expect(errorExitCode(Object.assign(new Error('b'), { exitCode: 1.5 }))).toBe(1);
		expect(errorExitCode(Object.assign(new Error('c'), { exitCode: -1 }))).toBe(1);
		expect(errorExitCode(Object.assign(new Error('d'), { exitCode: 256 }))).toBe(1);
		expect(errorExitCode(Object.assign(new Error('e'), { exitCode: NaN }))).toBe(1);
		expect(errorExitCode(new Error('f'))).toBe(1);
		expect(errorExitCode(null)).toBe(1);
		expect(errorExitCode(undefined)).toBe(1);
		expect(errorExitCode('boom')).toBe(1);
	});

	it('should survive an exit code getter that throws', () => {
		const err = new Error('nope');
		Object.defineProperty(err, 'exitCode', {
			get() {
				throw new Error('getter exploded');
			},
		});

		expect(errorExitCode(err)).toBe(1);
	});

	it('should use a custom renderer and hand it the parse state', () => {
		const out = sink();
		const state = { cmd: { name: 'build' } } as unknown as ParseState;
		let seen: ErrorContext | undefined;

		errorHandler(new Error('nope'), {
			render: (err, ctx) => {
				seen = ctx;
				return `usage: ${(err as Error).message}`;
			},
			state,
			stderr: out.stream,
		});

		expect(out.text).toBe('usage: nope\n');
		expect(seen?.state).toBe(state);
	});

	it('should fall back to the default renderer when a custom one throws', () => {
		const out = sink();
		errorHandler(new Error('the real error'), {
			render: () => {
				throw new Error('renderer exploded');
			},
			stderr: out.stream,
		});

		expect(out.text).toBe('Error: the real error\n');
		expect(process.exitCode).toBe(1);
	});

	it('should still set the exit code when the stream cannot be written to', () => {
		// a closed pipe, a destroyed socket: rendering an error must not raise
		// a second, worse one
		const stream = {
			write() {
				throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
			},
		} as unknown as NodeJS.WritableStream;

		expect(() =>
			errorHandler(Object.assign(new Error('the real error'), { exitCode: 5 }), { stderr: stream })
		).not.toThrow();
		expect(process.exitCode).toBe(5);
	});

	it('should coerce a renderer that does not return a string', () => {
		const out = sink();
		errorHandler(new Error('nope'), {
			render: () => 42 as unknown as string,
			stderr: out.stream,
		});

		expect(out.text).toBe('42\n');
	});
});
