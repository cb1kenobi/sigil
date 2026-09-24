/**
 * `sigil new`: scaffold an app.
 *
 * ## What it asks, and what it works out
 *
 * It asks about the three things that change what gets written and have no
 * defensible default for a project that does not exist yet: the name, the
 * language, and whether there is one command or several. It asks about a linter
 * because people have preferences there and the answer is a config file nobody
 * enjoys writing twice.
 *
 * It does *not* ask about the package manager -- `npm_config_user_agent` says
 * which one invoked it, so asking would be asking a question whose answer is
 * already on the table. Nor about git, which it just does.
 *
 * ## `--link`, and why the default is the real thing
 *
 * `@ttylabs/sigil` is not published yet, so a scaffold that writes the real
 * version range produces an app that cannot install. `--link` writes a `file:`
 * dependency pointing at the runtime *this toolchain itself resolved*, which is
 * what makes a scaffold from a checkout actually run.
 *
 * The default is still the real range, because the flag is a workaround for a
 * temporary state of the world and a scaffold that quietly wrote a machine-local
 * path would keep working right up until somebody committed it. It is one line
 * to delete on the day the package ships.
 */

import { displayPath } from '../build/index.ts';
import {
	type Language,
	type Layout,
	type Linter,
	nameProblem,
	scaffold,
	type ScaffoldFile,
} from '../scaffold/index.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { confirm, select, text } from '@ttylabs/sigil/components';
import { expand } from '@ttylabs/sigil/paths';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This toolchain's own manifest, for the versions it writes. */
function toolchainManifest(): { devDependencies: Record<string, string>; version: string } {
	const path = new URL('../../package.json', import.meta.url);
	return JSON.parse(readFileSync(path, 'utf-8')) as {
		devDependencies: Record<string, string>;
		version: string;
	};
}

/**
 * Where the runtime and the toolchain should come from.
 *
 * Linked, they are the ones *this* process resolved -- not a guess at a
 * relative path, which would be wrong the moment the new app is created
 * anywhere but beside the checkout.
 *
 * **Both**, which the first version got wrong by linking only the runtime: the
 * scaffolded app takes `@ttylabs/cli` as a devDependency too, and that is no
 * more published than the runtime is, so the install died on a 404 for the
 * toolchain having succeeded at everything else. `--link` means "use what is on
 * this machine", and half of that is not a thing anybody asked for.
 *
 * @param link - Whether `--link` was passed.
 * @param version - The version to ask for otherwise.
 * @returns The two specifiers.
 */
function dependencyFor(link: boolean, version: string): { runtime: string; toolchain: string } {
	if (!link) {
		return { runtime: version, toolchain: version };
	}

	const require = createRequire(fileURLToPath(import.meta.url));
	const runtime = dirname(require.resolve('@ttylabs/sigil/package.json'));
	// this module's own package, which is the toolchain being run
	const toolchain = fileURLToPath(new URL('../..', import.meta.url));

	return {
		runtime: `file:${displayPath(runtime)}`,
		toolchain: `file:${displayPath(toolchain.replace(/\/$/, ''))}`,
	};
}

/** The package manager that invoked this, read rather than asked about. */
function packageManager(): string {
	const agent = process.env.npm_config_user_agent ?? '';
	for (const name of ['pnpm', 'yarn', 'bun']) {
		if (agent.startsWith(`${name}/`)) {
			return name;
		}
	}
	return 'npm';
}

/** Whether a directory is absent or empty, which is the only place to scaffold. */
function usable(dir: string): boolean {
	if (!existsSync(dir)) {
		return true;
	}
	try {
		// a lone `.git` is fine: `git init` then `sigil new` is an ordinary order
		// to do things in, and refusing it would be refusing the case
		return readdirSync(dir).filter((name) => name !== '.git').length === 0;
	} catch {
		return false;
	}
}

const newApp: AnyCommand = command({
	args: [
		{
			desc: 'The directory to create, which is also the app name',
			name: '[project-name]',
		},
	],
	options: {
		'--cwd [dir]': {
			desc: 'Where to create it, defaulting to the working directory',
		},
		'--js': { desc: 'JavaScript rather than TypeScript', type: 'bool' },
		'--lint [linter]': {
			choices: ['oxlint', 'eslint', 'biome', 'none'],
			desc: 'Which linter to set up',
		},
		'--link': {
			desc: 'Depend on the @ttylabs/sigil this toolchain resolved, rather than a published version',
			type: 'bool',
		},
		'--no-git': { desc: 'Do not run git init' },
		'--no-install': { desc: 'Do not install dependencies' },
		'--single': { desc: 'One command rather than a commands directory', type: 'bool' },
		'-y, --yes': { desc: 'Take the defaults for anything not passed', type: 'bool' },
	},

	async run({ argv }) {
		const yes = Boolean(argv.yes);

		const name = await askName(argv.projectName as string | undefined, yes);
		const problem = nameProblem(name);
		if (problem) {
			throw new Error(`${problem}: "${name}"`);
		}

		const dir = join(parentDir(argv.cwd as string | undefined), name);
		if (!usable(dir)) {
			throw new Error(`${displayPath(dir)} already exists and is not empty`);
		}

		const language = await askLanguage(argv, yes);
		const layout = await askLayout(argv, yes);
		const linter = await askLinter(argv, yes);

		const own = toolchainManifest();
		const from = dependencyFor(Boolean(argv.link), own.version);
		const files = scaffold({
			dependency: from.runtime,
			language,
			layout,
			linter,
			name,
			toolchain: from.toolchain,
			versions: own.devDependencies,
		});

		write(dir, files);

		const pm = packageManager();
		if (argv.git !== false) {
			run('git', ['init', '--quiet'], dir);
		}
		if (argv.install !== false) {
			process.stdout.write(`\nInstalling with ${pm}...\n`);
			run(pm, ['install'], dir);
		}

		process.stdout.write(
			`\nCreated ${name} in ${displayPath(dir)}.\n\n  cd ${displayPath(relative(process.cwd(), dir) || '.')}\n` +
				(argv.install === false ? `  ${pm} install\n` : '') +
				`  ${pm} run dev -- --help\n\n` +
				(argv.link
					? `It depends on a linked @ttylabs/sigil and @ttylabs/cli, so it will not\ninstall anywhere else.\n`
					: '')
		);
	},
});

