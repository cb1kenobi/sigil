/**
 * The build emitter: the same IR, printed as JavaScript instead of built.
 *
 * `emit()` in `@ttylabs/sigil/template` walks the IR and *makes* the elements.
 * This walks the same IR and writes down the calls that would have made them.
 * The output imports nothing from the template layer but the handful of leaf
 * helpers `emit()` itself uses, so an app built this way ships a runtime with
 * the parser, the tag and the IR walk all tree-shaken out of it -- which is the
 * real payoff, and the reason the compiler is worth having at all.
 *
 * ## It is a pure optimizer, and that is what makes it testable
 *
 * It may hoist, fold and decide ahead of time; it may not change what anything
 * evaluates to. No expression is rewritten, because a thunk is what makes a
 * prop reactive in every frontend -- so `${() => count()}` is printed back
 * exactly as it was written, and the generated tree is the interpreted tree.
 * `test/emitters.test.ts` asserts that over a corpus: same structure, same
 * resolved styles, same painted grid, before and after a signal write.
 *
 * ## What it settles at build time
 *
 * Everything the IR already says, which after the analysis pass is most of it:
 *
 * - A prop the template wrote as a literal is not a thunk, so it goes into the
 *   constructor instead of through `applyProp()`.
 * - A `<text>` the analyzer folded to one literal child is `text("...")` rather
 *   than an array and a scan.
 * - A child that is an element is appended directly; only an interpolation goes
 *   through `appendValue()`, because only an interpolation can turn out to be a
 *   thunk, an array, or nothing at all.
 * - A component's children are a static list however many of them there are, so
 *   the call is written out with its props object.
 *
 * Each of those is a line of `ir.ts` read at build time rather than at run
 * time, and each is one the differential test is pointed at.
 *
 * ## Hoisting, and the subtree it will not hoist
 *
 * The static prop objects are hoisted to module scope and deduplicated, so a
 * `For` over two hundred rows allocates no prop object per row. They are safe
 * to share because `Element.#apply()` reads one and never keeps it, and they
 * are frozen so that a future that keeps one is loud rather than silent.
 *
 * A static *subtree* is not hoisted, and the reason is worth knowing because it
 * is the optimization everybody reaches for first: Solid hoists a DOM template
 * and clones it per use, and an `Element` cannot be cloned -- it is mutable, it
 * has one parent, and a component body runs once per instance. A subtree at
 * module scope would be one tree shared by every mount of the component, which
 * is not a faster right answer, it is a wrong one.
 *
 * ## What this does not do, and who does
 *
 * It does not find templates in a file. Given the IR of every template in one
 * module it produces the expression that replaces each of them, the
 * module-scope statements they need, and the imports all of it needs; splicing
 * those into the module, and finding the templates in the first place, is
 * `sigil build`'s (SIG-73), which already owns reading an app off disk.
 *
 * It compiles the `ui` tag rather than JSX, which is not a gap: a `.tsx` is
 * compiled by the app's own TypeScript toolchain into `jsx()` calls, and those
 * carry no parser to shake out. The tag is the frontend that ships one.
 */

import {
	type ComponentRef,
	componentChildren,
	Expr,
	type IRElement,
	type IRNode,
	type IRProp,
	type SourceLocation,
	templateError,
} from '@ttylabs/sigil/template';

/** One name the generated code imports, and what it calls it. */
export interface CompiledBinding {
	/** The name the module exports. */
	readonly imported: string;
	/**
	 * The name the generated code calls, which carries the prefix.
	 *
	 * Aliased rather than imported bare, because the expression is spliced into
	 * a module this compiler has never seen: a component whose prop is called
	 * `text` puts a `text` in scope, and `const $e0 = text("")` then calls it.
	 * The interpreted emitter cannot have this problem -- it holds the function
	 * rather than a name to look up -- which is exactly why it is easy to miss.
	 */
	readonly local: string;
}

/** One module the generated code imports from, and the names it takes. */
export interface CompiledImport {
	/** The module specifier, exactly as it should be written. */
	readonly from: string;
	/** The named imports, sorted by the name the generated code uses. */
	readonly names: readonly CompiledBinding[];
}

