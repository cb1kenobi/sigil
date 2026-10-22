/**
 * The command surface: every path argv can reach, and what each one accepts.
 *
 * A CLI's command surface is its public API. Nothing in a build notices when it
 * moves, so a pull request that renames a flag silently breaks everybody's
 * scripts -- which is what `@oclif/plugin-command-snapshot` exists for and what
 * this is the payload of. One walk, two readers: `@ttylabs/cli` prints it as
 * markdown for a reader and as sorted JSON for a diff.
 *
 * ## Why this is a third walk of the registries
 *
 * `commandCatalog()` and `completionSpec()` already read the same registries,
 * and all three answer different questions. A catalog answers *what can be
 * selected and run*, so a namespace is noise and only a command's **required**
 * options are listed; completion answers *what can be typed*, so an option's
 * `required` and `multiple` are irrelevant and the arguments' values are
 * unioned rather than kept per position. A reference answers *what does this
 * program accept*, which needs every option, each positional in its own place,
 * and the `required`/`multiple` neither of the others records. None of the three
 * is derivable from either other, which is what makes this a third reader rather
 * than a duplicate -- and `should reach every command the completion spec
 * reaches` is the differential that keeps them from drifting about the thing
 * they do agree on.
 *
 * What is *not* re-derived is anything either already decides. `tokensFor()` and
 * `declaredValues()` are imported from the completion spec, because "which
 * tokens reach this command" and "what can be typed for this choice" have one
 * right answer each and two walks that each worked one out would be two answers.
 *
 * ## It loads every module, and that is the one place that is right
 *
 * A command's description and `hidden` live inside its module, and its options
 * and arguments live *only* there -- `sigil build` lifts the first two and
 * nothing lifts the rest, which is why a reference cannot be a static read of an
 * app's source. So this is `completionSpec()`'s cost taken for the same reason
 * and with the same honesty: a command module is allowed to do things at top
 * level -- read a config file, open a connection, exit -- and this imports all
 * of them. A module that throws takes the reference with it rather than leaving
 * a gap nobody is told about, because a committed reference is read long after
 * it was generated and a silently incomplete one is the failure that lasts.
 *
 * ## It records what the app declared, and not what the framework adds
 *
 * `help`, `completion`, `--help` and `--version` are the parser's, added by
 * `parse()` rather than by the schema -- so a surface built here, which never
 * parses, simply does not contain them. That is the answer rather than a
 * filter: an app's snapshot should move when the app moves and not when the
 * framework does, and what the framework adds is the framework's to document.
 *
 * ## It is faithful about prose and filtered about tokens
 *
 * A description is carried exactly as the declaration resolved it, newlines and
 * all, because a printer's format decides what a description has to become --
 * markdown flattens one into a table cell, and a snapshot drops it. A *token* is
 * filtered by reachability instead: a name no registry answers to and a choice
 * holding a control character are each reachable by nothing, so neither is part
 * of what argv accepts. One line rather than two rules: prose is the printer's,
 * and reachability is the walk's.
 */

import { declaredValues, tokensFor } from '../completion/spec.js';
import { initCommand } from '../parser/command/init-command.js';
import { loadCommand } from '../parser/command/load-command.js';
import type { OptionRegistry } from '../parser/option/option-registry.js';
import {
  Internal,
  type ArgDataType,
  type CommandExample,
  type InternalArgument,
  type InternalCommand,
  type InternalOption,
  type OptionDataType,
  type Schema,
} from '../types.js';

/**
 * A control character, for the one name nothing else filters.
 *
 * A command's name is filtered by `tokensFor()`'s own `typeable()` check and an
 * option's spellings are refused by `initOption()`, so the program's is the only
 * one that reaches a printer unchecked. Without the `g` flag, because `test()` on
 * a global regex is stateful -- the trap `spec.ts` keeps two patterns for.
 */
const HAS_CONTROL = /\p{Cc}/u;

/**
 * Two strings in code-unit order.
 *
 * `localeCompare` is what the catalog and the completion spec sort with, and it
 * is the wrong answer for anything **committed**: it reads the environment, so
 * the same surface produces different bytes on two machines. See the walk.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns Their order.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One positional argument, in the place it is typed. */
