import { Internal, type InternalCommand } from '../../types.js';

/**
 * The names a command publishes: the labels of its name string, less any `!`
 * one, in the order they were written.
 *
 * Read off the label `parseName()` built rather than off `aliases`, because the
 * two are different sets on purpose. `aliases` is every name argv may reach the
 * command by, the `alias` property's included; the label is the part of that
 * the app chose to publish, and an alias that should answer without being
 * advertised has nowhere else to go. Help reading `aliases` is how a property
 * alias reached the screen -- see "The help label is the name string's" in
 * `src/help/AGENTS.md`.
 *
 * One function with three readers -- help, the completion menu and the markdown
 * reference -- because each of them is a *listing*, and three readers that each
 * split the label themselves would be three answers to which names a command
 * advertises.
 *
 * Empty when every label was `!` prefixed, which only a hidden command can be,
 * so no listing ever reaches the empty case for a command it shows.
 *
 * @param cmd - The command.
 * @returns The names, deduplicated.
 */
export function labelNames(cmd: InternalCommand): string[] {
  // a label is a join of labels the name string was split on `[, ]+` to get,
  // so none of them holds the separator it is split on again. A set, because
  // `'build, build'` is one name written twice and saying it twice says nothing
  return [...new Set(cmd[Internal].label.split(', ').filter(Boolean))];
}