/** A module's templates: one expression each, plus what they all need around them. */
export interface Compiled {
	/**
	 * Statements for module scope, in order: the hoisted prop objects.
	 *
	 * Separate from `sources` because a template is compiled into a module that
	 * already exists, and these belong at the top of it rather than inside the
	 * function the template was written in.
	 */
	readonly hoisted: readonly string[];
	/** The modules `sources` and `hoisted` import from. */
	readonly imports: readonly CompiledImport[];
	/**
	 * One expression per template, in the order they were given, each to be
	 * written where its template was.
	 */
	readonly sources: readonly string[];
}

export interface CompileOptions {
	/** Where the host constructors come from. */
	readonly element?: string;
	/**
	 * What every generated name starts with: the bindings, the hoisted objects,
	 * and the imports.
	 *
	 * *Every* one of them, which is the whole point -- the compiler has no idea
	 * what is in scope where its output lands, and an import taken bare is the
	 * one that looks safe and is not. So whoever splices the output in picks
	 * something that cannot collide, and nothing the output names escapes it.
	 *
	 * **It must not occur anywhere in the module the output is spliced into**,
	 * and that is a contract on the caller rather than something this function
	 * can check, because it is handed IR and not a file. It cuts both ways. A
	 * local at the splice site named like a generated one shadows it, which is
	 * the outward half. The inward half is that an interpolated expression is
	 * printed back into the scope those locals are declared in, so a template
	 * whose expression reads a free variable called `$e0` reads the generated
	 * `$e0` instead of the author's. Neither is reachable by a caller that scans
	 * the module for its prefix first, which is a substring search and is
	 * `sigil build`'s to do.
	 */
	readonly prefix?: string;
	/** Where the leaf helpers come from. */
	readonly template?: string;
}

const ELEMENT_MODULE = '@ttylabs/sigil/element';
const TEMPLATE_MODULE = '@ttylabs/sigil/template';

/** What a prefix has to be, since every generated name starts with it. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Compiles a module's templates into the JavaScript that builds them.
 *
 * Every template in one module at once, rather than one call per template,
 * because what comes back is module-level: one set of imports, one hoisted
 * block, one prefix that has to be unique in that module and in nothing else.
 * Compiling them one at a time made the caller merge all three, and merging is
 * where the answers stop being one answer -- twenty templates each asking for
 * `text` under their own prefix is twenty aliases for one import, and two
 * templates that share a prop set share nothing.
 *
 * @param nodes - The IR of each template, in source order. Each should have
 *   been through `analyze()` first -- this prints what the IR says, so a
 *   constant nobody folded is a constant assembled at run time.
 * @param options - Module specifiers and the name prefix.
 * @returns One expression per template, the statements they need at module
 *   scope, and the imports all of it needs.
 */
export function compile(nodes: readonly IRNode[], options: CompileOptions = {}): Compiled {
	const printer = new Printer(options);
	const sources = nodes.map((node) => printer.template(node));
	return printer.finish(sources);
}

/**
 * Writes a set of imports as source, merging the ones that name one module.
 *
 * Merging is the whole reason this is not a one-liner at the call site: a
 * module holding six templates has six `Compiled`s that all want `text`, and
 * six import statements from one specifier is not something anybody should read
 * -- or, in a bundler that has opinions, necessarily accept.
 *
 * @param imports - Every import every template asked for.
 * @returns The import statements, one per module, newline-terminated.
 */
export function renderImports(imports: readonly CompiledImport[]): string {
	const merged = new Map<string, Map<string, string>>();

	for (const { from, names } of imports) {
		let bindings = merged.get(from);
		if (!bindings) {
			bindings = new Map();
			merged.set(from, bindings);
		}
		for (const { imported, local } of names) {
			bindings.set(local, imported);
		}
	}

	// the specifier goes through the same quoting every other string in the
	// output does, which is one rule rather than two and cannot be surprised by
	// a quote or a backslash in a module name
	return [...merged]
		.map(([from, bindings]) => {
			const names = [...bindings]
				.sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
				.map(([local, imported]) => (local === imported ? local : `${imported} as ${local}`));
			return `import { ${names.join(', ')} } from ${quote(from)};\n`;
		})
		.join('');
}

/** Builds the source for one template, collecting what it needs as it goes. */
class Printer {
	readonly #element: string;
	readonly #template: string;
	readonly #prefix: string;

