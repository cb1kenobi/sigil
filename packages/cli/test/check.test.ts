import { run, schema } from '../src/index.js';
import { readRoutes } from '@ttylabs/sigil/routes';
import { readFileSync } from 'node:fs';
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
const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');

/** The commands the filesystem says exist, which is the source of truth. */
function routeNames(): string[] {
	return (readRoutes(commandsDir)?.routes ?? []).map((route) => route.name).sort();
}

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
		it('should be routed beside build, both complete', () => {
			// a command that exists and refuses is worse than one that does not
			// exist yet; both of these are the whole of what they claim, and
			// `build` runs `check`'s pass rather than replacing it. They are files
			// in a directory now rather than keys in a map, so that is what is read
			expect(schema().commands).toBe('./commands');
			expect(routeNames()).toStrictEqual(['add', 'build', 'check', 'new']);
		});

		it('should keep its description in its own module', () => {
			// where a filesystem route keeps one. `sigil build` lifts it statically
			// into the tree it bakes, so `sigil --help` still names the command
			// without importing the native parser behind it
			const source = readFileSync(join(commandsDir, 'check.ts'), 'utf-8');
			expect(source).toContain("desc: 'Check an app without building it'");
		});

		it('should be listed in help without loading its module', async () => {
			// by name alone from source, which is what an unbuilt filesystem tree
			// has always done: the description is inside `check.ts` and reading it
			// means importing the module, which is the one thing the deferral
			// exists to avoid. `sigil build` lifts it statically and bakes it in,
			// so the *built* toolchain names and describes it -- asserted in
			// `commands.test.ts`, against the artifact that has the lift in it
			const { out } = await sigil('--help');

			expect(out).toContain('check');
		});

		it('should describe its own options once it is asked', async () => {
			const { out } = await sigil('check', '--help');

			expect(out).toContain('--commands');
			expect(out).toContain('--entry');
			expect(out).toContain('--tree');
			expect(out).toContain('[dir]');
		});
	});

	describe('discovery', () => {
		it('should find the app and name the entry it chose', async () => {
			// choosing the entry is a heuristic -- source conventions before the
			// manifest -- and a guess nobody can see is the kind that costs an
			// afternoon
			const { err } = await sigil('check', join(fixtures, 'app'));

			expect(err).toContain('fixture-app');
			expect(err).toContain('index.ts');
		});

		it('should refuse a directory that does not depend on the runtime', async () => {
			const { err } = await sigil('check', join(fixtures, 'discover', 'not-an-app'));

			expect(err).toContain('does not depend on @ttylabs/sigil');
			expect(process.exitCode).toBe(1);
		});

		it('should follow a schema that writes its commands out', async () => {
			const { out } = await sigil('check', join(fixtures, 'discover', 'inline-app'), '--tree');

			expect(out).toContain('build it');
			expect(out).toContain('commands/build.ts');
		});

		it('should take an entry the caller names', async () => {
			const { err } = await sigil(
				'check',
				join(fixtures, 'discover', 'built-app'),
				'--entry',
				'dist/cli.mjs'
			);
			expect(err).toContain('dist/cli.mjs');
		});

		it('should say so once when a schema names commands it cannot read', async () => {
			// one problem said twice, with the second telling wrong, is worse than
			// the problem
			const { err } = await sigil('check', join(fixtures, 'ts-app'));

			expect(err).toContain('"commands" is computed');
			expect(err).not.toContain('no "commands" found');
			expect(process.exitCode).toBe(1);
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
			const { err } = await sigil('check', join(fixtures, 'discover', 'bad-tree'));

			expect(err).toContain('both declare a "dupe" command');
			expect(process.exitCode).toBe(1);
			expect(err).not.toContain('at Object.');
		});

		it('should say so when the directory its entry names is not there', async () => {
			const { err } = await sigil('check', join(fixtures, 'discover', 'no-commands-dir'));

			expect(err).toContain('no command directory here');
			expect(err).toContain('--commands');
			expect(process.exitCode).toBe(1);
		});
	});

	describe('a schema whose paths mean two things', () => {
		it('should warn when a relative commands path has no baseDir', async () => {
			// the build resolves it against the entry module and the runtime
			// resolves it against the working directory, so the app builds and then
			// throws `Unsupported command module` the moment it is run from source.
			// Before this, `check` said "no problems found" about exactly that.
			const { err } = await sigil('check', join(fixtures, 'discover', 'no-basedir'));

			expect(err).toContain('"baseDir"');
			expect(err).toContain('import.meta.dirname');
			expect(err).toContain('1 warning');
		});

		it('should stay quiet when the schema says what it is relative to', async () => {
			// a warning that fires on correct code teaches people to ignore warnings
			const { err } = await sigil('check', join(fixtures, 'buildable'));
			expect(err).not.toContain('"baseDir"');
		});

		it('should not call it fatal', async () => {
			// the *built* app is genuinely fine, and an app that only ever ships
			// bundled is not wrong. What was wrong is this command having nothing
			// to say about it
			const { err } = await sigil('check', join(fixtures, 'discover', 'no-basedir'));
			expect(err).not.toContain('error:');
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
