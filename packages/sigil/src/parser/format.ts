/**
 * `--format`, and the `--json` sugar, wired the way `--quiet` is -- except for
 * the one thing that makes this option different from every other the parser
 * adds: it is **per command**, because the command is what asked for it.
 *
 * ## Why it is not on the root
 *
 * `--help`, `--version` and `--quiet` go on the root context, because options
 * resolve across the whole chain and a question about the program is one every
 * invocation can ask. A format is not that. A full-screen dashboard has no data
 * to serialize, and a `--format` on it would be an option that parses and does
 * nothing -- which this repository calls worse than no option at all. So a
 * command **opts in**, by declaring the formats it supports or `true` for every
 * one the schema provides, and the option exists exactly where the command said
 * it does.
 *
 * What that comes to for a command that did **not** opt in is narrower than the
 * first version of this sentence claimed, and it claimed `Unknown option`:
 * measured, `mycli dashboard --format json` exits **0** and serializes nothing,
 * because `allowUnknownOptions` defaults to true and an undeclared option
 * produces a value rather than erroring. `Unknown option "--format"` is the
 * answer for an app that turned that off. Which is still the point rather than
 * a hole in it: what is refused is the option **existing** -- it is in no
 * registry, so it is on no help screen, in no reference and in no completion
 * script -- where an option added everywhere would be one that parses and does
 * nothing on every command with no data to serialize.
 *
 * Which also means it is added in `initCommand()` rather than in `parse()`, and
 * that is the whole of why it belongs in the reference and in a completion
 * script where the other three do not. Those are added by the parse, so a
 * surface built by initializing the schema "simply does not have them. That is
 * the answer rather than a filter: an app's snapshot should move when the app
 * moves and not when the framework does, and what the framework adds is the
 * framework's to document." This one is the app's: the command declared
 * `format`, so the option it got is as much a part of its declared surface as
 * any option it wrote out, and every walk of the registries sees it for free.
 *
 * ## Both spellings, and that is muscle memory rather than an oversight
 *
 * Two spellings of one thing is something this repository normally refuses, so
 * the reason is written down rather than left to look like a slip: `--json` is
 * what everybody types and what every other tool accepts, and a framework that
 * made people learn `--format json` instead would be spending its users'
 * goodwill on consistency they did not ask for. So `--json` is sugar, offered
 * only where the command accepts `json`, and it is the same mechanism rather
 * than a second one -- see `formatFromValue()`.
 *
 * `--output` is deliberately **not** offered. `-o`/`--output` means an output
 * *file* in gcc, curl, ffmpeg and most of what a user of this framework has
 * ever typed, so claiming it for a format name would be this framework taking a
 * spelling that already means something else. And there is no short form:
 * unlike `-h`, `-v` and `-q` there is no consensus on one, and `-f` is `--force`
 * or `--file` far more often than it is `--format`.
 *
 * ## There is no `choices` list, and the message is why
 *
 * The obvious thing is to give the option a `choices` list so a bad name is a
 * parse error. It is refused, and not for want of a place to put it: the list is
 * `declared ∩ what the schema provides`, which is knowable at init for
 * `format: ['json']` and **not** for `format: true`, because `initCommand()` has
 * no schema. So `choices` would judge one spelling of the declaration and not
 * the other -- two behaviours for one thing, which is what this repository
 * deletes everywhere else.
 *
 * One validation point instead, in `detectFormat()`, which runs before anything
 * is validated and so before the command runs. What that buys beyond
 * consistency is the message: `formatFor()` names what *is* available, where
 * `Invalid value "{0}" for {1}` has the list in hand and does not print it.
 * What it costs is value completion -- `mycli build --format <TAB>` offers
 * nothing -- and no choices in the generated reference. Both are a missing
 * feature rather than a wrong answer, and both are additive later: the shape is
 * to thread the schema's format names into `initCommand()` the way `baseDir` is
 * threaded, after which `choices` answers for both spellings at once.
 */

import { formatFor, outputFormats } from '../format.js';
import { __ } from '../i18n/index.js';
import {
  Internal,
  type InternalCommand,
  type InternalOption,
  type ParseState,
  type ParsedOption,
} from '../types.js';
import type { OptionRegistry } from './option/option-registry.js';

/**
 * Adds `--format` -- and `--json`, where the command accepts it -- to a command
 * that declared `format`.
 *
 * Called from `initCommand()`, so the option is part of the command's registry
 * before anything walks it: help, the reference, a completion script and the
 * parse all see one option rather than four readers each adding their own.
 *
 * Nothing is added over the top of a declaration, and the asymmetry is
 * `registerQuiet()`'s own: `find()` answers about spellings and `has()` about
 * the key the registry stores an option under, which is its name. A merely
 * *named* `format` costs the command the option entirely, where a taken
 * `--json` costs it only the sugar -- because replacing a registry key is a
 * worse thing to do to an app than declining to add a spelling.
 *
 * @param options - The command's option registry.
 * @param accepts - What the declaration said: `true` for every format the
 *   schema provides, a list of names, `false` or absent for no option.
 * @param name - The command's name, for the message.
 * @throws If `format` is neither a boolean nor a non-empty list of strings.
 */
