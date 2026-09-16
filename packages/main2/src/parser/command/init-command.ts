import debug from '../../debug/index.js';
import {
	Command,
	Internal,
	InternalArgument,
	InternalCommand,
	InternalState,
	Schema,
} from '../../types.js';
import { copyDeclaration } from '../../util/copy-declaration.js';
import { lockDerived } from '../../util/lock-derived.js';
import { initArgs } from '../argument/init-args.js';
import { OptionRegistry } from '../option/option-registry.js';
import { CommandRegistry } from './command-registry.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

const { log } = debug('main2:init-command');

const fileTypeRegExp = /^\.[cm]?js$/;
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
 * @returns A new internal command.
 */
export async function initCommand(it: CommandsLike, entryFile?: string): Promise<InternalCommand> {
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

	// commands
	if (decl.commands !== undefined) {
		if (decl.commands && typeof decl.commands === 'string') {
			await registerCommandPath({
				commands,
				file: decl.commands,
			});
		} else if (Array.isArray(decl.commands)) {
			await Promise.all(
				decl.commands.map((cmdOrPath) =>
					registerCommand({
						cmdOrPath,
						commands,
					})
				)
			);
		} else if (decl.commands && typeof decl.commands === 'object') {
			await Promise.all(
				Object.entries(decl.commands).map(([name, cmdOrPath]) =>
					registerCommand({
						cmdOrPath,
						commands,
						name,
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

	// a command left dirty by a failed init hook is rebuilt from scratch, so
	// recover the module it came from rather than losing it
	entryFile ??= it[Internal]?.path;

	const commandPath = decl.path;
	if (commandPath) {
		entryFile = entryFile ? join(dirname(entryFile), commandPath) : commandPath;
	}

	const cmd = Object.defineProperty(cloneDeclaration(decl, parsed, argDecls), Internal, {
		configurable: true,
		value: {
			aliases,
			args,
			commands,
			label: parsed.label,
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

	// a command's `beforeError` hooks are not fired from here, but a list that
	// is not a list of functions has to be rejected while the schema is being
	// built: the error path is the one place a silent no-op does the most harm
	if (decl.hooks?.beforeError !== undefined) {
		const beforeError = decl.hooks.beforeError;
		if (!Array.isArray(beforeError) || beforeError.some((h) => typeof h !== 'function')) {
			throw new TypeError('Expected command beforeError hooks to be an array of functions');
		}
	}

	// `help` hooks are fired by the help module rather than from here, and for the
	// same reason as `beforeError`: a list that is not a list of functions is
	// worth rejecting now, because the alternative is finding out when somebody
	// asks for help and gets an error instead
	if (decl.hooks?.help !== undefined) {
		const help = decl.hooks.help;
		if (!Array.isArray(help) || help.some((h) => typeof h !== 'function')) {
			throw new TypeError('Expected command help hooks to be an array of functions');
		}
	}

	if (decl.hooks?.init !== undefined) {
		if (!Array.isArray(decl.hooks.init)) {
			throw new TypeError('Expected command init hooks to be an array');
		}
		for (const hook of decl.hooks.init) {
			await hook({ cmd, ...cmd[Internal] });
		}
	}

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

	// the hook lists are copied as well, so a hook that registers another hook
	// on the command it was handed does not append to the declaration — and
	// does not extend the list `initCommand()` is in the middle of walking
	if (decl.hooks && typeof decl.hooks === 'object') {
		// every list, not a named few: a hook that adds to the list it was read from
		// would otherwise reach the caller's declaration and grow it on every parse
		const hooks: Record<string, unknown> = { ...decl.hooks };
		for (const [name, list] of Object.entries(hooks)) {
			if (Array.isArray(list)) {
				hooks[name] = [...list];
			}
		}
		cmd.hooks = hooks as Command['hooks'];
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

async function registerCommand({
	cmdOrPath,
	commands,
	name,
}: {
	cmdOrPath: string | Command;
	commands: CommandRegistry;
	name?: string;
}): Promise<void> {
	if (cmdOrPath && typeof cmdOrPath === 'string') {
		await registerCommandPath({
			commands,
			file: cmdOrPath,
			name,
		});
	} else if (cmdOrPath && typeof cmdOrPath === 'object') {
		// the key a command is declared under names it, but that name belongs on
		// the copy `initCommand()` makes, not on the caller's object
		commands.add(
			await initCommand(cmdOrPath.name === undefined ? { ...cmdOrPath, name } : cmdOrPath)
		);
	} else {
		throw new TypeError('Expected commands to be one or more paths or an object');
	}
}

async function registerCommandPath({
	commands,
	file,
	name,
}: {
	commands: CommandRegistry;
	file: string;
	name?: string;
}): Promise<void> {
	const cmd = await registerCommandPackage(file);
	if (cmd) {
		commands.add(cmd);
		return;
	}

	if (!name) {
		try {
			const files = readdirSync(file);
			for (const filename of files) {
				const { ext, name } = parse(filename);
				if (fileTypeRegExp.test(ext)) {
					const cmdFile = join(file, filename);
					commands.add(await initCommand({ name }, cmdFile));
				}
			}
			return;
		} catch {
			// not a package, not a directory
		}
	}

	// `file` is not a package or directory or `name` is set and we didn't want
	// to treat it as a directory

	const { ext, name: filename } = parse(file);

	if (!name) {
		name = filename;
	}

	if (!ext || !name || !fileTypeRegExp.test(ext)) {
		throw new Error(`Unsupported command module "${file}"`);
	}

	commands.add(await initCommand({ name }, file));
}

/**
 * Resolves a package's `exports` to the relative paths worth trying, best first.
 *
 * An `exports` map nests: `"."` holds a conditions object, a condition holds
 * another, and an array is a fallback list. Unwrapping exactly one level --
 * `exports['.'] || exports.default` -- left a plain object for the ordinary
 * `{ ".": { "import": "./index.js" } }`, which then reached `join()` as
 * `[object Object]` and reported the package as having no valid export.
 *
 * Every candidate is returned rather than the first one, because a fallback list
 * means "the first of these that works" and whether one works is a question about
 * the file system: the caller already walks the list looking for a file, so
 * picking here would pick a path that may not exist and call the package broken.
 *
 * Only what this loader can actually import is considered: `import` and `node`
 * before `default`, and `require` last, since a CommonJS entry still loads. The
 * conditions it cannot honor -- `browser`, `types`, a user condition -- are
 * skipped rather than guessed at.
 *
 * @param exports - The `exports` field, whatever shape it is in.
 * @param subpath - Whether a `"."` subpath is still to be taken.
 * @returns The relative paths, in the order they should be tried.
 */
function resolveEntries(exports: unknown, subpath = true): string[] {
	if (typeof exports === 'string') {
		return [exports];
	}

	if (Array.isArray(exports)) {
		return exports.flatMap((candidate) => resolveEntries(candidate, subpath));
	}

	if (!exports || typeof exports !== 'object') {
		return [];
	}

	const map = exports as Record<string, unknown>;

	// a map whose keys are subpaths is a different thing from one whose keys are
	// conditions, and `"."` is only a subpath at the top
	if (subpath && Object.hasOwn(map, '.')) {
		return resolveEntries(map['.'], false);
	}

	const entries: string[] = [];
	for (const condition of ['import', 'node', 'default', 'require']) {
		if (Object.hasOwn(map, condition)) {
			entries.push(...resolveEntries(map[condition], false));
		}
	}

	// one file reached through two conditions is still one file to try
	return [...new Set(entries)];
}

async function registerCommandPackage(dir: string): Promise<InternalCommand | undefined> {
	const pkgFile = join(dir, 'package.json');

	let json;
	try {
		json = readFileSync(pkgFile, 'utf-8');
	} catch {
		// no package.json, not a package
		return;
	}

	let pkgJson;
	try {
		pkgJson = JSON.parse(json);
	} catch (err) {
		throw new Error(`Failed to JSON parse ${pkgFile}: ${err instanceof Error ? err.message : err}`);
	}

	const { description, exports, main, name, type } = pkgJson;

	const entries = resolveEntries(exports);
	if (!entries.length && typeof main === 'string') {
		entries.push(main);
	}

	const filePaths = entries.length ? entries : ['index.js', 'index.mjs', 'index.cjs'];
	let entryFile;

	for (const filepath of filePaths) {
		try {
			const file = join(dir, filepath);
			const st = statSync(file);
			if (st.isFile()) {
				entryFile = file;
				break;
			}
		} catch {
			// not a file or does not exist
		}
	}

	if (!entryFile) {
		throw new Error(
			`Command package does not have a valid ${type === 'module' ? 'export' : 'main'}: ${dir}`
		);
	}

	const { default: cmd } = await import(entryFile);

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
