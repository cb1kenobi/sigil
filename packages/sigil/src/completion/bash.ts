/**
 * The bash script, printed from a spec.
 *
 * ## bash 3.2, because that is what macOS ships
 *
 * `bash --version` on this machine is 3.2.57, and it is the bash a great many
 * users have -- so no associative arrays, no `mapfile`, and no dependency on
 * `bash-completion` being installed, which rules out `_init_completion`. What
 * is left is `COMP_WORDS`, `COMP_CWORD`, `case` and `for`, which is enough.
 *
 * ## Every candidate is a quoted `case` pattern, which is what makes it exact
 *
 * bash matches a `case` pattern literally wherever it is quoted -- "quoting any
 * part of the pattern causes that part to be matched literally" -- so a command
 * called `*` is a pattern that matches `*` and nothing else. That is the whole
 * reason the data is emitted as `case` arms rather than as a space-separated
 * word list for `compgen -W`: a word list is split on `IFS` and re-globbed, so a
 * name with a space in it arrives as two candidates and a name with a `*` in it
 * matches everything. Prefix filtering is `case "$c" in "$cur"*)`, where the
 * quoted `"$cur"` is literal and the trailing `*` is the only glob -- which is
 * `compgen`'s job done with no subshell and no quoting left to go wrong.
 *
 * ## The data appears once per question
 *
 * `__x_known` is the set of command paths and is what the walk tests against,
 * so the subcommand names are not written out a second time to answer "does
 * this word extend the path". `__x_optval` sets a flag and an array rather than
 * printing, because the walk has to ask whether an option consumes the next
 * token *without* adding anything to `COMPREPLY`.
 */

import type { CompletionCommand, CompletionSpec } from './spec.js';

/**
 * A string as a bash single-quoted literal.
 *
 * `'` closes the quote, so it is written as `'\''`: close, escape one quote,
 * reopen. Every other byte -- a backtick, a `$`, a `\`, a newline -- is literal
 * inside single quotes, which is why this is the only escaping bash needs and
 * why it is the one used for both the `case` patterns and the `__x_add`
 * arguments.
 *
 * @param text - The string.
 * @returns The quoted literal.
 */
export function bashQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The `case` pattern for a command path, `''` for the root. */
function pathPattern(path: readonly string[]): string {
	return bashQuote(path.join(' '));
}

/**
 * The prefix every generated name carries.
 *
 * Sanitized because a function name has to be typable: `my-cli` becomes
 * `__my_cli_*`. Two programs whose names differ only in a character that is not
 * a letter, a digit or an underscore collide here, which matters only if both
 * are installed and is the same collision `complete -F` would have anyway.
 *
 * @param program - The program's name.
 * @returns The prefix.
 */
export function bashPrefix(program: string): string {
	return `__${program.replaceAll(/[^A-Za-z0-9_]/gu, '_')}`;
}

/** The name of the completion function, which is what `complete -F` names. */
export function bashFunction(program: string): string {
	return `_${program.replaceAll(/[^A-Za-z0-9_]/gu, '_')}`;
}

/** One `case` arm, or nothing when there is nothing to say for that path. */
function arm(path: readonly string[], body: string): string {
	return `\t\t${pathPattern(path)}) ${body} ;;\n`;
}

/**
 * The arms that say which path a word at a path takes you to.
 *
 * A mapping rather than a yes-or-no, because an **alias** is a token the parser
 * accepts and the rest of the line has to complete against the command it
 * reaches: `mycli rm <TAB>` on a `remove` aliased `rm` has to be `remove`'s
 * subtree. So the arm matches every token and answers with the *canonical*
 * path, which keeps the arms below keyed on one spelling.
 *
 * It is also what keeps the subcommand names from being written out twice: the
 * walk needs to know whether a word is a command, and this is the one place
 * that is said.
 *
 * @param spec - What to complete.
 * @param pre - The generated-name prefix.
 * @returns The arms.
 */
function resolveArms(spec: CompletionSpec, pre: string): string {
	let out = '';

	for (const cmd of spec.commands) {
		if (cmd.subcommands.length === 0) {
			continue;
		}

		let inner = '';
		for (const sub of cmd.subcommands) {
			const patterns = sub.tokens.map(bashQuote).join('|');
			const reached = bashQuote([...cmd.path, sub.name].join(' '));
			inner += `\t\t\t\t${patterns}) ${pre}_next=${reached} ;;\n`;
		}

		out += `\t\t${pathPattern(cmd.path)})\n\t\t\tcase "$2" in\n${inner}\t\t\tesac\n\t\t\t;;\n`;
	}

	return out;
}

