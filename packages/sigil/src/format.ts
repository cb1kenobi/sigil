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
 * what was returned. Then no command branches on **which** format was asked
 * for, which is the whole of the `if (json) … else …`: it computes one value,
 * and which presentation reaches the terminal is the framework's decision
 * rather than an `if` in every command. Two paths, not a conditional -- which
 * is the same shape the quiet axis takes one layer along, where a component
 * says what it is and `resolveOutput()` decides whether it draws.
 *
 * What a command may still ask is **whether** a format was selected, because
 * stdout belongs to the serializer once one was and a command drawing its own
 * human form there has to stop. `state.format` is that, and the reason the
 * framework cannot decide it is measurable rather than a matter of taste: it
 * could only suppress a command's own stdout by patching
 * `process.stdout.write`, which a spawned child writing to the inherited fd
 * walks straight past -- so the suppression would be partial, which is worse
 * than none. Drawing to **stderr** is the other answer and needs no branch at
 * all, which is the split `sigil check` already makes.
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
 * Anything the selected serializer takes, and the serializer **refuses what it
 * cannot represent rather than losing it**. For `json` that is `lossyAs()`, and
 * what it is written against is that two of `JSON.stringify`'s three answers
 * for a value it cannot hold are **silent**: a function, a symbol or an
 * `undefined` has its key dropped in an object and becomes `null` in an array,
 * and `NaN`, both infinities and every object JSON has no mapping for -- a
 * `Map`, a `Set`, an `Error` -- are rewritten as `null` or `{}`. So a command
 * returning a `Map` of results would have piped `{}` and said nothing, which is
 * the one thing the house rules name directly: never swallow data.
 *
 * An app's own serializer answers for its own format the same way, which is
 * what `WritableConfigStore.canRepresent()` already is one subsystem along --
 * refused where it was written rather than discovered in the output.
 */

import { __ } from './i18n/index.js';
import type { OutputFormat, Schema } from './types.js';

/**
 * C0, `DEL` and C1, named rather than enumerated.
 *
 * Which is the spelling the escape pass settled on, for its reason: a class of
 * `\u0000`-escapes trips `no-control-regex` and carries a suppression a
 * formatter can detach from the line it was written over, where `\p{Cc}` names
 * the set and carries no control character escaped or otherwise.
 */
const CONTROL = /\p{Cc}/u;

/**
 * Whether a value is a record somebody wrote as an object literal.
 *
 * Two readers in this module and two questions: `lossyAs()` asks it to tell an
 * object JSON writes as its own fields from one it has no mapping for, and
 * `outputFormats()` asks it of `schema.formats`, where a `Map` would contribute
 * nothing and say nothing.
 *
 * It is **not** `isPlainObject()` from the config module, and that is a
 * layering call rather than an oversight: that one is published as
 * `@ttylabs/sigil/config` for the store kit and is about the structure the
 * config merge owns, so importing it here would put a config chunk on the graph
 * the whole feature's byte budget is about -- and moving it to `src/util/`, the
 * answer this repository has reached for three times, is a change to published
 * API with fifty readers across three packages, taken inside a ticket about
 * output formats. The two agree and neither is derived from the other, which is
 * worth one sentence rather than a cross-subsystem refactor.
 *
 * @param value - The value to test.
 * @returns Whether it is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * What JSON would silently do to a value, as a sentence, or nothing where it
 * would write it faithfully.
 *
 * `JSON.stringify` has three answers for a value it cannot represent and only
 * one of them is loud. It **throws** for a `BigInt` and for a cycle. It answers
 * the *value* `undefined` for a function, a symbol and `undefined` itself,
 * which in an object position **drops the key** and in an array position
 * becomes `null`. And it rewrites `NaN` and both infinities as `null`, and
 * every object it has no mapping for -- a `Map`, a `Set`, an `Error`, a
 * `RegExp`, a `Promise` -- as `{}`.
 *
 * Which is the house rule this feature would otherwise walk straight past:
 * never swallow data. `writeFormatted()` already refuses a *top-level*
 * `undefined` for exactly this reason, and the nested cases are the same loss
 * one level in -- so they are refused too, naming what JSON would have done and
 * where. The silent ones are the point; the two JSON throws for are named here
 * as well, because the path is worth more than `Do not know how to serialize a
 * BigInt` with no indication of which value it was.
 *
 * It is **not** `jsonCanHold()` from the config module, and the two differ on
 * purpose rather than by drift. That one asks whether a value survives a write
 * and a read **back**, so it refuses a class instance -- the round trip turns
 * one into a plain object, which for a file somebody loads again is a type that
 * moved. This asks only whether JSON writes what it was given, once, into a
 * pipe, so a class instance with fields is written as its fields and that is
 * what the app asked for. `checkValue()` against `transformValue()` is the same
 * two-questions-one-vocabulary split one subsystem along.
 *
 * The `{}` family is asked of `JSON.stringify` itself rather than by a
 * prototype table, which is what makes it exact: `new Number(5)` is a non-plain
 * object with no own keys and JSON writes `5`, so a table keyed on the
 * prototype would refuse a value that is written faithfully. Asking what JSON
 * will write cannot be wrong about what JSON will write. An empty `Map` is the
 * one value this calls a loss that holds nothing to lose -- correct, because a
 * `Map` is written as `{}` whether or not it has entries, so the app's
 * serialization is wrong regardless of what happens to be in it now.
 *
 * @param value - The value, as the replacer was handed it.
 * @returns What would be lost, or `undefined`.
 */
