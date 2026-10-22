/**
 * The command tree, read as the data a shell needs to complete it.
 *
 * Everything here is something the app already told the parser: the names and
 * aliases a command answers to, what each one is for, `hidden`, every option's
 * spellings, and the `choices` a value is checked against. There is nothing new
 * to declare and nothing to extract from source -- which is the whole reason a
 * framework that owns an argument parser can have completion cheaply, and is
 * the same claim `commandCatalog()` rests on one layer along.
 *
 * ## Why this is not `commandCatalog()`
 *
 * It is the same registries read for a different question, and the two
 * questions really are different. A catalog answers *what can be selected and
 * run*, so a namespace is noise and a command's **required** options are the
 * values it needs; completion answers *what can be typed*, so every path
 * segment counts -- you have to type `db` to get to `db migrate` -- and every
 * option is a candidate whether it is required or not. `should offer every
 * command the catalog lists` is the differential that keeps the two from
 * drifting about the thing they do agree on.
 *
 * ## It loads every module, and that is the one place that is right
 *
 * A command's description and `hidden` live inside its module, and its options
 * live *only* there -- `sigil build` lifts the first two and nothing lifts the
 * third. So a completion script for a routed or a bundled app cannot know what
 * `db migrate` accepts without importing `db/migrate.js`. Generating one is
 * exactly the moment to pay for that: it is a one-off a user runs when they
 * install completion, not a per-keypress cost, and reading everything is what a
 * compiler does -- which is the argument `tree.ts` already makes for the build's
 * own walk.
 *
 * What it costs is written down rather than hedged: a command module is allowed
 * to do things at top level -- read a config file, open a connection, exit --
 * and this imports all of them. An app whose modules do that will do it once
 * here, and a module that throws takes the script with it rather than leaving a
 * gap nobody is told about. A completion script is installed once and forgotten,
 * so a silently incomplete one is the failure that lasts.
 */

import { loadCommand } from '../parser/command/load-command.js';
import { Internal, type InternalCommand, type InternalOption, type Schema } from '../types.js';
import { registerable } from './install.js';

/** Where the tree is, which is what a parse already produced. */
export interface CompletionTarget {
  /**
   * The command chain, innermost first, ending at the schema's root. Only the
   * root is read: a completion script describes the whole program rather than
   * wherever the invocation that asked for it happened to end up.
   */
  contexts: InternalCommand[];
  /** The schema, for the program's name. */
  schema?: Schema;
}

/** One option, as a shell offers it. */
export interface CompletionOption {
  /** What it is for, on one line. */
  readonly desc?: string;
  /**
   * The dashed spellings argv reaches it by, long names before short ones.
   *
   * Spellings rather than the name, because that is what gets typed: an option
   * declared `'-p <n>'` is *named* `p` and answers to `-p` and not to `--p`.
   * A negated flag's positive spelling is in here too, since the registry
   * answers to both.
   */
  readonly spellings: readonly string[];
  /** Whether it consumes the next token, which is `!isFlag`. */
  readonly takesValue: boolean;
  /**
   * The values it accepts, when the declaration said: `choices` as written, or
   * the two words a `bool` or a `yesno` takes.
   *
   * Absent where there is nothing to offer, which is both "a value is anything
   * the type will coerce" and "the declaration named a list with nothing
   * typeable in it". One spelling, because every reader asks `?.length` and a
   * `[]` beside an `undefined` would be a distinction nothing observes.
   */
  readonly values?: readonly string[];
}

