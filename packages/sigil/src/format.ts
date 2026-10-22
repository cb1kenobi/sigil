/**
 * Output formats: the command returns data, a serializer presents it.
 *
 * oclif's answer to "give me JSON" is `enableJsonFlag` plus a `toSuccessJson()`
 * hook, and the objection to copying it is right on two counts: `--json` is one
 * format of several people want, and a command that branches on it grows a
 * large `if (json) … else …` with two code paths that drift apart.
 *
 * ## The conditional exists because the command is doing both jobs
 *
 * So the two jobs are split. `run()` **returns data**, and optionally also
 * draws, exactly as today. A **serializer** is selected by name and presents
 * what was returned. Then no command branches at all: it computes a value and
 * optionally renders one, and which of the two reaches the terminal is the
 * framework's decision rather than an `if` in every command. Two paths, not a
 * conditional -- which is the same shape the quiet axis takes one layer along,
 * where a component says what it is and `resolveOutput()` decides whether it
 * draws.
 *
 * ## `json` ships and everything else is the app's
 *
 * `JSON.stringify` is free, so `json` is built in and the zero-dependency
 * constraint is untouched. `yaml`, `xml`, `csv` and `tsv` are the **app's to
 * register**, which is the honest division and the one the config stores
 * already draw: we ship the plumbing and the one format that costs nothing, and
 * an app that wants YAML brings the YAML library it chose. An app that declares
 * its own `json` keeps it, which is the declaration-respecting rule every free
 * flag here follows.
 *
 * They live on the **schema** rather than in a process-wide registry, and that
 * is the one place this parts company with `setQuiet()`. The argument for a
 * module-level slot there is that the two ends have no other connection --
 * `--quiet` is read while argv is parsed and a spinner is built much later
 * inside `run()`. It does not transfer: a format's two ends are the parse, which
 * decides whether the name is one this app has, and `main()`, which serializes
 * the value -- and the schema is in hand at both. A process-wide registry would
 * be the second mechanism, and it would leak between two schemas in one process,
 * which the nested `main()` the command palette documents really is.
 *
 * ## A serializer is synchronous, and that is forced
 *
 * `errorHandler()` is synchronous, and the serialized error has to come out of
 * the same function the serialized result does -- a script that gets JSON on
 * success and a rendered message on failure cannot be scripted against. So the
 * type is `(value: unknown) => string` and there is no promise anywhere in it.
 * Which is the better answer anyway: a serializer that did I/O could fail half
 * way through writing an answer it had already begun.
 *
 * ## What the data has to be
 *
 * Anything the selected serializer takes, and the serializer refuses what it
 * cannot represent -- which for `json` is `JSON.stringify`'s own three answers,
 * two of which are silent. It **throws** for a `BigInt` and for a circular
 * structure, which propagates; it answers the *value* `undefined` for a
 * function, a symbol and `undefined` itself, which would reach a file as the
 * word; and it rewrites `NaN` and `Infinity` as `null`. The first is loud and
 * the second is what `assertSerialized()` is for. The third is JSON's and is
 * left alone, for the reason `jsonCanHold()` in the config module records
 * refusing it: there, a value is being written back to a file somebody will read
 * again, and here it is being handed to a pipe once.
 */

import { __ } from './i18n/index.js';
import type { OutputFormat, Schema } from './types.js';

/**
 * The one format the framework ships.
 *
 * Two-space pretty rather than compact, on the reading that the commonest
 * interactive use is a human looking at it and every consumer of JSON ignores
 * whitespace -- which is also the indentation the config writer settled on, so
 * the two things in this repository that write JSON agree. A terminal-versus-pipe
 * branch would be two forms for no gain, since both parse.
 *
 * @param value - What the command returned, or the error payload.
 * @returns The JSON text.
 */
function json(value: unknown): string {
  return JSON.stringify(value, undefined, 2);
}

/**
 * Every format this app can present, which is `json` plus whatever the schema
 * provides.
 *
 * The schema's own entries go **over** the built-in, so an app that declares
 * `json` keeps its own -- the rule `registerHelp()` and `registerQuiet()` keep
 * about a spelling an app has claimed, said about a name.
 *
 * @param schema - The schema, for `formats`.
 * @returns The registry, keyed by the name argv types.
 * @throws If `formats` is not an object of names and functions.
 */
