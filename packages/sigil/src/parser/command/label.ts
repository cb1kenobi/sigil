import { Internal, type InternalCommand } from '../../types.js';
import type { CommandRegistry } from './command-registry.js';

/**
 * The names a command publishes: the labels of its name string, less any `!`
 * one and less any its registry routes somewhere else, in the order they were
 * written.
 *
 * Read off the label `parseName()` built rather than off `aliases`, because the
 * two are different sets on purpose. `aliases` is every name argv may reach the
 * command by, the `alias` property's included; the label is the part of that
 * the app chose to publish, and an alias that should answer without being
 * advertised has nowhere else to go. Help reading `aliases` is how a property
 * alias reached the screen -- see "The help label is the name string's" in
 * `src/help/AGENTS.md`.
 *
 * Asked of the registry as well, because a published name is a claim about
 * what that name runs. Two siblings sharing an alias is allowed and the later
 * declaration wins it, so `{ 'build, go': {}, 'ship, go': {} }` routes `go` to
 * `ship` -- and a label read off the name string alone printed `go` beside
 * both. The registry's `find()` is the one answer to who owns a spelling, so a
 * name it hands to a sibling is not this command's to list. Asked when the
 * listing is drawn rather than when the command was built, since that answer
 * moves: a module that loads may bring a name string of its own, and
 * `CommandRegistry.replace()` settles what it shares with a sibling by
 * declaration order.
 *
 * One function with three readers -- help, the completion menu and the markdown
 * reference -- because each of them is a *listing*, and three readers that each
 * split the label themselves would be three answers to which names a command
 * advertises.
 *
 * Empty when every label was `!` prefixed, which only a hidden command can be,
 * so no listing ever reaches the empty case for a command it shows. Losing an
 * alias never empties it, because what is lost is only ever an alias: a
 * command's own name is in its label, and a sibling taking a name is refused by
 * `CommandRegistry.assertReachable()`.
 *
 * @param cmd - The command, as `registry` holds it.
 * @param registry - Its parent's registry, which says who each name runs.
 * @returns The names, deduplicated.
 */
export function labelNames(cmd: InternalCommand, registry: CommandRegistry): string[] {
  // a label is a join of labels the name string was split on `[, ]+` to get,
  // so none of them holds the separator it is split on again. A set, because
  // `'build, build'` is one name written twice and saying it twice says nothing
  return [...new Set(cmd[Internal].label.split(', ').filter(Boolean))].filter(
    (name) => registry.find(name) === cmd
  );
}