export interface SurfaceArgument {
  /** The values it accepts, as argv has to spell them. Empty where any value will do. */
  readonly choices: readonly string[];
  /** What it is for, exactly as the declaration resolved it. */
  readonly desc?: string;
  /**
   * The environment variables it reads, in declaration order.
   *
   * In **declaration** order because that order is the precedence:
   * `envValue()` answers with the first variable that is set, so which one wins
   * is a fact about where it was written. An argument reads them exactly as an
   * option does, and this recorded none of them. Found by review.
   */
  readonly env: readonly string[];
  /** Whether it collects the rest -- the `...` in `<files...>`. */
  readonly multiple: boolean;
  /**
   * Its name, which is what `argv` holds it under and what a usage line shows.
   *
   * The bare name rather than `<name>` or `[name...]`: the brackets are
   * `required` and the ellipsis is `multiple`, both of which are their own
   * fields, so spelling them into the name would be the same fact twice.
   */
  readonly name: string;
  /** Whether a value has to be given. */
  readonly required: boolean;
  /** The data type a value is coerced with. */
  readonly type: ArgDataType;
}

/** One option, as argv reaches it. */
export interface SurfaceOption {
  /** The values it accepts, as argv has to spell them. Empty where any value will do. */
  readonly choices: readonly string[];
  /**
   * What a value falls back to, where the declaration named one and it is not a
   * flag's implied `false`.
   *
   * Which is help's own test, because this is what help prints -- the
   * **snapshot** drops it, for the reason recorded there. Anything a schema put
   * there, so a reader has to be ready for a function. Found by review, where
   * the page said less than `--help` about the same declaration.
   */
  readonly default?: unknown;
  /** What it is for, exactly as the declaration resolved it. */
  readonly desc?: string;
  /**
   * The environment variables it reads, in declaration order.
   *
   * In **declaration** order because that order is the precedence:
   * `envValue()` answers with the first variable that is set, so which one wins
   * is a fact about where it was written -- which is why the snapshot does not
   * sort this list where it sorts the spellings and the choices.
   */
  readonly env: readonly string[];
  /** The help section it is listed under, if the declaration named one. */
  readonly group?: string;
  /** Whether help leaves it out. It still resolves. */
  readonly hidden: boolean;
  /** What a value is called in the usage line, if the declaration named it. */
  readonly hint?: string;
  /**
   * The long spellings that reach **this** option, in declaration order.
   *
   * Filtered through the registry rather than read off the declaration, which
   * is the only exact answer: `initOption()` puts a negated flag's positive
   * spelling in its own `long` -- `--no-cheese` also lists `--cheese` -- and
   * `OptionRegistry.add()` then gives that spelling to the *valued* twin where
   * there is one. So a declaration's own list over-reports, and a reference
   * built from it would document `--cheese` as reaching the off switch.
   */
  readonly long: readonly string[];
  /** Whether repeating it collects an array. */
  readonly multiple: boolean;
  /**
   * What the declaration calls it, which is what `--${name}` is.
   *
   * Recorded because a printer needs it: a negated flag's positive spelling is
   * the one help deliberately leaves off the row, and knowing which spelling
   * that is means knowing the name. Not part of the *snapshot*, because the
   * destination it names is what the app's own code reads rather than what argv
   * accepts.
   */
  readonly name: string;
  /** Whether it turns its destination off rather than setting it. */
  readonly negate: boolean;
  /** Whether a run without it fails. */
  readonly required: boolean;
  /** The short spellings that reach this option, in declaration order. */
  readonly short: readonly string[];
  /** Whether it consumes a value, which is `!isFlag`. */
  readonly takesValue: boolean;
  /** The data type a value is coerced with. */
  readonly type: OptionDataType;
}

/** One example, as the declaration wrote it. */
export interface SurfaceExample {
  /**
   * What it is for, where the declaration said.
   *
   * Optional, because help prints an example with no label at all -- so a
   * reference that required one said less than help about the same
   * declaration. Found by review.
   */
  readonly label?: string;
  /** The command line, verbatim. */
  readonly text: string;
}

