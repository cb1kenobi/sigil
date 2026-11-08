import { type Ansi, ansi as defaultAnsi, type ColorLevel } from '../ansi/index.js';
import type { Terminal } from '../terminal/index.js';

/**
 * How much colour a component resolves for: the one place that decides.
 *
 * The colour level is the terminal's, and a component is handed one. In order of
 * who knows best: a `colorLevel` the caller named, the `ansi` the caller handed
 * over, the level the `terminal` was built with -- which a fixture sets and a real
 * terminal leaves unsaid -- and last the environment's own guess, which is what
 * `ansi` has always been when nobody said. The third is the new one: a prompt
 * handed `terminal: ui.terminal` and no `ansi` used to ask the environment, so a
 * level-0 test terminal wrote colour under `FORCE_COLOR=3` and a test that read
 * the screen for text still found it in escapes on a CI runner that sets it.
 *
 * Twenty-three sites spelled `opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level`
 * and now call this, so a fourth source is one edit and not twenty-three. Only six
 * of them pass a terminal -- `mountLive()`, `group`, `pager`, `tasks` and the two in
 * `log` -- because those are the components that draw on one. The rest are string
 * facades and view builders whose options carry no `terminal`, and pass none: they
 * resolve exactly as they did, and a terminal's level reaches them only through
 * the `colorLevel` or `ansi` of whoever mounts them.
 *
 * @param opts - What the caller passed.
 * @param terminal - The terminal the component draws on, if it has one.
 * @param fallback - What to ask when nobody named a level. Defaults to the
 *   environment's, and is for the one caller (`log`) that detects from a stream of
 *   its own.
 * @returns The level.
 */
export function colorLevelOf(
  opts: { readonly ansi?: Ansi; readonly colorLevel?: ColorLevel },
  terminal?: Pick<Terminal, 'colorLevel'>,
  fallback: Ansi = defaultAnsi
): ColorLevel {
  return opts.colorLevel ?? opts.ansi?.level ?? terminal?.colorLevel ?? fallback.level;
}