export async function registerFormats(
  options: OptionRegistry,
  accepts: unknown,
  name: string
): Promise<void> {
  if (accepts === undefined || accepts === false) {
    return;
  }

  // the call a non-boolean `hidden` already gets, and for its reason: a
  // declaration that cannot mean anything is refused where it was written
  // rather than discovered as an option that does nothing. An empty list is
  // refused with it, because a `--format` that rejects every value is a flag
  // that cannot work -- and saying so beats treating `[]` as `false`, which is
  // the silent reading
  if (accepts !== true) {
    if (!Array.isArray(accepts) || accepts.some((it) => !it || typeof it !== 'string')) {
      throw new TypeError(
        `Expected format in "${name}" command to be true, false, or a non-empty list of format names`
      );
    }
    if (accepts.length === 0) {
      throw new TypeError(
        `Expected format in "${name}" command to name at least one format: a command that presents none should not declare one`
      );
    }
  }

  const list: true | readonly string[] = accepts === true ? true : [...accepts];
  let added = false;

  if (!options.find('--format') && !options.has('format')) {
    // `[name]` rather than `<name>`, because `<value>` makes the **option**
    // required here rather than its value -- which would make every run of an
    // opted-in command fail for not having asked for a format
    await options.add({ desc: __`Present the result in this format`, format: '--format [name]' });
    added = mark(options.find('--format'), list);
  }

  // only where `json` is one of the formats this command presents, or the sugar
  // would select a format the command refuses. `true` always includes it,
  // because the registry is `json` plus whatever the schema added and there is
  // no way to take it away
  const takesJson = list === true || list.includes('json');

  if (takesJson && !options.find('--json') && !options.has('json')) {
    await options.add({ desc: __`Present the result as JSON`, format: '--json' });
    added = mark(options.find('--json'), list) || added;
  }

  // a command that took both spellings for itself and still declares `format`
  // has no way left to select one, which is a declaration that parses and does
  // nothing -- the thing this repository calls worse than one that does not
  // exist. Refused here because this is the one place both facts are in hand:
  // what the command declared, and what the registry would let us add.
  //
  // Only where **neither** could be added, which is what keeps the graceful
  // half graceful: an app that claimed `--format` keeps it and still selects
  // with `--json`, exactly as one that claimed `-q` keeps `--quiet`
  if (!added) {
    throw new Error(
      `The "${name}" command declares "format" and also declares every spelling that would select one, so no format can be asked for. Drop "format", or free "--format"${takesJson ? ' or "--json"' : ''}.`
    );
  }
}

/**
 * Marks an option as one that selects an output format, and records what the
 * command accepts on the option itself.
 *
 * What the mark says is that this option **selects a format**, which is what
 * `detectFormat()` reads to tell a format token from any other option. What it
 * deliberately does *not* decide is what that token may name: the accepted set
 * is carried here as well, and it is read off the **chain** rather than off the
 * option argv bound to. The two part company whenever the token precedes the
 * subcommand -- `db --format json list` binds to `db`'s option, because `list`
 * has not been seen yet -- so reading it here would make a narrowing on `list`
 * apply or not according to where in the line the token sat. See
 * `detectFormat()`; the set is on the option because that is where both
 * spellings can share one, and it is the nearest command's that governs.
 *
 * `parserOwned` keeps the value off `argv`, and what that is for is narrower
 * than "a command cannot branch on it" -- which is what this said and is false
 * of the one branch a command legitimately has. `state.format` **is** handed to
 * `run()`, and a command that draws its own human form to stdout has to read it,
 * because stdout belongs to the serializer once a format was selected. What is
 * off `argv` is the **name**: a destination called `format` on an app that never
 * declared one is a value nothing wrote, and reading which format was asked for
 * is the two-answers conditional this exists to delete, where asking whether one
 * was is a question about presentation. See the module doc.
 *
 * @param opt - The option, or `undefined` where the registry did not take it.
 * @param accepts - What the command accepts.
 * @returns Whether there was an option to mark, which is what the caller needs
 *   in order to tell a command that can select a format from one that cannot.
 */
function mark(opt: InternalOption | undefined, accepts: true | readonly string[]): boolean {
  // a **tripwire** rather than a guard, and the sabotage pass is what
  // established it: every caller looks the option up immediately after adding
  // it, and `OptionRegistry.add()` throws rather than declining, so there is no
  // reachable way for this to be `undefined`. It is kept because the honest
  // alternative is a `TypeError` from the next line, and `add()` answers `void`
  // so the lookup cannot be avoided
  if (!opt) {
    return false;
  }

  opt[Internal].formats = accepts;
  opt[Internal].parserOwned = true;

  return true;
}