/**
 * The directory the project is created *in*.
 *
 * The name is validated as an npm package name, so it can never hold a
 * separator -- which is what made `sigil new ~/projects/my-cli` an error rather
 * than a location, and what left an `isAbsolute(name)` branch here that could
 * not be reached. Saying where and saying what it is called are two questions,
 * so they are two inputs.
 *
 * `expand()` rather than `resolve()` alone, because a `~` only reaches a
 * process when the shell did not eat it -- `--cwd "~/projects"` is quoted, and
 * `resolve()` would make a directory *called* `~`. That is the failure
 * `paths.ts` already records, met from the one place a user hands this tool a
 * path to write into.
 *
 * It is not required to exist: the scaffold makes each file's directory as it
 * goes, so a `--cwd` naming somewhere new is `mkdir -p` rather than an error.
 *
 * @param cwd - What `--cwd` said, if anything.
 * @returns The absolute directory to create the project inside.
 */
function parentDir(cwd: string | undefined): string {
	return cwd === undefined ? process.cwd() : resolve(process.cwd(), expand(cwd));
}

/** Asks for the name, or takes the one that was given. */
async function askName(given: string | undefined, yes: boolean): Promise<string> {
	if (given !== undefined) {
		return given;
	}
	if (yes) {
		throw new Error(
			'A project name is required. Pass it as an argument, or drop --yes to be asked.'
		);
	}

	return (await text({ message: 'What is it called?', placeholder: 'my-cli' })).trim();
}

/** Asks whether it is TypeScript, defaulting to yes. */
async function askLanguage(argv: Record<string, unknown>, yes: boolean): Promise<Language> {
	if (argv.js) {
		return 'js';
	}
	if (yes) {
		return 'ts';
	}

	return (await confirm({ message: 'Would you like to use TypeScript?' })) ? 'ts' : 'js';
}

/** Asks whether there are subcommands, defaulting to yes. */
async function askLayout(argv: Record<string, unknown>, yes: boolean): Promise<Layout> {
	if (argv.single) {
		return 'single';
	}
	if (yes) {
		return 'multi';
	}

	return (await select({
		choices: [
			{ hint: 'a commands/ directory, one file each', label: 'Several commands', value: 'multi' },
			{ hint: 'one thing, no subcommands', label: 'One command', value: 'single' },
		],
		message: 'How many commands?',
	})) as Layout;
}

/** Asks which linter, defaulting to oxlint. */
async function askLinter(argv: Record<string, unknown>, yes: boolean): Promise<Linter> {
	if (typeof argv.lint === 'string') {
		return argv.lint as Linter;
	}
	if (yes) {
		return 'oxlint';
	}

	return (await select({
		choices: [
			{ hint: 'fast, near-zero config', label: 'oxlint', value: 'oxlint' },
			{ label: 'eslint', value: 'eslint' },
			{ label: 'biome', value: 'biome' },
			{ label: 'none', value: 'none' },
		],
		message: 'Which linter would you like to use?',
	})) as Linter;
}

/** Writes the files, making directories as it goes. */
function write(dir: string, files: readonly ScaffoldFile[]): void {
	for (const file of files) {
		const path = join(dir, file.path);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, file.contents, file.executable ? { mode: 0o755 } : undefined);
	}
}

/**
 * Runs a command in the new app, reporting rather than failing the scaffold.
 *
 * The files are already written by the time either of these runs, so a failed
 * `git init` or a failed install is not a reason to call the whole thing a
 * failure -- it is a reason to say which step to run by hand.
 *
 * @param cmd - The program.
 * @param argv - Its arguments.
 * @param cwd - Where to run it.
 */
function run(cmd: string, argv: string[], cwd: string): void {
	const result = spawnSync(cmd, argv, {
		cwd,
		encoding: 'utf-8',
		shell: process.platform === 'win32',
		stdio: 'inherit',
	});

	if (result.status !== 0) {
		process.stderr.write(
			`\n${cmd} ${argv.join(' ')} did not succeed; run it yourself in the new app.\n`
		);
	}
}

export default newApp;
