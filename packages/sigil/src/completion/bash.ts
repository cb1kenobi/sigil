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
 * ## What is inserted is quoted, and what was typed is unquoted
 *
 * readline inserts a `COMPREPLY` entry as it stands, so `__x_put` stores each
 * candidate the way it has to be typed -- `printf %q`, or what an open quote
 * needs -- and `__x_keep` takes the user's own quoting off every word before
 * anything is compared, so `two\ w` is a prefix of `two words` and `it\'s` is
 * the command `it's`. The rule and its measurements are in this directory's
 * `AGENTS.md`.
 *
 * ## The data appears once per question
 *
 * `__x_known` is the set of command paths and is what the walk tests against,
 * so the subcommand names are not written out a second time to answer "does
 * this word extend the path". `__x_optval` sets a flag and an array rather than
 * printing, because the walk has to ask whether an option consumes the next
 * token *without* adding anything to `COMPREPLY`.
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
 * A string as a bash single-quoted literal.
 *
 * `'` closes the quote, so it is written as `'\''`: close, escape one quote,
 * reopen. Every other byte -- a backtick, a `$`, a `\`, a newline -- is literal
 * inside single quotes, which is why this is the only escaping bash needs and
 * why it is the one used for both the `case` patterns and the `__x_add`
 * arguments.
 *
 * It is `shQuote()`, which is the same rule and is in `./install.ts` because
 * the startup-file lines the installer prints need it too -- and `install.ts`
 * is what this module imports rather than the other way round, so the quoting
 * cannot live here. Two spellings of "one shell word" is how one of them comes
 * to be a line that runs on every login with a quote in it.
 *
 * @param text - The string.
 * @returns The quoted literal.
 */
export function bashQuote(text: string): string {
  return shQuote(text);
}

/** The `case` pattern for a command path, `''` for the root. */
function pathPattern(path: readonly string[]): string {
  return bashQuote(path.join(' '));
}

/** One `case` arm, or nothing when there is nothing to say for that path. */
function arm(path: readonly string[], body: string): string {
  return `    ${pathPattern(path)}) ${body} ;;\n`;
}

/**
 * The arms that say which path a word at a path takes you to.
 *
 * A mapping rather than a yes-or-no, because an **alias** is a token the parser
 * accepts and the rest of the line has to complete against the command it
 * reaches: `mycli rm <TAB>` on a `remove` aliased `rm` has to be `remove`'s
 * subtree. So the arm matches every token and answers with the *canonical*
 * path, which keeps the arms below keyed on one spelling. Every token, a
 * property alias included -- one that is never offered still resolves once it
 * has been typed, because a menu leaving a spelling out is not argv refusing it.
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
      inner += `        ${patterns}) ${pre}_next=${reached} ;;\n`;
    }

    out += `    ${pathPattern(cmd.path)})\n      case "$2" in\n${inner}      esac\n      ;;\n`;
  }

  return out;
}

/**
 * The arms that offer subcommand names.
 *
 * Every listed token rather than the canonical name alone, for the reason
 * `CompletionSubcommand.listed` gives: a name-string alias is published, and
 * one that is not a prefix of its own name is otherwise unreachable. A property
 * alias is not listed, and is still in the arms `resolveArms()` writes.
 *
 * @param spec - What to complete.
 * @param pre - The generated-name prefix.
 * @returns The arms.
 */
function subArms(spec: CompletionSpec, pre: string): string {
  let out = '';
  for (const cmd of spec.commands) {
    const names = cmd.subcommands.flatMap((sub) => sub.listed.map(bashQuote));
    if (names.length > 0) {
      out += arm(cmd.path, `${pre}_add '' "$2" "$3" ${names.join(' ')}`);
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
      out += arm(cmd.path, `${pre}_add '' "$2" "$3" ${spellings.map(bashQuote).join(' ')}`);
    }
  }
  return out;
}

/** The arms that offer a command's positional choices. */
function argArms(spec: CompletionSpec, pre: string): string {
  let out = '';
  for (const cmd of spec.commands) {
    if (cmd.argValues.length > 0) {
      out += arm(cmd.path, `${pre}_add '' "$2" "$3" ${cmd.argValues.map(bashQuote).join(' ')}`);
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
    inner += `        ${patterns}) ${pre}_takes=1${values} ;;\n`;
  }

  return `    ${pathPattern(cmd.path)})\n      case "$2" in\n${inner}      esac\n      ;;\n`;
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
  const pre = generatedPrefix(program);
  const fn = completionFunction(program);
  const q = bashQuote(program);

  return `# ${generatedBy('bash', program)}
