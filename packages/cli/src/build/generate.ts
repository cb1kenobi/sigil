/**
 * Printing a resolved tree as the schema literal a built app carries.
 *
 * What comes out is a `commands` object, nested as deep as the tree goes, with
 * a `load` where the unbundled tree had a directory to walk:
 *
 * ```js
 * export const commands = {
 *   build: {
 *     desc: "build the app",
 *     load: () => import("./commands/build.js"),
 *   },
 *   db: {
 *     commands: {
 *       migrate: {
 *         desc: "run migrations",
 *         load: () => import("./commands/db/migrate.js"),
 *       },
 *     },
 *   },
 * };
 * ```
 *
 * ## Why a `load` and not a `path`
 *
 * A `path` is a file to `stat` and a URL to build, and a bundled app has
 * neither: its command modules are chunks a bundler named. A dynamic `import()`
 * with a literal specifier is the one thing a bundler can see, follow, and
 * rewrite -- so the deferral that makes `mycli --help` fast survives bundling
 * instead of being flattened into the entry chunk.
 *
 * ## The specifier is a specifier, not a path
 *
 * `relative()` answers with the platform's separator, and a backslash in an
 * import specifier is not a path separator -- it is an escape, so a Windows
 * build would emit `import("./commands\build.js")` and fail at run time on the
 * machine that built it. Every specifier is written with forward slashes and
 * carries an explicit `./`, since a bare `commands/build.js` is a *package*
 * specifier to every resolver there is.
 *
 * ## It prints what the tree says and decides nothing
 *
 * No `name` is emitted, because the key a command is declared under names it
 * and a `name` beside it would be a second answer. Nothing is emitted for a
 * command the tree gave no module -- a namespace directory -- so it keeps the
 * runtime's behaviour of matching, listing, and having nothing to run. And a
 * `desc` or `hidden` the extractor could not read is simply absent, which
 * leaves the command exactly where an unbundled one is: described once its
 * module loads.
 */

import type { ResolvedCommand, ResolvedTree } from './tree.js';
import { relative, sep } from 'node:path';

/** How to print a tree. */
export interface GenerateOptions {
	/**
	 * The directory the generated module will sit in.
	 *
	 * Every `import()` specifier is written relative to it, because that is what
	 * a specifier in that module means.
	 */
	readonly from: string;
	/**
	 * What to call the exported binding.
	 *
	 * Defaults to `commands`, which is the shape a schema wants it in:
	 * `schema: { commands }`.
	 */
	readonly name?: string;
}

/** One tab, since the repo's formatter uses them. */
const INDENT = '\t';

/**
 * Prints a resolved tree as a module.
 *
 * @param tree - The tree.
 * @param options - Where the module lands, and what to call the export.
 * @returns The module's source, newline-terminated.
 */
export function generateCommands(tree: ResolvedTree, options: GenerateOptions): string {
	const name = options.name ?? 'commands';

	return `export const ${name} = ${printCommands(tree.commands, options.from, 0)};\n`;
}

/**
 * Prints one level of commands as an object literal.
 *
 * @param commands - The commands.
 * @param from - The directory specifiers are relative to.
 * @param depth - How far in, for the indentation.
 * @returns The literal.
 */
function printCommands(commands: readonly ResolvedCommand[], from: string, depth: number): string {
	if (!commands.length) {
		return '{}';
	}

	const pad = INDENT.repeat(depth + 1);
	const body = commands
		.map((command) => `${pad}${quoteKey(command.name)}: ${printCommand(command, from, depth + 1)},`)
		.join('\n');

	return `{\n${body}\n${INDENT.repeat(depth)}}`;
}

/**
 * Prints one command as an object literal.
 *
 * @param command - The command.
 * @param from - The directory specifiers are relative to.
 * @param depth - How far in, for the indentation.
 * @returns The literal.
 */
function printCommand(command: ResolvedCommand, from: string, depth: number): string {
	const pad = INDENT.repeat(depth + 1);
	const fields: string[] = [];

	// the keys are written in the order a reader wants them: what it is, then how
	// to get it, then what is under it -- so a nested tree reads top-down rather
	// than opening with a subtree and mentioning the command afterwards
	if (command.desc !== undefined) {
		fields.push(`${pad}desc: ${quote(command.desc)},`);
	}

	if (command.hidden !== undefined) {
		fields.push(`${pad}hidden: ${command.hidden},`);
	}

	if (command.module) {
		fields.push(`${pad}load: () => import(${quote(specifier(from, command.module))}),`);
	}

	if (command.commands.length) {
		fields.push(`${pad}commands: ${printCommands(command.commands, from, depth + 1)},`);
	}

	if (!fields.length) {
		// a directory with nothing in it that this could say anything about. The
		// runtime still registers it, so an empty literal is the honest print
		return '{}';
	}

	return `{\n${fields.join('\n')}\n${INDENT.repeat(depth)}}`;
}

/**
 * The import specifier that reaches a module from the generated one.
 *
 * @param from - The directory the generated module sits in.
 * @param module - The module, as an absolute path.
 * @returns The specifier, with forward slashes and an explicit `./`.
 */
export function specifier(from: string, module: string): string {
	// `sep` rather than a literal backslash, so the swap is the running
	// platform's separator rather than a guess about which one it was
	const parts = relative(from, module).split(sep).join('/');

	// a specifier with no leading `./` is a package specifier to every resolver
	// there is, so `commands/build.js` would be looked for in `node_modules`
	return parts.startsWith('.') ? parts : `./${parts}`;
}

/**
 * A key, quoted only where it has to be.
 *
 * A command name is whatever a file was called, so it may be anything a file
 * name can be -- `my-command` is the ordinary case and is not an identifier.
 *
 * @param name - The key.
 * @returns It, bare or quoted.
 */
function quoteKey(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name);
}

/**
 * A string as JavaScript source.
 *
 * `JSON.stringify` and not a template literal, because a description is
 * somebody's prose: it may hold a quote, a backslash, or a newline, and JSON's
 * escaping is the one already known to be right about all three. The two line
 * terminators JSON leaves raw are escaped after it, since they are line breaks
 * to a JavaScript parser and would end the string.
 *
 * @param value - The string.
 * @returns Its source.
 */
function quote(value: string): string {
	return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}