/** One command, as the program accepts it. */
export interface SurfaceCommand {
  /** Its positional arguments, in declaration order, which is the order they are typed. */
  readonly args: readonly SurfaceArgument[];
  /**
   * Whether it is the command argv reaches by naming none.
   *
   * Part of the surface, and the reason is sharper than it looks: a `default`
   * command is dispatched when argv names no command, so it **is**
   * `contexts[0]` and its positional arguments are typable at its parent --
   * `mycli out.js` is accepted with a default `build <entry>` and an
   * `Unexpected argument` without one. So this is what argv accepts rather than
   * what the program does, which is the line the snapshot draws.
   */
  readonly default: boolean;
  /** What it is for, exactly as the declaration resolved it. */
  readonly desc?: string;
  /** The examples it declared. */
  readonly examples: readonly SurfaceExample[];
  /** Whether help leaves it out. It is still reachable. */
  readonly hidden: boolean;
  /**
   * The options it declares itself, in declaration order.
   *
   * Its own and no ancestor's, although an ancestor's resolve here too: options
   * resolve across the whole context chain, so recording the chain would put a
   * root option in every command's entry and make one declaration N diffs. The
   * inheritance is a fact about the parser rather than about any one command, so
   * a printer states it once and the surface records each declaration where it
   * was written.
   */
  readonly options: readonly SurfaceOption[];
  /**
   * The argv path from the root, by each segment's canonical name. Empty for
   * the root itself.
   */
  readonly path: readonly string[];
  /**
   * Whether the declaration has a handler of its own.
   *
   * A command that holds others and runs nothing matches, lists what is under
   * it and exits -- so `mycli db` printing help and `mycli db` doing something
   * differ in their output and their exit code, which is a thing a script
   * notices. Recorded for that, and faithfully: the root's own `run` is in here
   * too, which is what the *declaration* says rather than a claim about what
   * `main()` dispatches.
   */
  readonly runnable: boolean;
  /**
   * Every token that reaches this command's last segment, its name first and
   * the aliases sorted after it. Empty for the root.
   *
   * The name a *registry* is keyed by rather than whatever a loaded module calls
   * itself, and filtered through `find()` -- so an alias a sibling also answers
   * to belongs to the sibling and is not recorded here. See `tokensFor()`.
   */
  readonly tokens: readonly string[];
}

/** Everything a reference is printed from. */
export interface CommandSurface {
  /**
   * Every command, the root first, then depth-first in name order.
   *
   * Pre-order because that is the order a reference reads in: a command is
   * followed by what is under it. A *snapshot* sorts by path instead, so that
   * changing the order a reference reads in is not a change to the surface.
   */
  readonly commands: readonly SurfaceCommand[];
  /** What the program is called, which is the schema's `name`. */
  readonly program: string;
}

/**
 * The declared `choices` as argv has to spell them.
 *
 * `[]` rather than `undefined` for a declaration that named none, because every
 * reader asks `length` and a snapshot that sometimes omits the key would make a
 * declaration gaining its first choice a structural diff rather than a value
 * one.
 *
 * @param type - The data type.
 * @param choices - What the declaration allowed, if anything.
 * @returns The tokens, in declaration order.
 */
function choicesOf(type: string, choices: unknown): readonly string[] {
  return Array.isArray(choices) ? declaredValues(type, choices) : [];
}

/**
 * The examples a declaration wrote, as a list.
 *
 * `Command.examples` is one or many, which is the shape every list-ish field in
 * a declaration takes. An entry missing either half is dropped rather than
 * printed with a hole in it: an example with no `text` is nothing to show, and
 * one with no `label` is a heading a reference would leave blank.
 *
 * @param examples - What the declaration held.
 * @returns The examples.
 */
function examplesOf(examples: unknown): SurfaceExample[] {
  const list = Array.isArray(examples) ? examples : examples === undefined ? [] : [examples];

  // help's own rule rather than a second one: `exampleList()` keeps any entry
  // with a truthy `text` and prints the label only where there is one, so an
  // example declared `{ text: 'mycli go --now' }` is on the help screen -- and
  // requiring a `label` too dropped it from the reference, which is the one
  // place a reference may not say less than help about what it was given.
  // Measured. Found by review
  return (list as CommandExample[])
    .filter((it) => typeof it?.text === 'string' && it.text !== '')
    .map(({ label, text }) => ({ label: typeof label === 'string' ? label : undefined, text }));
}

/**
 * One argument, as the surface records it.
 *
 * @param arg - The initialized argument.
 * @returns The record.
 */
