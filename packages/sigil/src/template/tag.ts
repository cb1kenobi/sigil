/**
 * The `ui` tag: the zero-build frontend, over the same IR.
 *
 * This is the frontend that exists because Node's
 * type stripping does not handle JSX: a `.ts` command module runs with nothing
 * compiling it, a `.tsx` one does not, and AGENTS.md already promises the
 * former. So the tag is what a script, a prototype, or a UI whose shape is only
 * known at runtime uses.
 *
 * ```js
 * ui`<box class="row"><text>${() => count()} items</text></box>`
 * ```
 *
 * ## The name
 *
 * Two characters, because it is prefixed to every template and wants to
 * disappear the way `html` does in lit and htm. Not `html`, which would be a
 * lie about what is inside; not `x`, which in this codebase is a coordinate 45
 * times over in `src/canvas/` alone; not `jsx`, which is both inaccurate -- the
 * interpolation is `${}` -- and already the name of a function next door.
 *
 * There is no second, more verbose export, for the reason AGENTS.md gives
 * against every second spelling of one idea. ESM is the alias mechanism:
 * `import { ui as html }` is how somebody opts into an editor extension that
 * highlights `html` tags, and costs this module nothing.
 *
 * It is JSX's syntax with JavaScript's own interpolation, which is the only
 * interpolation available: a template literal splits on `${}` and nothing else,
 * so `{expr}` arrives as literal text and the only way to evaluate it would be
 * `new Function` -- which SIG-72 rules out. `${}` is therefore not a preference.
 *
 * ## A component is interpolated, never named
 *
 * `<${Counter} />` rather than `<Counter />`. A tag function has no scope to
 * look a name up in, so the alternatives are a registry -- which breaks
 * tree-shaking, the thing SIG-70 flags as unsettled -- or this. Interpolating
 * keeps the reference lexical, so a bundler can see it. Host elements stay bare
 * because `box`, `text` and `raw` are the only three and they need no lookup.
 *
 * ## Whitespace
 *
 * SIG-70's rule: preserve a whitespace run within a line, drop one containing a
 * newline. So the indentation between two elements disappears and the trailing
 * space in `<text>Enter your email: </text>` survives.
 */

import type { Element } from '../element/index.js';
import {
	type ComponentRef,
	emit,
	Expr,
	type IRNode,
	type IRProp,
	type SourceLocation,
} from './ir.js';

/** Names a tag or an attribute may use, kebab included, since style props are kebab. */
const NAME_RE = /[A-Za-z_]/;
const NAME_BODY_RE = /[\w.:-]/;

/**
 * Builds an element tree from a template literal.
 *
 * @param strings - The literal's static parts.
 * @param values - What was interpolated between them.
 * @returns The one element the template describes.
 */
export function ui(strings: TemplateStringsArray, ...values: unknown[]): Element {
	return emit(parse(strings, values));
}

/**
 * Reads a template into IR without building anything.
 *
 * The half of `ui` a compiler wants, and the reason it is separable: the build
 * emitter has to read a template out of a file, where every `${...}` is text
 * rather than a value, and it reads it *with this parser* -- an `Expr` per
 * interpolation. A toolchain that parsed the syntax itself would be the second
 * parser this design cannot afford, and the day the two disagreed about
 * whitespace or about a closing tag would be the day a template meant
 * different things before and after `sigil build`.
 *
 * Taken as two arrays rather than as a tag's arguments, because a compiler has
 * no template literal to spread: what it has is the quasis it read and the
 * expressions between them.
 *
 * @param strings - The literal's static parts.
 * @param values - What sits between them: a value at runtime, an `Expr` at
 *   build time.
 * @returns The one node the template describes.
 */
export function parse(strings: readonly string[], values: readonly unknown[]): IRNode {
	const parser = new Parser(strings, values);
	const nodes = parser.parseNodes();
	parser.expectEnd();

	// whitespace-only text is dropped and anything else counts, so that text
	// beside the root is *reported* rather than silently discarded: the filter
	// used to drop every text node, so ``ui`hello<box/>` `` quietly emitted the
	// box alone. A run containing a newline is already gone by here, which is
	// what the indentation of a multi-line template is
	const roots = nodes.filter((node) => node.kind !== 'text' || node.value.trim() !== '');
	if (roots.length !== 1) {
		throw new Error(
			`A template produces exactly one element; this one produced ${roots.length}. ` +
				'There is no fragment -- wrap the group in <box>.'
		);
	}

	return roots[0]!;
}

