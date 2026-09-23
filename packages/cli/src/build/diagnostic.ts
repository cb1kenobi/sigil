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
 * A path as the report spells it, which is with forward slashes everywhere.
 *
 * `relative()` and `join()` answer with the platform's separator, so a report
 * built from either says `commands\\build.ts` on Windows and
 * `commands/build.ts` on everything else -- the same app described two ways
 * depending on who ran the build. That costs more than it looks: a CI log from
 * one runner cannot be diffed against another's, a snapshot cannot be shared,
 * and a path copied out of a Windows log into an issue is read by nobody's
 * tooling.
 *
 * So the report picks one spelling, and it is the one the build already picked
 * for the specifiers it emits: forward slashes are what every resolver takes,
 * Windows included, and `D:/app/commands/build.ts` is a path Node, a terminal
 * and an editor all still open.
 *
 * Applied where a path becomes *text a person reads*, never to a path still
 * being used to reach a file -- `join()` and `readFile()` get the platform's
 * own spelling, as they always did.
 *
 * @param path - A path, in whatever the platform writes.
 * @returns The same path with forward slashes.
 */
export function displayPath(path: string): string {
	return path.replaceAll('\\', '/');
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
	// every diagnostic goes through here, so this is the one place the rule has
	// to be applied for all of them
	const shown = displayPath(file);
	const at =
		line === undefined ? shown : `${shown}:${line}${column === undefined ? '' : `:${column}`}`;

	return `${at}: ${severity}: ${message}`;
}
