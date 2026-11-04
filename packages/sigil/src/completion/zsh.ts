/**
 * The zsh script, printed from a spec.
 *
 * ## It is the same four rules as bash, said in zsh
 *
 * Which option am I inside, which command path am I at, is the current word an
 * option, is it a value. Both emitters read one spec, so neither can offer
 * something the other does not know about -- and *that they offer the same
 * things* is a claim about these two files rather than something the shared spec
 * guarantees: it was false twice, once over `--` and once over a command that
 * has both subcommands and positional choices, and both are pinned now.
 *
 * What differs on purpose is that zsh shows a description beside each candidate
 * and bash does not, which is why `_describe` is used rather than `compadd`: it
 * is the one-line way to offer `name:description` pairs. zsh also filters by
 * prefix itself, inside `_describe`, where bash filters in the script.
 *
 * ## The two install modes, from one file
 *
 * A zsh completion is normally a file called `_app` on `$fpath` that `compinit`
 * autoloads, tagged by a first line of `#compdef app`. But the obvious thing to
 * do with a command that prints a script is `source <(app completion zsh)`, and
 * a file written for autoloading ends by *calling* its function -- which, when
 * sourced, runs the completion function with no completion to do. The
 * `$funcstack[1]` test is what makes one file work both ways: inside an
 * autoload the function's own name is on the stack, and when sourced it is not,
 * so the sourced case registers with `compdef` instead.
 *
 * ## Escaping is `_describe`'s rather than the shell's alone
 *
 * Each element is a single-quoted `name:description`, so `'` is written
 * `'\''` exactly as in bash -- which makes a backtick, a `$` and a newline
 * inert *as code*. A newline is still not inert to `_describe`, which is
 * line-oriented, so `spec.ts` keeps one out of a description by collapsing and
 * out of a *name* by refusing the name altogether. On top of that `_describe`
 * reads the element itself: it splits on the first `:` that is not backslash-escaped, so a `:` in
 * a *name* has to be `\:` or the name is cut in half -- and a `\` in a name has
 * to be `\\` or it escapes whatever follows it. Both are done to the name,
 * which is the half that gets inserted into the command line. The description
 * is left alone: everything after the first colon is the description whatever
 * is in it, and escaping a backslash there would only make it print as two.
 *
 * ## A `case` *subject* is quoted for the reader, and a `case` *pattern* for
 * the shell
 *
 * `case "$word" in` is consistency with the bash emitter and with what a shell
 * reader expects rather than a guard, and it is the one survivor of the sabotage
 * pass. Neither shell splits or globs the subject of a `case`: measured over
 * `*` and `a b` in `zsh -f` under `sh_word_split`, `glob_subst`, `nounset`,
 * `ksh_glob` and `extendedglob`, and in bash with a matching file present, the
 * word arrives whole every time -- so nothing can be written that fails when
 * the quotes go. What *is* load bearing is the quoting on the other side, which
 * is bash's `case "$__c" in "$cur"*)`: a `cur` of `a*` unquoted there is a
 * pattern rather than a prefix and offers every candidate beginning `a`.
 */

import {
  completionFunction,
  generatedBy,
  generatedPrefix,
  installComment,
  shQuote,
} from './install.js';
import type { CompletionCommand, CompletionSpec } from './spec.js';

/**
 * A string as a zsh single-quoted literal.
 *
 * The same rule bash takes, and for the same reason: inside `'...'` every byte
 * is literal, so a backtick, a `$` or a newline cannot do anything, and `'` is
 * written as close-escape-reopen. So it is `shQuote()`, as `bashQuote()` is --
 * it was a copy of it, which is the shape `bashQuote()`'s own comment names as
 * how one of them comes to be a line that runs on every login with a quote in
 * it.
 *
 * @param text - The string.
 * @returns The quoted literal.
 */
export function zshQuote(text: string): string {
  return shQuote(text);
}

/**
 * One `_describe` element: the value, and what it is for.
 *
 * The backslash before the colon is `_describe`'s own escape and is what keeps
 * a name containing a colon whole; the doubled backslash is what keeps a name
 * containing a backslash from eating the character after it. Done in this order,
 * or the backslash this adds would itself be doubled.
 *
 * @param name - The value to insert.
 * @param desc - What it is for, if anything.
 * @returns The quoted element.
 */
export function zshPair(name: string, desc?: string): string {
  const value = name.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  return zshQuote(desc === undefined ? value : `${value}:${desc}`);
}

/** The `case` pattern for a command path, `''` for the root. */
function pathPattern(path: readonly string[]): string {
  return `(${zshQuote(path.join(' '))})`;
}

/** One `case` arm. */
function arm(path: readonly string[], body: string): string {
  return `    ${pathPattern(path)} ${body} ;;\n`;
}