export function outputFormats(schema: Schema | undefined): Map<string, OutputFormat> {
  const formats = new Map<string, OutputFormat>([['json', json]]);
  const declared = schema?.formats;

  if (declared === undefined) {
    return formats;
  }

  if (!declared || typeof declared !== 'object') {
    throw new TypeError('Expected schema formats to be an object of names and functions');
  }

  for (const [name, serialize] of Object.entries(declared)) {
    if (typeof serialize !== 'function') {
      throw new TypeError(`Expected the "${name}" schema format to be a function`);
    }
    formats.set(name, serialize);
  }

  return formats;
}

/**
 * The serializer a name selects, where the command accepts that name.
 *
 * One function with two readers, which is what keeps the two questions from
 * coming to disagree: `parse()` calls it to **judge** a name against what the
 * command said it accepts, and `main()` calls it to **get** the serializer. A
 * second implementation of "which formats are available here" is how a parse
 * that accepted a name comes to meet a `main()` that cannot serialize it.
 *
 * The message names what *is* available, which `choices` cannot -- `Invalid
 * value "{0}" for {1}` has the list in hand and does not print it, which the
 * suggestion work already records as the better fix and a different ticket. It
 * is the reason this option carries no `choices` at all: see
 * `registerFormats()`.
 *
 * @param schema - The schema, for the registry.
 * @param name - The name argv selected.
 * @param accepts - What the command accepts: `true` for every registered
 *   format, or the names it declared.
 * @returns The serializer.
 * @throws If the name is not a format this command can present.
 */
export function formatFor(
  schema: Schema | undefined,
  name: string,
  accepts: true | readonly string[] = true
): OutputFormat {
  const formats = outputFormats(schema);
  const available =
    accepts === true ? [...formats.keys()] : accepts.filter((it) => formats.has(it));
  const serialize = available.includes(name) ? formats.get(name) : undefined;

  if (!serialize) {
    throw new Error(
      __`Unknown output format "${name}". This command accepts: ${available.join(', ')}`
    );
  }

  return serialize;
}

/**
 * What a serialized error says.
 *
 * Wrapped in `error` rather than being the error's own fields at the top level,
 * because `{"message":…}` is indistinguishable from a command that succeeded and
 * returned a `message` -- and a reader merging the two streams has to be able to
 * tell them apart. Every tool that serializes an error wraps it.
 *
 * `name` is the half a script can branch on, and that is the reason it is here
 * rather than a nicety: **a message is translated and a name is not**, so a
 * script keyed on the message breaks the moment `LANG` moves. `exitCode` is
 * deliberately absent -- the process already carries the verdict, and putting it
 * in the payload would be the same fact twice.
 *
 * It is built from the same `message` the human form prints, so the two cannot
 * come to disagree about what the error says.
 */
export interface SerializedError {
  error: {
    message: string;
    /** The error's own `name`, where it has one that says more than `Error`. */
    name?: string;
  };
}

/**
 * Refuses a serializer's answer that is not text.
 *
 * Reachable through the **built-in**, which is what makes it a guard rather
 * than a tripwire: `JSON.stringify` answers the *value* `undefined` for a
 * function and for a symbol, so a command returning either would otherwise put
 * the word `undefined` on stdout. An app's own serializer that returns nothing
 * is the same failure arriving through the other door.
 *
 * English rather than a catalog key, because what it reports is a bug in the
 * app's own code -- the line this repository draws everywhere: a translated
 * `Expected option choices to be an array` is a bug report in a language the
 * maintainer cannot read.
 *
 * @param text - What the serializer answered.
 * @param name - The format, for the message.
 * @returns The text.
 * @throws If the serializer did not answer with a string.
 */
export function assertSerialized(text: unknown, name: string): string {
  if (typeof text !== 'string') {
    throw new TypeError(
      `Expected the "${name}" output format to return a string, got ${text === null ? 'null' : typeof text}`
    );
  }
  return text;
}
