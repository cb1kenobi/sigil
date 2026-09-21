/**
 * The defects two rounds of review found, as the inputs that reproduced them.
 *
 * Every case here printed a wrong answer -- or silently printed nothing wrong
 * while building the wrong tree -- before the fix beside it. They are assertions
 * rather than a script that prints, for the reason `jsx-types.tsx` exists: a pin
 * nothing runs is a pin that does not hold.
 *
 * The JSX frontend is exercised by calling `jsx()` and `jsxs()` directly, which
 * is what the transform emits, so this needs no `.tsx` and no build.
 */

import { box, renderToString, text } from '../../src/element/index.js';
import { createRoot, Show } from '../../src/renderer/index.js';
import { jsxDEV } from '../../src/template/dev-runtime.js';
import { ui } from '../../src/template/index.js';
import { jsx, jsxs } from '../../src/template/runtime.js';
import { describe, expect, it } from 'vitest';

/** Builds under an owner, renders, and tears the owner down again. */
function render(build: () => ReturnType<typeof box>): string {
	return createRoot((dispose) => {
		const out = renderToString(build(), { colorLevel: 0, width: 24 });
		dispose();
		return out;
	});
}

describe('the ui tag', () => {
	it('should skip the space on both sides of an attribute "="', () => {
		// only the space *before* `=` was skipped, so the one after it was read as
		// the start of a bare value and the quote came back as an attribute name
		expect(render(() => ui`<box class = "row"><text>a</text></box>`)).toBe('a');
		expect(render(() => ui`<box class = ${'row'}><text>a</text></box>`)).toBe('a');
		expect(render(() => ui`<box padding= "0"><text>a</text></box>`)).toBe('a');
	});

	it('should report text beside the root rather than dropping it', () => {
		// the root filter dropped every text node, so this quietly emitted the box
		expect(() => ui`hello<box><text>x</text></box>`).toThrow(/exactly one element/);
		expect(() => ui`<box><text>x</text></box>world`).toThrow(/exactly one element/);
	});

	it('should keep the template layout out of the text', () => {
		const laidOut = ui`
			<box>
				<text>one</text>
			</box>
		`;
		expect(render(() => laidOut)).toBe('one');
	});

	it('should keep a trailing space that no line break touches', () => {
		// read off the element rather than the rendered line: a string render drops
		// a trailing run of blanks, which is its own recorded rule and would hide
		// what this is asking about
		expect(
			createRoot((dispose) => {
				const el = ui`<text>a: </text>`;
				dispose();
				return el.text;
			})
		).toBe('a: ');
	});

	it('should read a line break inside prose as a space', () => {
		// deleting the run is right between two elements and wrong inside prose:
		// this came out "helloworld", and JSX's transform joins the lines with a
		// space -- so the two frontends were different languages
		const wrapped = ui`<text>hello
world</text>`;
		expect(render(() => wrapped)).toBe('hello world');
	});

	it('should refuse a second piece after an interpolated attribute value', () => {
		// `width=${10}px` read `10` and took `px` for a bare attribute
		expect(() => ui`<box width=${10}px><text>a</text></box>`).toThrow(/whole value/);
	});

	it('should refuse a component named rather than interpolated', () => {
		expect(() => ui`<box><Show/></box>`).toThrow(/no scope to look a name up in/);
	});
});

describe('a text element', () => {
	it('should treat a boolean as absent rather than painting the word', () => {
		// `appendValue()` skipped a boolean and this did not, so one rule said
		// twice disagreed: empty as a box child, the word `false` inside a text.
		// Through a variable rather than a literal `false &&`, which is the shape
		// an author writes and which a linter reads as a mistake when it is spelled
		// out
		const ready = false;
		expect(render(() => ui`<text>${ready && 'ready'}</text>`)).toBe('');
		expect(render(() => ui`<text>${() => ready}</text>`)).toBe('');
	});

	it('should still paint a zero, which is a value somebody meant to show', () => {
		expect(render(() => ui`<text>${0}</text>`)).toBe('0');
	});

	it('should refuse an element in text position however it arrived', () => {
		// the guard read `kind === 'element'`, and JSX evaluates a child before the
		// call -- so a built element arrives as a *slot* and was painted as
		// `[object Object]`, on both frontends
		const message = /no inline layout/;
		expect(() => ui`<text><box/></text>`).toThrow(message);
		expect(() => ui`<text>${box()}</text>`).toThrow(message);
		expect(() => jsx('text', { children: jsx('box', {}) })).toThrow(message);
	});
});