/**
 * The format name a parsed option selects.
 *
 * One rule for both spellings rather than a second field saying which is the
 * sugar: a format option whose value is a **string** names that format, and one
 * whose value is `true` names the format it is **called after**. So `--json`
 * selects `json` because it is called `json`, and the mechanism would give a
 * later `--yaml` the same thing for nothing.
 *
 * It is safe for `--format` because that option takes a value, so its value is
 * always a string: a bare `--format` is `Missing value for option --format`, and
 * `--format=` is the empty string, which is the one way to say "deliberately
 * empty" and is refused as a format name like any other.
 *
 * `false` names nothing, which is what makes `--json=false` contribute nothing
 * rather than select JSON.
 *
 * @param parsed - The parsed option.
 * @returns The name it selects, or `undefined` where it selects none.
 */
function formatFromValue(parsed: ParsedOption): string | undefined {
  const { option, value } = parsed;
  return typeof value === 'string' ? value : value === true ? option.name : undefined;
}

/**
 * Settles which format argv asked for, and refuses one this command cannot
 * present.
 *
 * **Last wins**, which is where this parts company with the three flags the
 * parser owns: `--help`, `--version` and `--quiet` are *questions*, so any
 * typed true wins in either order, and a format is a *value*, so the rule is
 * the one every valued option in this schema already follows. `--json --format
 * yaml` is yaml and `--format yaml --json` is json, which needs no rule of its
 * own -- and `--json --json=false` is still json, because a `false` names
 * nothing and the first use is the last one that said anything.
 *
 * The declared names are checked whether or not argv asked for a format, so a
 * command naming a format the schema does not provide is a parse error on every
 * run rather than a surprise on the first run that types `--format`. It is the
 * call `initCommand()` makes for a non-boolean `hidden`: a declaration that
 * cannot mean anything fails where it was written. Only the chain is walked, so
 * a routed tree pays for the commands argv named and nothing else.
 *
 * A bad name throws rather than deferring to `--help`, which is the rule
 * already recorded for a value: help wins over a *missing* required option,
 * because that is a question about what the command needs, and an invalid value
 * "failed on the way in, while argv was being read".
 *
 * @param state - The parse state.
 * @throws If a declared format is not one the schema provides, or if the name
 *   argv selected is not one this command presents.
 */
export function detectFormat(state: ParseState): void {
  /**
   * What the command that **ran** accepts, which is the nearest declaration in
   * the chain. `state.contexts` is innermost-first, so the first one found is
   * it -- and `undefined` afterwards means no command in the chain opted in at
   * all, which is a declared fast path rather than a guard: without it the walk
   * below finds nothing and `state.format` stays unset, which is the same
   * answer. What it buys is not walking argv a second time for every app whose
   * commands never declared `format`, which is most of them.
   */
  let governs: true | readonly string[] | undefined;

  for (const cmd of state.contexts) {
    for (const opt of cmd[Internal].options.values()) {
      const accepts = opt[Internal].formats;

      if (accepts === undefined) {
        continue;
      }

      // every declaration in the chain, because a command naming a format the
      // schema does not provide is a mistake wherever in the chain it sits
      assertDeclared(state, cmd, accepts);
      governs ??= accepts;
    }
  }

  if (governs === undefined) {
    return;
  }

  let selected: string | undefined;

  for (const parsed of state.$) {
    if (parsed.type !== 'Option') {
      continue;
    }

    // the option's own mark says which *tokens* are format selectors, and says
    // nothing about what they may name: that is `governs`. Reading the accepted
    // set off the option argv bound to was the first spelling and it is
    // **position-dependent**, which is the one thing a format must not be --
    // `db --format json list` resolves the token against the contexts known at
    // that moment, which is `db` alone, so a narrowing on `list` was never
    // applied and `db list --format json` and `db --format json list` were two
    // different answers to one command line. Found by review
    if (parsed.option[Internal].formats === undefined) {
      continue;
    }

    const name = formatFromValue(parsed);

    if (name !== undefined) {
      selected = name;
    }
  }

  if (selected !== undefined) {
    // resolved rather than merely looked up, and the answer is discarded: the
    // point is that the *same* function `main()` gets the serializer from is
    // what judged the name, so a parse that accepted a name cannot meet a
    // `main()` that has nothing to serialize it with
    formatFor(state.schema, selected, governs);
    state.format = selected;
  }
}

/**
 * Refuses a command that declared a format the schema does not provide.
 *
 * English rather than a catalog key: what it reports is a mistake in the app's
 * own declaration, which is the line this repository draws between a message a
 * user's argv provoked and one only the app's code can.
 *
 * @param state - The parse state, for the schema.
 * @param cmd - The command that declared it, for the message.
 * @param accepts - What it declared.
 */
function assertDeclared(
  state: ParseState,
  cmd: InternalCommand,
  accepts: true | readonly string[]
): void {
  if (accepts === true) {
    return;
  }

  // membership rather than a `formatFor()` in a `try`, because that function
  // throws two different things: a name this command cannot present, and a
  // `schema.formats` that is not an object of functions. Catching would report
  // the second as the first, which is a message pointing at the wrong mistake
  const formats = outputFormats(state.schema);

  for (const name of accepts) {
    if (!formats.has(name)) {
      throw new Error(
        `The "${cmd.name}" command declares the "${name}" output format, which this app does not provide. Add it to "formats" on the schema.`
      );
    }
  }
}
