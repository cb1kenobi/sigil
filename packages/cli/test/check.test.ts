import { run, schema } from '../src/index.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Captures a stream, since `run()` writes through the framework. */
function capture(stream: 'stdout' | 'stderr') {
	const chunks: string[] = [];
	const spy = vi.spyOn(process[stream], 'write').mockImplementation(((
		chunk: string | Uint8Array
	) => {
		chunks.push(chunk.toString());
		return true;
	}) as typeof process.stdout.write);

	return {
		restore: () => spy.mockRestore(),
		get text() {
			return chunks.join('');
		},
	};
}

/** Runs the CLI with both streams captured, and hands back what they got. */
async function sigil(...argv: string[]) {
	const out = capture('stdout');
	const err = capture('stderr');
	try {
		await run(argv);
	} finally {
		out.restore();
		err.restore();
	}
	return { err: err.text, out: out.text };
}

/**
 * `sigil check`, wired into the CLI.
 *
 * It is not a stub standing in for `build`: it is the whole of what it claims
 * to be, and `build` will run it rather than replace it. The rule the schema
 * carries -- that a command which exists and refuses is worse than one that does
 * not exist yet -- is what these assert it keeps.
 */
describe('sigil check', () => {
	let exitCode: typeof process.exitCode;

	beforeEach(() => {
		exitCode = process.exitCode;
	});

	afterEach(() => {
		// a leaked exit code would fail the entire test run
		process.exitCode = exitCode;
		vi.restoreAllMocks();
	});

	describe('the wiring', () => {
		it('should be declared with a description the schema carries itself', () => {
			// on the placeholder rather than in the module, so `sigil --help` can
			// describe it without loading a native parser it has no use for. The
			// same shape `sigil build` generates for an app's own commands
			// `commands` may be a path or a list as well as a map, so it is narrowed
			// rather than indexed straight into
			const commands = schema().commands as Record<string, { desc?: string; load?: unknown }>;
			const check = commands.check;

			expect(check).toBeTypeOf('object');
			expect(check.desc).toBe('Check an app without building it');
			expect(check.load).toBeTypeOf('function');
		});

		it('should describe itself in help without loading its module', async () => {
			const { out } = await sigil('--help');

			expect(out).toContain('check');
			expect(out).toContain('Check an app without building it');
		});

		it('should describe its own options once it is asked', async () => {
			const { out } = await sigil('check', '--help');

			expect(out).toContain('--commands');
			expect(out).toContain('--tree');
			expect(out).toContain('[dir]');
		});
	});

	describe('an app that checks out', () => {
		it('should report what it found and leave the exit code alone', async () => {
			const { err } = await sigil('check', join(fixtures, 'app'));

			expect(err).toContain('commands');
			expect(process.exitCode).toBeFalsy();
		});

		it('should report a description it could not read as a warning, not a failure', async () => {
			// the command keeps exactly the help it would have had unbundled, which
			// is none until its module loads -- so this is worth saying and is not
			// worth failing over
			const { err } = await sigil('check', join(fixtures, 'app'));

			expect(err).toContain('warning');
			expect(err).toContain('"desc" is computed');
			expect(process.exitCode).toBeFalsy();
		});

		it('should name the file relative to the app', async () => {
			// an absolute path per line is mostly the same prefix repeated, and the
			// interesting part is at the end of it
			const { err } = await sigil('check', join(fixtures, 'app'));
			const [diagnostic] = err.split('\n');

			expect(diagnostic).toContain('commands/computed.js');
			expect(diagnostic).not.toContain(fixtures);
		});
	});

	describe('an app that does not', () => {
		it('should fail on a type error', async () => {
			const { err } = await sigil('check', join(fixtures, 'typecheck', 'broken'));

			expect(err).toContain('TS2322');
			expect(process.exitCode).toBe(1);
		});

		it('should fail, rather than throw a stack, when a tree cannot exist', async () => {
			// two routes claiming one name is a tree that cannot be built at all,
			// which is a diagnostic rather than something to take the process down
			// with
			const { err } = await sigil('check', join(fixtures, 'ts-app'), '--commands', '.');

			expect(process.exitCode).toBe(1);
			expect(err).not.toContain('at Object.');
		});

		it('should say so when there is no command directory', async () => {
			const { err } = await sigil('check', fixtures);

			expect(err).toContain('no command directory here');
			expect(err).toContain('--commands');
			expect(process.exitCode).toBe(1);
		});
	});

	describe('--tree', () => {
		it('should print every command, its module, and its description', async () => {
			const { out } = await sigil('check', join(fixtures, 'app'), '--tree');

			expect(out).toContain('Command');
			expect(out).toContain('build the app');
			expect(out).toContain('commands/build.ts');
		});

		it('should mark a namespace as having nothing to run', async () => {
			const { out } = await sigil('check', join(fixtures, 'app'), '--tree');

			expect(out).toMatch(/db\s+\(directory, nothing to run\)/);
		});

		it('should mark a hidden command', async () => {
			const { out } = await sigil('check', join(fixtures, 'app'), '--tree');
			expect(out).toContain('secret (hidden)');
		});

		it('should nest a subcommand under its parent', async () => {
			const { out } = await sigil('check', join(fixtures, 'app'), '--tree');
			expect(out).toMatch(/\n {4}up\s/);
		});

		it('should go to stdout, so it can be piped without losing the problems', async () => {
			// the tree is data somebody asked for; the diagnostics are not
			const { err, out } = await sigil('check', join(fixtures, 'app'), '--tree');

			expect(out).toContain('Command');
			expect(out).not.toContain('warning');
			expect(err).toContain('warning');
		});
	});

	it('should default to the working directory', async () => {
		const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(fixtures, 'app'));
		try {
			const { err } = await sigil('check');
			expect(err).toContain('commands');
		} finally {
			cwd.mockRestore();
		}
	});
});