/**
 * A cursor over the interleaving of static strings and interpolated values.
 *
 * The position is a string index and an offset into it. Running off the end of
 * string `i` means value `i` is next, which is what makes a slot a token the
 * parser can ask about rather than a character it has to recognise.
 */
class Parser {
	readonly #strings: readonly string[];
	readonly #values: readonly unknown[];
	#si = 0;
	#ci = 0;

	constructor(strings: readonly string[], values: readonly unknown[]) {
		this.#strings = strings;
		this.#values = values;
	}

	/** Whether the cursor sits on an interpolation. */
	#atSlot(): boolean {
		return this.#ci >= this.#strings[this.#si]!.length && this.#si < this.#values.length;
	}

	/** Whether the whole template has been read. */
	#done(): boolean {
		return this.#si === this.#strings.length - 1 && this.#ci >= this.#strings[this.#si]!.length;
	}

	/**
	 * The character under the cursor, or `''` on a slot or at the end.
	 *
	 * @param ahead - How far to look.
	 * @returns The character, or the empty string.
	 */
	#peek(ahead = 0): string {
		return this.#strings[this.#si]![this.#ci + ahead] ?? '';
	}

	/**
	 * Consumes one character.
	 *
	 * @returns The character consumed.
	 */
	#take(): string {
		const char = this.#peek();
		this.#ci += 1;
		return char;
	}

	/**
	 * Consumes the interpolation under the cursor.
	 *
	 * @returns The value that was interpolated.
	 */
	#takeSlot(): unknown {
		const value = this.#values[this.#si];
		this.#si += 1;
		this.#ci = 0;
		return value;
	}

	/** Consumes a run of whitespace within the current string. */
	#skipSpace(): void {
		while (/\s/.test(this.#peek())) {
			this.#ci += 1;
		}
	}

	/**
	 * Consumes one expected character.
	 *
	 * @param char - What must be there.
	 */
	#expect(char: string): void {
		if (this.#peek() !== char) {
			throw new Error(`Expected "${char}"${this.#where()}`);
		}
		this.#ci += 1;
	}

	/**
	 * Reads a tag or attribute name.
	 *
	 * @returns The name, or the empty string if there is none.
	 */
	#readName(): string {
		if (!NAME_RE.test(this.#peek())) {
			return '';
		}

		let name = this.#take();
		while (NAME_BODY_RE.test(this.#peek())) {
			name += this.#take();
		}
		return name;
	}

	/**
	 * Roughly where the cursor is, for an error message.
	 *
	 * Rough because the real answer is a line and column in the file the
	 * template was written in, which needs the source positions SIG-69 wants
	 * carried through the IR. This is the placeholder for that. Only the static
	 * parts are counted: an interpolated value is not source anybody wrote a
	 * newline into.
	 *
	 * @returns A phrase naming the line within the template.
	 */
	#where(): string {
		return ` on line ${this.loc().line} of the template`;
	}

	/**
	 * Where the cursor is, as a line and column.
	 *
	 * Only the static parts are measured: an interpolated value is not source
	 * anybody wrote a newline into, and counting what it happens to hold at
	 * runtime would make the reported line depend on the data. There is no file
	 * to name -- a tagged template is an expression inside a module the reader is
	 * already looking at, and the line is the line within the template.
	 *
	 * @returns The position.
	 */
	loc(): SourceLocation {
		let source = '';
		for (let i = 0; i < this.#si; i += 1) {
			source += this.#strings[i];
		}
		source += this.#strings[this.#si]!.slice(0, this.#ci);
		const lines = source.split('\n');
		return { column: lines[lines.length - 1]!.length + 1, line: lines.length };
	}

	/** Throws unless everything has been read. */
	expectEnd(): void {
		if (!this.#done()) {
			throw new Error(`Unexpected "${this.#peek()}"${this.#where()}`);
		}
	}

	/**
	 * Reads children until a closing tag or the end of the template.
	 *
	 * @returns The nodes read.
	 */
	parseNodes(): IRNode[] {
		const nodes: IRNode[] = [];
		let run = '';

		let runAt: SourceLocation | undefined;

		const flush = () => {
			const kept = collapse(run);
			if (kept !== '') {
				nodes.push({ kind: 'text', loc: runAt, value: kept });
			}
			run = '';
			runAt = undefined;
		};

		for (;;) {
			if (this.#atSlot()) {
				flush();
				const at = this.loc();
				nodes.push({ kind: 'slot', loc: at, value: this.#takeSlot() });
				continue;
			}

			if (this.#done()) {
				flush();
				return nodes;
			}

			if (this.#peek() === '<') {
				if (this.#peek(1) === '/') {
					flush();
					return nodes;
				}
				if (this.#peek(1) === '!') {
					this.#skipComment();
					continue;
				}
				flush();
				nodes.push(this.#parseElement());
				continue;
			}

			runAt ??= this.loc();
			run += this.#take();
		}
	}

	/** Consumes a `<!-- ... -->` comment. */
	#skipComment(): void {
		this.#expect('<');
		this.#expect('!');
		this.#expect('-');
		this.#expect('-');

		for (;;) {
			if (this.#done()) {
				throw new Error('Unterminated comment');
			}
			if (this.#atSlot()) {
				this.#takeSlot();
				continue;
			}
			if (this.#peek() === '-' && this.#peek(1) === '-' && this.#peek(2) === '>') {
				this.#ci += 3;
				return;
			}
			this.#ci += 1;
		}
	}

	/**
	 * Reads one element, its attributes, and its children.
	 *
	 * @returns The element node.
	 */
	#parseElement(): IRNode {
		const at = this.loc();
		this.#expect('<');

		let type: ComponentRef | Expr | string;
		if (this.#atSlot()) {
			const value = this.#takeSlot();
			// an `Expr` is what the build path interpolates, and it is admitted
			// here rather than checked: a compiler reading a template out of a file
			// cannot know that `${Counter}` names a function, and refusing it would
			// leave the toolchain to parse the syntax itself
			if (typeof value !== 'function' && !(value instanceof Expr)) {
				throw new Error(
					`An interpolated tag must be a component function, got ${typeof value}${this.#where()}`
				);
			}
			type = value as ComponentRef | Expr;
		} else {
			const name = this.#readName();
			if (name === '') {
				throw new Error(`Expected a tag name after "<"${this.#where()}`);
			}
			if (/^[A-Z]/.test(name)) {
				throw new Error(
					`<${name}> names a component, and a tag function has no scope to look a name up in. ` +
						`Interpolate it instead: <\${${name}} />`
				);
			}
			type = name;
		}

		const props: IRProp[] = [];
		let selfClosing = false;

		for (;;) {
			this.#skipSpace();

			if (this.#atSlot()) {
				throw new Error(`A spread attribute is not supported${this.#where()}`);
			}

			const char = this.#peek();

			if (char === '/') {
				this.#ci += 1;
				this.#expect('>');
				selfClosing = true;
				break;
			}

			if (char === '>') {
				this.#ci += 1;
				break;
			}

			if (char === '') {
				throw new Error(`Unclosed tag <${label(type)}>: reached the end of the template`);
			}

			const name = this.#readName();
			if (name === '') {
				throw new Error(`Unexpected "${char}" in <${label(type)}>${this.#where()}`);
			}

			this.#skipSpace();

			if (this.#peek() === '=') {
				this.#ci += 1;
				props.push({ name, value: this.#readValue() });
			} else {
				// a bare attribute is the flag it looks like
				props.push({ name, value: true });
			}
		}

		return {
			children: selfClosing ? [] : this.#parseChildren(type),
			kind: 'element',
			loc: at,
			props,
			type,
		};
	}

	/**
	 * Reads an attribute's value.
	 *
	 * @returns The value: a string when quoted, whatever was interpolated otherwise.
	 */
	#readValue(): unknown {
		// the space *after* `=` is skipped here, and the one before it by the
		// caller. Only the caller used to skip, so `class = "row"` read the space
		// as the start of a bare value, stopped on it immediately, and handed the
		// `"` back to the attribute loop as the start of a name
		this.#skipSpace();

		if (this.#atSlot()) {
			const value = this.#takeSlot();
			this.#afterValue();
			return value;
		}

		const quote = this.#peek();
		if (quote === '"' || quote === "'") {
			this.#ci += 1;
			let value = '';
			for (;;) {
				if (this.#atSlot()) {
					throw new Error(
						`An interpolation inside a quoted value is not supported${this.#where()}; ` +
							'write the whole value as one interpolation'
					);
				}
				const char = this.#peek();
				if (char === '') {
					throw new Error(`Unterminated attribute value${this.#where()}`);
				}
				this.#ci += 1;
				if (char === quote) {
					return value;
				}
				value += char;
			}
		}

		let value = '';
		while (!this.#atSlot() && !this.#done() && !/[\s/>]/.test(this.#peek())) {
			value += this.#take();
		}
		return value;
	}

	/**
	 * Checks that an attribute's value ended where the value ended.
	 *
	 * An interpolation is the whole value, so anything but a separator after it
	 * is a value in two pieces -- `width=${10}px` read `10` and then took `px`
	 * for a bare attribute, which is a silent wrong answer where
	 * `class=foo${bar}` at least throws.
	 */
	#afterValue(): void {
		if (this.#atSlot() || this.#done()) {
			return;
		}
		if (!/[\s/>]/.test(this.#peek())) {
			throw new Error(
				`An interpolated value is the whole value, so "${this.#peek()}" cannot follow it` +
					`${this.#where()}; quote the value or interpolate all of it`
			);
		}
	}

	/**
	 * Reads children and the closing tag that ends them.
	 *
	 * @param type - What was opened, for the error message and the match.
	 * @returns The children.
	 */
	#parseChildren(type: ComponentRef | Expr | string): IRNode[] {
		const children = this.parseNodes();

		if (this.#done()) {
			throw new Error(`Unclosed tag <${label(type)}>`);
		}

		this.#expect('<');
		this.#expect('/');

		if (this.#atSlot()) {
			const closing = this.#takeSlot();
			// two `Expr`s are compared by their source rather than by identity: a
			// compiler makes a fresh one per interpolation, so `</${Counter}>` is
			// never the same object as the `<${Counter}>` it closes, and comparing
			// references refused a template that is closed exactly right
			const matches =
				type instanceof Expr && closing instanceof Expr
					? closing.source === type.source
					: closing === type;
			if (!matches) {
				throw new Error(`<${label(type)}> is closed by <${label(closing as ComponentRef | Expr)}>`);
			}
		} else {
			const name = this.#readName();
			// `</>` closes whatever is open, which is htm's shorthand and is worth
			// having where the opening tag was interpolated
			if (name !== '' && name !== type) {
				throw new Error(`<${label(type)}> is closed by </${name}>`);
			}
		}

		this.#skipSpace();
		this.#expect('>');
		return children;
	}
}

