/**
 * The command surface, printed as JSON for a diff.
 *
 * A CLI's command surface is its public API, and nothing in a build notices
 * when it moves: a pull request that renames a flag breaks everybody's scripts
 * and reads as a one-line change. `@oclif/plugin-command-snapshot` commits the
 * surface as JSON so that pull request **fails**, and this is that, over the
 * same payload the markdown is printed from.
 *
 * ## The two readers differ in what they drop, and that is the whole design
 *
 * `commandSurface()` is faithful: it records what every command accepts *and*
 * what every declaration says it is for. The markdown prints all of it. This
 * drops everything that is not part of what argv accepts -- `desc`, `examples`,
 * `group`, `hint` -- because a snapshot that moved when a description was
 * reworded would be a check nobody could leave on. "What argv accepts, not what
 * the screen says" is the line, and it is the one the ticket asked for.
 *
 * ## Stability is the feature, so everything about the order is decided here
 *
 * A diff is only readable if the bytes move for one reason. So: the keys are
 * sorted, at every level and by `sortKeys()` rather than by the order the
 * literals happen to be written in; the commands are sorted by path, which makes
 * the order the *markdown* reads in free to change without moving the snapshot;
 * the options are sorted by their spellings and each option's own spellings are
 * sorted too, because which one a declaration wrote first is a fact about the
 * declaration; and the arguments are **never** sorted, because their order is
 * their position and sorting them would hide the one change that matters most.
 *
 * Every one of those sorts is by **code unit** rather than by `localeCompare`,
 * which reads the machine's locale: a committed artifact sorted by a setting is
 * one whose bytes depend on who ran the generator.
 *
 * Every field is always written, with a canonical empty -- `[]`, `false` -- so
 * that a declaration gaining its first choice is a value diff rather than a
 * structural one. No version and no timestamp: a snapshot carrying either moves
 * on every release, which turns the check into noise and trains people to
 * refresh it without reading it.
 */

import type { CommandSurface, SurfaceCommand, SurfaceOption } from '@ttylabs/sigil/reference';

/** A JSON value, which is what the snapshot is made of. */
type Json = Json[] | boolean | number | string | { [key: string]: Json } | null;

/**
 * One value with its object keys sorted, however deep.
 *
 * Rather than writing the literals below in alphabetical order, which would be
 * the same bytes today and nothing at all tomorrow: a key added out of order
 * would move every byte after it, and the diff would be about the edit rather
 * than about the surface. This is also why the literals below are *not* written
 * alphabetically -- with this doing the work, `should sort every key` fails when
 * it goes, where literals already in order would make that test vacuous.
 *
 * @param value - The value.
 * @returns It, with every object's keys in order.
 */
function sortKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys(value[key] as Json);
  }
  return out;
}

/**
 * The surface is faithful and this is normalized, which is the one place the
 * two part company about *order* rather than about content.
 *
 * Sorted with no comparator, which is specified to compare by UTF-16 code unit
 * -- so this is `byCodeUnit` already and only a sort with a *key* has to write
 * it out. A `localeCompare` here would read the machine's locale, so the same
 * surface would print different bytes on a German laptop and on CI: measured,
 * `['z', 'ä', 'a-b', 'a_b', 'A', 'a']` orders three different ways under
 * `de`, `sv` and by code unit. A committed artifact cannot be sorted by a
 * setting.
 *
 * @param values - What the declaration held, in its own order.
 * @returns The same values, sorted.
 */
function ordered(values: readonly string[]): string[] {
  return [...values].sort();
}

/**
 * Two strings by UTF-16 code unit, which is `Array.sort()`'s own default said
 * out loud for the two places that sort by a key rather than by the string.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns The ordering.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Two argv paths, compared a segment at a time.
 *
 * Rather than by the joined string, which is ambiguous in the one way a route
 * name makes reachable: a command named `a b` -- which a routed file called
 * `a b.js` produces -- joins to exactly what `['a', 'b']` joins to, so the two
 * compared equal and `sort()` left them in whatever order the walk had. A
 * separator-free comparison has nothing to be ambiguous about, and it is the
 * same reason the markdown keys a path with NUL rather than with a space.
 *
 * @param a - One path.
 * @param b - The other.
 * @returns The ordering.
 */
function byPath(a: readonly string[], b: readonly string[]): number {
  for (let at = 0; at < Math.min(a.length, b.length); at++) {
    const step = byCodeUnit(a[at] as string, b[at] as string);
    if (step !== 0) {
      return step;
    }
  }
  return a.length - b.length;
}

/**
 * How two options are ordered in the snapshot.
 *
 * By every spelling rather than by the first one, so that an option gaining a
 * short name does not move it past a sibling it used to sit before -- the sort
 * key is the whole of what argv reaches it by, which is the thing that would
 * have to change for its place to change.
 *
 * @param opt - The option.
 * @returns Its sort key.
 */
