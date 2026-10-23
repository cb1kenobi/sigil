import debug from '../../debug/index.js';
import { Internal, type InternalCommand } from '../../types.js';
import { loadCommand } from './load-command.js';

const { log } = debug('sigil:parser:topic');

/**
 * Resolves a split token as a command path, all of it or none of it.
 *
 * The rule is that **every** segment has to resolve as a command against
 * successively inner contexts, and that is what makes the colon form
 * non-destructive by construction rather than by a list of exceptions. A
 * positional value holds a colon all the time -- a URL, `host:port`,
 * `node:22`, `10:30`, a drive-relative Windows path -- and none of those is
 * eaten, because `http` and `node` and `10` are not commands. Where the first
 * segment is not one, which is the overwhelming case, this costs a single
 * `Map` lookup and reads nothing.
 *
 * A matched command joins the chain **before** the module behind it is
 * loaded, which is the contract the space form keeps in as many words: a
 * module that will not load is an error this command's own `beforeError`
 * hooks should still see. So the chain is grown as the walk goes and a path
 * the walk then *refuses* is taken back off it -- a refusal is a token that
 * was never a path, where a throw is a command that really did match.
 *
 * Loading is the half that cannot be taken back, so what a refused path leaves
 * behind is recorded rather than dropped: a level that had to be read to find
 * out whether the next segment resolves is put **back into its parent's
 * registry** as the command it loaded into. `loadCommand()` answers a second
 * call with the placeholder it was given, so a load whose result was thrown
 * away would mark that placeholder loaded and leave a later match with a
 * command carrying no `run` -- the silent shape of a command that parses and
 * does nothing. Recording it is also what keeps `subcommandLoaded` firing
 * exactly once, since the registry hands the loaded command over and nothing
 * loads it again.
 *
 * What the atomic rule costs is one divergence from the space form, and it is
 * intrinsic rather than an oversight: a command contributed by an ancestor's
 * `parse` hook is reachable by `mycli db migrate` and not by `mycli db:migrate`,
 * because that hook fires when a command joins the chain and no hook here may
 * fire until the whole path has resolved. Firing them as the walk went would
 * commit half a path that then failed, which is the one thing this rule exists
 * to refuse.
 *
 * @param contexts - The context chain, innermost first. Grown by what
 *   resolved, and left exactly as it was found when the path is refused.
 * @param segments - The split token.
 * @returns The commands, outermost first, or `undefined` when any segment did
 *   not resolve.
 */
export async function resolveTopic(
  contexts: InternalCommand[],
  segments: string[]
): Promise<InternalCommand[] | undefined> {
  const chain: InternalCommand[] = [];

  for (const segment of segments) {
    // the parent is read before the unshift puts the match in front of it
    const parent = contexts[0]!;
    const found = parent[Internal].commands.find(segment);

    if (!found) {
      log(`Not a command path: "${segment}" does not resolve against "${parent.name}"`);
      // whatever resolved before it was never a command argv named, because
      // the token it was part of turned out not to be a path
      contexts.splice(0, chain.length);
      return undefined;
    }

    contexts.unshift(found);

    const loaded = await loadCommand(found, parent);

    if (loaded !== found) {
      contexts[0] = loaded;
      // the load is recorded where the placeholder was found, so that a path
      // this walk goes on to refuse has still left the registry pointing at
      // the command that was read rather than at a placeholder marked loaded
      parent[Internal].commands.add(loaded);
    }

    chain.push(loaded);
  }

  return chain;
}