/** One command, as a shell completes at it. */
export interface CompletionCommand {
  /**
   * Every value this command's positional arguments accept, in declaration
   * order and deduplicated.
   *
   * The union rather than one list per position, which is a deliberate
   * looseness: knowing *which* positional the cursor is at means counting the
   * non-option words after the command path and knowing which of them were
   * consumed as option values, and getting that wrong offers the wrong list.
   * The union over-offers for a command whose two arguments have different
   * choices and is right for every command with one, which is almost all of
   * them.
   */
  readonly argValues: readonly string[];
  /**
   * Every option reachable here: its own first, then each ancestor's outward.
   *
   * Options resolve across the whole context chain, so an ancestor's are
   * typable here and have to be offered. A nearer declaration of the same
   * spelling shadows an outer one, which is the order the registry lookup
   * already resolves in.
   */
  readonly options: readonly CompletionOption[];
  /**
   * The argv path from the root, empty for the root itself.
   *
   * Every emitter keys its arms on this joined by a space, which is the same
   * spelling `PaletteEntry.label` already uses -- and which a command whose own
   * *name* holds a space makes ambiguous: a root `my cmd` and a `cmd` under a
   * `my` join to the one key. A name like that comes only from a file called
   * `my cmd.js` and is already something a user has to quote to type at all, so
   * it is written down rather than worked around; there is no separator a route
   * name cannot contain.
   */
  readonly path: readonly string[];
  /** The direct subcommands, by the name argv reaches each one by. */
  readonly subcommands: readonly CompletionSubcommand[];
}

/** One subcommand, as a shell offers it. */
export interface CompletionSubcommand {
  /** What it is for, on one line. */
  readonly desc?: string;
  /**
   * The token that reaches it, which is the name its *registry* is keyed by
   * rather than whatever its module calls itself.
   *
   * The two part company for a `{ path }` or `{ load }` whose module declares
   * a different `name`: only the placeholder's name routes, so offering the
   * module's would be offering a token the parser refuses. That is
   * `matchedName()`'s lesson in the catalog, met from the other side -- here
   * the loaded command is read for its description and its options and never
   * for its name.
   */
  readonly name: string;
  /**
   * Every token that reaches it, the name first, then the aliases it answers
   * to -- asked of the registry rather than read off the command.
   *
   * An alias is a token the parser accepts, so it belongs in a list of what
   * can be typed: a `remove` aliased `rm` is unreachable by prefix, and
   * `mycli rm <TAB>` has to resolve to `remove`'s subtree or the rest of the
   * line completes against the wrong command. That is where this differs from
   * `PaletteEntry`, which keeps its aliases out of the label on purpose -- a
   * palette lists one row per *command*, and a completion menu lists *tokens*.
   *
   * Asked of the registry, because `find()` is what decides which command a
   * token reaches: an alias a sibling's name shadows resolves to the sibling,
   * so offering it here would offer a token that goes somewhere else. Nothing
   * refuses such a schema, so the only exact answer is the registry's own.
   */
  readonly tokens: readonly string[];
}

/** Everything a script needs. */
export interface CompletionSpec {
  /** Every command, the root first, parents before children. */
  readonly commands: readonly CompletionCommand[];
  /** The executable the script registers itself for. */
  readonly program: string;
}

/** Every control character, named rather than enumerated. */
const CONTROL = /\p{Cc}/gu;

/**
 * The same set, without the `g` flag, because `test()` on a global regex is
 * stateful: it leaves `lastIndex` past the match, so the next call on a
 * different string starts part way in and answers `false` for a string that
 * holds one. One pattern used two ways is how that bug happens, so there are
 * two patterns.
 */
const HAS_CONTROL = /\p{Cc}/u;

/**
 * A description as one line, with nothing a terminal would act on in it.
 *
 * Both halves matter and the order does too. Whitespace is collapsed first,
 * because a description is shown on one line in every shell that shows one at
 * all -- zsh's `_describe` takes line-oriented pairs -- and a newline inside a
 * correctly quoted string is still a broken list. Then whatever control
 * characters are left are dropped, which is the rule this repository keeps
 * everywhere: a raw escape sequence in a file something is about to print is a
 * sequence waiting to be executed, and a completion script is printed by the
 * shell on every tab.
 *
 * Collapsing is not a substitute for quoting and is not treated as one: a quote
 * or a backtick survives this untouched, and each emitter escapes its own.
 *
 * @param text - The description, if there is one.
 * @returns One line, or nothing when there is nothing left to say.
 */
export function oneLine(text: unknown): string | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }

  const flat = text.replaceAll(/\s+/gu, ' ').replaceAll(CONTROL, '').trim();
  return flat || undefined;
}

