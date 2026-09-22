/**
 * Lifting what help needs out of a command module without importing it.
 *
 * ## The problem this exists for
 *
 * A lazily loaded command appears in help by name alone until its module is
 * read, because its `desc` lives inside that module and reading it means
 * importing it. That was a rare case when a `path` was something you
 * hand-wrote. Filesystem routing makes it the common one, so a root `--help`
 * over a routes tree prints:
 *
 * ```
 * Commands:
 *   build
 *   config
 *   db
 *   deploy
 * ```
 *
 * Help that lists sixty commands by name alone is not help. **The runtime
 * cannot fix this**, and that is not a gap in it: knowing a description means
 * importing the module, and not importing it is the entire point of the
 * deferral. So the fix has to happen where somebody is already reading every
 * file -- the build -- and the answer has to be baked into what it emits.
 *
 * ## What is lifted, and what deliberately is not
 *
 * `desc` and `hidden`, and nothing else. Both are things *help* reads, and
 * baking them makes a built app answer a question an unbundled one can only
 * answer after a load. That asymmetry is the point rather than a divergence to
 * avoid: unbundled is the one that is wrong, and the `!` name prefix already
 * exists precisely because `hidden` could not be seen in time.
 *
 * `name` and `alias` are the ones it would be tempting to lift next, and doing
 * so would be a bug. They decide *routing* -- what a user types -- and the
 * runtime rule is that only the placeholder's name can match, because the
 * command has to be matched before the module that renames it can be loaded.
 * Baking a module's own `name` would make a command reachable bundled under a
 * spelling that does not resolve unbundled, which is exactly the "routes
 * differently bundled and unbundled" failure the shared route rules exist to
 * prevent. So they stay where they are.
 *
 * ## A computed value is reported, never guessed
 *
 * `desc: greeting()` cannot be read from source, and the two wrong answers are
 * to invent something and to fail the build. It is a *warning* with a file and
 * a line: the command keeps the description it would have had unbundled, which
 * is none until it loads, and the author is told which file and why. A module
 * with no default export at all is an `error`, because that is a module the
 * runtime would refuse too -- the build is just finding out first.
 *
 * A spread is the case worth knowing about, because it looks harmless.
 * `export default { ...base, hidden: true }` may well carry a `desc` inside
 * `base`, and nothing in this file can see it -- so an absent `desc` beside a
 * spread is reported rather than taken as "there is none", which is the
 * difference between a description the build missed and a description that was
 * never written.
 */

import { parseModule, position, type ParsedModule } from './parse-module.js';
import type {
	Expression,
	ExportDefaultDeclarationKind,
	ObjectExpression,
	ObjectProperty,
} from 'oxc-parser';

/** How much a diagnostic means. */
export type Severity = 'error' | 'warning';

/** Something the build found in a file and has to say out loud. */
export interface Diagnostic {
	/** One-based column, when the node carried a position. */
	readonly column?: number;
	/** The file it is about. */
	readonly file: string;
	/** One-based line, when the node carried a position. */
	readonly line?: number;
	/** What to tell the author, written as the thing to do about it. */
	readonly message: string;
	/** Whether the build can carry on. */
	readonly severity: Severity;
}

/** What a command module says about itself, read statically. */
export interface CommandFacts {
	/**
	 * Its description, when the module wrote one as a literal.
	 *
	 * `undefined` covers two different situations on purpose, and the
	 * diagnostics are what tell them apart: the module wrote no `desc`, or it
	 * wrote one this cannot read.
	 */
	readonly desc?: string;
	/** Whether it hides itself, when the module wrote a boolean literal. */
	readonly hidden?: boolean;
}

/** One module's facts, and what reading it turned up. */
export interface Extracted {
	readonly diagnostics: readonly Diagnostic[];
	readonly facts: CommandFacts;
}

/** The keys this lifts, so the set is one list rather than several checks. */
const LIFTED = ['desc', 'hidden'] as const;

/**
 * Reads what a command module says about itself.
 *
 * @param file - Where the source came from; its extension decides TypeScript.
 * @param source - The module's source.
 * @returns Its facts and every diagnostic reading it produced.
 * @throws If the source does not parse. A file that is not a module is not a
 *   thing to warn about and carry on from.
 */
export function extractCommand(file: string, source: string): Extracted {
	return factsOf(parseModule(file, source));
}

