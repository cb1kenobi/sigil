/**
 * Reading a module as a tree, which is what the build does instead of running
 * it.
 *
 * Everything the build has to know about a command module is a question about
 * its *source*: what its description says, whether it is hidden, which
 * templates are in it. Importing it to ask would run its top-level code, and a
 * command module is allowed to do things there -- read a config file, open a
 * connection, exit -- so the build reads rather than imports. That is the same
 * reason the runtime defers an import until argv names the command, reached
 * from the other end.
 *
 * ## One parser
 *
 * `oxc-parser` is the parser rolldown already embeds, so the toolchain has one
 * and not two. It handles every extension a route may have without a compile
 * step of its own -- `.ts`, `.mts` and `.cts` included, decided off the
 * filename the way Node's own type stripping is -- and hands back ESTree, which
 * is a shape anybody reading this file already knows.
 *
 * ## Offsets are string indices
 *
 * A node's `start` and `end` are **UTF-16 code unit offsets**: `source.slice()`
 * takes them directly. They are not UTF-8 byte offsets, which is the other
 * plausible convention and the one that would corrupt every expression this
 * slices the moment a template above it held a non-ASCII character -- silently,
 * and only for that app. `should slice an expression by string index` pins it,
 * because a parser that changed its mind about this would look exactly like one
 * that had not.
 *
 * ## A line is counted only when something needs one
 *
 * Positions are carried as offsets and turned into a line and a column when a
 * diagnostic is built, which is the rule the stylesheet parser already follows:
 * counting newlines per node makes reading a module with nothing wrong with it
 * quadratic in its own length.
 */

import {
	type Comment,
	type EcmaScriptModule,
	type ParserOptions,
	parseSync,
	type Program,
} from 'oxc-parser';

/** A module, read. */
export interface ParsedModule {
	/** Its comments, in source order. */
	readonly comments: readonly Comment[];
	/** The path it was read from, for anything it has to report. */
	readonly file: string;
	/**
	 * What it imports and exports, as oxc records it.
	 *
	 * Worth having rather than walking the tree for: the local name a binding
	 * was imported under is exactly the question "which of these tagged
	 * templates is a `ui` template", and this answers it without a scope walk.
	 */
	readonly module: EcmaScriptModule;
	/** Its tree. */
	readonly program: Program;
	/** Its source, kept because a node is a span into it. */
	readonly source: string;
}

/** Where in a file something is, counted for a human. */
export interface Position {
	/** One-based. */
	readonly column: number;
	/** One-based. */
	readonly line: number;
}

/**
 * Reads a module.
 *
 * @param file - Where it came from. Its extension is what decides whether the
 *   source is TypeScript, so it has to be the real name rather than a label.
 * @param source - The source.
 * @returns The tree, and what is needed to read spans out of it.
 * @throws If the source does not parse.
 */
export function parseModule(file: string, source: string): ParsedModule {
	const result = parseSync(file, source);

	// a module that does not parse is not a module this build can say anything
	// about, and guessing past a syntax error is how a build reports a missing
	// description for a file whose real problem is a missing brace
	const failure = result.errors.find((error) => error.severity === 'Error') ?? result.errors[0];
	if (failure) {
		const at = failure.labels[0]?.start;
		const where = at === undefined ? file : `${file}:${formatPosition(position(source, at))}`;
		throw new Error(`Failed to parse ${where}: ${failure.message}`);
	}

	return {
		comments: result.comments,
		file,
		module: result.module,
		program: result.program,
		source,
	};
}

/**
 * Whether oxc said anything at all about a parse.
 *
 * One definition of "does not parse", shared by the three readers below, because
 * `parseModule()` reports any entry oxc hands back whatever its severity and a
 * second reader that counted only the ones marked `Error` would be a second
 * answer to one question. Measured over every bundle this repo produces -- 114
 * chunks across the fixtures, `packages/cli/dist` and `packages/sigil/dist` --
 * oxc returns no entry of any severity for code that is fine, so the two
 * readings agree today and this is about keeping them agreeing.
 *
 * @param result - What oxc handed back.
 * @returns Whether it failed.
 */
function failed(result: { readonly errors: readonly unknown[] }): boolean {
	return result.errors.length > 0;
}

/**
 * Whether a source parses at all, which is the question `parseModule()` throws
 * about said as a boolean.
 *
 * Deliberately does **not** touch `result.program`. The AST is deserialized
 * lazily, and reaching for it is the expensive half: measured, asking only about
 * the errors over the 9 chunks of a built fixture is 2.0ms and touching
 * `.program` as well is 9.9ms -- five times, for a question that does not need
 * a tree. `parseTree()` is the one that pays it, and it is only ever reached on a
 * path that is already failing.
 *
 * @param file - Where it came from. Its extension is what decides the language,
 *   and for a chunk of an `esm` bundle the `.mjs` it is named is also what says
 *   the source is a module -- which is the whole of what this clause asks.
 * @param source - The source.
 * @returns Whether it parsed.
 */
export function parses(file: string, source: string): boolean {
	return !failed(parseSync(file, source));
}

/**
 * The tree, or nothing if the source did not parse.
 *
 * The companion to `parses()` for a caller that has to look at what is *in* a
 * source rather than only whether it reads -- which is a different question and
 * is what stops a parse differential being used as a proxy for one. It costs the
 * AST deserialization, so see `parses()` for why the two are separate functions.
 *
 * @param file - Where it came from.
 * @param source - The source.
 * @param options - Passed through.
 * @returns The program, or `undefined`.
 */
export function parseTree(
	file: string,
	source: string,
	options?: ParserOptions
): Program | undefined {
	const result = parseSync(file, source, options);

	return failed(result) ? undefined : result.program;
}

/**
 * The line and column one offset falls on.
 *
 * @param source - The source the offset is into.
 * @param offset - A UTF-16 code unit offset, as every node carries.
 * @returns The one-based line and column.
 */
export function position(source: string, offset: number): Position {
	// clamped rather than trusted: an offset past the end is a bug somewhere
	// above, and a diagnostic is the worst place to turn one bug into two
	const end = Math.max(0, Math.min(offset, source.length));

	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < end; i++) {
		if (source[i] === '\n') {
			line++;
			lineStart = i + 1;
		}
	}

	return { column: end - lineStart + 1, line };
}

/**
 * A position as `line:column`, which is what an editor and a terminal both
 * understand.
 *
 * @param at - The position.
 * @returns The text.
 */
export function formatPosition(at: Position): string {
	return `${at.line}:${at.column}`;
}
