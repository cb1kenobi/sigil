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
import { fold, fuzzyMatch } from '../util/fuzzy.js';

/**
 * How many characters of slip a candidate is allowed, as a rate.
 *
 * One per three, with a floor of one, measured against the shorter of the two
 * strings. A **rate** rather than a fitted constant, because what it is a
 * statement about is how often a finger slips: a flat cap of 1 answers 44 of the
 * fifty-typo corpus and misses a double slip in a long word (`insatlll`,
 * `verisno`), while a flat cap of 2 answers 46 and offers something for seven of
 * the thirty-six tokens that should offer nothing -- `hello` for `help`, `q` for
 * `db`, and the empty string for anything. One per three answers 46 by itself and
 * refuses every one of those.
 *
 * Measured on the **shorter** of the two, which is worth saying because applying
 * it to the candidate's length instead is the natural misreading and has been
 * made: an abbreviation of three characters against a candidate of seven is
 * allowed one slip rather than two, because three is what the two have in common
 * to be wrong about.
 *
 * @param shorter - The shorter of the two strings, in code points.
 * @returns The largest distance that still counts as a near miss.
 */
function limit(shorter: number): number {
	return Math.max(1, Math.floor(shorter / 3));
}

/** The shortest query worth reading as an abbreviation. */
const MIN_ABBREVIATION = 2;

/**
 * The Damerau-Levenshtein distance between two strings, case folded.
 *
 * Optimal string alignment: an insertion, a deletion, a substitution or a
 * transposition of two **adjacent** characters each cost one. The transposition
 * is the whole reason this is not plain Levenshtein, and it is not a refinement
 * -- it is most of the feature. A transposition is two edits to Levenshtein, so
 * `verbsoe` is distance 2 from `verbose` there and 1 here, and every floor tight
 * enough to be safe refuses 2: measured, the same corpus and the same floor
 * answer 44 with the transposition priced at one and 17 without it.
 *
 * Over **code points** rather than code units, which is the unit
 * `FuzzyMatch.matched` already records: by code unit a surrogate pair is two
 * edits from nothing and an astral typo is twice as far from its candidate as it
 * should be.
 *
 * Unbounded on purpose. A bound is the obvious optimization and it buys nothing
 * here: a candidate list is a few dozen names of a dozen characters, which is
 * thousands of integer comparisons on a path that is already about to throw.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns The distance, in edits.
 */
export function distance(a: string, b: string): number {
	const x = [...fold(a)];
	const y = [...fold(b)];

	// one row behind, the row before it, and the row being filled. Three rows
	// rather than the whole matrix, because a transposition reaches two back and
	// nothing reaches further
	let twoBack: number[] = [];
	let oneBack: number[] = Array.from({ length: y.length + 1 }, (_, j) => j);

	for (let i = 1; i <= x.length; i++) {
		const row: number[] = [i];

		for (let j = 1; j <= y.length; j++) {
			const cost = x[i - 1] === y[j - 1] ? 0 : 1;
			let best = Math.min(
				(oneBack[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(oneBack[j - 1] as number) + cost
			);

			if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
				best = Math.min(best, (twoBack[j - 2] as number) + cost);
			}

			row[j] = best;
		}

		twoBack = oneBack;
		oneBack = row;
	}

	return oneBack[y.length] as number;
}

/** What a candidate is compared as, where that is not what it is typed as. */
export type SuggestKey = (candidate: string) => string;

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
 * The nearest candidate by edit distance, or nothing where that is ambiguous.
 *
 * Two floors, and both were measured rather than chosen. The **rate** is
 * `limit()`. The other is that a suggestion has to have **something in common**
 * with what was typed: a distance at or past the shorter string's own length
 * means the two share nothing, which for a one-character string means the two
 * characters simply differ. That is the whole of what refuses `-x` for `-v`, and
 * short options are common enough that without it the feature is unusable.
 *
 * An **exact** match is allowed, and is reachable rather than dead: it is `--p`
 * against a declared `-p`, where the names agree and only the spelling differs.
 * A candidate whose own spelling equals what was typed cannot be in the list at
 * all, because the parse would have resolved it instead of failing.
 *
 * **A tie is no answer**, which is the "a wrong suggestion is worse than none"
 * rule applied to ambiguity: two candidates equally near is one right answer and
 * one wrong one, and choosing between them would choose by registration order --
 * which for a directory of command modules is whatever the file system felt
 * like, and which this repository refuses everywhere else.
 *
 * @param typed - What was typed.
 * @param candidates - What it could have been.
 * @param key - What to compare each of them as, applied to both sides.
 * @returns The candidate, as it is typed, or nothing.
 */
export function nearMiss(
	typed: string,
	candidates: readonly string[],
	key: SuggestKey
): string | undefined {
	// folded once here rather than per comparison, so the lengths below and the
	// distance are measured on the same string. The fold is one code point out for
	// one code point in -- see `fold()`, and the brute force over every code point
	// that pins it -- so the folded length *is* the raw length and there is no
	// second reading of it to keep in agreement. There was, before `U+0130` was
	// swapped: folding lengthened there, and the two readings answered differently
	const q = fold(key(typed));
	const qLength = [...q].length;
	let best: string | undefined;
	let bestDistance = Infinity;
	let ties = 0;

	for (const candidate of candidates) {
		const c = fold(key(candidate));
		const cLength = [...c].length;
		const shorter = Math.min(qLength, cLength);

		// a **declared fast path**: an edit distance is at least the difference in
		// length, so a pair this refuses is one the two floors below would refuse
		// anyway, and no answer changes. What it buys is that nothing walks the
		// whole matrix per candidate -- measured, a 100,000-character token against
		// twenty-eight ten-character commands is 78ms without it and 5.9ms with,
		// and an argv token really can be a very long path. What is left is the one
		// fold and the one count of the token itself, which is why it is 5.9 rather
		// than nothing
		if (Math.abs(qLength - cLength) > limit(shorter)) {
			continue;
		}

		const d = distance(q, c);

		if (d >= shorter || d > limit(shorter)) {
			continue;
		}

		if (d < bestDistance) {
			bestDistance = d;
			best = candidate;
			ties = 1;
		} else if (d === bestDistance) {
			ties++;
		}
	}

	return ties === 1 ? best : undefined;
}

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
 * `--help` and `--version` are in, although the parser owns them: they are
 * typeable, they are real, and `--hepl` is a typo worth answering.
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

	return near === undefined
		? __`Unexpected argument "${subject}"`
		: __`Unexpected argument "${subject}". Did you mean "${near}"?`;
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

	return near === undefined
		? __`Unknown option "${subject}"`
		: __`Unknown option "${subject}". Did you mean "${near}"?`;
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

	return near === undefined
		? __`Unknown command "${subject}"`
		: __`Unknown command "${subject}". Did you mean "${near}"?`;
}