function argumentOf(arg: InternalArgument): SurfaceArgument {
  return {
    choices: choicesOf(arg.type, arg.choices),
    desc: typeof arg.desc === 'string' ? arg.desc : undefined,
    // an argument reads environment variables exactly as an option does --
    // `initArg()` stores `envs` and `envValue()` reads them with the same
    // first-wins rule -- and this recorded none of them, so `ENTRY=x mycli`
    // working was a contract the snapshot could not see being broken. Measured.
    // Found by review
    env: [...arg[Internal].envs],
    multiple: !!arg.multiple,
    name: arg.name,
    required: !!arg.required,
    type: arg.type,
  };
}

/**
 * One option, as the surface records it.
 *
 * Everything is in declaration order, which is the faithful answer: which
 * spelling a declaration wrote first is a fact about the declaration, so
 * *normalizing* it belongs to the projection that wants a stable diff rather
 * than to the walk. The snapshot sorts; the markdown reads in the order the app
 * wrote.
 *
 * The spellings are filtered through the registry, for the reason
 * `SurfaceOption.long` records: a declaration's own list over-reports.
 *
 * @param opt - The initialized option.
 * @param registry - The registry it is in, which is what decides which
 *   spellings reach it.
 * @returns The record.
 */
function optionOf(opt: InternalOption, registry: OptionRegistry): SurfaceOption {
  const { envs, isFlag, long, short } = opt[Internal];
  const reaches = (spelling: string): boolean => registry.find(spelling) === opt;

  return {
    choices: choicesOf(opt.type, opt.choices),
    // help's own test: a flag's implied `false` is noise rather than
    // information, so it is dropped there and here. What a *reference* does
    // with this is print it, which is what help does; the snapshot drops it
    // deliberately, for the reason recorded there -- a computed default has no
    // stable serialization. Found by review, where the page said less than
    // `--help` about the same declaration
    default: opt[Internal].impliedDefault ? undefined : opt.default,
    desc: typeof opt.desc === 'string' ? opt.desc : undefined,
    env: [...envs],
    group: typeof opt.group === 'string' ? opt.group : undefined,
    hidden: !!opt.hidden,
    hint: typeof opt.hint === 'string' ? opt.hint : undefined,
    long: [...long].filter(reaches),
    multiple: !!opt.multiple,
    name: opt.name,
    negate: !!opt.negate,
    required: !!opt.required,
    short: [...short].filter(reaches),
    takesValue: !isFlag,
    type: opt.type,
  };
}

/**
 * One command, as the surface records it.
 *
 * @param cmd - The loaded command.
 * @param path - The argv path from the root.
 * @param tokens - Every token that reaches its last segment.
 * @param fallback - Whether its parent's registry reaches it by naming nothing.
 * @returns The record.
 */
function commandOf(
  cmd: InternalCommand,
  path: readonly string[],
  tokens: readonly string[],
  fallback: boolean
): SurfaceCommand {
  const internal = cmd[Internal];

  return {
    args: internal.args.map(argumentOf),
    default: fallback,
    desc: typeof cmd.desc === 'string' ? cmd.desc : undefined,
    examples: examplesOf(cmd.examples),
    hidden: !!cmd.hidden,
    options: [...internal.options.values()].map((opt) => optionOf(opt, internal.options)),
    path,
    runnable: typeof cmd.run === 'function',
    tokens,
  };
}

/**
 * Reads a whole command tree into the data a reference is printed from.
 *
 * The schema is initialized here rather than parsed, which is what keeps the
 * parser's own additions out: `parse()` is what adds `help`, `completion`,
 * `--help` and `--version`, and a schema initialized on its own has exactly
 * what the app declared. It is also what makes this callable with no argv, which
 * a generator has none of.
 *
 * Every module is imported, for the reason the module comment gives.
 *
 * @param schema - The app's schema, as it would be handed to `main()`.
 * @returns The surface.
 * @throws If the schema names no program, since a reference has to say what to
 *   type; or whatever initializing the schema or loading a command module threw.
 */