/**
 * The program a completion is for, from a schema's `name`.
 *
 * One function because the two readers of that name disagreed about what it
 * *is* rather than about what is allowed. `registerable()` was already shared,
 * and `completionSpec()` asked it of `oneLine(name)` while the installer asked
 * it of the raw string -- so the predicate agreed and the subject did not, and
 * the two halves of one command answered differently about one app:
 *
 * - `name: 'my<ESC>cli'`. The printer strips the control character and writes a
 *   header naming `mycli`; the installer's path was `_my<ESC>cli` and its
 *   marker was built from the raw name. Measured: the first install wrote, and
 *   then every re-run read its own file as `foreign` -- so it asked before
 *   replacing the script it had just written, and `--uninstall` **refused to
 *   remove it at all**. An installed completion nothing could maintain or take
 *   back out.
 * - `name: ' mycli '`. The printer trims and serves it; the install path threw,
 *   because `installTargets()` runs before `completionScript()` does.
 *
 * Which is the shared-predicate-unshared-subject shape, and the reason the
 * derivation is a function rather than a rule each caller keeps. Found by
 * review round 3.
 *
 * It does not say whether the result is *registerable* -- that is
 * `registerable()`'s, asked by both callers of this -- only what the name
 * reduces to.
 *
 * @param name - What the schema declared, which is `unknown` to this package.
 * @returns The name, or nothing where there is none left.
 */
export function programOf(name: unknown): string | undefined {
  return oneLine(name);
}

/**
 * The values a declaration says a slot accepts.
 *
 * `choices` as the app wrote them, stringified the way argv would have to spell
 * them -- a choice is compared against the *coerced* value, so what a user types
 * for `choices: [true, false]` on a `yesno` is `yes` and `no` rather than `true`
 * and `false`. Then the two words a flagless `bool` or `yesno` takes, which is
 * a completion list the app declared by declaring a type.
 *
 * `bool` accepts six spellings of true and seven of false, and offering all
 * thirteen is noise: `true`/`false` and `yes`/`no` are the canonical pair for
 * each type, which is what the prompts already draw.
 *
 * @param type - The data type a value is coerced with.
 * @param choices - What the declaration allowed, if anything.
 * @returns The values, or nothing where a value is anything the type will take.
 */
function valuesFor(type: string, choices: unknown): readonly string[] | undefined {
  // a declared list is the whole answer, and the `return` is the load-bearing
  // half: an empty `choices` is a list the parser refuses *every* value
  // against, so falling through to the type's own two words would offer tokens
  // the parse then rejects -- which is the divergence this whole file is
  // written against. What an unusable list comes to is `undefined` rather than
  // `[]`, which changes no answer and is one spelling for one meaning
  if (Array.isArray(choices)) {
    const values = declaredValues(type, choices);
    return values.length > 0 ? values : undefined;
  }

  if (type === 'bool') {
    return ['true', 'false'];
  }
  if (type === 'yesno') {
    return ['yes', 'no'];
  }
}

/**
 * The tokens a declared `choices` list is reachable by, in the order it was
 * written.
 *
 * The first branch of `valuesFor()`, lifted out because the command surface
 * asks the same question and must not answer it a second way: a `yesno` whose
 * choices are the booleans is reachable only by the words, and a choice holding
 * a control character is reachable by nothing. Two readers that each stringified
 * a choice themselves would be two answers to "what can be typed here", which is
 * the one thing a reference and a completion script have to agree about.
 *
 * What it does *not* do is add the two words a bare `bool` or `yesno` takes --
 * that is `valuesFor()`'s own second half and belongs only to a completion
 * menu. A reference records what the declaration said, and the type already says
 * the rest.
 *
 * @param type - The data type a value is coerced with.
 * @param choices - The declared list.
 * @returns The tokens, deduplicated, in declaration order.
 */
export function declaredValues(type: string, choices: readonly unknown[]): string[] {
  return dedupe(choices.map((choice) => tokenFor(choice, type)).filter(typeable));
}