	/** The statements inside the template being printed, in order. */
	readonly #lines: string[] = [];
	/** A hoisted object's source, against the name it was given. */
	readonly #hoisted = new Map<string, string>();
	/** What each module is asked for, as the local name against the exported one. */
	readonly #imports = new Map<string, Map<string, string>>();

	#elements = 0;

	constructor(options: CompileOptions) {
		this.#element = options.element ?? ELEMENT_MODULE;
		this.#template = options.template ?? TEMPLATE_MODULE;
		this.#prefix = options.prefix ?? '$';

		// an empty prefix reopens the bug the prefix exists to close -- every
		// import comes back bare, and a local named `text` at the splice site
		// shadows it again -- and it is the one value a caller can reach by
		// passing something falsy rather than by meaning it
		if (!IDENTIFIER_RE.test(this.#prefix)) {
			throw new Error(
				`A prefix must be a non-empty identifier-safe string, and "${this.#prefix}" is not. ` +
					'Every name the generated code uses starts with it, so it is what keeps the ' +
					'output from colliding with the module it is spliced into.'
			);
		}
	}

	/**
	 * Prints one whole template as one expression.
	 *
	 * A template that needed no statements is an expression on its own -- a lone
	 * `<text>` compiles to `$text("hi")` and nothing else -- so the IIFE is only
	 * written where there is something to put in it. The statement list is this
	 * template's alone; the hoisted objects, the imports and the element counter
	 * are the module's and carry across.
	 *
	 * @param node - The template's IR.
	 * @returns The expression.
	 */
	template(node: IRNode): string {
		this.#lines.length = 0;
		const expression = this.value(node);

		return this.#lines.length === 0
			? expression
			: `(() => {\n${this.#lines.map((line) => `\t${line}\n`).join('')}\treturn ${expression};\n})()`;
	}

	/**
	 * Assembles what every template asked for.
	 *
	 * @param sources - The expressions, in the order the templates were given.
	 * @returns The compiled module.
	 */
	finish(sources: readonly string[]): Compiled {
		return {
			hoisted: [...this.#hoisted].map(([literal, name]) => `const ${name} = ${literal};`),
			imports: [...this.#imports].map(([from, bindings]) => ({
				from,
				names: [...bindings]
					.sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
					.map(([local, imported]) => ({ imported, local })),
			})),
			sources,
		};
	}

	/**
	 * The expression that builds one node.
	 *
	 * Statements the expression depends on are printed first, so a caller may
	 * always interpolate what comes back.
	 *
	 * @param node - The node.
	 * @returns The expression.
	 */
	value(node: IRNode): string {
		if (node.kind === 'text') {
			return `${this.#use(this.#element, 'text')}(${quote(node.value)})`;
		}

		if (node.kind === 'slot') {
			// only ever the root: a slot anywhere else is a child, and a child is
			// appended rather than built
			return `${this.#use(this.#template, 'rootElement')}(${this.#source(node.value)}, ${loc(node.loc)})`;
		}

		if (node.type instanceof Expr) {
			// through `#source()` rather than parenthesized here, so that the callee
			// gets the same treatment every other expression does -- it was the one
			// expression written out in two places, which is how one of them comes
			// to be missing a rule the other has
			return this.#component(node, this.#source(node.type));
		}

		if (typeof node.type === 'function') {
			// a live function has no source to print. It is how a template reaches
			// the IR at run time and it cannot reach a file, so this is a frontend
			// handing the compiler something only the interpreter can use
			throw templateError(
				`<${(node.type as ComponentRef).name || 'anonymous component'}> is a function rather ` +
					'than an expression, so it cannot be compiled: interpolate the component ' +
					'itself, and let the build read its name from the source',
				node.loc
			);
		}

		switch (node.type) {
			case 'box':
				return this.#box(node);
			case 'raw':
				return this.#raw(node);
			case 'text':
				return this.#text(node);
			default:
				throw templateError(
					`Unknown element <${node.type}>. The host types are <box>, <text> and <raw>; ` +
						'a component is interpolated rather than named.',
					node.loc
				);
		}
	}

	/**
	 * Prints a `box` and everything under it.
	 *
	 * @param node - The element node.
	 * @returns The name it was bound to.
	 */
	#box(node: IRElement): string {
		const name = this.#name();
		const statics = this.#statics(node.props);

		this.#lines.push(`const ${name} = ${this.#use(this.#element, 'box')}(${statics.argument});`);
		this.#applyProps(name, statics.rest);

