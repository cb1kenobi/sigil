/**
 * `--quiet`, wired the way `--help` and `--version` are.
 *
 * ## Why the framework owns it
 *
 * The same argument those two settled. Every CLI that reports progress wants a
 * way to stop reporting it, and before this each had to write one -- declare the
 * option, parse, and then pass the answer by hand into every spinner, bar and
 * note it builds. Passing it by hand is the half that cannot work: a built-in is
 * built inside a command's `run()`, so one missed call site is a flag that
 * parses and does nothing, which this repository calls worse than no flag at
 * all. `resolveOutput()` is what the flag reaches instead, and every built-in
 * already reads that.
 *
 * And it survives `sigil build` for the reason `--version` is written down for:
 * the build generates the executable and calls `main()`, so whatever an app
 * wrapped around `main()` is not in the bundle. The schema is the one thing the
 * build carries across whole.
 *
 * ## Nothing is added over the top of a declaration
 *
 * An app whose `-q` means something else keeps it and gets `--quiet` without the
 * short form; one that declares `--quiet` itself gets no flag from here and owns
 * what quiet means -- which is the only reading of a declaration that means
 * anything, and is exactly what `registerHelp()` does with `-h`.
 *
 * A **subcommand** that declares its own reaches backwards over the root's,
 * which is the parser's context rule rather than anything here and is worth
 * saying because it is not what "shadows it for itself alone" sounds like:
 * options resolve across the whole chain, so a nearer valued declaration owns
 * the destination a bare root use wrote -- and `mycli --quiet work`, on an app
 * whose `work` declares `--quiet <level>`, is `Missing required options:
 * --quiet` rather than a quiet run. Confirmed by probe. The app claimed the
 * spelling, so it owns what every use of it means.
 *
 * `schema.quiet: false` turns it off, for an app that wants neither spelling
 * taken.
 *
 * ## It is not `--verbose`, and that is a decision
 *
 * Verbosity is how much a command says about its **answer**, which is the
 * command's own business: the framework cannot know what "more" means for an
 * app's output, so a `--verbose` it added would be a flag no built-in could
 * read -- the defect above, in the other direction. The framework's own half of
 * that question is already answered by `DEBUG` and `src/debug/`. Making one knob
 * out of two -- a numeric level with quiet at the bottom -- would mean inventing
 * the middle of a scale nobody has asked for.
 */

import { __ } from '../i18n/index.js';
import { Internal, type InternalCommand, type InternalOption, type ParseState } from '../types.js';

/**
 * The `--quiet` flag a schema gets for free, so a parse can tell whether argv
 * asked for it. An app that declares its own keeps it, and then this is empty.
 */
export interface QuietHandles {
  option?: InternalOption;
}

/**
 * Adds `-q, --quiet` to the root context, unless the app has its own or has
 * turned it off.
 *
 * On the root rather than on every command, because options resolve across the
 * whole context chain: one there answers everywhere, and a command that declares
 * its own shadows it for itself alone.
 *
 * @param root - The root context, built from the schema.
 * @param quiet - What the schema said about wanting the flag.
 * @returns What was added, so a parse can recognize it later.
 */
export async function registerQuiet(
  root: InternalCommand,
  quiet: boolean | undefined
): Promise<QuietHandles> {
  if (quiet === false) {
    return {};
  }

  const internal = root[Internal];
  const handles: QuietHandles = {};

  // `find()` answers about spellings and `has()` about the key the registry
  // stores an option under, which is its name -- both have to be free, for the
  // reason the help wiring records: an option spelled `-x` and named `quiet`
  // takes the key without answering to `--quiet`, and adding one there would
  // replace it, leaving `-x` pointing at whatever replaced it.
  //
  // The asymmetry is the surprising half and is why it is written down: a
  // merely-*named* `quiet` costs the app the flag **entirely**, where a taken
  // `-q` costs it only the short form. Replacing a registry key is a worse
  // thing to do to an app than declining to add a spelling
  if (internal.options.find('--quiet') || internal.options.has('quiet')) {
    return handles;
  }

  const format = internal.options.find('-q') ? '--quiet' : '-q, --quiet';
  await internal.options.add({ desc: __`Suppress progress, not results`, format });
  handles.option = internal.options.find('--quiet');

  if (handles.option) {
    // a flag always has a value, and this one is not the app's: an app that
    // never declared `--quiet` should not find `quiet: false` on one of its own
    // destinations. What a command that wants to know asks instead is
    // `resolveOutput()`, which is the resolved answer rather than one of its
    // four sources -- a mount told `quiet: false` would make `argv.quiet` a lie
    handles.option[Internal].parserOwned = true;
  }

  return handles;
}

/**
 * Whether argv asked for quiet.
 *
 * Typed and true, which is `detectHelp()`'s own rule: a default or an
 * environment variable can give a flag a value without anybody asking for it,
 * and `--quiet=false` is somebody typing it and saying no.
 *
 * **Any** typed true wins, in either order, which is where the three flags the
 * parser owns part company with every valued option in this schema: those are
 * last-wins by destination, and `--quiet --quiet=false` is quiet. It is
 * `--help`'s rule said again rather than a decision taken here -- the three
 * flags of this shape read argv the same way, and changing one of them inside a
 * ticket about another is how they come to disagree. Worth knowing because the
 * spelling somebody reaches for to undo it, `--no-quiet`, is not a negation of
 * this flag at all: a `no-` twin is created by declaring one, so it lands on
 * `argv` as an undeclared option instead.
 *
 * @param state - The parse state.
 * @param handles - What `registerQuiet()` added.
 * @returns Whether argv turned it on.
 */
export function detectQuiet(state: ParseState, handles: QuietHandles): boolean {
  const { option } = handles;

  // a fast path rather than a guard, and `detectVersion()`'s own body byte for
  // byte: a `ParsedOption` carries a required `option`, so an `undefined` one
  // matches nothing and the scan below answers `false` either way -- which a
  // sabotage of it said. What it skips is a walk of `state.$` for every app that
  // declared its own, and what it would cost to delete is the two copies of one
  // function disagreeing, which is the rule the paragraph above keeps
  if (!option) {
    return false;
  }

  return state.$.some(
    (parsed) => parsed.type === 'Option' && parsed.option === option && parsed.value === true
  );
}