/**
 * The arms that offer subcommand names.
 *
 * Every token rather than the canonical name alone, for the reason
 * `CompletionSubcommand.tokens` gives: a menu of what can be typed has to hold
 * what can be typed, and an alias that is not a prefix of its own name is
 * otherwise unreachable.
 *
 * @param spec - What to complete.
 * @param pre - The generated-name prefix.
 * @returns The arms.
 */
function subArms(spec: CompletionSpec, pre: string): string {
	let out = '';
	for (const cmd of spec.commands) {
		if (cmd.subcommands.length > 0) {
			const names = cmd.subcommands.flatMap((sub) => sub.tokens.map(bashQuote)).join(' ');
			out += arm(cmd.path, `${pre}_add '' "$2" ${names}`);
		}
	}
	return out;
}

/** The arms that offer option spellings. */
function optArms(spec: CompletionSpec, pre: string): string {
	let out = '';
	for (const cmd of spec.commands) {
		const spellings = cmd.options.flatMap((opt) => opt.spellings);
		if (spellings.length > 0) {
			out += arm(cmd.path, `${pre}_add '' "$2" ${spellings.map(bashQuote).join(' ')}`);
		}
	}
	return out;
}

/** The arms that offer a command's positional choices. */
function argArms(spec: CompletionSpec, pre: string): string {
	let out = '';
	for (const cmd of spec.commands) {
		if (cmd.argValues.length > 0) {
			out += arm(cmd.path, `${pre}_add '' "$2" ${cmd.argValues.map(bashQuote).join(' ')}`);
		}
	}
	return out;
}

/**
 * One command's option-value arm: which of its options take a value, and what
 * each one accepts.
 *
 * @param cmd - The command.
 * @param pre - The generated-name prefix.
 * @returns The arm, or nothing when none of its options takes a value.
 */
function valueArm(cmd: CompletionCommand, pre: string): string {
	const valued = cmd.options.filter((opt) => opt.takesValue);

	if (valued.length === 0) {
		return '';
	}

	let inner = '';
	for (const opt of valued) {
		const patterns = opt.spellings.map(bashQuote).join('|');
		const values = opt.values?.length
			? `; ${pre}_vals=(${opt.values.map(bashQuote).join(' ')})`
			: '';
		inner += `\t\t\t\t${patterns}) ${pre}_takes=1${values} ;;\n`;
	}

	return `\t\t${pathPattern(cmd.path)})\n\t\t\tcase "$2" in\n${inner}\t\t\tesac\n\t\t\t;;\n`;
}

/** The arms that say which options take a value. */
function valueArms(spec: CompletionSpec, pre: string): string {
	return spec.commands.map((cmd) => valueArm(cmd, pre)).join('');
}

/**
 * The bash completion script for a spec.
 *
 * @param spec - What to complete.
 * @returns The script, ending in a newline.
 */
