/**
 * "Did you mean": the nearest thing the reader could have typed instead.
 *
 * `Unknown option "--verbsoe"` tells the reader nothing they did not already
 * know. This answers the question they are about to ask, from the registries the
 * parse has already built -- so there is no second list of commands to declare
 * and keep in agreement with the first, which is the claim `commandCatalog()`
 * makes one layer along and is the reason only a framework that owns an argument
 * parser has one cheaply.
 *
 * **Two metrics, because they answer two questions**, which is the measurement
 * SIG-143 rests on rather than a preference. An **edit distance** says "this is
 * one slip away from that" and a **subsequence match** says "this is an
 * abbreviation of that", and neither sees what the other does: over a corpus of
 * fifty real typos `fuzzyMatch()` alone answers 13 and an edit distance alone 44,
 * where the two together answer 49. Every transposition -- `buidl`, `verbsoe`,
 * `tset`, `hlep` -- is invisible to a subsequence match, because `buidl` simply
 * is not a subsequence of `build`; every abbreviation -- `dpl`, `ver`, `bld` --
 * is past any edit-distance floor worth having. The distance is **Damerau**
 * rather than plain Levenshtein for exactly that reason: with transposition
 * priced at one the same corpus is 44, and without it 17.
 *
 * **A wrong suggestion is worse than none**, because it sends the reader
 * somewhere, so both halves have a floor and an ambiguous answer is no answer.
 * `test/parser/suggest.test.ts` pins the table of pairs that should and should
 * not suggest, the way the palette's own ranking table is pinned.
 *
 * **It costs nothing until something is about to throw.** Every candidate comes
 * from a registry that is already populated -- the root's level is read while the
 * schema is built and every deeper level was read by the `loadCommand()` that put
 * that context in the chain -- so a suggestion is a walk over a `Map` and not one
 * byte of I/O, and it happens inside the `if` that throws. A successful parse
 * never asks. `test/parser/suggest-cost.test.ts` counts both.
 */

import { __ } from '../i18n/index.js';
import { Internal, type InternalCommand, type Settings } from '../types.js';
import { escapeControls } from '../util/escape-controls.js';
import { fuzzyMatch } from '../util/fuzzy.js';
import { nearMiss, type SuggestKey } from '../util/near-miss.js';

// The edit-distance half lives in `util/near-miss.ts`, which imports nothing but
// `fold()`, so it can be published on its own (`@ttylabs/sigil/suggest`) and run
// in a browser. Re-exported here so the parser reads it as before.
export { distance, nearMiss, type SuggestKey } from '../util/near-miss.js';

/** The shortest query worth reading as an abbreviation. */
const MIN_ABBREVIATION = 2;

/** The identity, which is what a command name is compared as. */
const asTyped: SuggestKey = (s) => s;

/**
 * The leading dashes taken off, which is what an option spelling is compared as.
 *
 * Both sides, so the two cannot disagree about the rate above -- and that is
 * load bearing rather than tidy. Compared with their dashes on, `-x` and `-v`
 * are two characters of which one differs, which the rate reads as an ordinary
 * one-character slip in a two-character string: every short option in the app
 * would be offered for every mistyped one. Stripped, they are one character each
 * and the "something in common" rule below refuses the pair outright.
 *
 * It is also what makes the one case where a *dash* is the typo work:
 * `--p` against a declared `-p` strips to `p` on both sides, which is a distance
 * of nothing and the strongest suggestion there is.
 */
const withoutDashes: SuggestKey = (s) => s.replace(/^-+/, '');

/**
 * The candidate the typed token best abbreviates, or nothing.
 *
 * `fuzzyMatch()`, with two floors. An abbreviation **starts with the same
 * character**, which is the principled version of a score threshold and is what
 * it took to make this half pay for itself: `out` is a subsequence of `logout`
 * and is a plausible argument value, so without the prefix rule the one thing
 * this adds beyond the near miss costs a false positive on a real directory
 * name. Nobody abbreviates `deploy` as `epl`. And a query of one character is
 * not an abbreviation of anything -- `a` is a prefix of `add` and suggesting it
 * is noise.
 *
 * A tie is no answer, for `nearMiss()`'s reason: `ver` is an equally good prefix
 * of `verbose` and `version`, and that is exactly the case where the reader
 * should be reading help rather than being pointed at one of the two.
 *
 * @param typed - What was typed.
 * @param candidates - What it could have been.
 * @param key - What to compare each of them as, applied to both sides.
 * @returns The candidate, as it is typed, or nothing.
 */
