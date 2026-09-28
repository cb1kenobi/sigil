/**
 * Whether the bundle is closed, on every path out of `bundleApp()`.
 *
 * rolldown's `close()` releases a **native** handle, so what is not released is
 * not something the garbage collector will get to -- and rolldown's own
 * documentation says to call it even when the build failed. It used to sit
 * directly after `bundle.write()`, which meant a write that threw skipped it:
 * measured before anything was changed, an `--out` that is an existing file
 * makes `write()` reject and `close()` was never reached.
 *
 * `bundleApp()` builds the bundle itself and hands back a `BundleResult`, so
 * nothing outside it can see the bundle -- and the alternative to mocking is a
 * seam on the function whose only reader would be this file, which is the kind
 * of seam AGENTS.md argues against. So `rolldown` is mocked the way
 * `blame.test.ts` mocks `compile()`: the real bundler runs, the real app is
 * bundled, the real files are written, and the one thing the wrapper adds is a
 * record of whether `close()` was called and a way to make it fail. Nothing
 * here is a fake bundle.
 *
 * A file of its own rather than a `describe` inside `bundle.test.ts`, because
 * `vi.mock` is hoisted and module-wide: every test in the file it sits in would
 * run through the wrapper, which is a thing nobody reading those tests would
 * expect.
 */

import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** One entry per `close()` the build made, in order. */
const closes: string[] = [];

/** Set to make the next bundle's `close()` reject, as a plugin hook would. */
let failClose = false;

vi.mock('rolldown', async (importOriginal) => {
	const real = await importOriginal<typeof import('rolldown')>();

	return {
		...real,
		async rolldown(options: Parameters<typeof real.rolldown>[0]) {
			const bundle = await real.rolldown(options);
			const close = bundle.close.bind(bundle);

			// defined on the instance rather than handed back behind a `Proxy`:
			// rolldown's bundle reads private fields off `this`, so a `Proxy`
			// receiver fails `write()` with `Receiver must be an instance of class`
			// -- measured, and the reason this is a property assignment
			Object.defineProperty(bundle, 'close', {
				configurable: true,
				value: async () => {
					closes.push('close');
					await close();
					if (failClose) {
						throw new Error('closeBundle exploded');
					}
				},
			});

			return bundle;
		},
	};
});

const { bundleApp } = await import('../../src/build/bundle.js');
const { discoverApp } = await import('../../src/build/discover.js');
const { resolveCommandTree } = await import('../../src/build/tree.js');

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/buildable');

/** Bundles the fixture into `out`, reporting the message rather than throwing. */
async function build(out: string): Promise<string> {
	const app = discoverApp(fixture);
	const tree = resolveCommandTree(join(fixture, 'src', 'commands'));

	return bundleApp({ app, binName: 'buildable', out, tree }).then(
		// spelled out rather than `rejects.toThrow`, so a build that *succeeded*
		// fails with a sentence rather than with chai complaining about
		// `undefined` -- the same shape the unresolved-import test uses
		() => '(the build succeeded)',
		(error: unknown) => (error as Error).message
	);
}

/** An `--out` that is an existing file, which is what makes `write()` reject. */
function outIsAFile(): string {
	const file = join(mkdtempSync(join(tmpdir(), 'sigil-close-')), 'afile');
	writeFileSync(file, 'x');
	return file;
}

describe('closing the bundle', () => {
	beforeEach(() => {
		closes.length = 0;
		failClose = false;
	});

	it('should close the bundle when the write threw', async () => {
		// the defect. `close()` was written directly after the write, so the one
		// path that needs it most -- the one where rolldown has a graph built and
		// a native handle open and no output to show for it -- was the path that
		// skipped it
		const failure = await build(outIsAFile());

		// named, so the test cannot pass because something else went wrong on the
		// way to the write
		expect(failure).toContain('Could not create directory');
		expect(closes).toStrictEqual(['close']);
	}, 60_000);

	it('should close the bundle exactly once when the build worked', async () => {
		// the other half: the `finally` replaced the eager call rather than joining
		// it, because two closes is two answers even where the second is a no-op
		const out = mkdtempSync(join(tmpdir(), 'sigil-close-ok-'));
		const failure = await build(out);

		expect(failure).toBe('(the build succeeded)');
		expect(existsSync(join(out, 'buildable.mjs'))).toBe(true);
		expect(closes).toStrictEqual(['close']);
	}, 60_000);

	it('should not let a close that throws replace the error the build was reporting', async () => {
		// what `close()` must never do, and the same rule `undo()` follows one
		// function along: a `finally` that rethrows swaps the real diagnostic for
		// one about releasing a handle. `closeBundle exploded` is what a plugin
		// hook that throws produces -- measured against rolldown 1.2.11, that
		// really does come out of `close()`
		failClose = true;

		const failure = await build(outIsAFile());

		expect(failure).toContain('Could not create directory');
		expect(failure).not.toContain('closeBundle exploded');
	}, 60_000);

	it('should not fail a build that worked because the bundle would not close', async () => {
		// swallowed on the success path too, rather than raised there: the
		// asymmetry would have to be stated as "releasing the bundle is fatal only
		// when everything else worked", and what it produces is a refused build
		// beside a bundle that is complete, escaped and executable
		failClose = true;

		const out = mkdtempSync(join(tmpdir(), 'sigil-close-late-'));
		const failure = await build(out);

		expect(failure).toBe('(the build succeeded)');
		expect(existsSync(join(out, 'buildable.mjs'))).toBe(true);
	}, 60_000);
});
