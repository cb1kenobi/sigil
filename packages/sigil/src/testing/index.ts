/**
 * Testing an app built with sigil.
 *
 * Three answers to three problems, each of which this repository worked out for
 * its own suite and none of which is derivable from outside it:
 *
 * - `runCommand()` runs a schema through the **real** `main()` and hands back
 *   the exit code, stdout, stderr and the parsed values. A reimplementation
 *   would be a second answer to what a parse means.
 * - `runOnTerminal()` runs a whole program in a child whose streams claim to be
 *   a terminal, because **a test runner's streams are pipes** -- so a suite that
 *   never spawns one is green and silent about everything a terminal changes.
 * - `createTestTerminal()` is a terminal and a keyboard in-process, which is how
 *   a prompt is driven with no pty, and `Screen` is the model its frames are
 *   replayed against, because a canvas frame is a diff and the bytes alone say
 *   nothing about what is on screen.
 *
 * It is a subpath of the runtime rather than a package of its own, and the
 * reason is the one `sigil add` already records: an app depends on
 * `@ttylabs/sigil` at an exact version, so helpers that ship beside it always
 * match the `main()` they run and the `Terminal` they fake. A separate package
 * on its own version line could be a release ahead of the runtime under test,
 * which for `runCommand()` would mean running a `main()` that is not the app's.
 *
 * Nothing here is on the root entry's import graph, which is measured: importing
 * `@ttylabs/sigil` costs what it always did, and this is loaded only by a module
 * that asks for it.
 */

export { runCommand, type RanCommand } from './command.js';
export { Screen, screenStream, type ScreenStream } from './screen.js';
export {
  runOnTerminal,
  type FakeableStream,
  type RanOnTerminal,
  type TerminalRunOptions,
} from './spawn.js';
export {
  alt,
  createTestTerminal,
  ctrl,
  KEYS,
  type TestInput,
  type TestKeyName,
  type TestTerminal,
  type TestTerminalOptions,
  tick,
} from './terminal.js';