function spellingKey(opt: SurfaceOption): string {
  return [...ordered(opt.long), ...ordered(opt.short)].join(' ');
}

/**
 * `ordered()` is for a **set** and not for every list.
 *
 * `long`, `short` and `choices` are sets -- a spelling reaches the option
 * whichever order the declaration wrote them in, and a choice is accepted
 * whichever order the list holds -- so sorting them is what keeps the snapshot
 * from moving when nothing argv accepts has moved.
 *
 * `env` is **not** one, which is the distinction the first version missed:
 * `envValue()` answers with the first variable that is set, so the order is the
 * precedence and sorting it hid a real change. Written here rather than only at
 * the two call sites, because "which of these lists is a set" is the question
 * that got answered wrongly.
 */

/**
 * One option, as the snapshot records it.
 *
 * @param opt - The option.
 * @returns The record.
 */
function optionOf(opt: SurfaceOption): Json {
  return {
    takesValue: opt.takesValue,
    required: opt.required,
    multiple: opt.multiple,
    type: opt.type,
    long: ordered(opt.long),
    short: ordered(opt.short),
    // **not** sorted, unlike the spellings and the choices beside it: `env` is
    // an ordered list rather than a set, because `envValue()` answers with the
    // first variable that is **set** -- so swapping `['SERVER_PORT', 'PORT']`
    // for `['PORT', 'SERVER_PORT']` changes which one wins, which is a surface
    // change a sorted list cannot see. Measured. Found by review
    env: [...opt.env],
    // sorted, for the reason the spellings are: a `choices` list reordered
    // accepts exactly the same set of values, so what moved is the hint on the
    // screen rather than what argv takes -- and this is the one reader that
    // drops what the screen says. It was the one list here that was not sorted,
    // which made reordering a `choices` list the only cosmetic edit that could
    // fail the check
    choices: ordered(opt.choices),
    hidden: opt.hidden,
  };
}

/**
 * One command, as the snapshot records it.
 *
 * @param cmd - The command.
 * @returns The record.
 */
function commandOf(cmd: SurfaceCommand): Json {
  return {
    path: [...cmd.path],
    tokens: [...cmd.tokens],
    hidden: cmd.hidden,
    // `default` and `runnable` are each a thing argv reaches: a command marked
    // `default` is dispatched when argv named none, so marking one -- or moving
    // the mark -- changes what a bare invocation does, and a namespace gaining a
    // `run` is a path that did nothing and now does something. Both were absent,
    // so the snapshot could not see either move
    default: cmd.default,
    runnable: cmd.runnable,
    // never sorted: an argument's order is its position, so sorting them would
    // hide the one change a reader most needs to see
    args: cmd.args.map((arg) => ({
      name: arg.name,
      required: arg.required,
      multiple: arg.multiple,
      type: arg.type,
      // sorted, for the reason an option's are: a reordered list accepts
      // exactly the same set of values. It was the one list left in declaration
      // order after the option half was fixed, so reordering an *argument's*
      // choices was the only cosmetic edit that could still fail the check --
      // and `should never sort the arguments` pins the order of the arguments
      // themselves rather than the choices inside one, so nothing could see it.
      // Found by review
      choices: ordered(arg.choices),
      // in declaration order, for the reason an option's is
      env: [...arg.env],
    })),
    options: [...cmd.options]
      .sort((a, b) => byCodeUnit(spellingKey(a), spellingKey(b)))
      .map(optionOf),
  };
}

/**
 * The surface as the object a snapshot holds.
 *
 * Separate from `snapshotJson()` so a test can read a field out of it without
 * parsing a string back, and so the sort is asserted on the thing that is
 * written rather than on a round trip.
 *
 * @param surface - The surface.
 * @returns The snapshot, keys sorted.
 */
export function snapshotOf(surface: CommandSurface): Json {
  return sortKeys({
    program: surface.program,
    // by path rather than in the surface's own pre-order, so that changing the
    // order a *reference* reads in is not a change to the surface
    commands: [...surface.commands].sort((a, b) => byPath(a.path, b.path)).map(commandOf),
  });
}

/**
 * The snapshot as the bytes that go in the file.
 *
 * Two-space indent and a trailing newline, which is what every other JSON file
 * in this repository is written with and what a text diff wants: one key per
 * line, so a changed spelling is a one-line diff rather than a whole-file one.
 *
 * @param surface - The surface.
 * @returns The JSON, ending in exactly one newline.
 */
export function snapshotJson(surface: CommandSurface): string {
  return `${JSON.stringify(snapshotOf(surface), undefined, 2)}\n`;
}