/**
 * Whether a value is one a shell can offer at all.
 *
 * Dropped rather than cleaned, which is the opposite call from a description
 * and is the right one for the opposite reason: a description is *shown*, so
 * stripping a control character out of it loses nothing a reader wanted, while
 * a value is *inserted into the command line* -- so offering `ab` for a choice
 * of `a<ESC>b` would type a token that is not the value, which is a wrong
 * answer rather than a tidied one. A value holding one was never completable,
 * and leaving it in would put a live escape sequence in a file the shell prints
 * on every tab.
 *
 * Whitespace is deliberately not touched: a value really may contain a space,
 * and every emitter quotes it.
 *
 * @param value - The token.
 * @returns Whether to offer it.
 */
function typeable(value: string): boolean {
  return value !== '' && !HAS_CONTROL.test(value);
}

/**
 * One choice, as it has to be typed.
 *
 * A `yesno` coerces `yes` to `true`, so a declaration whose choices are the
 * booleans is reachable only by the words -- offering `true` there is offering a
 * token the parser turns into a value the choice check then refuses. Everything
 * else is `String()`, which is what the value was written as.
 *
 * A `date` or a `json` choice is compared by identity, so no token can ever
 * match one; it is still offered as what it prints, because leaving the list
 * empty would fall back to file completion and that says less.
 *
 * @param choice - The declared value.
 * @param type - The data type.
 * @returns The token.
 */
function tokenFor(choice: unknown, type: string): string {
  if (typeof choice === 'boolean' && type === 'yesno') {
    return choice ? 'yes' : 'no';
  }
  return String(choice);
}

/**
 * Removes repeats, keeping the first of each.
 *
 * @param values - The values.
 * @returns The values, deduplicated in order.
 */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The spellings one option answers to, long before short.
 *
 * Long first because that is the one worth offering in a list: `--verbose` says
 * what it does and `-v` does not. Both are included, since both resolve -- and
 * so does a negated flag's positive spelling, which `OptionRegistry.add()` puts
 * in `long` alongside the `--no-` one.
 *
 * @param opt - The option.
 * @returns Its spellings.
 */
function spellingsOf(opt: InternalOption): string[] {
  const { long, short } = opt[Internal];
  return dedupe([...long, ...short]);
}

/**
 * Every option typable at a command, nearest declaration first.
 *
 * A `hidden` option is left out, which is the same rule a hidden command
 * follows: `hidden` means "not listed", and a completion menu is a listing. A
 * `parserOwned` one -- `--help`, `--version`, `--quiet`, and `--format` with its
 * `--json` sugar -- is *kept*, which is the opposite call from `slotsFor()` and
 * is right for the opposite reason: what that flag says is that the option's
 * *value* is not the app's business, and `--help` is a thing a user types.
 * Measured on a command that declared `format`: the generated bash script lists
 * `--format` and `--json` beside `--help` and `--quiet`, and names `--format` as
 * one that takes a value.
 *
 * Deduplicated by spelling with the nearer declaration winning, because that is
 * the order the registry lookup resolves in: a command declaring `--mode`
 * shadows the root's for itself, and offering both would offer one description
 * for an option that does something else here.
 *
 * @param chain - The command, then its ancestors, ending at the root.
 * @returns The options, innermost first.
 */
function optionsOf(chain: readonly InternalCommand[]): CompletionOption[] {
  const options: CompletionOption[] = [];
  const taken = new Set<string>();

  for (const cmd of chain) {
    for (const opt of cmd[Internal].options.values()) {
      if (opt.hidden) {
        continue;
      }

      const spellings = spellingsOf(opt).filter(
        (spelling) => typeable(spelling) && !taken.has(spelling)
      );
      if (spellings.length === 0) {
        continue;
      }
      for (const spelling of spellings) {
        taken.add(spelling);
      }

      const takesValue = !opt[Internal].isFlag;

      options.push({
        desc: oneLine(opt.desc),
        spellings,
        takesValue,
        // only where a value is taken: a flag's `choices` would be a list
        // nothing can be typed into, since `initOption()` makes an option
        // with `choices` take a value in the first place
        ...(takesValue ? { values: valuesFor(opt.type, opt.choices) } : {}),
      });
    }
  }

  return options;
}

