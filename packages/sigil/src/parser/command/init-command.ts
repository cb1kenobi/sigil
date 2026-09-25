import debug from '../../debug/index.js';
import {
	Command,
	Internal,
	InternalArgument,
	InternalCommand,
	InternalState,
	RouteInfo,
	Schema,
} from '../../types.js';
import { copyDeclaration } from '../../util/copy-declaration.js';
import { lockDerived } from '../../util/lock-derived.js';
import { initArgs } from '../argument/init-args.js';
import { OptionRegistry } from '../option/option-registry.js';
import { CommandRegistry } from './command-registry.js';
import {
	moduleName,
	readDirectory,
	readPackage,
	readRoutes,
	resolveRoutes,
	type Route,
	routeName,
} from './routes.js';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { log } = debug('sigil:init-command');

const nameSplitRegExp = /[, ]+/;

/**
 * "-a"
 * "-a, --all"
 * "-a --all"
 * "--no-colors"
 * "--opt <value>"
 * "--opt [value]"
 * "--opt=<value>"
 */
// const optionFormatRE = /^(?:-(\w)(?:[ ,|]+)?)?(?:--(no-)?([^\s=]+))?(?:[\s=]+(.+))?$/;

type CommandsLike = Command | InternalCommand | Schema;

interface ParsedName {
	aliases: string[];
	args: string[];
	hidden: boolean;
	label: string;
	name: string;
}

/**
 * Builds an internal command from a declaration.
 *
 * The declaration is only ever read. The parsed name, the `hidden` flag, the
 * normalized arguments, and the `Internal` state are all written to a new
 * object this library owns, so parsing the same schema twice sees the same
 * schema twice and a frozen declaration parses like any other.
 *
 * @param it - The command or schema declaration.
 * @param entryFile - The module this declaration came from, when lazy loaded.
 * @param baseDir - The directory this declaration's relative paths are
 * relative to, when that is not the directory `entryFile` sits in -- a command
 * declared inline inside a lazily loaded module came from that module's file
 * without being that file.
 * @returns A new internal command.
 */