/**
 * Text as it reads once the source's own line breaks are taken out.
 *
 * SIG-70's rule was "preserve a run within a line, drop one that crosses a
 * newline", and deleting the run is right between two elements and wrong inside
 * prose: `hello` and `world` on two lines came out `helloworld`. It also put
 * the two frontends into different languages, which is the one thing this
 * design cannot afford -- JSX's transform joins those lines with a space, so
 * the same template read `hello world` compiled and `helloworld` interpreted.
 *
 * This is JSX's rule instead, which gets both: each line is trimmed of the
 * indentation that only exists because the template is laid out over several
 * lines, blank lines go, and what is left is joined with a single space. So the
 * indentation between two elements still disappears, `<text>Enter your email:
 * </text>` still keeps its trailing space because that run has no newline in
 * it, and prose across two lines reads as two words.
 *
 * @param run - The text as it was written.
 * @returns What it reads as, or the empty string if it was only layout.
 */
function collapse(run: string): string {
	if (!run.includes('\n')) {
		return run;
	}

	const lines = run.split('\n');
	const kept: string[] = [];

	for (const [at, line] of lines.entries()) {
		// only the sides that touch a line break are trimmed: the first line's
		// start and the last line's end are joined to whatever sits beside them in
		// the template, so their whitespace is the author's the same way a run
		// with no newline in it is
		const trimmed = line.slice(
			at === 0 ? 0 : line.length - line.trimStart().length,
			at === lines.length - 1 ? line.length : line.trimEnd().length
		);
		if (trimmed !== '') {
			kept.push(trimmed);
		}
	}

	return kept.join(' ');
}

/**
 * What a tag is called, for an error message.
 *
 * @param type - A host name, a component, or the expression one was
 *   interpolated as.
 * @returns Something readable.
 */
function label(type: ComponentRef | Expr | string): string {
	if (type instanceof Expr) {
		return type.source;
	}
	return typeof type === 'function' ? type.name || 'anonymous component' : type;
}