function lossyAs(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : `JSON writes ${String(value)} as null`;
  }

  // every one of the three is the `undefined` the replacer is handed, so an
  // array **hole** arrives here too and is refused with them. The message
  // cannot tell a hole from an `undefined` somebody wrote, which is honest
  // rather than a gap: JSON writes both as `null` in an array and drops both in
  // an object, so what is lost is the same thing either way
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return `JSON has no ${typeof value}; it drops the key in an object and writes null in an array`;
  }

  if (typeof value === 'bigint') {
    return 'JSON has no bigint';
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value) || isRecord(value)) {
    return undefined;
  }

  // `toJSON` has already run by the time a replacer is handed a value, so a
  // `Date` and anything else that says what it is in JSON never reaches this.
  // A throw is not ours to report: the outer `JSON.stringify` is about to meet
  // the same value and will throw about it with its own message
  let written: string | undefined;
  try {
    written = JSON.stringify(value);
  } catch {
    return undefined;
  }

  if (written !== '{}') {
    return undefined;
  }

  // no article in front of the name, because `a Error` is what one costs and
  // agreement is not a thing to write a table for. Read off the **prototype**
  // rather than off the value and inside a `try`, because this is a sentence
  // about somebody else's object and a throwing `constructor` must not replace
  // a message about a silent loss with one about a getter
  let kind: string | undefined;
  try {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
    kind = typeof proto?.constructor?.name === 'string' ? proto.constructor.name : undefined;
  } catch {
    kind = undefined;
  }

  return kind
    ? `JSON has no mapping for ${kind}, so it writes {}`
    : 'JSON has no mapping for this kind of object, so it writes {}';
}

/**
 * The one format the framework ships.
 *
 * Two-space pretty rather than compact, on the reading that the commonest
 * interactive use is a human looking at it and every consumer of JSON ignores
 * whitespace -- which is also the indentation the config writer settled on, so
 * the two things in this repository that write JSON agree. A terminal-versus-pipe
 * branch would be two forms for no gain, since both parse.
 *
 * The replacer is what makes it refuse rather than lose: see `lossyAs()`. It
 * carries the **path** as it goes, which a replacer can do and a hand walk would
 * have to reproduce `toJSON` short-circuiting to match -- `this` is the holder,
 * and a holder is always visited before the values under it, so one `WeakMap`
 * from object to the path it was reached by is enough. Two paths to one object
 * are a DAG rather than a cycle and either is a true path, so the collision is
 * benign; a real cycle is `JSON.stringify`'s own throw, whose message says so.
 *
 * @param value - What the command returned, or the error payload.
 * @returns The JSON text.
 * @throws If JSON would silently change what it was given.
 */