/** The arms that say which path a word at a path takes you to. See `resolveArms()` in `./bash.ts`. */
function resolveArms(spec: CompletionSpec, next: string): string {
  let out = '';

  for (const cmd of spec.commands) {
    if (cmd.subcommands.length === 0) {
      continue;
    }

    let inner = '';
    for (const sub of cmd.subcommands) {
      const patterns = sub.tokens.map(zshQuote).join('|');
      const reached = zshQuote([...cmd.path, sub.name].join(' '));
      inner += `        (${patterns}) ${next}=${reached} ;;\n`;
    }

    out += `    ${pathPattern(cmd.path)}\n      case "$2" in\n${inner}      esac\n      ;;\n`;
  }

  return out;
}

/**
 * The arms that offer subcommand names and their listed aliases, with their
 * descriptions. See `subArms()` in `./bash.ts`.
 */
function subArms(spec: CompletionSpec, cands: string): string {
  let out = '';
  for (const cmd of spec.commands) {
    const pairs = cmd.subcommands.flatMap((sub) =>
      sub.listed.map((token) => zshPair(token, sub.desc))
    );
    if (pairs.length > 0) {
      out += arm(cmd.path, `${cands}=(${pairs.join(' ')})`);
    }
  }
  return out;
}

/** The arms that offer option spellings, with their descriptions. */
function optArms(spec: CompletionSpec, cands: string): string {
  let out = '';
  for (const cmd of spec.commands) {
    const pairs = cmd.options.flatMap((opt) =>
      opt.spellings.map((spelling) => zshPair(spelling, opt.desc))
    );
    if (pairs.length > 0) {
      out += arm(cmd.path, `${cands}=(${pairs.join(' ')})`);
    }
  }
  return out;
}

/** The arms that offer a command's positional choices. */
function argArms(spec: CompletionSpec, cands: string): string {
  let out = '';
  for (const cmd of spec.commands) {
    if (cmd.argValues.length > 0) {
      const pairs = cmd.argValues.map((value) => zshPair(value)).join(' ');
      out += arm(cmd.path, `${cands}=(${pairs})`);
    }
  }
  return out;
}

/**
 * One command's option-value arm.
 *
 * @param cmd - The command.
 * @param takes - The name of the flag to set.
 * @param cands - The name of the array to fill.
 * @returns The arm, or nothing when none of its options takes a value.
 */
function valueArm(cmd: CompletionCommand, takes: string, cands: string): string {
  const valued = cmd.options.filter((opt) => opt.takesValue);

  if (valued.length === 0) {
    return '';
  }

  let inner = '';
  for (const opt of valued) {
    const patterns = opt.spellings.map(zshQuote).join('|');
    const values = opt.values?.length
      ? `; ${cands}=(${opt.values.map((value) => zshPair(value)).join(' ')})`
      : '';
    inner += `        (${patterns}) ${takes}=1${values} ;;\n`;
  }

  return `    ${pathPattern(cmd.path)}\n      case "$2" in\n${inner}      esac\n      ;;\n`;
}

/** The arms that say which options take a value. */
function valueArms(spec: CompletionSpec, takes: string, cands: string): string {
  return spec.commands.map((cmd) => valueArm(cmd, takes, cands)).join('');
}

/**
 * The zsh completion script for a spec.
 *
 * @param spec - What to complete.
 * @returns The script, ending in a newline.
 */
