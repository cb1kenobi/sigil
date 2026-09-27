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
 * Where a diagnostic is, as `file`, `file:line`, or `file:line:column`.
 *
 * Its own function because two things print it: the one-line form below, which
 * is what a pipe gets, and the laid-out form in `report.ts`, which is what a
 * terminal gets. Those are two renderings of one diagnostic and they must agree
 * about the location exactly -- it is what an editor jumps to and what a CI log
 * is grepped for -- so there is one implementation of it rather than two that
 * agree for now.
 *
 * `displayPath()` is applied here, which makes this the one place the
 * forward-slash rule has to hold for every diagnostic however it is printed.
 *
 * @param diagnostic - The diagnostic.
 * @returns The location, with no trailing colon.
 */
export function diagnosticLocation(diagnostic: Diagnostic): string {
	const { column, file, line } = diagnostic;
	const shown = displayPath(file);

	return line === undefined ? shown : `${shown}:${line}${column === undefined ? '' : `:${column}`}`;
}

/**
 * A diagnostic as one line, the way every compiler writes one.
 *
 * `file:line:column: severity: message` is what an editor, a terminal and a CI
 * log all already know how to read, so there is nothing to invent. This is the
 * form a **pipe** gets, and `report.ts` is what lays the same diagnostic out for
 * a terminal -- the split is `tsc --pretty`'s, for the reason that flag exists.
 *
 * @param diagnostic - The diagnostic.
 * @returns The line, without a trailing newline.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
	return `${diagnosticLocation(diagnostic)}: ${diagnostic.severity}: ${diagnostic.message}`;
}
