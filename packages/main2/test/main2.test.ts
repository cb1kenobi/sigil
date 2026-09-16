import { main2 } from '../src/index.js';
import type { ErrorContext, ParseState } from '../src/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Captures whatever the built-in error handler writes to the real stderr.
 */
function captureStderr() {
	const chunks: string[] = [];
	const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((
		chunk: string | Uint8Array
	) => {
		chunks.push(chunk.toString());
		return true;
	}) as typeof process.stderr.write);

	return {
		restore: () => spy.mockRestore(),
		get text() {
			return chunks.join('');
		},
	};
}

describe('main2', () => {
	let exitCode: typeof process.exitCode;

	beforeEach(() => {
		exitCode = process.exitCode;
	});

	afterEach(() => {
		// a leaked exit code would fail the entire test run
		process.exitCode = exitCode;
		vi.restoreAllMocks();
	});

	describe('happy path', () => {
		it('should resolve the parse state when no command runs', async () => {
			const result = (await main2({
				argv: ['--verbose'],
				schema: { options: { '-v, --verbose': 'Print more output' } },
			})) as ParseState;

			expect(result.argv.verbose).toBe(true);
			expect(process.exitCode).toBe(exitCode);
		});

		it('should run the matched command and resolve its return value', async () => {
			const result = await main2({
				argv: ['build'],
				schema: { commands: { build: { run: () => 'built' } } },
			});

			expect(result).toBe('built');
		});

		it('should resolve the parse state when the command returns nothing', async () => {
			const result = (await main2({
				argv: ['build'],
				schema: { commands: { build: { run: () => undefined } } },
			})) as ParseState;

			expect(result.cmd?.name).toBe('build');
		});
	});

	describe('error handling', () => {
		it('should render a parse error and set a non-zero exit code', async () => {
			const stderr = captureStderr();
			const result = await main2({
				argv: [],
				schema: { options: { '--name <value>': 'Your name' } },
			});
			stderr.restore();

			expect(stderr.text).toBe('Error: Missing required options: --name\n');
			expect(stderr.text).not.toContain('at ');
			expect(result).toBeUndefined();
			expect(process.exitCode).toBe(1);
		});

		it('should render an error thrown by the command handler', async () => {
			const stderr = captureStderr();
			await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							run() {
								throw new Error('build failed');
							},
						},
					},
				},
			});
			stderr.restore();

			expect(stderr.text).toBe('Error: build failed\n');
			expect(process.exitCode).toBe(1);
		});

		it('should render an async rejection from the command handler', async () => {
			const stderr = captureStderr();
			await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							run: async () => {
								await Promise.resolve();
								throw Object.assign(new Error('deploy failed'), { exitCode: 4 });
							},
						},
					},
				},
			});
			stderr.restore();

			expect(stderr.text).toBe('Error: deploy failed\n');
			expect(process.exitCode).toBe(4);
		});

		it('should render a thrown value that is not an error', async () => {
			const stderr = captureStderr();
			await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							run() {
								throw 'just a string';
							},
						},
					},
				},
			});
			stderr.restore();

			expect(stderr.text).toBe('Error: just a string\n');
			expect(process.exitCode).toBe(1);
		});

		it('should rethrow when the error handler is turned off', async () => {
			await expect(
				main2({
					argv: [],
					schema: { options: { '--name <value>': 'Your name' } },
					settings: { errorHandler: false },
				})
			).rejects.toThrow('Missing required options: --name');

			expect(process.exitCode).toBe(exitCode);
		});

		it('should rethrow a command handler error when turned off', async () => {
			await expect(
				main2({
					argv: ['build'],
					schema: {
						commands: {
							build: {
								run() {
									throw new Error('build failed');
								},
							},
						},
					},
					settings: { errorHandler: false },
				})
			).rejects.toThrow('build failed');
		});

		it('should call a custom error handler with the error and the state', async () => {
			let seen: unknown;
			let ctx: ErrorContext | undefined;

			const result = await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							run() {
								throw new Error('build failed');
							},
						},
					},
				},
				settings: {
					errorHandler: (err, c) => {
						seen = err;
						ctx = c;
					},
				},
			});

			expect((seen as Error).message).toBe('build failed');
			expect(ctx?.state?.cmd?.name).toBe('build');
			expect(result).toBeUndefined();
			// a custom handler owns the exit code
			expect(process.exitCode).toBe(exitCode);
		});

		it('should await an async custom error handler', async () => {
			const calls: string[] = [];

			await main2({
				argv: [],
				schema: { options: { '--name <value>': 'Your name' } },
				settings: {
					errorHandler: async () => {
						await Promise.resolve();
						calls.push('handled');
					},
				},
			});

			expect(calls).toEqual(['handled']);
		});

		it('should reject when a custom error handler throws', async () => {
			// swallowing this would leave nothing at all reporting either error
			await expect(
				main2({
					argv: [],
					schema: { options: { '--name <value>': 'Your name' } },
					settings: {
						errorHandler: () => {
							throw new Error('handler exploded');
						},
					},
				})
			).rejects.toThrow('handler exploded');
		});

		it('should hand the handler the state a parse error died with', async () => {
			let ctx: ErrorContext | undefined;

			await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							options: { '--target <name>': 'Where to build to' },
						},
					},
				},
				settings: {
					errorHandler: (_err, c) => {
						ctx = c;
					},
				},
			});

			// the usage line Phase 3 wants to print comes from here
			expect(ctx?.state?.cmd?.name).toBe('build');
			expect(ctx?.state?.contexts[0].name).toBe('build');
		});

		it('should hand the handler no state when parsing never produced one', async () => {
			let ctx: ErrorContext | undefined;

			await main2({
				schema: 'nope' as never,
				argv: [],
				settings: {
					errorHandler: (_err, c) => {
						ctx = c;
					},
				},
			});

			expect(ctx?.state).toBeUndefined();
		});

		it('should handle bad app options rather than crashing', async () => {
			const stderr = captureStderr();
			await main2(null as never);
			stderr.restore();

			expect(stderr.text).toContain('Error: ');
			expect(process.exitCode).toBe(1);
		});
	});

	describe('beforeError hooks', () => {
		it('should fire for an error thrown by the command handler', async () => {
			let seen: unknown;
			let state: ParseState | undefined;

			const stderr = captureStderr();
			await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							run() {
								throw new Error('build failed');
							},
						},
					},
					hooks: {
						beforeError: [
							(err, s) => {
								seen = err;
								state = s;
							},
						],
					},
				},
			});
			stderr.restore();

			expect((seen as Error).message).toBe('build failed');
			expect(state?.cmd?.name).toBe('build');
			// observing never suppresses: the error is still reported
			expect(stderr.text).toBe('Error: build failed\n');
			expect(process.exitCode).toBe(1);
		});

		it('should fire for an async rejection from the command handler', async () => {
			const calls: unknown[] = [];

			const stderr = captureStderr();
			await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							run: async () => {
								await Promise.resolve();
								throw new Error('deploy failed');
							},
						},
					},
					hooks: { beforeError: [(err) => void calls.push(err)] },
				},
			});
			stderr.restore();

			expect(calls).toHaveLength(1);
			expect((calls[0] as Error).message).toBe('deploy failed');
		});

		it('should fire a command hook for an error its own run() threw', async () => {
			const calls: string[] = [];

			const stderr = captureStderr();
			await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							hooks: { beforeError: [() => void calls.push('build')] },
							run() {
								throw new Error('build failed');
							},
						},
					},
					hooks: { beforeError: [() => void calls.push('schema')] },
				},
			});
			stderr.restore();

			expect(calls).toEqual(['build', 'schema']);
		});

		it('should render the error a hook replaced', async () => {
			const stderr = captureStderr();
			await main2({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							run() {
								throw new Error("ENOENT: no such file or directory, open 'x'");
							},
						},
					},
					hooks: {
						beforeError: [
							() => Object.assign(new Error('Could not read the project file'), { exitCode: 3 }),
						],
					},
				},
			});
			stderr.restore();

			expect(stderr.text).toBe('Error: Could not read the project file\n');
			// the replacement owns the exit code too
			expect(process.exitCode).toBe(3);
		});

		it('should hand a custom handler the error a hook replaced', async () => {
			let seen: unknown;

			await main2({
				argv: [],
				schema: {
					hooks: { beforeError: [() => new Error('nicer message')] },
					options: { '--name <value>': 'Your name' },
				},
				settings: {
					errorHandler: (err) => {
						seen = err;
					},
				},
			});

			expect((seen as Error).message).toBe('nicer message');
		});

		it('should rethrow the error a hook replaced when the handler is off', async () => {
			// the hooks run before the opt-out, so the same error leaves whichever
			// way it goes out
			await expect(
				main2({
					argv: [],
					schema: {
						hooks: { beforeError: [() => new Error('nicer message')] },
						options: { '--name <value>': 'Your name' },
					},
					settings: { errorHandler: false },
				})
			).rejects.toThrow('nicer message');
		});

		it('should fire once for a parse error', async () => {
			// `parse()` fires them itself, so main2() must not fire them again
			const calls: unknown[] = [];

			const stderr = captureStderr();
			await main2({
				argv: [],
				schema: {
					hooks: { beforeError: [(err) => void calls.push(err)] },
					options: { '--name <value>': 'Your name' },
				},
			});
			stderr.restore();

			expect(calls).toHaveLength(1);
		});

		it('should keep the state a parse error died with after a replacement', async () => {
			let ctx: ErrorContext | undefined;

			await main2({
				argv: ['build'],
				schema: {
					commands: { build: { options: { '--target <name>': 'Where to build to' } } },
					hooks: { beforeError: [() => new Error('nicer message')] },
				},
				settings: {
					errorHandler: (_err, c) => {
						ctx = c;
					},
				},
			});

			expect(ctx?.state?.cmd?.name).toBe('build');
		});

		it('should fire when reading the app options is what threw', async () => {
			// this error never reached parse(), so nothing has fired the hooks yet
			const calls: unknown[] = [];

			const stderr = captureStderr();
			await main2({
				get argv(): string[] {
					throw new Error('bad argv getter');
				},
				schema: { hooks: { beforeError: [(err) => void calls.push(err)] } },
			});
			stderr.restore();

			expect(calls).toHaveLength(1);
			expect((calls[0] as Error).message).toBe('bad argv getter');
			expect(stderr.text).toBe('Error: bad argv getter\n');
		});

		it('should still render when reading the settings is what threw', async () => {
			// the handler lookup is on the error path too, so a getter of the
			// caller's own must not cost them the error being reported
			const calls: unknown[] = [];

			const stderr = captureStderr();
			await main2({
				argv: [],
				schema: { hooks: { beforeError: [(err) => void calls.push(err)] } },
				get settings(): undefined {
					throw new Error('bad settings getter');
				},
			});
			stderr.restore();

			expect(calls).toHaveLength(1);
			expect(stderr.text).toBe('Error: bad settings getter\n');
			expect(process.exitCode).toBe(1);
		});

		it('should lose the state when the replacement cannot carry it', async () => {
			// a string cannot hold a property, so the usage line goes with it --
			// which is the argument for replacing an error with an error
			let ctx: ErrorContext | undefined;
			let seen: unknown;

			await main2({
				argv: ['build'],
				schema: {
					commands: { build: { options: { '--target <name>': 'Where to build to' } } },
					hooks: { beforeError: [() => 'just a string'] },
				},
				settings: {
					errorHandler: (err, c) => {
						seen = err;
						ctx = c;
					},
				},
			});

			expect(seen).toBe('just a string');
			expect(ctx?.state).toBeUndefined();
		});

		it('should report the original error when a hook throws', async () => {
			const stderr = captureStderr();
			await main2({
				argv: [],
				schema: {
					hooks: {
						beforeError: [
							() => {
								throw new Error('hook exploded');
							},
						],
					},
					options: { '--name <value>': 'Your name' },
				},
			});
			stderr.restore();

			expect(stderr.text).toBe('Error: Missing required options: --name\n');
			expect(process.exitCode).toBe(1);
		});
	});
});