#
# Save it somewhere your shell reads:
${installComment('bash', program)}
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
  # \`$1\` is what every candidate sits after inside one word -- \`--opt=\` for an
  # attached value, empty otherwise -- so \`$1$c\` is the whole word the shell
  # would end up with. \`$2\` is the whole word as typed, which is what a
  # candidate is filtered by, and \`$3\` is the part of it readline will *not*
  # replace, which is what has to come back off the front of what is inserted.
  # Both have had the user's quoting taken off by \`_keep\`, so a candidate is
  # compared as the value it is rather than as somebody spelled it
  local __pre="$1" __cur="$2" __keep="$3" __c __w
  shift 3
  for __c in "$@"; do
    __w="$__pre$__c"
    case "$__w" in
      "$__cur"*) ${pre}_put "\${__w#"$__keep"}" ;;
    esac
  done
}

# every \`~\` that \`%q\` left bare in \`__o\` takes a backslash: bash expands one
# at the start of a word and after an \`=\` or a \`:\` in one, and bash 3.2's
# \`%q\` escapes none of them. A \`$'...'\` answer has quoted all of itself
${pre}_tilde() {
  case "$__o" in "$'"*) return ;; esac
  local __t='' __j=0 __d
  while [ "$__j" -lt \${#__o} ]; do
    __d="\${__o:__j:1}"
    __j=$((__j + 1))
    case "$__d" in
      '\\')
        __t="$__t$__d\${__o:__j:1}"
        __j=$((__j + 1))
        ;;
      '~') __t="$__t\\\\~" ;;
      *) __t="$__t$__d" ;;
    esac
  done
  __o="$__t"
}

# a candidate as it has to be typed, because readline inserts \`COMPREPLY\` as
# it stands -- it quotes only under \`-o filenames\` -- so \`two words\` would
# arrive as two arguments and \`it's\` as an open quote. Outside a quote that is
# \`printf %q\` of anything holding a character a shell could read as something
# else. Inside a quote the user opened, readline closes it, so only what that
# quote cannot hold is said. A \`~\` takes its backslash in \`_tilde\`, because
# bash 3.2's \`%q\` leaves it bare, and bare it is a home directory
${pre}_put() {
  local __v="$1" __o='' __c __i=0
  case "$${pre}_quote" in
    "'")
      # nothing is special inside single quotes but the quote itself, which
      # is closed, escaped and reopened
      while [ "$__i" -lt \${#__v} ]; do
        __c="\${__v:__i:1}"
        if [ "$__c" = "'" ]; then __o="$__o'\\''"; else __o="$__o$__c"; fi
        __i=$((__i + 1))
      done
      ;;
    '"')
      # four characters take a backslash inside double quotes. A \`!\` is
      # history expansion there however it is escaped, so it steps outside
      while [ "$__i" -lt \${#__v} ]; do
        __c="\${__v:__i:1}"
        case "$__c" in
          '$' | '\`' | '"' | '\\') __o="$__o\\\\$__c" ;;
          '!') __o="$__o"'"\\!"' ;;
          *) __o="$__o$__c" ;;
        esac
        __i=$((__i + 1))
      done
      ;;
    *)
      case "$__v" in
        *[![:alnum:]_@%+=:,./-]*)
          printf -v __o '%q' "$__v"
          ${pre}_tilde
          ;;
        *) __o="$__v" ;;
      esac
      ;;
  esac
  # readline closes the quote the user opened only when the character before
  # the cursor is not that quote already, so a replacement ending in one -- an
  # escaped quote, or the quote \`"\\!"\` reopens -- was left open. Every one of
  # them ends with the quote open, so it is closed here instead
  case "$${pre}_quote" in
    "'" | '"')
      case "$__o" in *"$${pre}_quote") __o="$__o$${pre}_quote" ;; esac
      ;;
  esac
  # readline will not double an opening quote: a replacement that starts with
  # the quote the user opened is written over it, which turns the first quote
  # of \`'\\''\` or \`"\\!"\` from a close into an open. One more in front puts
  # back the quote readline takes away
  case "$${pre}_quote" in
    "'" | '"')
      case "$__o" in "$${pre}_quote"*) __o="$${pre}_quote$__o" ;; esac
      ;;
  esac
  COMPREPLY[\${#COMPREPLY[@]}]="$__o"
}

# what a word means and how much of it readline keeps, read the way the shell
# and readline read it. Sets \`_cur\` to the word with its quoting taken off,
# \`_pre\` to the same for the part readline will not replace, \`_q\` to the
# quote still open at the end, and \`_end\` to 1 when the last character is a
# break character nothing quoted.
#
# readline replaces from just after a quote that is still open, and otherwise
# from just after the last character in \`$COMP_WORDBREAKS\` that is not quoted
# -- an escaped space, or a \`:\` inside quotes, is part of the word. A
# candidate carrying what readline keeps is inserted twice:
# \`--mode=--mode=fast\`, measured in bash 3.2. Nothing is expanded, so \`$H\` is
# those two characters, because what is being matched is a value. The
# membership test quotes the character, so a \`*\` or a \`[\` in
# \`$COMP_WORDBREAKS\` is matched literally
${pre}_keep() {
  ${pre}_cur=''
  ${pre}_pre=''
  ${pre}_q=''
  ${pre}_end=0
  local __w="$1" __i=0 __c __u='' __q='' __brk='' __open=''
  while [ "$__i" -lt \${#__w} ]; do
    __c="\${__w:__i:1}"
    __i=$((__i + 1))
    ${pre}_end=0
    if [ "$__q" = "'" ]; then
      if [ "$__c" = "'" ]; then __q=''; else __u="$__u$__c"; fi
      continue
    fi
    if [ "$__c" = '\\' ]; then
      __c="\${__w:__i:1}"
      # inside double quotes a backslash quotes only these four, and is
      # otherwise itself
      if [ "$__q" = '"' ]; then
        case "$__c" in
          '$' | '\`' | '"' | '\\') ;;
          *) __u="$__u\\\\"; continue ;;
        esac
      fi
      __u="$__u$__c"
      __i=$((__i + 1))
      continue
    fi
    if [ -n "$__q" ]; then
      if [ "$__c" = '"' ]; then __q=''; else __u="$__u$__c"; fi
      continue
    fi
    case "$__c" in
      "'" | '"')
        __q="$__c"
        __open="$__u"
        continue
        ;;
    esac
    __u="$__u$__c"
    case "$COMP_WORDBREAKS" in
      *"$__c"*) __brk="$__u"; ${pre}_end=1 ;;
    esac
  done
  ${pre}_cur="$__u"
  ${pre}_q="$__q"
  if [ -n "$__q" ]; then ${pre}_pre="$__open"; else ${pre}_pre="$__brk"; fi
}

