/**
 * What the build has to say about an app, in one shape.
 *
 * Several passes produce these and they are reported together: the static
 * `desc` lift, the type check, and whatever the bundling stage turns up. One
 * shape rather than one per pass, so there is one reporter and one rule about
 * what stops a build -- a second vocabulary is how two halves of one build come
 * to disagree about whether something was fatal.
 */

/** How much a diagnostic means. */
export type Severity = 'error' | 'warning';

/** Something the build found in a file and has to say out loud. */
export interface Diagnostic {
	/** One-based column, when whatever produced it knew one. */
	readonly column?: number;
	/** The file it is about. */
	readonly file: string;
	/** One-based line, when whatever produced it knew one. */
	readonly line?: number;
	/** What to tell the author, written as the thing to do about it. */
	readonly message: string;
	/** Whether the build can carry on. */
	readonly severity: Severity;
}

/**
 * Whether a set of diagnostics should stop the build.
 *
 * Asked in one place because "what is fatal" is one decision. A warning is
 * something the author should know and the build can live without -- a `desc`
 * nobody could read leaves a command described exactly where an unbundled one
 * is -- while an error is a thing that would produce a broken app.
 *
 * @param diagnostics - Everything found so far.
 * @returns Whether any of it is fatal.
 */
export function isFatal(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

/**
 * A diagnostic as one line, the way every compiler writes one.
 *
 * `file:line:column: severity: message` is what an editor, a terminal and a CI
 * log all already know how to read, so there is nothing to invent.
 *
 * @param diagnostic - The diagnostic.
 * @returns The line, without a trailing newline.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
	const { column, file, line, message, severity } = diagnostic;
	const at =
		line === undefined ? file : `${file}:${line}${column === undefined ? '' : `:${column}`}`;

	return `${at}: ${severity}: ${message}`;
}