function json(value: unknown): string {
  const at = new WeakMap<object, string>();

  return JSON.stringify(
    value,
    function (this: unknown, key: string, it: unknown): unknown {
      const base = typeof this === 'object' && this !== null ? at.get(this) : undefined;
      const where = key === '' ? '' : base ? `${base}.${key}` : key;

      if (it !== null && typeof it === 'object') {
        at.set(it, where);
      }

      const lost = lossyAs(it);
      if (lost !== undefined) {
        throw new TypeError(where === '' ? lost : `${lost} (at "${where}")`);
      }

      return it;
    },
    2
  );
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

  // a **record** rather than merely an object, which is three refusals rather
  // than one and every one of them was something that parsed and then did
  // something nobody meant. An array mints a format called `0`, because
  // `Object.entries` keys it by index. A `Map` -- which is the shape anybody
  // reaching for a registry writes -- contributes **nothing**, so
  // `--format yaml` answered `This command accepts: json` about an app that had
  // declared yaml. And a class instance is the same silent no-op one step
  // along. Found by review
  if (!isRecord(declared)) {
    throw new TypeError(
      'Expected schema formats to be an object of names and functions, written as an object literal'
    );
  }

  for (const [name, serialize] of Object.entries(declared)) {
    // a name is what a user types after `--format`, so the empty string is not
    // one: `{ '': fn }` made `--format=` -- the one way argv says "deliberately
    // empty" -- select a format, which is a spelling nobody would document
    if (!name) {
      throw new TypeError(
        'Expected every schema format to have a name: the empty string is not one a user can type'
      );
    }

    // and a name reaches a terminal, in the `This command accepts:` list the
    // refusal prints -- so a control character in one is a sequence waiting for
    // something to print it, which is the rule this repository keeps for every
    // byte it emits. `\p{Cc}` names the set rather than enumerating it, which is
    // the spelling the escape pass already settled on
    if (CONTROL.test(name)) {
      throw new TypeError(
        `Expected the schema format named ${JSON.stringify(name)} to have no control character in its name`
      );
    }

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
 * script keyed on the message breaks the moment `LANG` moves. It is present
 * wherever the thrown value has one, which is uniform for every `Error` there
 * is -- `Error` included, because a script asking "is this an `Error` or a
 * `TypeError`" needs the field to be there either way, and a rule that omitted
 * the base name would be a field that is absent for the commonest case. A
 * thrown *string* has none, which is the one shape the `?` is for. `exitCode`
 * is deliberately absent -- the process already carries the verdict, and
 * putting it in the payload would be the same fact twice.
 *
 * It is built from the same `message` the human form prints, so the two cannot
 * come to disagree about what the error says.
 */
export interface SerializedError {
  error: {
    message: string;
    /** The error's own `name`, where the thrown value has one at all. */
    name?: string;
  };
}

/**
 * Refuses a serializer's answer that is not text.
 *
 * Unreachable through the **built-in**, which is the one thing worth saying
 * about it: `JSON.stringify` answers the *value* `undefined` for a function and
 * for a symbol, so this was the guard that stopped the word `undefined`
 * reaching stdout -- and `lossyAs()` now refuses both at the value, with the
 * path, which is the better message and one step earlier. What is left is an
 * app's own serializer that returns nothing, which is a real guard for a real
 * door rather than a tripwire: the type says `string` and a JavaScript app is
 * not bound by it.
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
  if (typeof text === 'string') {
    return text;
  }

  // a promise is the one wrong answer worth naming on its own, and it costs
  // more than the message: `got object` sends the author to look at their data
  // rather than at their signature, and the promise is **discarded**, so a
  // serializer that rejects takes the process down with an unhandled rejection
  // about an answer nobody is waiting for -- twice, because the error path
  // serializes the payload with the same serializer. `Promise.resolve()` adopts
  // a bare thenable as readily as a promise, and the `catch` swallows rather
  // than reports because the throw below is the report. Found by review
  if (text !== null && typeof (text as { then?: unknown })?.then === 'function') {
    void Promise.resolve(text).catch(() => {});
    throw new TypeError(
      `Expected the "${name}" output format to return a string, got a promise: a serializer is synchronous, because the error path that uses it is`
    );
  }

  throw new TypeError(
    `Expected the "${name}" output format to return a string, got ${text === null ? 'null' : typeof text}`
  );
}