export async function initCommand(
	it: CommandsLike,
	entryFile?: string,
	baseDir?: string
): Promise<InternalCommand> {
	if (typeof it === 'object' && Internal in it && it[Internal].state === InternalState.OK) {
		return it as InternalCommand;
	}

	const decl = it as Command;

	if (!decl.name || typeof decl.name !== 'string') {
		throw new TypeError('Expected command name to be a non-empty string');
	}

	log(`Initializing command "${decl.name}"`);

	const aliases = new Set<string>();
	const args: InternalArgument[] = [];
	const commands = new CommandRegistry();
	const options = new OptionRegistry();

	if (decl.run !== undefined && typeof decl.run !== 'function') {
		throw new TypeError(`Invalid run function in "${decl.name}" command`);
	}

	// the module at `path` *is* the command -- `loadCommand()` builds the merge
	// from its export and fills in only what the module left undefined -- so an
	// inline `run` beside a `path` is a handler that runs whenever the module
	// happens not to declare one, and a path that cannot be read is a hard error
	// however good the inline handler was. Refused where the schema is built,
	// the way two `default` siblings and a `...` hint on an option are, because
	// there is no right answer to pick and picking one silently is what makes it
	// a trapdoor
	if (decl.path !== undefined && decl.run !== undefined) {
		throw new Error(
			`Cannot combine "path" with "run" in the "${decl.name}" command: the module at "path" is the command, so an inline run would never be reached`
		);
	}

	if (decl.load !== undefined && typeof decl.load !== 'function') {
		throw new TypeError(`Invalid load function in "${decl.name}" command`);
	}

	// `load` is `path` said as a function rather than as a file, so it is the
	// same statement and collides with the same things: three answers to "what
	// is this command" and no right one to pick between them. Refused here for
	// the reason the pair above is -- picking silently is what makes it a
	// trapdoor -- and refused against `path` as well, since a command with both
	// would fetch its module twice by two mechanisms and merge whichever won
	if (decl.load !== undefined && decl.run !== undefined) {
		throw new Error(
			`Cannot combine "load" with "run" in the "${decl.name}" command: the module "load" imports is the command, so an inline run would never be reached`
		);
	}

	if (decl.load !== undefined && decl.path !== undefined) {
		throw new Error(
			`Cannot combine "load" with "path" in the "${decl.name}" command: both name the module that is the command, so only one of them can be it`
		);
	}

	if (decl.hidden !== undefined && typeof decl.hidden !== 'boolean') {
		throw new TypeError(`Expected hidden to be a boolean in "${decl.name}" command`);
	}

	if (decl.default !== undefined && typeof decl.default !== 'boolean') {
		throw new TypeError(`Expected default in "${decl.name}" command to be a boolean`);
	}

	const parsed = parseName(decl.name);

	for (const alias of parsed.aliases) {
		aliases.add(alias);
	}

	if (decl.alias !== undefined) {
		const aliasList = typeof decl.alias === 'string' ? [decl.alias] : decl.alias;
		if (Array.isArray(aliasList)) {
			for (const alias of aliasList) {
				if (typeof alias !== 'string') {
					throw new TypeError('Expected command alias to be a string or list of strings');
				}
				aliases.add(alias);
			}
		} else {
			throw new TypeError('Expected command alias to be a string or list of strings');
		}
	}

	// args
	let argDecls = decl.args;
	if (parsed.args.length) {
		if (decl.args?.length) {
			throw new Error(`Cannot combine command arguments with inline arguments "${decl.name}"`);
		}
		argDecls = parsed.args;
	}

	if (argDecls !== undefined) {
		if (!Array.isArray(argDecls)) {
			throw new TypeError('Expected arguments to be an array');
		}

		args.push(...initArgs(argDecls, `the "${parsed.name}" command`));
	}

	if (parsed.name !== decl.name) {
		log(`Command name changed "${decl.name}" -> "${parsed.name}"`);
	}

	// where the declaration came from has to be settled before its subcommands
	// are registered rather than after: a path one of them gives is relative to
	// the file that declared it, and asking after they are built is asking too
	// late
	//
	// a command left dirty by a failed init hook is rebuilt from scratch, so
	// recover the module it came from -- and the directory its paths were
	// resolved against, which is the file that declared the command rather than
	// the file its `path` resolved to, and is not recoverable from that file
	const dirty = it[Internal];
	if (dirty) {
		entryFile ??= dirty.path;
		baseDir ??= dirty.baseDir;
	} else if (entryFile) {
		baseDir ??= dirname(entryFile);
	}

	const commandPath = decl.path;
	if (commandPath) {
		entryFile = resolveDeclaredPath(baseDir, commandPath);
	}

	// commands
	if (decl.commands !== undefined) {
		if (decl.commands && typeof decl.commands === 'string') {
			await registerCommandPath({
				baseDir,
				commands,
				file: decl.commands,
				routeInfo: decl.routeInfo,
			});
		} else if (Array.isArray(decl.commands)) {
			await Promise.all(
				decl.commands.map((cmdOrPath) =>
					registerCommand({
						baseDir,
						cmdOrPath,
						commands,
						routeInfo: decl.routeInfo,
					})
				)
			);
		} else if (decl.commands && typeof decl.commands === 'object') {
			await Promise.all(
				Object.entries(decl.commands).map(([name, cmdOrPath]) =>
					registerCommand({
						baseDir,
						cmdOrPath,
						commands,
						name,
						routeInfo: decl.routeInfo,
					})
				)
			);
		} else {
			throw new TypeError('Expected commands to be one or more paths or an object');
		}
	}

	// options
	if (decl.options !== undefined) {
		if (!decl.options || typeof decl.options !== 'object') {
			throw new TypeError('Expected options to be an object');
		}

		for (const [format, params] of Object.entries(decl.options)) {
			if (params === undefined || params === null) {
				await options.add({ format });
			} else if (typeof params === 'string') {
				await options.add({ desc: params, format });
			} else if (typeof params === 'object') {
				// the format key fills in for a missing `format`, but folding it in
				// must not write to the caller's option object
				await options.add({ ...params, format: params.format ?? format });
			} else {
				throw new TypeError('Expected option to be an object');
			}
		}
	}

	const cmd = Object.defineProperty(cloneDeclaration(decl, parsed, argDecls), Internal, {
		configurable: true,
		value: {
			aliases,
			args,
			baseDir,
			commands,
			label: parsed.label,
			load: decl.load,
			// a placeholder has not pulled its module in yet; `loadCommand()`
			// flips this only once the import and the module's own init have
			// both succeeded
			loaded: false,
			options,
			path: entryFile,
			// the command is not fully initialized until its init hooks have
			// run, so a hook that throws leaves it dirty and it is rebuilt the
			// next time it is initialized rather than silently accepted
			state: InternalState.Dirty,
		},
	}) as InternalCommand;

	// `cmd.args`, `cmd.commands`, and `cmd.options` echo the declaration; the
	// parser reads the normalized arguments and the registries on `Internal`,
	// which are a different shape on purpose — an inline `<arg>` in the name, a
	// subcommand still waiting on its module, and an option's parsed spellings
	// only exist on the internal side
	lockDerived(
		cmd,
		['args', 'commands', 'options'],
		(prop) =>
			`Cannot set "${prop}" on the initialized "${parsed.name}" command: the parser reads cmd[Internal].${prop}, so change that instead`
	);

	// `beforeError` and `help` are fired elsewhere -- by the error path and by the
	// help module -- and are checked here anyway, because those are the two places
	// where a value that is not a function does the most harm: one is reached only
	// when something has already gone wrong, and the other only when somebody asks
	// for help and gets an error instead
	for (const name of ['beforeError', 'help', 'init', 'parse'] as const) {
		const hook = decl.hooks?.[name];
		if (hook !== undefined && typeof hook !== 'function') {
			throw new TypeError(`Expected command ${name} hook to be a function`);
		}
	}

	await decl.hooks?.init?.({ cmd, ...cmd[Internal] });

	cmd[Internal].state = InternalState.OK;

	return cmd;
}