export function zshScript(spec: CompletionSpec): string {
  const { program } = spec;
  const pre = generatedPrefix(program);
  const fn = completionFunction(program);
  const q = zshQuote(program);
  const cands = `${pre}_cands`;
  const next = `${pre}_next`;
  const path = `${pre}_path`;
  const takes = `${pre}_takes`;

  return `#compdef ${program}
# ${generatedBy('zsh', program)}
#
# Save it where zsh looks:
${installComment('zsh', program)}
#
# Nothing in here runs \`${program}\`: every candidate was baked in when this
# file was written, so a tab costs no process at all. Regenerate it when the
# commands, options or choices change.

# which path a word takes you to, by its name or by any alias it answers to.
# A word that is no command answers nothing, which is also what keeps an
# option's value from being read as one
${pre}_resolve() {
  ${next}=''
  case "$1" in
${resolveArms(spec, next)}  esac
}

${pre}_subs() {
  ${cands}=()
  case "$1" in
${subArms(spec, cands)}  esac
}

${pre}_opts() {
  ${cands}=()
  case "$1" in
${optArms(spec, cands)}  esac
}

${pre}_args() {
  ${cands}=()
  case "$1" in
${argArms(spec, cands)}  esac
}

# sets ${takes} and ${cands} rather than completing, because the walk has to ask
# whether an option eats the next token without offering anything
${pre}_optval() {
  ${takes}=0
  ${cands}=()
  case "$1" in
${valueArms(spec, takes, cands)}  esac
}

${fn}() {
  # one option rather than \`emulate -L zsh\`, which was the first fix and broke
  # a real completion. A sourced function does not get what an autoloaded one
  # does -- \`compinit\` loads a \`_name\` from $fpath with \`autoload -Uz\` and
  # \`source <(app completion zsh)\` does not -- so under a user's \`ksh_arrays\`
  # the \`$words[i]\` walk read the wrong word and \`app db <TAB>\` offered the
  # root's commands. But \`localoptions\` scopes an option over everything this
  # function *calls*, and \`emulate\` resets them all: measured through a pty,
  # \`_files\` then failed with \`no matches found: *:globbed-files\` and completed
  # a file from the working directory instead of the option's values. So the fix
  # is the one option that was wrong, and nothing else moves
  setopt localoptions no_ksh_arrays

  # both are the data functions' to write: \`local\` is dynamically scoped, so
  # they fill this call's and leak nothing
  local -a ${cands}
  local ${takes}=0
  local ${next}=''
  # \`path\` is prefixed because in zsh it is a **special** parameter tied to
  # \`PATH\`: \`local path=''\` empties \`$PATH\` for the duration of the function,
  # so \`whence -p ls\` finds nothing -- measured -- and this function calls into
  # the whole completion system, which is third-party shell code that may run an
  # external command. The bash emitter prefixes it too, for one spelling across
  # the two rather than because bash needs it
  local ${path}='' word cur prev opt
  local -i i skip=0

  # the command path, read off the words before the cursor. A word that
  # resolves to no command leaves the path where it was -- which is also what
  # keeps an option's value from being read as a command
  for (( i = 2; i < CURRENT; i++ )); do
    word=$words[i]
    if (( skip )); then
      skip=0
      continue
    fi
    case "$word" in
      # after the terminator everything is an extra argument, so a file is\n      # the answer -- which is what bash's \`-o default\` gives there\n      ('--') _files; return ;;
      ('') continue ;;
      (-*)
        ${pre}_optval "$${path}" "$word"
        (( ${takes} )) && skip=1
        continue
        ;;
    esac
    ${pre}_resolve "$${path}" "$word"
    # a command's path is never empty, so an empty answer is "no command"
    [[ -n $${next} ]] && ${path}=$${next}
  done

  cur=$words[CURRENT]
  prev=''
  (( CURRENT > 1 )) && prev=$words[CURRENT-1]

  # \`--opt=<TAB>\`: zsh keeps that as one word, so the option is the part before
  # the \`=\` and \`compset\` is what takes the prefix off the match
  if [[ $cur == -*=* ]]; then
    opt=\${cur%%=*}
    ${pre}_optval "$${path}" "$opt"
    if (( ${takes} )); then
      # by length rather than by the pattern \`*=\`, which is greedy: a value
      # holding an \`=\` -- \`--file=a=b\` -- had its prefix taken through the
      # *last* one, so the matcher saw \`b\` where bash's \`\${cur#*=}\` sees
      # \`a=b\`. The option's own length is exact and needs no pattern quoting
      compset -p $(( \${#opt} + 1 ))
      if (( \${#${cands}} )); then
        _describe -t values value ${cands} && return 0
      fi
      _files && return 0
      return 1
    fi
  fi

  if [[ $cur == -* ]]; then
    ${pre}_opts "$${path}"
    if (( \${#${cands}} )); then
      _describe -t options option ${cands} && return 0
    fi
    return 1
  fi

  if [[ $prev == -* ]]; then
    ${pre}_optval "$${path}" "$prev"
    if (( ${takes} )); then
      if (( \${#${cands}} )); then
        _describe -t values value ${cands} && return 0
      fi
      _files && return 0
      return 1
    fi
  fi

  # both, and neither returns early: a command with subcommands may also have
  # positional choices -- a \`default\` subcommand's are offered at its parent --
  # and returning after the first \`_describe\` offered the commands and dropped
  # the values, where bash adds both. Found by review
  local -i ${pre}_added=0

  ${pre}_subs "$${path}"
  if (( \${#${cands}} )); then
    _describe -t commands command ${cands} && ${pre}_added=1
  fi

  ${pre}_args "$${path}"
  if (( \${#${cands}} )); then
    _describe -t values value ${cands} && ${pre}_added=1
  fi

  (( ${pre}_added )) && return 0

  # a file is the answer where nothing is declared: an option whose values are
  # anything its type will take, and a positional with no choices
  _files
}

# autoloaded from $fpath, the function's own name is on the stack and this file
# is being asked to complete; sourced, it is not and the job is to register
if [ "$funcstack[1]" = ${zshQuote(fn)} ]; then
  ${fn} "$@"
else
  compdef ${fn} ${q}
fi
`;
}