export function bashScript(spec: CompletionSpec): string {
	const { program } = spec;
	const pre = bashPrefix(program);
	const fn = bashFunction(program);
	const q = bashQuote(program);

	return `# bash completion for \`${program}\`, generated by sigil.
#
# Save it somewhere your shell reads, then start a new shell:
#
#   # with bash-completion installed, system wide
#   ${program} completion bash > /etc/bash_completion.d/${program}
#
#   # or from your own .bashrc, anywhere
#   ${program} completion bash > ~/.${program}-completion.bash
#   echo 'source ~/.${program}-completion.bash' >> ~/.bashrc
#
# Nothing in here runs \`${program}\`: every candidate was baked in when this
# file was written, so a tab costs no process at all. Regenerate it when the
# commands, options or choices change.
#
# Written for bash 3.2, which is what macOS ships, and it needs no
# bash-completion package.

# $1 is prepended to whatever is offered and $2 is the word to match against.
# The prefix is for \`--opt=value\` where the \`=\` is *not* a word break, which is
# a shell somebody configured: readline replaces the whole word, so the
# candidate has to carry the \`--opt=\` back with it
${pre}_add() {
\tlocal __pre="$1" __cur="$2" __c
\tshift 2
\tfor __c in "$@"; do
\t\tcase "$__c" in
\t\t\t"$__cur"*) COMPREPLY[\${#COMPREPLY[@]}]="$__pre$__c" ;;
\t\tesac
\tdone
}

# which path a word takes you to, by its name or by any alias it answers to.
# A word that is no command answers nothing, which is also what keeps an
# option's value from being read as one
${pre}_resolve() {
\t${pre}_next=''
\tcase "$1" in
${resolveArms(spec, pre)}\tesac
}

${pre}_subs() {
\tcase "$1" in
${subArms(spec, pre)}\tesac
}

${pre}_opts() {
\tcase "$1" in
${optArms(spec, pre)}\tesac
}

${pre}_args() {
\tcase "$1" in
${argArms(spec, pre)}\tesac
}

# sets ${pre}_takes and ${pre}_vals rather than adding, because the walk has to
# ask whether an option eats the next token without offering anything
${pre}_optval() {
\t${pre}_takes=0
\t${pre}_vals=()
\tcase "$1" in
${valueArms(spec, pre)}\tesac
}

${fn}() {
\tlocal cur prev word
\tlocal i skip
\t# prefixed for the reason the zsh emitter records: there, \`path\` is a
\t# special parameter tied to \`PATH\`. bash has no such parameter and this is
\t# one spelling across the two
\tlocal ${pre}_path=''
\tlocal ${pre}_next=''
\tlocal ${pre}_takes=0
\t# declared rather than assigned, because \`local x=()\` is not an array
\t# declaration in every bash this has to run in
\tlocal -a ${pre}_vals

\tCOMPREPLY=()
\tcur="\${COMP_WORDS[COMP_CWORD]}"
\tprev=''
\tif [ "$COMP_CWORD" -gt 0 ]; then
\t\tprev="\${COMP_WORDS[COMP_CWORD-1]}"
\tfi

\t# the command path, read off the words before the cursor. A word that
\t# resolves to no command leaves the path where it was -- which is also what
\t# keeps an option's value from being read as a command
\tskip=0
\ti=1
\twhile [ "$i" -lt "$COMP_CWORD" ]; do
\t\tword="\${COMP_WORDS[i]}"
\t\ti=$((i + 1))
\t\tif [ "$skip" = 1 ]; then
\t\t\t# the \`=\` of \`--opt=value\`, which bash breaks out as a word of its own:
\t\t\t# the value is still to come, so keep skipping
\t\t\tcase "$word" in
\t\t\t\t'=') continue ;;
\t\t\tesac
\t\t\tskip=0
\t\t\tcontinue
\t\tfi
\t\tcase "$word" in
\t\t\t'--') return 0 ;;
\t\t\t'='|'') continue ;;
\t\t\t-*)
\t\t\t\t${pre}_optval "$${pre}_path" "$word"
\t\t\t\tif [ "$${pre}_takes" = 1 ]; then skip=1; fi
\t\t\t\tcontinue
\t\t\t\t;;
\t\tesac
\t\t${pre}_resolve "$${pre}_path" "$word"
\t\t# a command's path is never empty, so an empty answer is "no command"
\t\tif [ -n "$${pre}_next" ]; then ${pre}_path="$${pre}_next"; fi
\tdone

\t# \`--opt=<TAB>\`: the option is two words back, because \`=\` is a word break
\tif [ "$prev" = '=' ] && [ "$COMP_CWORD" -ge 2 ]; then
\t\t${pre}_optval "$${pre}_path" "\${COMP_WORDS[COMP_CWORD-2]}"
\t\tif [ "$${pre}_takes" = 1 ]; then
\t\t\tif [ \${#${pre}_vals[@]} -gt 0 ]; then ${pre}_add '' "$cur" "\${${pre}_vals[@]}"; fi
\t\t\treturn 0
\t\tfi
\tfi

\t# ...and the same thing where \`=\` is not a word break, so the whole
\t# \`--opt=value\` arrived as one word: what is inserted replaces that word, so
\t# every candidate carries the \`--opt=\` back
\tcase "$cur" in
\t\t-*=*)
\t\t\t${pre}_optval "$${pre}_path" "\${cur%%=*}"
\t\t\tif [ "$${pre}_takes" = 1 ]; then
\t\t\t\tif [ \${#${pre}_vals[@]} -gt 0 ]; then
\t\t\t\t\t${pre}_add "\${cur%%=*}=" "\${cur#*=}" "\${${pre}_vals[@]}"
\t\t\t\tfi
\t\t\t\treturn 0
\t\t\tfi
\t\t\t;;
\tesac

\tcase "$cur" in
\t\t-*)
\t\t\t${pre}_opts "$${pre}_path" "$cur"
\t\t\treturn 0
\t\t\t;;
\tesac

\tcase "$prev" in
\t\t-*)
\t\t\t${pre}_optval "$${pre}_path" "$prev"
\t\t\tif [ "$${pre}_takes" = 1 ]; then
\t\t\t\tif [ \${#${pre}_vals[@]} -gt 0 ]; then ${pre}_add '' "$cur" "\${${pre}_vals[@]}"; fi
\t\t\t\treturn 0
\t\t\tfi
\t\t\t;;
\tesac

\t${pre}_subs "$${pre}_path" "$cur"
\t${pre}_args "$${pre}_path" "$cur"
\treturn 0
}

# \`-o default\` is what makes a file the answer where this has none: an option
# whose values nothing declared, and a positional with no choices
complete -o default -F ${fn} ${q}
`;
}