function abbreviates(
  typed: string,
  candidates: readonly string[],
  key: SuggestKey
): string | undefined {
  const q = key(typed);

  if ([...q].length < MIN_ABBREVIATION) {
    return undefined;
  }

  let best: string | undefined;
  let bestScore = -1;
  let ties = 0;

  for (const candidate of candidates) {
    const match = fuzzyMatch(q, key(candidate));

    // a match that does not start at the first character is not an
    // abbreviation of the candidate, whatever it scored
    if (!match || match.matched[0] !== 0) {
      continue;
    }

    if (match.score > bestScore) {
      bestScore = match.score;
      best = candidate;
      ties = 1;
    } else if (match.score === bestScore) {
      ties++;
    }
  }

  return ties === 1 ? best : undefined;
}

/**
 * The nearest thing to what was typed, or nothing worth saying.
 *
 * A near miss first and an abbreviation second, because a one-character slip is
 * a stronger statement about intent than a subsequence is: `inst` is one
 * character from `init` and an abbreviation of `install`, and the reader who
 * typed it more likely meant the former. Which costs the one miss the corpus
 * records, and it is the honest one -- `inst` really is one character from
 * `init`.
 *
 * The candidates are expected to be **distinct**, which is what the `Set` in
 * `commandTokens()` and `optionTokens()` is for: a duplicate ties with itself
 * and refuses a suggestion it should have made. Stated rather than guarded,
 * because the two producers are the only callers there are.
 *
 * Nothing here **normalizes**, and that is a decision rather than an omission: a
 * decomposed `cafe\u0301` is two edits from a composed `caf\u00e9` and so offers
 * nothing. Normalizing would offer the composed name -- and the parser does not
 * match across the normalization either, because a registry lookup is a plain
 * object key, so `mycli cafe\u0301` is `Unexpected argument "caf\u00e9"` against a
 * command declared composed. Measured. A suggestion whose equality the matcher
 * denies is a suggestion that does not resolve, which is the one thing this must
 * not offer.
 *
 * @param typed - What was typed.
 * @param candidates - What it could have been.
 * @param key - What to compare each of them as. Defaults to the identity.
 * @returns The candidate, as it is typed, or nothing.
 */
export function nearest(
  typed: string,
  candidates: readonly string[],
  key: SuggestKey = asTyped
): string | undefined {
  return nearMiss(typed, candidates, key) ?? abbreviates(typed, candidates, key);
}

/**
 * Every token that would have reached a subcommand of this one.
 *
 * One level, and that is the resolution rule honoured rather than a limitation:
 * commands resolve against the **innermost context**, so a sibling of the
 * context argv ended up in would have been an unexpected argument too, and the
 * whole subtree's paths from the root are not tokens that resolve in the
 * position the reader typed one. Suggesting either would be offering something
 * that also fails.
 *
 * Aliases are tokens, so they are candidates -- a transposed `sl` for a declared
 * `ls` is exactly the typo this exists for -- and a `hidden` command is not. The
 * app said not to list it, and a suggestion is a listing of one.
 *
 * A `Set`, because an alias really can be declared on two commands: the registry
 * keeps the last one for routing and both commands keep it in their own alias
 * set, so without this the shared spelling appears twice, ties with itself, and
 * refuses a suggestion it should have made.
 *
 * @param cmd - The context whose subcommands could have been meant.
 * @returns The tokens, each once.
 */
export function commandTokens(cmd: InternalCommand): string[] {
  const tokens = new Set<string>();

  for (const child of cmd[Internal].commands.values()) {
    if (child.hidden) {
      continue;
    }
    tokens.add(child.name);
    for (const alias of child[Internal].aliases) {
      tokens.add(alias);
    }
  }

  return [...tokens];
}

/**
 * Every option spelling the chain answers to.
 *
 * The whole chain rather than the innermost context, because options resolve
 * across the whole context chain -- which is the asymmetry with
 * `commandTokens()` above, and it is deliberate on both sides. A `hidden` option
 * is left out for the reason a hidden command is.
 *
 * `--help`, `--version`, `--quiet` and `--format` with its `--json` sugar are
 * in, although the parser owns them: they are typeable, they are real, and
 * `--hepl` is a typo worth answering. Measured -- `--formt` answers `Did you
 * mean "--format"?` and `--jsn` answers `--json`, beside `--quet` and `--hepl`.
 *
 * @param contexts - The chain, innermost first.
 * @returns The spellings, each once, dashed as they are typed.
 */
