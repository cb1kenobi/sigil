/**
 * Lifting the descriptions out of a command directory.
 *
 * ## What it is for
 *
 * A filesystem route keeps its description *inside the module*, and importing
 * every module to build a help screen is the one thing the deferral exists to
 * avoid -- so a routed tree lists names and nothing else, which is not help.
 * `Route.desc` says as much where it is declared: a package describes itself in
 * its manifest, "every other kind keeps its description inside the module,
 * which is why it is `undefined` here and why the build has to lift it
 * statically". This is that lift.
 *
 * What it produces is a `RouteInfo` map, which the runtime treats as a **cache
 * over the walk** rather than a manifest: the directory is still read, every
 * route in it is still a command, and a route with no entry here still works
 * and simply lists without a description. So this cannot go stale in a way that
 * loses a command -- only in a way that loses a sentence.
 *
 * ## It walks with the runtime's own reader
 *
 * `readRoutes()` is what the runtime walks with, so using it here is what makes
 * the two agree by construction. A second walk with its own idea of what a
 * route is would be the divergence `routes.ts` exists to prevent, reintroduced
 * by the pass whose whole job is to describe that walk.
 */

import { extractCommand } from './extract.ts';
import type { RouteInfo } from '@ttylabs/sigil';
import { readRoutes } from '@ttylabs/sigil/routes';
import { readFileSync } from 'node:fs';

/** What a lift turned up, alongside what it produced. */
export interface LiftedRoutes {
	/** Every module whose description could not be read, and why. */
	readonly problems: readonly string[];
	/** The descriptions, ready to hand to a schema as `routeInfo`. */
	readonly routeInfo: Record<string, RouteInfo>;
}

/**
 * Reads the descriptions out of a command directory, recursively.
 *
 * @param dir - The directory the filesystem router would walk.
 * @returns The lifted descriptions, and anything that could not be read.
 */
export function liftRouteInfo(dir: string): LiftedRoutes {
	const problems: string[] = [];
	const routeInfo = walk(dir, problems) ?? {};

	return { problems, routeInfo };
}

/** One level, and everything under it. */
function walk(dir: string, problems: string[]): Record<string, RouteInfo> | undefined {
	const level = readRoutes(dir);

	if (!level || level.routes.length === 0) {
		return undefined;
	}

	const info: Record<string, RouteInfo> = {};

	for (const route of level.routes) {
		// a package describes itself in its manifest, which the runtime reads on
		// every walk for free -- and prefers over anything lifted, because that
		// read cannot go stale. Lifting it would bake an answer nobody reads.
		if (route.kind === 'package') {
			continue;
		}

		const entry =
			route.kind === 'directory'
				? directoryEntry(route.path, problems)
				: moduleEntry(route.path, problems);

		if (entry) {
			info[route.name] = entry;
		}
	}

	return Object.keys(info).length > 0 ? info : undefined;
}

/** What a module route contributes: its own facts, if it has any to give. */
function moduleEntry(file: string, problems: string[]): RouteInfo | undefined {
	return entry(factsOf(file, problems));
}

/** What a directory route contributes: its index module's facts, and its children's. */
function directoryEntry(dir: string, problems: string[]): RouteInfo | undefined {
	const level = readRoutes(dir);
	const own = level?.index ? factsOf(level.index, problems) : {};
	const commands = walk(dir, problems);

	return entry(own, commands);
}

/**
 * One entry, with the absent halves left out rather than set to `undefined`.
 *
 * The printed form omits what is absent, so a value carrying `hidden:
 * undefined` is a value that does not match the source printed from it -- and
 * the drift check compares both. Leaving the key out is also what the type
 * means: `hidden?: boolean`, not `boolean | undefined`.
 *
 * @param facts - What was lifted.
 * @param commands - The children, for a directory.
 * @returns The entry, or `undefined` when there is nothing in it.
 */
function entry(
	facts: { desc?: string; hidden?: boolean },
	commands?: Record<string, RouteInfo>
): RouteInfo | undefined {
	const info: { commands?: Record<string, RouteInfo>; desc?: string; hidden?: boolean } = {};

	if (commands) {
		info.commands = commands;
	}
	if (facts.desc !== undefined) {
		info.desc = facts.desc;
	}
	if (facts.hidden !== undefined) {
		info.hidden = facts.hidden;
	}

	return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Reads one module's facts, collecting rather than throwing.
 *
 * A description this cannot read is a command that lists without one, which is
 * exactly where a routed tree was before this existed -- so it is reported and
 * the lift carries on. Failing the build over it would make an unreadable
 * `desc` worse than no `desc` at all.
 *
 * @param file - The module.
 * @param problems - Where to record what could not be read.
 * @returns Whatever it could read.
 */
function factsOf(file: string, problems: string[]): { desc?: string; hidden?: boolean } {
	const { diagnostics, facts } = extractCommand(file, readFileSync(file, 'utf-8'));

	for (const diagnostic of diagnostics) {
		problems.push(`${file}: ${diagnostic.message}`);
	}

	return facts;
}

/**
 * Prints a lifted map as the source of a module.
 *
 * Written in the repo's own format -- tabs, single quotes -- so that the file
 * it produces is one `pnpm check` is already happy with. A generator whose
 * output has to be reformatted afterwards is one whose drift check reformats
 * the working tree every time it runs.
 *
 * @param routeInfo - What to print.
 * @returns The module source, ending in a newline.
 */
export function printRouteInfo(routeInfo: Record<string, RouteInfo>): string {
	const body = Object.entries(routeInfo)
		.map(([name, entry]) => `\t${key(name)}: ${printEntry(entry, 1)},`)
		.join('\n');

	return `// Generated by scripts/generate-commands.mjs. Do not edit.
//
// The descriptions lifted out of src/commands/, so \`sigil --help\` can name
// every command without importing one. Regenerate with:
//
//     node scripts/generate-commands.mjs
//
// \`the committed route info\` in test/commands.test.ts fails if this and the
// command modules have come apart.

import type { RouteInfo } from '@ttylabs/sigil';

export const ROUTE_INFO: Record<string, RouteInfo> = {
${body}
};
`;
}

/** One entry, indented to sit at `depth` tabs. */
function printEntry(entry: RouteInfo, depth: number): string {
	const pad = '\t'.repeat(depth);
	const inner = '\t'.repeat(depth + 1);
	const parts: string[] = [];

	if (entry.commands) {
		const nested = Object.entries(entry.commands)
			.map(([name, child]) => `${inner}\t${key(name)}: ${printEntry(child, depth + 2)},`)
			.join('\n');
		parts.push(`${inner}commands: {\n${nested}\n${inner}},`);
	}
	if (entry.desc !== undefined) {
		parts.push(`${inner}desc: ${quote(entry.desc)},`);
	}
	if (entry.hidden !== undefined) {
		parts.push(`${inner}hidden: ${entry.hidden},`);
	}

	return `{\n${parts.join('\n')}\n${pad}}`;
}

/** A single-quoted string literal, which is what this repo's formatter wants. */
function quote(value: string): string {
	return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/**
 * A property key, quoted only where it has to be.
 *
 * A command name is whatever the file was called, so `my-command` needs the
 * quotes and `build` does not -- and the formatter takes them off the ones that
 * do not, which is a difference this has to match or every regeneration leaves
 * the tree dirty. A reserved word is a legal key and stays bare, which is what
 * `new` is.
 */
function key(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name);
}
