import { PROBES } from '../../sigil/scripts/terminal-probe.mjs';
import { describe, expect, it } from 'vitest';

/**
 * That `terminal-probe.mjs` loads at all, which is the one thing about it a test
 * can say.
 *
 * Everything the script does is paint a frame or ask the terminal a question and
 * wait for a hand on the keyboard, so none of it can run here -- that is the whole
 * reason the file exists. What *can* go wrong without anybody noticing is smaller
 * and worse: nothing type-checks it, nothing lints it as a module, and a named
 * import of an export that no longer exists is a `SyntaxError` raised at the point
 * somebody runs it, which is when they were trying to diagnose something else.
 * That is the same hole `demos.test.ts` was written for, which is why this lives
 * in the package whose tests already require a build.
 *
 * Its docblock has called it "importable for a headless smoke test" since it was
 * written, and until now there was no such test -- a correct comment with nothing
 * behind it, which is the shape this repository keeps finding.
 */
describe('the terminal probe', () => {
	it('should load, which is what imports it cannot resolve would stop', () => {
		// the assertion is almost beside the point: reaching it means every `dist/`
		// specifier at the top of that file resolved, and every name it asked for
		// exists on what it imported
		expect(PROBES.length).toBeGreaterThan(0);
	});

	it('should say what to look at and what to expect, for every probe', () => {
		// a probe with no `expect` line is one whose reader has to guess what agreement
		// looks like, which is the same as not having run it
		for (const probe of PROBES) {
			expect(typeof probe.title, probe.title).toBe('string');
			expect(probe.title.length, probe.title).toBeGreaterThan(0);
			expect(probe.expect.length, probe.title).toBeGreaterThan(0);
			expect(typeof probe.run, probe.title).toBe('function');
		}
	});
});