export async function commandSurface(schema: Schema): Promise<CommandSurface> {
  const program = typeof schema?.name === 'string' ? schema.name.trim() : '';

  // a program's name is printed into a heading, a usage line and a front matter
  // title, none of which survives a newline in it -- measured, a name holding
  // one produced a second `#` heading in the generated page and split a table
  // row.
  //
  // **The name is not echoed**, which is the half the first version got wrong:
  // it interpolated the raw string, so `name: '\u001b'` threw an `Error` whose
  // message holds a raw escape -- and `errorHandler()` writes a message to
  // stderr, so the sequence ran on the terminal of whoever ran the build. Which
  // is this repository's own rule about what ships, arriving through the one
  // path that is *supposed* to be the safe one: a refusal. Measured. Found by
  // review. So the message says what is wrong with the name rather than showing
  // it; a `schema.name` is one value and the author has it in front of them.
  //
  // It is **not** the same refusal `completionSpec()` makes, which the comment
  // this replaces claimed. That one cleans the name with `oneLine()` first and
  // then refuses the whitespace that is left, so a control character is
  // *stripped* there and the name is accepted -- and it refuses a leading dash,
  // because `complete -F '-D'` is a builtin option and no quoting helps.
  // Neither transfers: a reference prints the name into a code span, a fence
  // and a JSON string, where a leading dash is an ordinary character, and it
  // must refuse what completion merely cleans, because what reaches a page is
  // the name rather than a cleaned copy of it. Two different questions, which
  // is why they are two checks rather than one -- said out loud here because
  // the previous sentence claimed the opposite
  if (!program || /\s/u.test(program) || HAS_CONTROL.test(program)) {
    throw new Error(
      `Cannot build a command reference: ${
        program
          ? `this app's name holds ${HAS_CONTROL.test(program) ? 'a control character' : 'whitespace'}, which a heading, a usage line and a front matter title cannot carry`
          : 'this app declares no name'
      }, and a reference has to say what to type. Set "name" on the schema to the command a user runs, which is one word.`
    );
  }

  // the schema *is* the root command, which is what lets one walk serve both a
  // command and the program. `name` is already known to be a string here, so
  // the `?? 'global'` `parse()` carries has nothing to answer for
  const root = await initCommand({ ...schema, name: program }, undefined, schema.baseDir);
  // the root is never anybody's default, because it is not a child
  const commands: SurfaceCommand[] = [commandOf(root, [], [], false)];

  /**
   * The registry entries already walked.
   *
   * It bounds a cycle, which is reachable for the reason the catalog and the
   * completion spec both record: a registry holds initialized commands and
   * `initCommand()` hands one straight back, so a declaration naming a command
   * already in its own subtree is a cycle rather than a copy. Keyed on the
   * *placeholder*, which is the object the registry holds -- the command a load
   * produces is a different object, so keying on that would never see one
   * twice.
   */
  const seen = new Set<InternalCommand>();

  /**
   * Reads one command's subcommands, then theirs.
   *
   * @param cmd - The command, already loaded.
   * @param path - The argv path that reaches it, from the root.
   */
  async function walk(cmd: InternalCommand, path: readonly string[]): Promise<void> {
    const registry = cmd[Internal].commands;
    // by code unit rather than by `localeCompare`, which is what the catalog and
    // the completion spec use and is wrong for a *committed* artifact: measured,
    // `localeCompare` puts `ä` before `a_b` under `LANG=de_DE.UTF-8` and after
    // `z` under `sv_SE.UTF-8`, so the same app's reference reads in a different
    // order on two machines and `--check` fails on one CI runner and passes on
    // another. Found by review
    const children = [...registry.values()].sort((a, b) => byCodeUnit(a.name, b.name));
    const fallback = registry.default;

    for (const child of children) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);

      // a command no token reaches is a command nothing can type, which is two
      // shapes: a control character in its name, and a name a sibling's alias
      // shadows. `tokensFor()` answers both, and it is the completion spec's own
      // answer rather than a second one -- an alias that routes somewhere else
      // documented here would be a reference naming a path the parser refuses
      const tokens = tokensFor(cmd, child);

      if (tokens.length === 0) {
        continue;
      }

      const loaded = await loadCommand(child, cmd);
      const here = [...path, child.name];

      // pre-order: a command is recorded before what is under it, which is the
      // order a reference reads in
      commands.push(commandOf(loaded, here, tokens, fallback === child));
      await walk(loaded, here);
    }
  }

  await walk(root, []);

  return { commands, program };
}