/**
 * Every token that reaches one subcommand, the name first.
 *
 * Filtered through `find()` rather than taken as declared, which is the only
 * way to be exact: the registry keys its lookup by name *and* alias and a later
 * registration overwrites an earlier one, so an alias a sibling also answers to
 * belongs to the sibling. A token that does not come back as this command is
 * one that goes somewhere else, and offering it would be offering a token that
 * completes the wrong subtree.
 *
 * Exported because the command surface asks the same question and a second walk
 * of the same registry is how the two come to disagree about which token reaches
 * what -- which for a reference is a documented alias that routes somewhere
 * else.
 *
 * @param parent - The command whose registry holds it.
 * @param child - The subcommand, as the registry holds it.
 * @returns The tokens, the name first and the aliases sorted after it.
 */
export function tokensFor(parent: InternalCommand, child: InternalCommand): string[] {
  const registry = parent[Internal].commands;

  return [child.name, ...[...child[Internal].aliases].sort()].filter(
    (token) => typeable(token) && registry.find(token) === child
  );
}

/**
 * Every value positional arguments accept at a command.
 *
 * Its own and no ancestor's, because `processArgs()` reads the positional values
 * against the command being run alone -- an ancestor's arguments are never read
 * once a subcommand is dispatched, so nothing typed here lands in one.
 *
 * And its **default** subcommand's, because those are typable here too: a
 * default command is dispatched when argv names no command, so it *is*
 * `contexts[0]` and a bare positional at its parent is one of its arguments.
 * Measured rather than reasoned -- `deep pub` on a `serve` whose `[dir]` has
 * `choices: ['pub', 'www']` runs `serve` with `dir: 'pub'`.
 *
 * @param cmd - The command.
 * @param fallback - Its default subcommand, loaded, when it has one that is
 *   offered at all.
 * @returns The values, deduplicated, the command's own first.
 */
function argValuesOf(cmd: InternalCommand, fallback?: InternalCommand): string[] {
  const values: string[] = [];

  for (const arg of [...cmd[Internal].args, ...(fallback?.[Internal].args ?? [])]) {
    values.push(...(valuesFor(arg.type, arg.choices) ?? []));
  }

  return dedupe(values);
}

/**
 * Reads a whole command tree into the data a script is printed from.
 *
 * Every module is imported, for the reason the module comment gives. The root
 * is read as it was handed over: it is the schema's own command, which `parse()`
 * built and whose own level a `commands: './dir'` declaration has already
 * expanded, so there is nothing left for it to wait for.
 *
 * @param target - A parse state, or anything carrying a context chain.
 * @returns The spec.
 * @throws If the schema names no program, since a script has to register itself
 *   for something; or whatever loading a command module threw.
 */