		for (const child of node.children) {
			if (child.kind === 'text') {
				this.#lines.push(
					`${name}.append(${this.#use(this.#element, 'text')}(${quote(child.value)}));`
				);
			} else if (child.kind === 'element') {
				// evaluated before the push, so the child's own statements land first
				const built = this.value(child);
				this.#lines.push(`${name}.append(${built});`);
			} else {
				this.#lines.push(
					`${this.#use(this.#template, 'appendValue')}(${name}, ${this.#source(child.value)});`
				);
			}
		}

		return name;
	}

	/**
	 * Prints a `text`, whose children are its content rather than its nodes.
	 *
	 * @param node - The element node.
	 * @returns The expression, or the name it was bound to.
	 */
	#text(node: IRElement): string {
		const statics = this.#statics(node.props);
		const make = this.#use(this.#element, 'text');
		const tail = statics.argument === '' ? '' : `, ${statics.argument}`;

		// what the analysis pass is for: a content it folded to one literal is a
		// string written into the constructor, with no array, no scan for a thunk
		// and no effect
		const folded = node.children.length === 0 || isFolded(node.children);
		if (folded && statics.rest.length === 0) {
			return `${make}(${quote(content(node.children))}${tail})`;
		}

		const name = this.#name();
		this.#lines.push(
			`const ${name} = ${make}(${quote(folded ? content(node.children) : '')}${tail});`
		);
		this.#applyProps(name, statics.rest);

		if (!folded) {
			const parts = node.children.map((child) => this.#part(child));
			this.#lines.push(
				`${this.#use(this.#template, 'applyText')}(${name}, [${parts.join(', ')}], ${loc(node.loc)});`
			);
		}

		return name;
	}

	/**
	 * One piece of a `text` element's content.
	 *
	 * @param child - The child node.
	 * @returns Its source.
	 */
	#part(child: IRNode): string {
		if (child.kind === 'text') {
			return quote(child.value);
		}
		if (child.kind === 'element') {
			// refused here rather than printed, for the reason `emit()` refuses it
			// before building: this is where the child's own position still is
			throw templateError(
				'An element cannot go inside <text>; there is no inline layout',
				child.loc
			);
		}
		return this.#source(child.value);
	}

	/**
	 * Prints a `raw`, which paints its own cells.
	 *
	 * @param node - The element node.
	 * @returns The expression, or the name it was bound to.
	 */
	#raw(node: IRElement): string {
		if (node.children.length > 0) {
			throw templateError('<raw> paints its own cells, so it cannot have children', node.loc);
		}

		const measure = node.props.find((prop) => prop.name === 'measure')?.value;
		const paint = node.props.find((prop) => prop.name === 'paint')?.value;

		// a value the template wrote out is a value, and a value is never a
		// function -- so this one is decidable now, and a build that fails is
		// better than an app that throws on the frame it is first drawn
		for (const [what, value] of [
			['measure', measure],
			['paint', paint],
		] as const) {
			if (!(value instanceof Expr)) {
				throw templateError(
					`<raw> needs a measure and a paint, and its ${what} is ${
						value === undefined ? 'missing' : 'a value rather than an expression'
					}`,
					node.loc
				);
			}
		}

		const statics = this.#statics(
			node.props.filter((prop) => prop.name !== 'measure' && prop.name !== 'paint')
		);
		const args = [
			this.#source(measure),
			this.#source(paint),
			loc(node.loc),
			...(statics.argument === '' ? [] : [statics.argument]),
		];
		const expression = `${this.#use(this.#template, 'rawElement')}(${args.join(', ')})`;

		if (statics.rest.length === 0) {
			return expression;
		}

		const name = this.#name();
		this.#lines.push(`const ${name} = ${expression};`);
		this.#applyProps(name, statics.rest);
		return name;
	}

	/**
	 * Prints a component call.
	 *
	 * @param node - The element node.
	 * @param callee - The expression the component was interpolated as.
	 * @returns The call.
	 */
	#component(node: IRElement, callee: string): string {
		const entries = node.props.map((prop) => `${quote(prop.name)}: ${this.#source(prop.value)}`);

		// the same children `emit()` hands over, dropped by the same function: a
		// component's children are data it interprets, and a stray space between
		// two tags is never part of that
		const children = componentChildren(node).map((child) =>
			child.kind === 'element'
				? this.value(child)
				: child.kind === 'text'
					? quote(child.value)
					: this.#source(child.value)
		);

		// written last so that it wins over an explicit `children` prop, which is
		// the order `emitComponent()` writes them in
		if (children.length === 1) {
			entries.push(`"children": ${children[0]}`);
		} else if (children.length > 1) {
			entries.push(`"children": [${children.join(', ')}]`);
		}

		// never hoisted, however static it is: a component is handed this object
		// and may keep it, add to it, or pass it on, and one shared between every
		// mount of a component is a bug nobody would look for here
		return `${callee}({${entries.length === 0 ? '' : ` ${entries.join(', ')} `}})`;
	}

	/**
	 * Writes the props an element could not be constructed with.
	 *
	 * @param name - The element's binding.
	 * @param props - The props still to write.
	 */
	#applyProps(name: string, props: readonly IRProp[]): void {
		for (const prop of props) {
			this.#lines.push(
				`${this.#use(this.#template, 'applyProp')}(${name}, ${quote(prop.name)}, ${this.#source(prop.value)});`
			);
		}
	}

	/**
	 * Splits props into the object an element is constructed with and the ones
	 * still to write.
	 *
	 * A prop whose value the template wrote out cannot be a thunk, so it needs no
	 * run-time question asked about it -- it is what a constructor takes. An
	 * interpolation might be either and goes through `applyProp()`, which is the
	 * same function `emit()` asks.
	 *
	 * @param props - Every prop.
	 * @returns The constructor argument, empty when there is nothing to pass, and
	 *   the props left over.
	 */
	#statics(props: readonly IRProp[]): { argument: string; rest: readonly IRProp[] } {
		const names = props.map((prop) => prop.name);
		const repeated = names.length !== new Set(names).size;

		// two props of one name are written in order and the last one wins, and
		// lifting one of them into the constructor reverses that: `color="red"`
		// after `color=${x}` is red until the signal moves, and would have been `x`
		// from the first frame. Nobody writes it, and the fix is to stop
		// reordering rather than to reason about when reordering is safe
		if (repeated) {
			return { argument: '', rest: props };
		}

		const statics: string[] = [];
		const rest: IRProp[] = [];

		for (const prop of props) {
			if (prop.value instanceof Expr) {
				rest.push(prop);
			} else if (prop.value !== undefined) {
				statics.push(`${key(prop.name)}: ${literal(prop.value)}`);
			}
		}

		return {
			argument: statics.length === 0 ? '' : this.#hoist(`Object.freeze({ ${statics.join(', ')} })`),
			rest,
		};
	}

	/**
	 * Lifts a static prop object to module scope, once per distinct object.
	 *
	 * @param literalSource - The object, as source.
	 * @returns The name it was bound to.
	 */
	#hoist(literalSource: string): string {
		const existing = this.#hoisted.get(literalSource);
		if (existing !== undefined) {
			return existing;
		}

		const name = `${this.#prefix}s${this.#hoisted.size}`;
		this.#hoisted.set(literalSource, name);
		return name;
	}

	/**
	 * The source for a value the IR carried.
	 *
	 * @param value - An expression the compiler read, or a value a frontend put
	 *   there.
	 * @returns Its source.
	 */
	#source(value: unknown): string {
		if (!(value instanceof Expr)) {
			return literal(value);
		}

		// parenthesized whatever it is: an arrow function, a sequence, a `yield`
		// and an `in` all read differently as an argument or an object value than
		// they did where they were written, and the compiler does not parse what
		// it was handed well enough to know which.
		//
		// A line comment is what makes the closing paren its own question: an
		// expression ending `foo // why` swallows whatever follows it on that
		// line, which is the `)` that was just written -- a SyntaxError in the
		// generated module, from a template with nothing wrong with it. A newline
		// before the paren costs a line of output and is always right. Asked with
		// `includes` rather than by tokenizing, which is sound in the direction
		// that matters: a source with no `//` in it cannot open a line comment,
		// and a `//` inside a string only costs the newline. `/* */` needs no
		// answer here, since an unterminated one is already an error, and neither
		// does `<!--`, which is not a comment in a module
		return value.source.includes('//') ? `(${value.source}\n)` : `(${value.source})`;
	}

	/**
	 * Records an import and hands back the name to call.
	 *
	 * @param from - The module.
	 * @param name - The name the module exports.
	 * @returns The prefixed name the generated code calls it by.
	 */
	#use(from: string, name: string): string {
		let bindings = this.#imports.get(from);
		if (!bindings) {
			bindings = new Map();
			this.#imports.set(from, bindings);
		}

		const local = `${this.#prefix}${name}`;
		bindings.set(local, name);
		return local;
	}

	/**
	 * A fresh binding for an element.
	 *
	 * @returns The name.
	 */
	#name(): string {
		const name = `${this.#prefix}e${this.#elements}`;
		this.#elements += 1;
		return name;
	}
}

