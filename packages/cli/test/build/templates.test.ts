import { findTemplates } from '../../src/build/templates.js';
import { compile } from '../../src/template/index.js';
import { analyze } from '../../src/template/index.js';
import { Expr, parse } from '@ttylabs/sigil/template';
import { describe, it, expect } from 'vitest';

/**
 * Finding the `ui` templates in a module, which is the half `compile()` has
 * always been handed rather than found.
 *
 * The two claims worth pinning hardest are that the tag is a *binding* rather
 * than a spelling, and that the spans are exactly what a caller splices -- both
 * fail silently when wrong. A template nobody found is simply not compiled, and
 * a span off by a character rewrites a module into one that does not parse.
 */
describe('finding templates in a module', () => {
	it('should find a template and read its parts', () => {
		const source = `import { ui } from '@ttylabs/sigil/template';
export default { run: () => ui\`<text>hello</text>\` };`;
		const found = findTemplates('a.ts', source);

		expect(found).to.have.lengthOf(1);
		expect(found[0]!.quasis).to.deep.equal(['<text>hello</text>']);
		expect(found[0]!.expressions).to.deep.equal([]);
		expect(found[0]!.tag).to.equal('ui');
		expect(found[0]!.line).to.equal(2);
	});

	it('should carry every interpolation back verbatim', () => {
		// an expression is never rewritten: a thunk is what makes a prop reactive,
		// and a compiler that touched one would stop being a pure optimizer
		const source = `import { ui } from '@ttylabs/sigil/template';
const t = ui\`<box color=\${() => theme.fg}>\${count}</box>\`;`;
		const [template] = findTemplates('a.ts', source);

		expect(template!.expressions).to.deep.equal(['() => theme.fg', 'count']);
		expect(template!.quasis).to.deep.equal(['<box color=', '>', '</box>']);
	});

	it('should span the whole tagged template, tag included', () => {
		const source = `import { ui } from '@ttylabs/sigil/template';
const t = ui\`<text>x</text>\`;`;
		const [template] = findTemplates('a.ts', source);

		// the span is what a caller replaces, so it has to be the whole expression
		expect(source.slice(template!.start, template!.end)).to.equal('ui`<text>x</text>`');
	});

	describe('the tag is a binding', () => {
		it('should find a template through an aliased import', () => {
			const source = `import { ui as html } from '@ttylabs/sigil/template';
const t = html\`<text>aliased</text>\`;`;
			const [template] = findTemplates('a.ts', source);

			expect(template!.tag).to.equal('html');
			expect(template!.quasis).to.deep.equal(['<text>aliased</text>']);
		});

		it('should ignore a local called ui that nobody imported', () => {
			// compiling something that was never the tag would rewrite a stranger's
			// template literal into calls it never asked for
			const source = 'const ui = String.raw;\nconst t = ui`<text>not ours</text>`;';
			expect(findTemplates('a.ts', source)).to.deep.equal([]);
		});

		it('should ignore a tag imported from somewhere else', () => {
			const source = `import { ui } from 'some-other-library';
const t = ui\`<text>theirs</text>\`;`;
			expect(findTemplates('a.ts', source)).to.deep.equal([]);
		});

		it('should ignore a type-only import, which erases', () => {
			const source = `import type { ui } from '@ttylabs/sigil/template';
const t = ui\`<text>x</text>\`;`;
			expect(findTemplates('a.ts', source)).to.deep.equal([]);
		});

		it('should find both names when a module imports the tag twice', () => {
			const source = `import { ui, ui as html } from '@ttylabs/sigil/template';
const a = ui\`<text>a</text>\`;
const b = html\`<text>b</text>\`;`;
			expect(findTemplates('a.ts', source).map((t) => t.tag)).to.deep.equal(['ui', 'html']);
		});

		it('should take a different tag when asked for one', () => {
			const source = `import { tpl } from 'my-lib';
const t = tpl\`<text>x</text>\`;`;
			const found = findTemplates('a.ts', source, { from: 'my-lib', name: 'tpl' });
			expect(found).to.have.lengthOf(1);
		});
	});

	describe('nesting', () => {
		it('should claim the outermost template and not the one inside an expression', () => {
			// the inner template's source travels into the generated code verbatim
			// and the runtime tag handles it there; returning both would splice the
			// inner one twice, once compiled and once inside the outer's expression
			const source = `import { ui } from '@ttylabs/sigil/template';
const t = ui\`<box>\${() => ui\`<text>inner</text>\`}</box>\`;`;
			const found = findTemplates('a.ts', source);

			expect(found).to.have.lengthOf(1);
			expect(found[0]!.expressions[0]).to.contain('ui`<text>inner</text>`');
		});

		it('should find two templates that merely sit near each other', () => {
			const source = `import { ui } from '@ttylabs/sigil/template';
const a = ui\`<text>one</text>\`;
function f() { return ui\`<text>two</text>\`; }`;
			expect(findTemplates('a.ts', source).map((t) => t.quasis[0])).to.deep.equal([
				'<text>one</text>',
				'<text>two</text>',
			]);
		});

		it('should find a template nested in something that is not a template', () => {
			// the walk is driven by oxc's own visitor keys rather than by a list of
			// node types, so a template inside a class method inside a conditional is
			// still a template
			const source = `import { ui } from '@ttylabs/sigil/template';
class C { m() { return cond ? ui\`<text>deep</text>\` : null; } }`;
			expect(findTemplates('a.ts', source)).to.have.lengthOf(1);
		});
	});

	it('should return templates in source order', () => {
		const source = `import { ui } from '@ttylabs/sigil/template';
const c = ui\`<text>3</text>\`;
const a = ui\`<text>1</text>\`;
const b = ui\`<text>2</text>\`;`;
		const starts = findTemplates('a.ts', source).map((t) => t.start);
		expect(starts).to.deep.equal([...starts].sort((x, y) => x - y));
	});

	it('should slice an expression by string index rather than by byte', () => {
		// oxc's offsets are UTF-16 code units, which is what `source.slice()`
		// takes. If they were ever UTF-8 bytes every expression after a non-ASCII
		// character would be sliced at the wrong place -- silently, and only for
		// the app that had one
		const source = `import { ui } from '@ttylabs/sigil/template';
const label = 'café ☕️ 𝄞';
const t = ui\`<text>\${theValue}</text>\`;`;
		const [template] = findTemplates('a.ts', source);

		expect(template!.expressions).to.deep.equal(['theValue']);
	});

	it('should cook the static parts rather than hand back raw text', () => {
		// `\\n` in a template is a newline to `ui`, so it has to be one here or the
		// compiled path reads a different template from the interpreted one
		const source =
			"import { ui } from '@ttylabs/sigil/template';\nconst t = ui`<text>a\\nb</text>`;";
		const [template] = findTemplates('a.ts', source);

		expect(template!.quasis[0]).to.equal('<text>a\nb</text>');
	});

	it('should hand the template toolchain something it can compile', () => {
		// the end-to-end claim: what this finds is exactly what `parse()` takes,
		// which is the seam the whole design rests on -- one parser, and this is
		// the thing that feeds it
		const source = `import { ui } from '@ttylabs/sigil/template';
const t = ui\`<box padding="1">\${() => count()}</box>\`;`;
		const found = findTemplates('a.ts', source);

		const irs = found.map(({ expressions, quasis }) =>
			analyze(
				parse(
					quasis,
					expressions.map((expression) => new Expr(expression))
				)
			)
		);
		const { sources } = compile(irs, { prefix: '$s_' });

		expect(sources).to.have.lengthOf(1);
		// the expression is printed back exactly as it was written
		expect(sources[0]).to.contain('() => count()');
	});

	it('should throw on a module that does not parse', () => {
		expect(() => findTemplates('broken.ts', 'const a = (')).to.throw(/Failed to parse broken\.ts/);
	});

	it('should do no work at all on a module that never imported the tag', () => {
		expect(findTemplates('a.ts', 'export default { desc: "no templates here" };')).to.deep.equal(
			[]
		);
	});
});
