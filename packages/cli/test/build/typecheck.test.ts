import { formatDiagnostic, isFatal } from '../../src/build/diagnostic.js';
import { typeCheck } from '../../src/build/typecheck.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, '../fixtures/typecheck');

/**
 * `sigil build` type-checks, and it does so with the app's own compiler and the
 * app's own config.
 *
 * The fixtures under `test/fixtures/typecheck/` are excluded from this
 * package's own tsconfig, which is the same thing the JSX template fixture
 * needs and for the same reason: `broken/` holds a deliberate type error, and a
 * suite that fails on its own fixture is a suite nobody can run.
 */
describe('type-checking an app', () => {
	it('should pass a clean app', () => {
		const result = typeCheck({ cwd: join(fixtures, 'clean') });

		expect(result.checked).to.equal(true);
		expect(result.diagnostics).to.deep.equal([]);
		expect(isFatal(result.diagnostics)).to.equal(false);
	});

	it('should report a type error, with the file and the position', () => {
		const result = typeCheck({ cwd: join(fixtures, 'broken') });

		expect(result.checked).to.equal(true);
		expect(result.diagnostics).to.have.lengthOf(1);

		const [diagnostic] = result.diagnostics;
		expect(diagnostic!.severity).to.equal('error');
		expect(diagnostic!.file).to.equal(join(fixtures, 'broken', 'commands', 'ship.ts'));
		expect(diagnostic!.line).to.equal(2);
		expect(diagnostic!.column).to.be.a('number');
		expect(diagnostic!.message).to.contain('TS2322');
	});

	it('should make a type error fatal', () => {
		// "build type-checks" has to mean the build stops, or it is a warning
		// nobody reads and the app ships anyway
		expect(isFatal(typeCheck({ cwd: join(fixtures, 'broken') }).diagnostics)).to.equal(true);
	});

	it('should report an absolute path, so one report can hold every pass', () => {
		// the compiler is run with the app as its cwd and writes relative paths;
		// every other pass carries an absolute one, and a report holding both
		// spellings is one nobody can sort
		const [diagnostic] = typeCheck({ cwd: join(fixtures, 'broken') }).diagnostics;
		expect(diagnostic!.file.startsWith(fixtures)).to.equal(true);
	});

	describe('when there is nothing to check', () => {
		it('should skip a JavaScript app rather than failing it', () => {
			// an app with no tsconfig has nothing to type-check, which is not a
			// thing to be wrong about
			const result = typeCheck({ cwd: join(fixtures, 'js-only') });

			expect(result.checked).to.equal(false);
			expect(result.diagnostics).to.deep.equal([]);
			expect(result.skipped).to.contain('nothing to type-check');
		});

		it('should say so when a config names a file that is not there', () => {
			const result = typeCheck({
				cwd: join(fixtures, 'clean'),
				project: 'tsconfig.nope.json',
			});

			expect(result.checked).to.equal(false);
			expect(result.skipped).to.contain('tsconfig.nope.json');
		});

		it('should skip, and say why, when the app has no typescript to check with', () => {
			// outside the workspace entirely, so there is no `node_modules` chain to
			// resolve a compiler through
			const away = mkdtempSync(join(tmpdir(), 'sigil-typecheck-'));
			writeFileSync(join(away, 'tsconfig.json'), '{}', 'utf-8');

			const result = typeCheck({ cwd: away });

			expect(result.checked).to.equal(false);
			expect(result.skipped).to.contain('typescript could not be resolved');
			expect(result.skipped).to.contain('devDependency');
		});
	});

	it('should take a config the caller names', () => {
		const result = typeCheck({ cwd: join(fixtures, 'clean'), project: 'tsconfig.json' });
		expect(result.checked).to.equal(true);
	});

	it('should surface a compiler that refuses to run rather than calling it clean', () => {
		// a non-zero exit with nothing parseable behind it is the compiler saying
		// it could not do the job -- a `composite` project that cannot be told
		// `--noEmit`, an option it does not know. Swallowing that reports a clean
		// type-check for a check that never happened
		const away = mkdtempSync(join(tmpdir(), 'sigil-typecheck-'));
		writeFileSync(join(away, 'tsconfig.json'), '{}', 'utf-8');
		const refuses = join(away, 'refuses.js');
		writeFileSync(refuses, 'console.error("I will not"); process.exit(3);', 'utf-8');

		const result = typeCheck({ cwd: away, tsc: refuses });

		expect(result.checked).to.equal(true);
		expect(isFatal(result.diagnostics)).to.equal(true);
		expect(result.diagnostics[0]!.message).to.contain('exited 3');
		expect(result.diagnostics[0]!.message).to.contain('I will not');
	});

	it('should throw when the compiler cannot be started at all', () => {
		expect(() =>
			typeCheck({ cwd: join(fixtures, 'clean'), tsc: join(fixtures, 'no-such-file.js') })
		).to.throw(/Failed to run the type checker/);
	});
});

describe('a diagnostic', () => {
	it('should format as the line every compiler writes', () => {
		expect(
			formatDiagnostic({
				column: 7,
				file: '/app/commands/ship.ts',
				line: 2,
				message: "TS2322: Type 'string' is not assignable to type 'number'.",
				severity: 'error',
			})
		).to.equal(
			"/app/commands/ship.ts:2:7: error: TS2322: Type 'string' is not assignable to type 'number'."
		);
	});

	it('should format one with no position', () => {
		expect(
			formatDiagnostic({
				file: '/app/commands/a.js',
				message: 'no default export',
				severity: 'error',
			})
		).to.equal('/app/commands/a.js: error: no default export');
	});

	it('should call a warning on its own survivable', () => {
		expect(isFatal([{ file: 'a.js', message: 'computed desc', severity: 'warning' }])).to.equal(
			false
		);
	});
});