/**
 * Whether a `<text>`'s content is entirely literal.
 *
 * Which is one child after the analysis pass has merged what it could, so this
 * is a question about the fold rather than a second fold: a `<text>` holding
 * two literals is one the analyzer did not see, and assembling it at run time
 * is the honest answer to that.
 *
 * @param children - The content.
 * @returns True when nothing in it can change.
 */
function isFolded(children: readonly IRNode[]): boolean {
	return children.length === 1 && children[0]!.kind === 'text';
}

/**
 * A folded content's string.
 *
 * @param children - The content, which is one text node or none.
 * @returns The string.
 */
function content(children: readonly IRNode[]): string {
	const only = children[0];
	return only?.kind === 'text' ? only.value : '';
}

/**
 * A position, as source.
 *
 * @param at - Where the node was written.
 * @returns The object literal, or `undefined` where the frontend carried none.
 */
function loc(at: SourceLocation | undefined): string {
	if (!at) {
		return 'undefined';
	}
	const file = at.file === undefined ? '' : `file: ${quote(at.file)}, `;
	return `{ column: ${at.column}, ${file}line: ${at.line} }`;
}

/**
 * A prop name, as a key in an object literal.
 *
 * `__proto__` is the one name that is not a key: written plainly or quoted it
 * is prototype sugar, so `{ "__proto__": "x" }` has no own property of that
 * name at all and the prop would be dropped on the way into the constructor. A
 * computed key is an ordinary own property, which is what every other name
 * already gets.
 *
 * Nothing observable depends on it today -- `Element`'s prop store is a plain
 * object, so the interpreted path's `#props["__proto__"] = "x"` is swallowed by
 * `Object.prototype`'s setter and both paths end up with nothing. It is closed
 * anyway, because the rule AGENTS.md already records for the parser's
 * registries is that a name really can be `__proto__`, and the day that store
 * becomes null-prototype is the day this becomes a divergence nobody is looking
 * for.
 *
 * @param name - The prop name.
 * @returns The key, computed only where it has to be.
 */
