/**
 * Which template a whole-module `compile()` failure is blamed on.
 *
 * `compile()` is handed every template in a module at once, so what it throws
 * names none of them -- and the first template's position was the answer for one
 * commit, which is a location pointing at code the author would read, find
 * correct, and be stuck on. `blame()` locates the culprit by compiling each
 * template alone and matching the message.
 *
 * The exact-match path is covered from the outside in
 * `compile-templates.test.ts`, with a real `<raw>` that `parse()` accepts and
 * `compile()` refuses. **The two fallbacks under it cannot be reached with
 * today's emitter**, which is the whole reason this file exists: no message
 * `compile()` throws depends on how many templates it was handed, so a template
 * that fails alone always produces the same message and the exact match always
 * wins. That was verified rather than assumed -- including the prefix check,
 * which throws one identical message for one node and for two.
 *
 * Machinery nothing exercises is machinery that stops working silently, and the
 * two earlier attempts at these tests were both green with the fallback they
 * were named for deleted. So `compile()` is mocked here to produce the one thing
 * the real emitter does not: a message that differs between compiling a module
 * and compiling one of its templates. That is what the ordering exists for, and
 * mocking is the only way to ask about it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const compile = vi.fn();

vi.mock('../../src/template/emit.js', () => ({
	compile,
	renderImports: () => '',
}));

const { compileTemplates, TemplateCompileError } =
	await import('../../src/build/compile-templates.js');

/** Two templates, on lines 2 and 3, both of them perfectly valid. */
const SOURCE = `import { ui } from '@ttylabs/sigil/template';
export const one = () => ui\`<text>a</text>\`;
export const two = () => ui\`<text>b</text>\`;
`;

/** What a successful `compile()` hands back, with a source per template. */
function compiled(count: number): unknown {
	return {
		hoisted: [],
		imports: [],
		sources: Array.from({ length: count }, (_at, i) => `"stub${i}"`),
	};
}

describe('blaming a whole-module compile failure', () => {
	beforeEach(() => {
		compile.mockReset();
	});

	it('should prefer the template whose message matches over an earlier one that also fails', () => {
		// what the exact match buys, and the one thing no real-emitter test can ask:
		// `compile()` throws on the *first* template that fails, so with today's
		// emitter the matching template and the first failing one are always the
		// same and the two rules are indistinguishable. Mocked apart, the message is
		// what says which template the module compile was actually talking about --
		// pairing it with an earlier template's position would be the original
		// defect with extra steps
		let alone = 0;
		compile.mockImplementation((nodes: readonly unknown[]) => {
			if (nodes.length > 1) {
				throw new Error('about the second one');
			}

			alone++;
			throw new Error(alone === 2 ? 'about the second one' : 'about the first, differently');
		});

		let thrown: unknown;
		try {
			compileTemplates('/app/two.ts', SOURCE);
		} catch (e: unknown) {
			thrown = e;
		}

		// line 3 -- the template that produced this message -- and not line 2, which
		// merely fails first
		expect((thrown as InstanceType<typeof TemplateCompileError>).line).toBe(3);
	});

	it('should blame a template that fails alone when no message matches the module’s', () => {
		// the middle fallback. The module compile says one thing and no single
		// template reproduces it, so the answer has to land on a template that
		// genuinely fails rather than on the first one -- which is the defect this
		// function was written for, returning silently
		let alone = 0;
		compile.mockImplementation((nodes: readonly unknown[]) => {
			if (nodes.length > 1) {
				throw new Error('about the module');
			}

			// the loop compiles in source order, so the second single-node call is
			// the template on line 3
			alone++;
			if (alone === 2) {
				throw new Error('about this one, said differently');
			}

			return compiled(1);
		});

		let thrown: unknown;
		try {
			compileTemplates('/app/two.ts', SOURCE);
		} catch (e: unknown) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(TemplateCompileError);
		// line 3, not line 2: the template that fails, not the first one
		expect((thrown as InstanceType<typeof TemplateCompileError>).line).toBe(3);
		// and the message stays the one `compile()` actually gave
		expect((thrown as Error).message).toContain('about the module');
	});

	it('should blame the first template when the failure is about no single one', () => {
		// the last resort: every template compiles alone, so the failure is
		// genuinely about the combination and the first is the honest answer
		compile.mockImplementation((nodes: readonly unknown[]) => {
			if (nodes.length > 1) {
				throw new Error('only together');
			}

			return compiled(1);
		});

		let thrown: unknown;
		try {
			compileTemplates('/app/two.ts', SOURCE);
		} catch (e: unknown) {
			thrown = e;
		}

		expect((thrown as InstanceType<typeof TemplateCompileError>).line).toBe(2);
		expect((thrown as Error).message).toContain('only together');
	});

	it('should compile each template at most once while looking', () => {
		// bounded, and only after the build is already failing: one module compile
		// plus at most one per template
		compile.mockImplementation((nodes: readonly unknown[]) => {
			if (nodes.length > 1) {
				throw new Error('about the module');
			}

			return compiled(1);
		});

		expect(() => compileTemplates('/app/two.ts', SOURCE)).toThrow(TemplateCompileError);
		expect(compile.mock.calls).toHaveLength(3);
	});
});
