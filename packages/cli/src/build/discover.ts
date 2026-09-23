/**
 * Finding the app: its root, its entry, and where it keeps its commands.
 *
 * Step one of the pipeline, and the one that decides whether anything else has
 * something to work on. A caller that already knows where the commands are can
 * say so and skip all of this; a caller standing in a directory cannot, and
 * "run it from the app root and it works out the rest" is the whole of what
 * makes a toolchain feel like one.
 *
 * ## `@ttylabs/sigil` in the manifest is what makes it an app
 *
 * Checked before anything else, because every error after it would be a worse
 * version of the same message. A directory that does not depend on the runtime
 * is not an app this can check, and saying that is more use than reporting that
 * it has no `commands/` directory.
 *
 * It is any kind of dependency -- a `dependency`, a `devDependency`, a
 * `peerDependency` -- since which one an app declares is a packaging decision
 * and none of them makes it less of a sigil app.
 *
 * ## Source first, manifest second
 *
 * The obvious entry is `bin`, and it is usually the wrong file: a published CLI
 * points its `bin` at built output, so following it means parsing a minified
 * bundle whose import specifiers are chunk names a bundler invented. `check`
 * reads what the author edits and what the build will compile, so it looks for
 * a source entry by convention first and falls back to what the manifest names
 * only when there is none.
 *
 * That is a heuristic, so the entry it picked is *reported* rather than assumed
 * -- and `--entry` overrides it. A guess nobody can see is the kind that costs
 * an afternoon.
 *
 * ## The schema is read, not run
 *
 * An app's `commands` is either a path -- the filesystem router, which
 * `resolveCommandTree()` already walks -- or an object written out. Both are
 * read off the entry's source, because running it would run the app.
 */

import { type Diagnostic, displayPath } from './diagnostic.ts';
import { factsOf } from './extract.ts';
import {
	literalBoolean,
	literalString,
	objectLiteral,
	plainProperty,
	propertyKey,
} from './literals.ts';
import { parseModule, position, type ParsedModule } from './parse-module.ts';
import type { ResolvedCommand } from './tree.ts';
import { walk } from './walk.ts';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Expression, ObjectExpression, Node } from 'oxc-parser';

/** What makes a directory an app this can check. */
const RUNTIME = '@ttylabs/sigil';

/**
 * Where a source entry is looked for, in order.
 *
 * `index` before `main` and `cli` because it is what every other tool means by
 * an entry, and `src/` before the root because an app with both keeps its
 * sources in one and its output in the other.
 */
const ENTRY_NAMES = ['src/index', 'src/main', 'src/cli', 'src/app', 'index', 'main', 'cli'];

/** The extensions a module may have, in the order they are tried. */
const EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** What an app's manifest says that matters here. */
export interface AppManifest {
	/** Every dependency it declares, however it declares them. */
	readonly dependencies: readonly string[];
	/** What it calls itself. */
	readonly name?: string;
	/** Where the manifest is. */
	readonly path: string;
}

/** An app, found. */
export interface DiscoveredApp {
	/** The module its schema was read from. */
	readonly entry: string;
	/** What its manifest said. */
	readonly manifest: AppManifest;
	/** Its root, which is where the manifest is. */
	readonly root: string;
}

/** Where an app keeps its commands, as its entry declares them. */
export type AppCommands =
	| {
			/** The directory the filesystem router walks. */
			readonly dir: string;
			readonly kind: 'directory';
	  }
	| {
			/** The commands the schema wrote out. */
			readonly commands: readonly ResolvedCommand[];
			readonly kind: 'inline';
	  };

/** How to find an app. */
export interface DiscoverOptions {
	/** The entry to read, when the conventions should not be trusted. */
	readonly entry?: string;
}

/**
 * Finds the app rooted at a directory.
 *
 * @param cwd - Where to look.
 * @param options - An entry, when the caller knows better than the conventions.
 * @returns The app.
 * @throws If there is no manifest, if it does not depend on the runtime, or if
 *   no entry can be found. Each is a thing to fix rather than to report and
 *   carry on from, because none of them leaves anything to check.
 */
export function discoverApp(cwd: string, options: DiscoverOptions = {}): DiscoveredApp {
	const root = resolve(cwd);
	const manifest = readManifest(root);

	// asked first, because every error after this one would be a worse version
	// of the same message
	if (!manifest.dependencies.includes(RUNTIME)) {
		throw new Error(
			`${manifest.path} does not depend on ${RUNTIME}, so there is no sigil app here to check`
		);
	}

	const entry = options.entry
		? resolveEntry(root, options.entry)
		: findEntry(root, readManifestEntries(manifest.path));

	if (!entry) {
		throw new Error(
			`No entry module found in ${root}. Looked for ${ENTRY_NAMES.map((name) => `${name}.*`).join(', ')} and what the manifest names; pass --entry to name one`
		);
	}

	return { entry, manifest, root };
}