/**
 * Reads what an already-parsed command module says about itself.
 *
 * Separate from `extractCommand()` because the build parses each module once
 * and asks it several questions -- this one and `templatesIn()` -- and parsing
 * per question is the cost nobody notices until a tree has sixty commands in
 * it.
 *
 * @param parsed - The module.
 * @returns Its facts and every diagnostic reading it produced.
 */
export function factsOf(parsed: ParsedModule): Extracted {
	const diagnostics: Diagnostic[] = [];
	const at = (offset?: number) => locate(parsed, offset);

	const object = defaultObject(parsed, diagnostics);
	if (!object) {
		return { diagnostics, facts: {} };
	}

	const facts: { desc?: string; hidden?: boolean } = {};
	let spread: number | undefined;

	for (const property of object.properties) {
		if (property.type === 'SpreadElement') {
			spread ??= property.start;
			continue;
		}

		const key = propertyKey(property);
		if (!key || !(LIFTED as readonly string[]).includes(key)) {
			continue;
		}

		// a getter or a setter is a function, whatever it would have returned, and
		// a method shorthand is the same thing written differently
		if (property.kind !== 'init' || property.method) {
			diagnostics.push({
				...at(property.start),
				message: `"${key}" is an accessor rather than a value, so it cannot be read at build time; help will fall back to loading the module`,
				severity: 'warning',
			});
			continue;
		}

		const value = property.value;

		if (key === 'desc') {
			const text = literalString(value);
			if (text === undefined) {
				diagnostics.push({
					...at(value.start),
					message:
						'"desc" is computed rather than a string literal, so it cannot be read at build time; help will list this command by name alone',
					severity: 'warning',
				});
				continue;
			}
			facts.desc = text;
			continue;
		}

		const flag = literalBoolean(value);
		if (flag === undefined) {
			diagnostics.push({
				...at(value.start),
				message:
					'"hidden" is computed rather than a boolean literal, so it cannot be read at build time; this command will be listed in help until its module loads',
				severity: 'warning',
			});
			continue;
		}
		facts.hidden = flag;
	}

	// a spread can carry anything, so an absent key beside one is unknown rather
	// than absent -- which is the whole difference between a description the
	// build missed and one nobody wrote
	if (spread !== undefined && facts.desc === undefined) {
		diagnostics.push({
			...at(spread),
			message:
				'the default export spreads another object, which may carry a "desc" this cannot see; write "desc" on the exported object to have it appear in help',
			severity: 'warning',
		});
	}

	return { diagnostics, facts };
}

/**
 * The object literal a module default-exports, or `undefined` with a
 * diagnostic saying why there is none.
 *
 * @param parsed - The module.
 * @param diagnostics - Where to report.
 * @returns The object expression.
 */
function defaultObject(
	parsed: ParsedModule,
	diagnostics: Diagnostic[]
): ObjectExpression | undefined {
	const exported = parsed.program.body.find((node) => node.type === 'ExportDefaultDeclaration');

	if (!exported) {
		// `export { cmd as default }` is a default export the runtime is perfectly
		// happy with, so this is about what *this pass* can read rather than about
		// the module being wrong -- which is why it is not the error below
		const indirect = parsed.program.body.some(
			(node) =>
				node.type === 'ExportNamedDeclaration' &&
				node.specifiers.some(
					(spec) => spec.exported.type === 'Identifier' && spec.exported.name === 'default'
				)
		);

		diagnostics.push({
			file: parsed.file,
			message: indirect
				? 'the default export is a reference rather than an object literal, so it cannot be read at build time; help will list this command by name alone'
				: 'no default export found; a command module must default-export a command object',
			severity: indirect ? 'warning' : 'error',
		});
		return undefined;
	}

	const declaration = unwrap(exported.declaration);

	if (declaration.type !== 'ObjectExpression') {
		diagnostics.push({
			...locate(parsed, declaration.start),
			message:
				'the default export is not an object literal, so it cannot be read at build time; help will list this command by name alone',
			severity: 'warning',
		});
		return undefined;
	}

	return declaration;
}

/**
 * Looks through the wrappers that do not change what a value is.
 *
 * `command()` is the one that matters: it is documented as the identity
 * function and exists only so inference reaches a nested literal, so a
 * template wrapped in it says exactly what the bare literal says. `as` and
 * `satisfies` are type syntax and erase to nothing. Parentheses are nothing at
 * all.
 *
 * A call is unwrapped whatever it is called, rather than only when it is
 * spelled `command`: the name is the app's to choose -- it may be imported
 * under another one, or be a wrapper of the app's own -- and the thing being
 * read is a literal sitting inside it either way. What that costs is a
 * `withDefaults({ desc: 'a' })` whose own body overrides `desc`, which reads
 * back as `'a'`; that is a warning-free wrong answer, and it is the reason the
 * unwrap stops at a call with exactly one argument that is an object literal,
 * since a wrapper doing anything more interesting than passing it through
 * almost always takes something else too.
 *
 * @param node - The expression.
 * @returns The expression worth reading.
 */
