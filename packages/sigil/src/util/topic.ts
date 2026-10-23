/**
 * What a command path is spelled with, and how one token comes apart into
 * segments.
 *
 * Two pure functions of a schema and a string, and the reason they are not
 * beside `resolveTopic()` is `src/util/fuzzy.ts`'s: the resolution needs
 * `loadCommand()`, help needs the **spelling** and nothing else, and one
 * module holding both put the whole command loader on the `./help` entry's
 * graph -- measured, 161,274 B over 22 modules to 178,555 B over 25, to read
 * a one-character answer. So the half with no dependencies is the half that
 * is shared, which is also what keeps the parse and the help screen reading
 * one rule rather than two.
 */

import type { Schema, TopicSeparator } from '../types.js';

/** The separator a schema that said nothing is read with. */
const SPACE: TopicSeparator = ' ';

/**
 * What a schema spells a command path with.
 *
 * Read rather than carried on the state, because every reader has the schema
 * in hand already: the parse does, and `HelpTarget` has had a `schema` on it
 * since the usage line needed a program name. A second copy on `ParseState`
 * would be the same fact twice, and the one thing that keeps a spelling
 * honest is that the parse and the help screen read it from one place.
 *
 * It throws on anything else rather than falling back, which is the rule a
 * non-boolean `hidden` already follows: a declaration that cannot mean
 * anything fails where it was written. `parse()` asks unconditionally for
 * that reason -- an app whose `topicSeparator` is `'/'` should not find out on
 * the first run that types one.
 *
 * @param schema - The schema, or nothing where a caller has none.
 * @returns The separator.
 */
export function topicSeparator(schema: Schema | undefined): TopicSeparator {
  const sep = schema?.topicSeparator;

  if (sep === undefined) {
    return SPACE;
  }

  if (sep !== SPACE && sep !== ':') {
    throw new TypeError(`Expected topicSeparator to be " " or ":", not ${JSON.stringify(sep)}`);
  }

  return sep;
}

/**
 * Splits one argv token into the command path it might be.
 *
 * `undefined` means there is nothing to try, and the three ways of getting
 * that are each a decision:
 *
 * The space form has no split to make. A token holding a space got there
 * through quoting, and `mycli run "foo bar"` is somebody passing one value --
 * reading it as a path would be a new behaviour for every app that never
 * asked for one, which is what makes the default an off switch rather than a
 * separator that happens to be rare.
 *
 * A token with no separator in it is not a path, and is the common case.
 *
 * An **empty segment** refuses the whole token: `db:`, `:db` and `db::migrate`
 * each name something with no name, and a command's name cannot be empty.
 *
 * That last one changes no answer and is still not redundant, which is worth
 * saying because an unreachable guard is a thing this repository deletes:
 * `find()` refuses an empty name already, so `db:` would be refused one step
 * later anyway -- after `db` had been *loaded* to find out what is under it.
 * A trailing colon is something a value has, so what the check buys is that a
 * value never imports a module. Pinned by a test that counts loads rather
 * than by the outcome, since the outcome is the same either way.
 *
 * @param token - The token as it was typed.
 * @param sep - The separator this schema spells a path with.
 * @returns The segments, or `undefined` when the token is not a path.
 */
export function splitTopic(token: string, sep: TopicSeparator): string[] | undefined {
  if (sep === SPACE || !token.includes(sep)) {
    return undefined;
  }

  const segments = token.split(sep);

  return segments.some((segment) => !segment) ? undefined : segments;
}
