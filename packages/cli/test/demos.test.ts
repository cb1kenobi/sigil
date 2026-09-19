import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The demos import `@ttylabs/sigil` by name, so they go through the package's
 * `exports` map and read `dist/` -- which is the one part of the surface no
 * other test covers. Nothing type-checks them, and a named import of an export
 * that no longer exists is not a lint error: it is a `SyntaxError` at the point
 * somebody runs the file, which is after it shipped.
 *
 * `06-ansi-and-wrap.js` went on importing `padCell()` for a whole pull request
 * after the component rewrite deleted it, and the suite was green the entire
 * time. This is the cheap half of the answer -- every named import a demo
 * makes has to be something the built package actually exports -- and it is
 * static, so it costs a read rather than 28 spawned processes.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const demos = resolve(root, 'demos');

/** Every `.js` under `demos/`, including the command modules in subdirectories. */
function scripts(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...scripts(path));
		} else if (entry.name.endsWith('.js')) {
			found.push(path);
		}
	}
	return found.sort();
}

interface DemoImport {
	names: string[];
	specifier: string;
}

/**
 * The static imports a demo makes from `@ttylabs/sigil`. Only the named ones
 * carry a promise this test can check; a namespace or default import merely
 * has to resolve, which importing the module proves on its own.
 */
function imports(source: string): DemoImport[] {
	const found: DemoImport[] = [];
	const re = /import\s+([^'"]*?)\s*from\s*'(@ttylabs\/sigil(?:\/[^']+)?)'/g;
	for (const match of source.matchAll(re)) {
		const clause = match[1] ?? '';
		const braces = /\{([^}]*)\}/.exec(clause);
		const names = braces
			? braces[1]
					.split(',')
					.map((part) => part.trim())
					.filter(Boolean)
					// `a as b` is a promise about `a`, which is the exported name
					.map((part) => part.split(/\s+as\s+/)[0]!.trim())
			: [];
		found.push({ names, specifier: match[2]! });
	}
	return found;
}

describe('the demos', () => {
	const files = scripts(demos);

	it('should have been found', () => {
		// a glob that matches nothing passes every assertion below it
		expect(files.length).toBeGreaterThan(20);
	});

	for (const file of files) {
		const name = relative(root, file);
		const declared = imports(readFileSync(file, 'utf-8'));
		if (declared.length === 0) {
			continue;
		}

		it(`should import what ${name} says it does`, async () => {
			for (const { names, specifier } of declared) {
				const module = (await import(specifier)) as Record<string, unknown>;
				for (const exported of names) {
					expect(Object.hasOwn(module, exported), `${specifier} exports ${exported}`).toBe(true);
				}
			}
		});
	}
});

/**
 * What a demo *does*, which the import check above cannot see.
 *
 * A demo that imports fine and then throws exits non-zero with a stack on
 * stderr, and nothing here would have known: the import check reads the file
 * and never runs it. So every demo is spawned, piped, and asked for its exit
 * code and its stderr.
 *
 * Piped is the interesting half rather than a limitation of CI. `demos/README.md`
 * documents what each one does without a terminal -- a spinner writes one line
 * per change, a bar one line every ten percent, a prompt fails rather than
 * waiting forever on a stdin that will never produce a keystroke -- and that is
 * the non-TTY rule the whole component layer rests on. Running them this way
 * checks the documented behaviour and needs no pty, which is what lets it run on
 * all nine of CI's node-and-os combinations.
 */

/** A demo that does not exit `0` with nothing on stderr, and why. */
const EXPECTED: Record<string, { code: number; stderr: RegExp }> = {
	// the non-TTY rule, and `demos/README.md` prints this very line
	'demos/components/04-prompts.js': {
		code: 1,
		stderr: /^\s*Cannot prompt for "Project name" because the input is not a terminal\s*$/,
	},
	// the demo *about* errors. Its narrative is stdout; what reaches stderr is
	// what `main()` rendered and then what a handler of the app's own did with
	// the same error -- a message each time, and never a stack, which is the
	// rule `errorHandler()` exists to keep and which `STACK` below re-checks
	'demos/parser/09-errors.js': {
		code: 0,
		// `\r?` because a pipe on Windows is still whatever `console.error` wrote
		stderr:
			/^Error: Missing required arguments: <host>\r?\nsorry: Error: Missing required arguments: <host>\r?\n$/,
	},
};

/**
 * A stack frame reaching the output is a throw nobody caught, exit code or not
 * -- which is also what catches an unhandled rejection that still exits `0`.
 *
 * The alternation is parenthesised because it means to be either whole branch
 * and not `^(\s+at .+)` or `(node:internal\/)$`: an alternation binds looser
 * than the anchors, which is the trap `optionTypesRE` in the parser is written
 * down for.
 */
const STACK = /(^\s+at .+$)|(node:internal\/)/m;

interface Ran {
	code: number | null;
	stderr: string;
	stdout: string;
}

function run(file: string): Promise<Ran> {
	return new Promise((settle, fail) => {
		const child = spawn(process.execPath, [file], {
			cwd: root,
			// a demo must never wait on stdin here; that is what `04-prompts.js` proves
			env: { ...process.env, COLUMNS: '80' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		let stdout = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			fail(new Error(`${relative(root, file)} did not finish within 30s`));
		}, 30_000);

		child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
		child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
		child.on('error', (error) => {
			clearTimeout(timer);
			fail(error);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			settle({ code, stderr, stdout });
		});
	});
}

describe('running the demos', () => {
	for (const file of scripts(demos)) {
		// the keys above are written the way the repository spells a path
		const name = relative(root, file).split(sep).join('/');
		const expected = EXPECTED[name];

		it.concurrent(`should run ${name}`, async () => {
			const { code, stderr, stdout } = await run(file);

			expect(`${stdout}${stderr}`, 'a stack reached the output').not.toMatch(STACK);
			expect(code, 'exit code').toBe(expected?.code ?? 0);
			if (expected) {
				expect(stderr).toMatch(expected.stderr);
			} else {
				expect(stderr, 'nothing was expected on stderr').toBe('');
			}
		}, 45_000);
	}
});