describe('a raw element', () => {
	it('should refuse children rather than discarding them', () => {
		// JSX had already built the child and left its effects on the owner before
		// this dropped it
		const measure = () => ({ height: 1, width: 3 });
		const paint = () => {};
		expect(() => ui`<raw measure=${measure} paint=${paint}><text>x</text></raw>`).toThrow(
			/cannot have children/
		);
	});
});

describe('the two frontends', () => {
	/** Reports what its children arrived as, which is what the two disagreed on. */
	const Kind = (props: { children?: unknown }) =>
		text(Array.isArray(props.children) ? 'array' : 'one');

	it('should hand a component the same children for a one-item array', () => {
		// `jsxs` was aliased to `jsx` and both flattened, so JSX unwrapped the
		// singleton and handed over `a` where the tag handed over `[a]`
		expect(render(() => jsx(Kind, { children: [text('a')] }))).toBe('array');
		expect(render(() => ui`<${Kind}>${[text('a')]}</>`)).toBe('array');
	});

	it('should hand a component the same children for a two-item array', () => {
		expect(render(() => jsx(Kind, { children: [text('a'), text('b')] }))).toBe('array');
		expect(render(() => ui`<${Kind}>${[text('a'), text('b')]}</>`)).toBe('array');
	});

	it('should split a list of children, which is what jsxs is for', () => {
		expect(render(() => jsxs('text', { children: ['a: ', 'b'] }))).toBe('a: b');
	});

	it('should build the same tree from the same template', () => {
		// the invariant the whole design rests on, and the thing that caught a bad
		// fix to `jsxs`: the tag and what the transform emits must agree
		const tagged = ui`<box><text>count: ${1}</text><text>${'low'}</text></box>`;
		const compiled = jsxs('box', {
			children: [jsxs('text', { children: ['count: ', 1] }), jsx('text', { children: 'low' })],
		});
		expect(render(() => tagged)).toBe(render(() => compiled));
	});
});

describe('component children', () => {
	it('should ignore whitespace-only text between its tags', () => {
		// one space before the expression made `props.children` the array
		// `[' ', fn]`, so this failed with `props.children is not a function`
		// while the same template across two lines worked
		const spaced = ui`<${Show} when=${() => true}> ${() => ui`<text>ok</text>`}</>`;
		expect(render(() => spaced)).toBe('ok');
	});

	it('should keep whitespace inside a host element, which is content', () => {
		expect(render(() => ui`<text>a b</text>`)).toBe('a b');
	});
});

describe('source positions', () => {
	it('should point a tag error at the line it was written on', () => {
		// the whole reason the IR carries a position: before this, an error about
		// a template named the rule it broke and not where it was broken
		const build = () => ui`
			<box>
				<text>fine</text>
				<text><box/></text>
			</box>
		`;
		expect(build).toThrow(/at line 4/);
	});

	it('should carry a file and a line from the dev transform', () => {
		// `source` is the only way a JSX frontend can say where it was: the
		// production transform passes none, which is why `loc` is optional
		const source = { columnNumber: 3, fileName: 'panel.tsx', lineNumber: 12 };
		expect(() => jsxDEV('text', { children: jsx('box', {}) }, undefined, false, source)).toThrow(
			/at panel\.tsx:12:3/
		);
	});

	it('should still build a tree when the transform passes no position', () => {
		// the production path, where nothing can say where anything came from
		expect(render(() => jsx('text', { children: 'ok' }))).toBe('ok');
	});
});
