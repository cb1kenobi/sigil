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

import type { Diagnostic } from './diagnostic.js';
import { literalBoolean, literalString, objectLiteral, propertyKey } from './literals.js';
import { parseModule, position, type ParsedModule } from './parse-module.js';
import type { ObjectExpression } from 'oxc-parser';

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

	const declaration = objectLiteral(exported.declaration as never);

	if (!declaration) {
		diagnostics.push({
			...locate(parsed, exported.declaration.start),
			message:
				'the default export is not an object literal, so it cannot be read at build time; help will list this command by name alone',
			severity: 'warning',
		});
		return undefined;
	}

	return declaration;
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