# bash 4 and later split the line \`as readline would split it, using
# COMP_WORDBREAKS\`, so \`--tag host:port\` arrives as five words and
# \`--mode=fast\` as three. bash 3.2 splits on shell metacharacters only and
# hands each over whole -- both are what their own manuals say, and this is the
# one place the difference has to be absorbed: everything below wants one word
# per word the user typed. A raw word that is nothing but break characters sat
# between two words with no space, and so does whatever follows a logical word
# that now ends in one
${pre}_join() {
  ${pre}_w=()
  ${pre}_c=0
  local __i=0 __n=\${#COMP_WORDS[@]} __raw __last __j
  while [ "$__i" -lt "$__n" ]; do
    __raw="\${COMP_WORDS[__i]}"
    __j=\${#${pre}_w[@]}
    if [ "$__j" -gt 0 ] && { ${pre}_allbreak "$__raw" || ${pre}_endsbreak "\${${pre}_w[__j-1]}"; }; then
      ${pre}_w[__j-1]="\${${pre}_w[__j-1]}$__raw"
      if [ "$__i" -le "$COMP_CWORD" ]; then ${pre}_c=$((__j - 1)); fi
    else
      ${pre}_w[__j]="$__raw"
      if [ "$__i" -le "$COMP_CWORD" ]; then ${pre}_c=$__j; fi
    fi
    __i=$((__i + 1))
  done
}

# whether a word is made only of break characters, and whether one ends in a
# break character -- the two questions \`_join\` asks per word. A quote is in
# the default \`$COMP_WORDBREAKS\` and is never split off as one, because bash
# 4 and later honour quoting when they split: \`''\` is an empty argument and
# \`it\\'\` ends in a quote nothing breaks at, and neither is glued to the word
# beside it
${pre}_allbreak() {
  local __w="$1" __i=0 __c
  [ -n "$__w" ] || return 1
  while [ "$__i" -lt \${#__w} ]; do
    __c="\${__w:__i:1}"
    case "$__c" in
      "'" | '"' | '\\') return 1 ;;
    esac
    case "$COMP_WORDBREAKS" in
      *"$__c"*) ;;
      *) return 1 ;;
    esac
    __i=$((__i + 1))
  done
  return 0
}

${pre}_endsbreak() {
  ${pre}_keep "$1"
  [ "$${pre}_end" = 1 ]
}

# which path a word takes you to, by its name or by any alias it answers to.
# A word that is no command answers nothing, which is also what keeps an
# option's value from being read as one
${pre}_resolve() {
  ${pre}_next=''
  case "$1" in
${resolveArms(spec, pre)}  esac
}

${pre}_subs() {
  case "$1" in
${subArms(spec, pre)}  esac
}

${pre}_opts() {
  case "$1" in
${optArms(spec, pre)}  esac
}

${pre}_args() {
  case "$1" in
${argArms(spec, pre)}  esac
}

# sets ${pre}_takes and ${pre}_vals rather than adding, because the walk has to
# ask whether an option eats the next token without offering anything
${pre}_optval() {
  ${pre}_takes=0
  ${pre}_vals=()
  case "$1" in
${valueArms(spec, pre)}  esac
}

${fn}() {
  local cur prev word
  local i skip
  # prefixed for the reason the zsh emitter records: there, \`path\` is a
  # special parameter tied to \`PATH\`. bash has no such parameter and this is
  # one spelling across the two
  local ${pre}_path=''
  local ${pre}_next=''
  local ${pre}_takes=0
  # declared rather than assigned, because \`local x=()\` is not an array
  # declaration in every bash this has to run in
  local -a ${pre}_vals
  # the rejoined words, the cursor's index into them, and the kept prefix
  local -a ${pre}_w
  local ${pre}_c=0
  # what \`_keep\` answers, and the two answers about the current word that
  # outlive the next time it is asked
  local ${pre}_cur='' ${pre}_pre='' ${pre}_q='' ${pre}_end=0
  local ${pre}_kept='' ${pre}_quote=''

  COMPREPLY=()
  ${pre}_join
  # every word is read as the value it spells, which is what argv will hold:
  # \`it\\'s\` is the command \`it's\`, and \`two\\ w\` is a prefix of \`two words\`.
  # For the current word, what readline will keep is what every candidate has
  # to come back off the front of, and an open quote says how to insert one
  ${pre}_keep "\${${pre}_w[${pre}_c]}"
  cur="$${pre}_cur"
  ${pre}_kept="$${pre}_pre"
  ${pre}_quote="$${pre}_q"
  prev=''
  if [ "$${pre}_c" -gt 0 ]; then
    ${pre}_keep "\${${pre}_w[${pre}_c-1]}"
    prev="$${pre}_cur"
  fi

  # the command path, read off the words before the cursor. A word that
  # resolves to no command leaves the path where it was -- which is also what
  # keeps an option's value from being read as a command
  skip=0
  i=1
  while [ "$i" -lt "$${pre}_c" ]; do
    ${pre}_keep "\${${pre}_w[i]}"
    word="$${pre}_cur"
    i=$((i + 1))
    if [ "$skip" = 1 ]; then
      skip=0
      continue
    fi
    case "$word" in
      '--') return 0 ;;
      '') continue ;;
      -*)
        ${pre}_optval "$${pre}_path" "$word"
        if [ "$${pre}_takes" = 1 ]; then skip=1; fi
        continue
        ;;
    esac
    ${pre}_resolve "$${pre}_path" "$word"
    # a command's path is never empty, so an empty answer is "no command"
    if [ -n "$${pre}_next" ]; then ${pre}_path="$${pre}_next"; fi
  done

  # \`--opt=<TAB>\`, which is one word now however the shell split it. The
  # candidates are values rather than words, so each one is offered as
  # \`--opt=\` plus the value -- which is what \`cur\` has to be filtered
  # against -- and \`_keep\` decides how much of that comes back off
  case "$cur" in
    -*=*)
      ${pre}_optval "$${pre}_path" "\${cur%%=*}"
      if [ "$${pre}_takes" = 1 ]; then
        if [ \${#${pre}_vals[@]} -gt 0 ]; then
          ${pre}_add "\${cur%%=*}=" "$cur" "$${pre}_kept" "\${${pre}_vals[@]}"
        fi
        return 0
      fi
      ;;
  esac

  case "$cur" in
    -*)
      ${pre}_opts "$${pre}_path" "$cur" "$${pre}_kept"
      return 0
      ;;
  esac

  case "$prev" in
    -*)
      ${pre}_optval "$${pre}_path" "$prev"
      if [ "$${pre}_takes" = 1 ]; then
        if [ \${#${pre}_vals[@]} -gt 0 ]; then ${pre}_add '' "$cur" "$${pre}_kept" "\${${pre}_vals[@]}"; fi
        return 0
      fi
      ;;
  esac

  ${pre}_subs "$${pre}_path" "$cur" "$${pre}_kept"
  ${pre}_args "$${pre}_path" "$cur" "$${pre}_kept"
  return 0
}

# \`-o default\` is what makes a file the answer where this has none: an option
# whose values nothing declared, and a positional with no choices
complete -o default -F ${fn} ${q}
`;
}