/**
 * Reads what an app's manifest says about itself.
 *
 * @param root - The app's root.
 * @returns Its manifest.
 * @throws If there is no manifest, or it will not parse.
 */
export function readManifest(root: string): AppManifest {
	const path = join(root, 'package.json');

	let raw;
	try {
		raw = readFileSync(path, 'utf-8');
	} catch {
		throw new Error(`No package.json in ${root}; sigil runs from an app's root`);
	}

	let json;
	try {
		json = JSON.parse(raw) as Record<string, unknown>;
	} catch (e: unknown) {
		throw new Error(`Failed to parse ${path}: ${(e as Error).message}`);
	}

	const dependencies = new Set<string>();
	for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
		const declared = json[field];
		if (declared && typeof declared === 'object') {
			for (const name of Object.keys(declared)) {
				dependencies.add(name);
			}
		}
	}

	return {
		dependencies: [...dependencies],
		name: typeof json.name === 'string' ? json.name : undefined,
		path,
	};
}

/**
 * The entries a manifest names, as paths relative to the app.
 *
 * Last resort rather than first guess: a published CLI points its `bin` at
 * built output, and parsing a bundle is not what anybody means by checking an
 * app.
 *
 * @param manifestPath - The manifest.
 * @returns The relative paths it names.
 */
function readManifestEntries(manifestPath: string): string[] {
	const json = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
		bin?: string | Record<string, string>;
		main?: string;
	};

	const named: string[] = [];

	if (typeof json.bin === 'string') {
		named.push(json.bin);
	} else if (json.bin && typeof json.bin === 'object') {
		named.push(...Object.values(json.bin));
	}

	if (typeof json.main === 'string') {
		named.push(json.main);
	}

	return named;
}

/**
 * The first entry that exists, source conventions before the manifest.
 *
 * @param root - The app's root.
 * @param named - What the manifest named.
 * @returns The entry, or `undefined`.
 */
