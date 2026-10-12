/**
 * Where a completion script goes, and how a user puts it there.
 *
 * This is one module because the knowledge has two readers and they must not
 * come apart: each emitter prints it into its script's own header, and the
 * `completion` command prints it as instructions when argv named no shell. A
 * second copy of "a zsh completion is a file called `_app` on `$fpath`" is a
 * copy that goes stale, and the one that goes stale is whichever a reader is
 * not looking at -- which is the rule `readRoutes()` already keeps for the two
 * route walks and `SEVERITY_ROLE` for the toolchain's severities.
 *
 * It imports the names and nothing else, so it stays on the deferred side: the
 * `choices` list is needed while the schema is built and none of this is, which
 * is the split `shells.ts` exists for.
 */

import type { ShellName } from './shells.js';

/**
 * One way to install a completion script, as the commands to run.
 *
 * A list rather than a single answer because both shells have two, and which
 * one applies is a fact about the machine rather than about the shell: whether
 * `bash-completion` is installed, whether `${fpath[1]}` is writable. Printing
 * both and letting the reader pick is what the headers already did.
 */
export interface InstallRoute {
	/** What distinguishes this route from the other, if anything does. */
	readonly label?: string;
	/** The commands, in order, verbatim. */
	readonly commands: readonly string[];
}

/** Every way to install a completion script for one shell. */
export interface InstallHint {
	/** The routes, most conventional first. */
	readonly routes: readonly InstallRoute[];
	/** What the reader has to do afterwards for any of it to take effect. */
	readonly after: string;
}

/**
 * How to install `program`'s completion for `shell`.
 *
 * @param shell - The shell.
 * @param program - The program's name, as the user types it.
 * @returns The routes and what follows them.
 */
export function installHint(shell: ShellName, program: string): InstallHint {
	if (shell === 'zsh') {
		return {
			after: 'Then restart your shell.',
			routes: [
				{
					commands: [`${program} completion zsh > "\${fpath[1]}/_${program}"`],
					label: 'as a file on your $fpath, which compinit autoloads',
				},
				{
					commands: [`echo 'source <(${program} completion zsh)' >> ~/.zshrc`],
					label: 'or sourced from .zshrc, after compinit',
				},
			],
		};
	}

	return {
		after: 'Then restart your shell.',
		routes: [
			{
				commands: [`${program} completion bash > /etc/bash_completion.d/${program}`],
				label: 'with bash-completion installed, system wide',
			},
			{
				commands: [
					`${program} completion bash > ~/.${program}-completion.bash`,
					`echo 'source ~/.${program}-completion.bash' >> ~/.bashrc`,
				],
				label: 'or from your own .bashrc, anywhere',
			},
		],
	};
}

/**
 * The hint as the comment block a generated script opens with.
 *
 * Rendered rather than written out, so that the script and the instructions the
 * command prints cannot disagree about where a completion goes.
 *
 * @param shell - The shell.
 * @param program - The program's name.
 * @returns Lines, each already `#`-prefixed, with no trailing newline.
 */
export function installComment(shell: ShellName, program: string): string {
	const hint = installHint(shell, program);
	const out: string[] = [];

	for (const route of hint.routes) {
		out.push('#');
		if (route.label) {
			out.push(`#   # ${route.label}`);
		}
		for (const command of route.commands) {
			out.push(`#   ${command}`);
		}
	}

	out.push('#', `# ${hint.after}`);

	return out.join('\n');
}

/**
 * Which shell the user is in, read off the environment.
 *
 * `SHELL` is the login shell rather than the running one -- a user in `bash`
 * under a `zsh` login still reads `zsh` here -- which is the right answer
 * anyway, because what is being installed goes in a startup file that the
 * login shell is the one to read.
 *
 * Matched on the **basename**, because the value is a path: `/bin/zsh`,
 * `/usr/local/bin/bash` and `/opt/homebrew/bin/bash` are all one of two
 * answers. A version suffix is not read -- `bash5` is not `bash` -- because
 * guessing there is how `csh` comes back as something it is not.
 *
 * @param env - The environment to read, for a caller that has one.
 * @returns The shell, or nothing where the variable named none this knows.
 */
export function detectShell(env: Record<string, string | undefined>): ShellName | undefined {
	const path = env['SHELL'];
	if (!path) {
		return undefined;
	}

	// the last segment of either separator, so a value somebody set by hand on
	// Windows is read the same way
	const name = path.split(/[/\\]/).pop();

	return name === 'bash' || name === 'zsh' ? name : undefined;
}

/**
 * The hint as the block the `completion` command prints when argv named no
 * shell.
 *
 * The same routes the script's own header carries, rendered for a terminal
 * rather than as shell comments -- which is the whole reason `installHint()`
 * is data.
 *
 * @param shell - The shell.
 * @param program - The program's name.
 * @returns The block, with a trailing newline.
 */
export function instructions(shell: ShellName, program: string): string {
	const hint = installHint(shell, program);
	const out: string[] = [];

	for (const route of hint.routes) {
		if (route.label) {
			out.push(`  ${route.label}`);
		}
		for (const command of route.commands) {
			out.push(`    ${command}`);
		}
		out.push('');
	}

	out.push(hint.after, '');

	return out.join('\n');
}