function unwrap(node: ExportDefaultDeclarationKind): ExportDefaultDeclarationKind {
	let current = node;

	for (;;) {
		if (
			current.type === 'TSAsExpression' ||
			current.type === 'TSSatisfiesExpression' ||
			current.type === 'ParenthesizedExpression' ||
			current.type === 'TSNonNullExpression'
		) {
			current = current.expression;
			continue;
		}

		if (current.type === 'CallExpression' && current.arguments.length === 1) {
			const [argument] = current.arguments;
			// a spread argument is not an object literal however it was written, and
			// `unwrapShallow()` answers for an expression rather than for an element
			if (argument && argument.type !== 'SpreadElement') {
				const inner = unwrapShallow(argument);
				if (inner.type === 'ObjectExpression') {
					current = inner;
					continue;
				}
			}
		}

		return current;
	}
}

/**
 * The type-only wrappers off one node, without looking through a call.
 *
 * Its own function because `unwrap()` has to ask "would this argument be an
 * object literal" before deciding to step into the call, and asking with
 * `unwrap()` itself would recurse through the call it is still deciding about.
 *
 * @param node - The expression.
 * @returns The expression under the type syntax.
 */
function unwrapShallow(node: Expression): Expression {
	let current = node;
	while (
		current.type === 'TSAsExpression' ||
		current.type === 'TSSatisfiesExpression' ||
		current.type === 'ParenthesizedExpression' ||
		current.type === 'TSNonNullExpression'
	) {
		current = current.expression;
	}
	return current;
}

/**
 * The name a property declares, or `undefined` when it does not declare one
 * statically.
 *
 * A computed key is `undefined` even when it happens to hold a string, because
 * `['desc']` and `[key]` are the same syntax and only one of them is readable
 * -- and a pass that reads the easy half of a construct it does not support is
 * worse than one that skips it, since the half it skipped is silent.
 *
 * @param property - The property.
 * @returns The key.
 */
function propertyKey(property: ObjectProperty): string | undefined {
	if (property.computed) {
		return undefined;
	}

	const { key } = property;

	if (key.type === 'Identifier') {
		return key.name;
	}

	// `{ 'desc': 'x' }` is the same declaration written with quotes
	if (key.type === 'Literal' && typeof key.value === 'string') {
		return key.value;
	}

	return undefined;
}

/**
 * The string a node is, when it is one written down.
 *
 * A template literal with no substitutions counts: `` `build the app` `` is a
 * string somebody wrote, and refusing it would make the two spellings of one
 * thing disagree. One *with* substitutions does not, because its value is not
 * in the source.
 *
 * @param node - The expression.
 * @returns The string, or `undefined`.
 */
function literalString(node: Expression): string | undefined {
	const value = unwrapShallow(node);

	if (value.type === 'Literal' && typeof value.value === 'string') {
		return value.value;
	}

	if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
		return value.quasis[0]?.value.cooked ?? undefined;
	}

	return undefined;
}

/**
 * The boolean a node is, when it is one written down.
 *
 * Only `true` and `false`. A `hidden: 1` is not a boolean, and the runtime
 * throws on a non-boolean `hidden` rather than coercing it -- so reading it as
 * truthy here would bake a value the app it came from refuses to start with.
 *
 * @param node - The expression.
 * @returns The boolean, or `undefined`.
 */
function literalBoolean(node: Expression): boolean | undefined {
	const value = unwrapShallow(node);

	return value.type === 'Literal' && typeof value.value === 'boolean' ? value.value : undefined;
}

/**
 * A diagnostic's location, counted now because a diagnostic is being built.
 *
 * @param parsed - The module.
 * @param offset - Where in it, if anywhere.
 * @returns The file, and the line and column when there is an offset.
 */
function locate(
	parsed: ParsedModule,
	offset?: number
): { column?: number; file: string; line?: number } {
	if (offset === undefined) {
		return { file: parsed.file };
	}

	const { column, line } = position(parsed.source, offset);
	return { column, file: parsed.file, line };
}