function findEntry(root: string, named: readonly string[]): string | undefined {
	for (const name of ENTRY_NAMES) {
		for (const extension of EXTENSIONS) {
			const candidate = join(root, `${name}${extension}`);
			if (isFile(candidate)) {
				return candidate;
			}
		}
	}

	for (const entry of named) {
		const candidate = resolve(root, entry);
		if (isFile(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * An entry the caller named, resolved and checked.
 *
 * @param root - The app's root.
 * @param entry - What they said.
 * @returns The path.
 * @throws If it is not a file.
 */
function resolveEntry(root: string, entry: string): string {
	const path = isAbsolute(entry) ? entry : resolve(root, entry);

	if (!isFile(path)) {
		throw new Error(`Entry module not found: ${displayPath(path)}`);
	}

	return path;
}

/**
 * Whether a path is a file that exists.
 *
 * @param path - The path.
 * @returns Whether to read it.
 */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolves an import specifier the way the module holding it would.
 *
 * The `.js` to `.ts` fallback is the one that matters and is not a guess: a
 * TypeScript ES module imports its neighbour as `./check.js` even though the
 * file on disk is `check.ts`, which is the convention this repo follows itself.
 * Without it every command a schema declares through `load` would come back
 * unresolved.
 *
 * @param from - The directory the specifier was written in.
 * @param specifier - What it said.
 * @returns The file, or `undefined` when nothing answers to it.
 */
export function resolveSpecifier(from: string, specifier: string): string | undefined {
	// a bare specifier is a package rather than a file in this app, and a
	// package's commands are its own business
	if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
		return undefined;
	}

	const base = isAbsolute(specifier) ? specifier : resolve(from, specifier);

	if (isFile(base)) {
		return base;
	}

	// `./check.js` where the file is `check.ts`
	const swapped = base.replace(/\.[cm]?js$/, '');
	if (swapped !== base) {
		for (const extension of EXTENSIONS) {
			const candidate = `${swapped}${extension}`;
			if (isFile(candidate)) {
				return candidate;
			}
		}
	}

	for (const extension of EXTENSIONS) {
		if (isFile(`${base}${extension}`)) {
			return `${base}${extension}`;
		}
	}

	// a directory is its index module
	for (const extension of EXTENSIONS) {
		const candidate = join(base, `index${extension}`);
		if (isFile(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * Reads where an app's entry says its commands are.
 *
 * @param app - The app.
 * @returns What its schema declares, and anything reading it turned up.
 */
export function readAppCommands(app: DiscoveredApp): {
	commands?: AppCommands;
	diagnostics: readonly Diagnostic[];
	/**
	 * Whether the entry declared `commands` at all.
	 *
	 * Apart from `commands` being `undefined`, which covers the other case too:
	 * a schema that declares commands this cannot *read* has already been
	 * reported on, and a caller adding "no commands found" on top would be
	 * saying one problem twice and getting the second one wrong.
	 */
	found: boolean;
} {
	const parsed = parseModule(app.entry, readFileSync(app.entry, 'utf-8'));
	const diagnostics: Diagnostic[] = [];

	const schemas = outermostWithCommands(parsed.program as never);

	if (!schemas.length) {
		return { diagnostics, found: false };
	}

	if (schemas.length > 1) {
		// more than one schema in one module is a thing this cannot choose
		// between, and choosing by source order would be choosing by accident
		diagnostics.push({
			...at(parsed, schemas[1]!.start),
			message: `found ${schemas.length} schemas in this module; pass --commands to say which command directory to check`,
			severity: 'warning',
		});
		return { diagnostics, found: true };
	}

	const declared = plainProperty(schemas[0]!, 'commands')!;
	const entryDir = dirname(app.entry);

	const asPath = literalString(declared.value);
	if (asPath !== undefined) {
		// A relative path here means two different things unless the schema says
		// what it is relative to. This pass resolves it against the entry module;
		// the runtime has no file to resolve an inline schema against, so it falls
		// back to the process's working directory -- which for an installed CLI is
		// wherever the user was standing. So the app builds and runs bundled, and
		// throws `Unsupported command module` the moment anybody runs it from
		// source, while this command reports no problems at all.
		//
		// A warning rather than an error because the *built* app is genuinely
		// fine, and an app that only ever ships bundled is not wrong. What is
		// wrong is this command having nothing to say about it.
		if (!isAbsolute(asPath) && !plainProperty(schemas[0]!, 'baseDir')) {
			diagnostics.push({
				...at(parsed, declared.value.start),
				message:
					`"commands" is a relative path and the schema sets no "baseDir", so this resolves it ` +
					`against ${displayPath(entryDir)} while the runtime resolves it against the working ` +
					`directory. Add \`baseDir: import.meta.dirname\` to the schema.`,
				severity: 'warning',
			});
		}

		return {
			commands: { dir: resolve(entryDir, asPath), kind: 'directory' },
			diagnostics,
			found: true,
		};
	}

	const written = objectLiteral(declared.value);
	if (!written) {
		diagnostics.push({
			...at(parsed, declared.value.start),
			message:
				'"commands" is computed rather than a path or an object literal, so it cannot be read at build time; pass --commands to name a command directory',
			severity: 'error',
		});
		return { diagnostics, found: true };
	}

	return {
		commands: { commands: readInline(written, entryDir, parsed, diagnostics), kind: 'inline' },
		diagnostics,
		found: true,
	};
}

/**
 * Every object literal in a module that declares `commands`, with the ones
 * nested inside another such object left out.
 *
 * A schema's `commands` holds commands, and a command may hold `commands` of
 * its own -- so the outermost is the schema and everything under it is a
 * subcommand this walk will reach anyway.
 *
 * @param program - The module's tree.
 * @returns The outermost schemas, in source order.
 */
function outermostWithCommands(program: Node): ObjectExpression[] {
	const found: ObjectExpression[] = [];

	walk(program, (node) => {
		if (node.type !== 'ObjectExpression') {
			return true;
		}

		const object = node as unknown as ObjectExpression;
		if (!plainProperty(object, 'commands')) {
			return true;
		}

		found.push(object);

		// claimed: everything below is this schema's own commands
		return false;
	});

	return found;
}

/**
 * Reads a `commands` object literal into commands.
 *
 * @param object - The literal.
 * @param from - What its specifiers are relative to.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @returns One command per property.
 */
function readInline(
	object: ObjectExpression,
	from: string,
	parsed: ParsedModule,
	diagnostics: Diagnostic[]
): ResolvedCommand[] {
	const commands: ResolvedCommand[] = [];

	for (const property of object.properties) {
		if (property.type === 'SpreadElement') {
			diagnostics.push({
				...at(parsed, property.start),
				message: '"commands" spreads another object, which may carry commands this cannot see',
				severity: 'warning',
			});
			continue;
		}

		const name = propertyKey(property);
		if (!name) {
			diagnostics.push({
				...at(parsed, property.start),
				message: 'a command is declared under a computed key, so its name cannot be read',
				severity: 'warning',
			});
			continue;
		}

		commands.push(readCommand(name, property.value, from, parsed, diagnostics));
	}

	return commands;
}

/**
 * Reads one declared command.
 *
 * @param name - What it is called.
 * @param value - What it was declared as.
 * @param from - What its specifiers are relative to.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @returns The command.
 */
function readCommand(
	name: string,
	value: Expression,
	from: string,
	parsed: ParsedModule,
	diagnostics: Diagnostic[]
): ResolvedCommand {
	// `commands: { build: './build.js' }` is a path, which the runtime resolves
	// as one command however many files sit behind it
	const asPath = literalString(value);
	if (asPath !== undefined) {
		return {
			commands: [],
			kind: 'inline',
			...moduleFacts(resolveSpecifier(from, asPath), asPath, name, parsed, diagnostics, value),
			name,
		};
	}

	const object = objectLiteral(value);
	if (!object) {
		diagnostics.push({
			...at(parsed, value.start),
			message: `the "${name}" command is computed rather than a literal, so nothing about it can be read at build time`,
			severity: 'warning',
		});
		return { commands: [], kind: 'inline', name };
	}

	const specifier = moduleSpecifier(object);
	const nested = plainProperty(object, 'commands');
	const declaredDesc = plainProperty(object, 'desc');
	const declaredHidden = plainProperty(object, 'hidden');

	// what the *placeholder* declares is what help shows before the module loads,
	// so a readable `desc` here is the answer to every question the module's own
	// readability could have raised -- which is why it silences them. All of
	// `factsOf()`'s diagnostics are about what help would show pre-load, and a
	// `hidden` the module computes is what the `!` name prefix is for
	const described = declaredDesc !== undefined && literalString(declaredDesc.value) !== undefined;

	const facts = moduleFacts(
		specifier ? resolveSpecifier(from, specifier) : undefined,
		specifier,
		name,
		parsed,
		diagnostics,
		value,
		described
	);

	return {
		commands: nested
			? objectLiteral(nested.value)
				? readInline(objectLiteral(nested.value)!, from, parsed, diagnostics)
				: []
			: [],
		// what the *placeholder* declares is what help shows before the module
		// loads, so it wins over what the module says -- which is the runtime's
		// merge read from the other side
		desc: declaredDesc ? (literalString(declaredDesc.value) ?? facts.desc) : facts.desc,
		hidden: declaredHidden ? (literalBoolean(declaredHidden.value) ?? facts.hidden) : facts.hidden,
		kind: 'inline',
		module: facts.module,
		name,
	};
}

/**
 * The specifier a command declares its module by, whichever way it declares it.
 *
 * `load: () => import('./x.js')` and `path: './x.js'` are the same statement --
 * the module *is* the command -- said as a function and as a file.
 *
 * @param object - The command literal.
 * @returns The specifier, or `undefined`.
 */
function moduleSpecifier(object: ObjectExpression): string | undefined {
	const path = plainProperty(object, 'path');
	if (path) {
		return literalString(path.value);
	}

	const load = plainProperty(object, 'load');
	if (!load) {
		return undefined;
	}

	// the one shape a bundler can see and this can read: an arrow whose body is
	// a dynamic import of a literal
	let body = load.value;
	if (body.type === 'ArrowFunctionExpression') {
		const inner = body.body;
		body = (inner.type === 'BlockStatement' ? undefined : inner) ?? body;
	}

	return body.type === 'ImportExpression' ? literalString(body.source) : undefined;
}

/**
 * What a command's module says about itself, when there is one to read.
 *
 * @param module - The resolved path, if it resolved.
 * @param specifier - What was written, for the message when it did not.
 * @param name - The command, for the message.
 * @param parsed - The entry, for positions.
 * @param diagnostics - Where to report.
 * @param at_ - The node to point at.
 * @param described - Whether the placeholder already said what help shows.
 * @returns Its facts and its module.
 */
function moduleFacts(
	module: string | undefined,
	specifier: string | undefined,
	name: string,
	parsed: ParsedModule,
	diagnostics: Diagnostic[],
	at_: { start: number },
	described = false
): { desc?: string; hidden?: boolean; module?: string } {
	if (!module) {
		if (specifier) {
			diagnostics.push({
				...at(parsed, at_.start),
				message: `the "${name}" command imports "${specifier}", which could not be resolved to a file`,
				severity: 'error',
			});
		}
		return {};
	}

	// the module the schema points at is a command module like any other, so it
	// is read the same way -- which is what makes `check` check the commands
	// rather than only the tree above them
	const read = factsOf(parseModule(module, readFileSync(module, 'utf-8')));

	// an `error` is the module being unusable rather than merely unreadable -- no
	// default export at all -- and that is worth saying however well the
	// placeholder describes it
	for (const diagnostic of read.diagnostics) {
		if (!described || diagnostic.severity === 'error') {
			diagnostics.push(diagnostic);
		}
	}

	return { ...read.facts, module };
}

/**
 * A position in the entry, counted because a diagnostic is being built.
 *
 * @param parsed - The module.
 * @param offset - Where in it.
 * @returns The file, line and column.
 */
function at(parsed: ParsedModule, offset: number): { column: number; file: string; line: number } {
	const { column, line } = position(parsed.source, offset);
	return { column, file: parsed.file, line };
}