/**
 * Copies a command declaration into a fresh object for the library to own and
 * normalize.
 *
 * Every container is copied too — a consumer that reaches into `cmd.args`,
 * `cmd.commands`, or `cmd.options` and changes something must not be editing
 * the schema they handed in. Values inside those containers are shared, since
 * cloning a user's `run` handler or `transform` is not something a library can
 * do, but nothing here writes to them.
 *
 * @param decl - The caller's declaration.
 * @param parsed - The pieces parsed out of the declaration's name string.
 * @param argDecls - The effective argument declarations, inline or otherwise.
 * @returns A new command object.
 */
function cloneDeclaration(decl: Command, parsed: ParsedName, argDecls: Command['args']): Command {
	const cmd: Command = copyDeclaration(decl);

	cmd.name = parsed.name;

	// A `!` prefixed name and an explicit `hidden` are additive: either one
	// hides the command. An explicit `hidden: false` does not un-hide a `!`
	// prefixed name; drop the `!` to make the command visible.
	cmd.hidden = parsed.hidden || decl.hidden === true;

	if (argDecls !== undefined) {
		cmd.args = Array.isArray(argDecls) ? [...argDecls] : argDecls;
	}

	if (decl.commands && typeof decl.commands === 'object') {
		cmd.commands = (
			Array.isArray(decl.commands) ? [...decl.commands] : { ...decl.commands }
		) as Command['commands'];
	}

	if (decl.options && typeof decl.options === 'object') {
		cmd.options = { ...decl.options };
	}

	// the hooks object is copied, so replacing one on the command a hook was
	// handed does not reach back into the caller's declaration and change what
	// every later parse of that schema does. One function rather than a list, so
	// there is nothing inside it left to copy: a caller that wants two things to
	// happen writes a hook that does both, or wraps the one that is there
	if (decl.hooks && typeof decl.hooks === 'object') {
		cmd.hooks = { ...decl.hooks };
	}

	return cmd;
}

function parseName(unparsedName: string): ParsedName {
	const aliases: string[] = [];
	const args: string[] = [];
	const labels: string[] = [];
	let hidden = false;
	let name: string | undefined;
	let fallbackName: string | undefined;

	for (let label of unparsedName.split(nameSplitRegExp)) {
		if (!label) {
			// a leading, trailing, or doubled separator
			continue;
		}

		const c = label[0];
		if ('<['.includes(c)) {
			args.push(label);
			continue;
		}

		if (c === '!') {
			// "!" hides the command, not just the label it sits on, so a stray
			// "!" still hides rather than quietly doing nothing
			hidden = true;
		}

		if ('!@'.includes(c)) {
			label = label.slice(1);
			if (!label) {
				// a stray "!" or "@" declares no name
				continue;
			}
			aliases.push(label);
			// a prefixed label names the command only if no bare label does
			fallbackName ??= label;
		} else if (name === undefined) {
			// the first bare label is the name...
			name = label;
		} else {
			// ...and every bare label after it is an alias
			aliases.push(label);
		}

		if (c !== '!') {
			labels.push(label);
		}
	}

	name ??= fallbackName;

	if (!name) {
		throw new Error(`Unable to determine command name from "${unparsedName}"`);
	}

	return {
		aliases,
		args,
		hidden,
		label: labels.join(', '),
		name,
	};
}