export function optionTokens(contexts: readonly InternalCommand[]): string[] {
  const tokens = new Set<string>();

  for (const ctx of contexts) {
    for (const opt of ctx[Internal].options.values()) {
      if (opt.hidden) {
        continue;
      }
      for (const name of opt[Internal].long) {
        tokens.add(name);
      }
      for (const name of opt[Internal].short) {
        tokens.add(name);
      }
    }
  }

  return [...tokens];
}

/**
 * Whether to look for one at all.
 *
 * On by default, because a strictly better error message should not have to be
 * asked for -- which is the other half of `settings.suggestions: false` being an
 * opt-out rather than an opt-in: a feature nobody turns on is a feature nobody
 * has. What the opt-out is for is an app whose error output something else
 * parses, where a second sentence is a second thing to match.
 *
 * @param settings - The parse settings.
 * @returns Whether a suggestion may be offered.
 */
function enabled(settings: Settings | undefined): boolean {
  return settings?.suggestions !== false;
}

/**
 * `Unexpected argument "x"`, with the nearest command where there is one.
 *
 * **This is the site a mistyped command actually reaches**, which is the premise
 * SIG-143's ticket had wrong. A mistyped top-level command does not throw
 * `Unknown command`: commands resolve against the innermost context, an
 * unmatched token falls through to the positional arguments, and with no
 * argument left to take it this is where it lands. `Unknown command` is only
 * ever reached by `mycli help buidl`. Measured by running a parse before any of
 * this was designed.
 *
 * Which also says why the candidates are commands and not arguments: the token
 * is in a position where a subcommand name would have matched -- the command
 * pass tries every unmatched token against the innermost context, whatever its
 * position -- so the thing it could have been is a command.
 *
 * @param subject - The token, as the message prints it.
 * @param ctx - The innermost context, whose subcommands could have been meant.
 * @param settings - The parse settings.
 * @returns The message.
 */
export function unexpectedArgument(
  subject: unknown,
  ctx: InternalCommand,
  settings?: Settings
): string {
  // `typeof` is the narrowing rather than a guard: `inputs[0]` is an `unknown`
  // on the parsed value and is a token out of argv in every reachable case
  const typed = typeof subject === 'string' && enabled(settings) ? subject : undefined;
  const near = typed === undefined ? undefined : nearest(typed, commandTokens(ctx));

  // the token is argv's and argv is not always typed -- a glob over a hostile
  // file name reaches here -- so it is echoed inert. `near` is the schema's own
  // spelling and is left alone
  const shown = escapeControls(subject);

  return near === undefined
    ? __`Unexpected argument "${shown}"`
    : __`Unexpected argument "${shown}". Did you mean "${near}"?`;
}

/**
 * `Unknown option "--x"`, with the nearest spelling where there is one.
 *
 * Only reachable with `settings.allowUnknownOptions: false`, because an
 * undeclared option produces a value by default rather than erroring -- so the
 * ticket's headline example, `--verbsoe`, is the one of the three sites an
 * ordinary app never sees. It is answered anyway: an app that turned the
 * pass-through off is an app that wants to be told.
 *
 * @param subject - The spelling, as it was typed.
 * @param contexts - The chain, innermost first.
 * @param settings - The parse settings.
 * @returns The message.
 */
export function unknownOption(
  subject: unknown,
  contexts: readonly InternalCommand[],
  settings?: Settings
): string {
  // the narrowing rather than a guard, for `unexpectedArgument()`'s reason:
  // `inputs[0]` is typed as possibly absent and is a token out of argv in
  // every case that reaches here, because the spelling was matched against
  // `unknownOptionRE` to get this far
  const typed = typeof subject === 'string' && enabled(settings) ? subject : undefined;
  const near =
    typed === undefined ? undefined : nearest(typed, optionTokens(contexts), withoutDashes);

  const shown = escapeControls(subject);

  return near === undefined
    ? __`Unknown option "${shown}"`
    : __`Unknown option "${shown}". Did you mean "${near}"?`;
}

/**
 * `Unknown command "x"`, with the nearest name where there is one.
 *
 * `help`'s own, and the only site where a command name really is what failed to
 * resolve. The candidates are the parent's subcommands, which is the level
 * `help build targets` was walking when it ran out.
 *
 * @param subject - The name, as it was typed.
 * @param parent - The command whose registry had no answer.
 * @param settings - The parse settings.
 * @returns The message.
 */
export function unknownCommand(
  subject: string,
  parent: InternalCommand,
  settings?: Settings
): string {
  const near = enabled(settings) ? nearest(subject, commandTokens(parent)) : undefined;

  const shown = escapeControls(subject);

  return near === undefined
    ? __`Unknown command "${shown}"`
    : __`Unknown command "${shown}". Did you mean "${near}"?`;
}