export async function completionSpec(target: CompletionTarget): Promise<CompletionSpec> {
  const contexts = target?.contexts;

  if (!Array.isArray(contexts) || contexts.length === 0) {
    throw new TypeError('Expected a context chain to build a completion spec from');
  }

  const root = contexts[contexts.length - 1] as InternalCommand;
  const program = programOf(target.schema?.name);

  // a script has to say which command it completes for, and it says so in
  // three places -- `complete -F`, `compdef`, and zsh's `#compdef` first line,
  // which is a *comment* that compinit reads and so cannot be quoted at all.
  // `oneLine()` has already flattened any newline out of the name, which is
  // what stops a second line being written into that comment; refusing the
  // whitespace that is left is what makes the line safe by construction rather
  // than by escaping.
  //
  // And a leading dash, because quoting does not help there either: quote
  // removal happens before a builtin reads its words, so
  // `complete -o default -F _x '-D'` is `complete: -D: invalid option` and the
  // name is never registered -- measured. There is no `--` to put in front of
  // it that `compdef` and `#compdef` would both take, and a command whose name
  // begins with a dash is one no shell can invoke plainly anyway.
  //
  // The rule is `registerable()` in `./install.js` rather than a pattern here,
  // because the **installer** asks it too: an uninstall builds no spec, so that
  // path had this question asked nowhere at all. The sentence stays this
  // caller's, since what it is about is printing a script
  if (!registerable(program)) {
    throw new Error(
      `Cannot generate a completion script: ${
        program
          ? `"${program}" is not a name a shell can register for`
          : 'this app declares no name'
      }, and a script has to name the command it completes for. Set "name" on the schema to what a user types, which is one word and does not begin with a dash.`
    );
  }

  const commands: CompletionCommand[] = [];

  /**
   * The registry entries already walked.
   *
   * It bounds a cycle, which is reachable for the reason the catalog records:
   * a registry holds initialized commands and `initCommand()` hands one
   * straight back, so a declaration naming a command already in its own
   * subtree is a cycle rather than a copy. Keyed on the *placeholder*, which
   * is the object the registry holds -- the command a load produces is a
   * different object, so it would never be seen twice.
   */
  const seen = new Set<InternalCommand>();

  /**
   * Reads one command, then its subcommands.
   *
   * @param cmd - The command, already loaded.
   * @param path - The argv path that reaches it, from the root.
   * @param above - Its ancestors, innermost first, so the option list is the
   *   one the parser would resolve against here.
   */
  async function walk(
    cmd: InternalCommand,
    path: string[],
    above: InternalCommand[]
  ): Promise<void> {
    const chain = [cmd, ...above];
    const subcommands: CompletionSubcommand[] = [];
    const registry = cmd[Internal].commands;

    /**
     * The default subcommand, once loaded, because its own options and
     * arguments are typable *here*.
     *
     * The loaded one rather than the registry's, which holds the placeholder
     * and so knows neither. A **hidden** default contributes nothing, which is
     * `hidden` taken at its word: it says do not list this command, and a
     * completion menu is a listing -- including of the values it would take.
     */
    let fallback: InternalCommand | undefined;

    const children = [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);

      // asked before the import as well as after it, and the two are not the
      // same question. Before: a `!` name prefix or a lifted `hidden` is on
      // the placeholder, so there is no reason to read a module whose command
      // is not going to be offered. After: `hidden` is additive and a module
      // may hide itself, which only an import can say -- so a routed command
      // that hides itself in its own module is offered by the catalog, which
      // never loads, and is not offered here
      if (child.hidden) {
        continue;
      }

      // a name no shell can offer is a command completion cannot reach, which
      // is two shapes rather than one. A control character in it is the
      // `typeable()` rule met on a *name* -- `_describe` is line-oriented, so
      // a newline in one breaks the element it is in, and an escape in one
      // reaches the screen on every tab. And **no token at all** is the
      // sharper of the two: `tokensFor()` drops a spelling a sibling answers
      // to, so a command whose own name a sibling's alias shadows has nothing
      // left -- and an empty pattern list is a `case` arm reading `) ... ;;`,
      // which is a *syntax error* in the whole generated script rather than
      // one command missing from it. Found by review
      const tokens = tokensFor(cmd, child);

      if (tokens.length === 0) {
        continue;
      }

      const loaded = await loadCommand(child, cmd);

      if (loaded.hidden) {
        continue;
      }

      if (registry.default === child) {
        fallback = loaded;
      }

      subcommands.push({ desc: oneLine(loaded.desc), name: child.name, tokens });
      await walk(loaded, [...path, child.name], chain);
    }

    commands.push({
      argValues: argValuesOf(cmd, fallback),
      // the default's options **last**, which is the measured order rather
      // than the chain's: at a parent with a default subcommand the *parent's*
      // declaration of a spelling is the one that resolves -- `sh --mode slow`
      // takes the root's choices and `sh serve --mode fast` takes serve's,
      // over the same two declarations -- so the default is the last resort
      // here and the nearest once its name has been typed
      options: optionsOf(fallback ? [...chain, fallback] : chain),
      path,
      subcommands,
    });
  }

  await walk(root, [], []);

  // parents before children, which is the order a reader of the script expects
  // and is not what the walk produces -- it pushes on the way back up
  commands.sort(
    (a, b) => a.path.length - b.path.length || a.path.join(' ').localeCompare(b.path.join(' '))
  );

  return { commands, program };
}