/**
 * Resolves a path a declaration gave against the file that declared it.
 *
 * A relative path in a command module means there what it means in an `import`:
 * a file alongside that module. Left to resolve on its own it is relative to
 * the process's working directory instead, which for an installed CLI is
 * whatever directory the user happened to be standing in and has nothing to do
 * with where its command modules live.
 *
 * `resolve()` rather than `join()`, because an absolute path is already an
 * answer: joining one onto a base makes a path to nowhere out of a path that
 * was never ambiguous.
 *
 * @param baseDir - The directory the declaration's paths are relative to, or
 * `undefined` for a schema the app wrote inline, which has no file to be
 * relative to.
 * @param file - The path as it was declared.
 * @returns Where to look for the module.
 */
function resolveDeclaredPath(baseDir: string | undefined, file: string): string {
	return baseDir ? resolve(baseDir, file) : file;
}

async function registerCommand({
	baseDir,
	cmdOrPath,
	commands,
	name,
	routeInfo,
}: {
	baseDir?: string;
	cmdOrPath: string | Command;
	commands: CommandRegistry;
	name?: string;
	routeInfo?: Record<string, RouteInfo>;
}): Promise<void> {
	if (cmdOrPath && typeof cmdOrPath === 'string') {
		await registerCommandPath({
			baseDir,
			commands,
			file: cmdOrPath,
			name,
			routeInfo,
		});
	} else if (cmdOrPath && typeof cmdOrPath === 'object') {
		// the key a command is declared under names it, but that name belongs on
		// the copy `initCommand()` makes, not on the caller's object
		//
		// the declaration is inline, so it came from the same file its parent did
		// and its paths are relative to that file -- it has no module of its own
		// for them to be relative to, which is why the base is passed rather than
		// the entry file
		commands.add(
			await initCommand(
				cmdOrPath.name === undefined ? { ...cmdOrPath, name } : cmdOrPath,
				undefined,
				baseDir
			)
		);
	} else {
		throw new TypeError('Expected commands to be one or more paths or an object');
	}
}

/**
 * Registers whatever a declared path points at.
 *
 * A path names one command when the declaration named it -- the key it was
 * written under in a `commands` object -- and a directory *of* commands when it
 * did not. That asymmetry is the whole of it: `commands: './commands'` means
 * every entry inside becomes a sibling, which is the one place a single path
 * produces more than one command, while `commands: { db: './db' }` means one
 * command called `db` however many files are behind it.
 */
async function registerCommandPath({
	baseDir,
	commands,
	file,
	name,
	routeInfo,
}: {
	baseDir?: string;
	commands: CommandRegistry;
	file: string;
	name?: string;
	routeInfo?: Record<string, RouteInfo>;
}): Promise<void> {
	const modulePath = resolveDeclaredPath(baseDir, file);

	if (name) {
		commands.add(await commandAtPath(modulePath, name, routeInfo?.[name]));
		return;
	}

	// a package is one command even unnamed, because its module names itself.
	// Asked before the walk, since a package *is* a directory and walking one
	// would register its internals as commands
	const pkg = await registerCommandPackage(modulePath);
	if (pkg) {
		commands.add(pkg);
		return;
	}

	const entries = readDirectory(modulePath);
	if (entries) {
		for (const route of resolveRoutes(modulePath, entries)) {
			commands.add(await routeCommand(route, routeInfo?.[route.name]));
		}
		return;
	}

	const filename = moduleName(modulePath);

	if (!filename) {
		throw new Error(`Unsupported command module "${modulePath}"`);
	}

	commands.add(await initCommand({ name: filename }, modulePath));
}

/**
 * Builds the one command a named path points at.
 *
 * @param modulePath - Where to look.
 * @param name - What the declaration called it.
 * @returns The command, initialized but not necessarily loaded.
 */
async function commandAtPath(
	modulePath: string,
	name: string,
	info: RouteInfo | undefined
): Promise<InternalCommand> {
	// a package the declaration pointed at keeps the rule it has always had: its
	// module is imported now and names itself, which is why the key it was
	// written under does not win. Only a package a *walk* found is deferred and
	// named by its directory, because there the file system has already named it
	const pkg = await registerCommandPackage(modulePath);
	if (pkg) {
		return pkg;
	}

	const entries = readDirectory(modulePath);
	if (entries) {
		// a directory with nothing in it that could be a command is not a command
		// either: it would register a name that matches, runs nothing, and lists
		// nothing, which is a worse answer than saying the path is unusable
		if (!entries.some((entry) => routeName(entry, modulePath) !== undefined)) {
			throw new Error(`Unsupported command module "${modulePath}"`);
		}
		return directoryCommand(modulePath, name, info);
	}

	if (!moduleName(modulePath)) {
		throw new Error(`Unsupported command module "${modulePath}"`);
	}

	return initCommand({ name }, modulePath);
}