function key(name: string): string {
	return name === '__proto__' ? `[${quote(name)}]` : quote(name);
}

/**
 * A string, as a JavaScript string literal.
 *
 * `JSON.stringify` rather than quoting by hand: it escapes every control
 * character and every lone surrogate, which is what keeps a generated module
 * free of the raw control characters AGENTS.md records two entries about.
 *
 * @param value - The string.
 * @returns The literal.
 */
function quote(value: string): string {
	return JSON.stringify(value);
}

/**
 * A value the IR carried, as source.
 *
 * @param value - The value.
 * @returns Its literal form.
 */
function literal(value: unknown): string {
	switch (typeof value) {
		case 'bigint':
			return `${value}n`;
		case 'boolean':
			return String(value);
		case 'number':
			// `JSON.stringify` writes `null` for a NaN and an infinity and `0` for a
			// negative zero, none of which is the number it was handed
			return Object.is(value, -0) ? '-0' : String(value);
		case 'string':
			return quote(value);
		case 'undefined':
			return 'undefined';
		default:
			if (value === null) {
				return 'null';
			}
			throw new Error(
				`A ${describe(value)} cannot be written as source. A template reaches the build ` +
					'emitter as text, so everything in it has to be a literal or an expression ' +
					'the compiler read.'
			);
	}
}

/**
 * What a value is, for the error above.
 *
 * @param value - The value.
 * @returns A phrase naming it.
 */
function describe(value: unknown): string {
	if (typeof value === 'function') {
		return value.name ? `function \`${value.name}\`` : 'function';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return `${typeof value} value`;
}
