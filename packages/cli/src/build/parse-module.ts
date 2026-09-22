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

import { type Comment, type EcmaScriptModule, parseSync, type Program } from 'oxc-parser';

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