/**
 * A command whose subcommands are the directory it sits on.
 *
 * Nothing about the directory is read here. The walk is deferred to
 * `loadCommand()`, which is what already defers a module's import, so the
 * directory is read when the command is matched or when help describes it and
 * not when the tree above it is built. That is what keeps a sixty-command tree
 * to one `readdir` per level argv actually names rather than one per level
 * there is -- and it is what bounds a cycle through a symlink, since nothing
 * walks a level nobody asked for.
 *
 * @param dir - The directory.
 * @param name - What the command is called.
 * @returns The command, unwalked.
 */
async function directoryCommand(
	dir: string,
	name: string,
	info: RouteInfo | undefined
): Promise<InternalCommand> {
	const cmd = await initCommand({ desc: info?.desc, hidden: info?.hidden, name });

	// written after the fact for the reason `loadCommand()` writes `label` and
	// `loaded` after the fact: these are what the parser knows about a
	// placeholder, not something its declaration said
	cmd[Internal].dir = dir;
	cmd[Internal].baseDir = dir;
	// its children's, handed down: a level only knows where it sits in the tree
	// because the level above told it
	cmd[Internal].routeInfo = info?.commands;

	return cmd;
}

/**
 * Builds the command one route is.
 *
 * The route has already settled everything about the file system: which of the
 * three kinds this is, what it is called, and what file is behind it. All that
 * is left is what a *command* is, which is what this layer knows and
 * `routes.ts` deliberately does not.
 *
 * @param route - The route.
 * @returns The command, unloaded either way.
 */
async function routeCommand(route: Route, info: RouteInfo | undefined): Promise<InternalCommand> {
	if (route.kind === 'directory') {
		return directoryCommand(route.path, route.name, info);
	}

	// a package arrives already named and described by its own manifest, and a
	// module arrives with nothing but its path -- what each still waits for is
	// the import, which is `loadCommand()`'s
	//
	// `route.desc ?? info?.desc` rather than the other way around, which is the
	// rule that keeps a lifted description honest: the filesystem wins wherever
	// it has an answer, because a package's manifest is a read that costs
	// nothing and cannot go stale, and what a build lifted only fills what the
	// walk could not say. A module's description is exactly that gap.
	return initCommand(
		{ desc: route.desc ?? info?.desc, hidden: info?.hidden, name: route.name },
		route.path
	);
}

/**
 * Walks a directory command's own level, once.
 *
 * Its entries become its subcommands and an `index` module beside them is the
 * command itself. Reached from `loadCommand()`, which is the whole point: a
 * level is read when something asks for it.
 *
 * @param cmd - The directory command.
 */
export async function loadCommandDir(cmd: InternalCommand): Promise<void> {
	const internal = cmd[Internal];
	const { dir } = internal;

	if (!dir) {
		return;
	}

	log(`Walking command directory: ${dir}`);

	const level = readRoutes(dir);
	if (!level) {
		throw new Error(`Command directory not found: ${dir}`);
	}

	for (const route of level.routes) {
		internal.commands.add(await routeCommand(route, internal.routeInfo?.[route.name]));
	}

	// no package branch: a directory holding a `package.json` was resolved to its
	// entry module where it was discovered, so nothing that reaches here is one
	internal.path = level.index;
}

/**
 * Builds the command a package the declaration pointed at exports.
 *
 * Imported here rather than deferred, and that is the older rule kept rather
 * than an oversight: a package pointed at by a path is named by its own module
 * -- `commands: { foo: './pkg' }` registers whatever the package calls itself,
 * not `foo` -- and there is no way to know that name without reading it. A
 * package a walk *found* is the other case and is deferred, because the
 * directory it sits in has already named it.
 *
 * @param dir - The directory that may be a package.
 * @returns The command, or `undefined` when the directory is not a package.
 */
async function registerCommandPackage(dir: string): Promise<InternalCommand | undefined> {
	const pkg = readPackage(dir);
	if (!pkg) {
		return;
	}

	const { description, entryFile, name } = pkg;

	// the file URL rather than the path: an absolute path on Windows starts with
	// a drive letter, which the ESM loader reads as a scheme it does not know
	const { default: cmd } = await import(pathToFileURL(entryFile).href);

	if (!cmd || typeof cmd !== 'object') {
		throw new TypeError(`Expected command package to default export an object: ${entryFile}`);
	}

	// the module object is cached by the ESM loader and shared with every other
	// importer, so the package's name and description fill in a copy
	return initCommand(
		{
			...cmd,
			desc: cmd.desc ?? description,
			name: cmd.name ?? name,
		},
		entryFile
	);
}
