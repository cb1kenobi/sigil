/**
 * The `schema` command a schema gets for free, wired the way `completion` is
 * (SIG-717).
 *
 * `mycli schema` prints every runnable command's input as JSON Schema, which is
 * what an agent, an MCP server or a tool definition reads to call the app
 * without parsing its help. `mycli schema db migrate` prints that command and
 * what is under it, so an agent that knows which command it wants reads one
 * schema rather than all of them.
 *
 * ## Why the framework owns it
 *
 * `completion`'s reasons, unchanged: the schema is printed from the command
 * tree and the declarations, which are the parser's, and a command an app
 * wrapped around `main()` is not in what `sigil build` bundles -- so the one
 * spelling that works from source and built alike is the one `parse()` adds.
 * `sigil reference --json-schema` prints the same document from the toolchain,
 * through the same `inputSchemasJson()`, so the two cannot disagree.
 *
 * On the root, and nothing is added over what the app declared: an app with its
 * own `schema` command, or an alias of that name, keeps it and gets nothing from
 * here. `schema: false` on the schema turns it off, which is the spelling
 * `help: false` and `completion: false` already have.
 *
 * ## It is listed in help
 *
 * Help is the one thing every agent reads first, and a command it is not told
 * about is a command it does not use. `completion` is listed for the same
 * reason.
 *
 * ## The mapping is behind a dynamic import
 *
 * A CLI that answers `--version` pays for the command existing -- a name in a
 * registry and an argument -- and not for the surface walk or the mapping,
 * which `run` reaches with `await import()`, exactly as `completion` reaches its
 * emitters.
 */

import { __ } from '../i18n/index.js';
import { writeOut } from '../output.js';
import { Internal, type InternalCommand, type ParseState, type Schema } from '../types.js';
import { initCommand } from './command/init-command.js';
import { resolveCommandPath } from './help.js';

/**
 * Adds `schema` to the root context, unless the app has its own or has turned
 * it off.
 *
 * @param root - The root context, built from the schema.
 * @param schema - The schema, for `schema: false`.
 */
export async function registerSchemaCommand(root: InternalCommand, schema: Schema): Promise<void> {
  if (schema.schema === false) {
    return;
  }

  const internal = root[Internal];

  // `find()` answers about the aliases as well as the name, which is what has
  // to be free -- the reason `completion` asks it
  if (internal.commands.find('schema')) {
    return;
  }

  const command = await initCommand({
    args: [{ desc: __`The command to print, and what is under it`, name: '[command...]' }],
    desc: __`Print each command's input as JSON Schema`,
    name: 'schema',

    async run(state: ParseState) {
      const words = Array.isArray(state.argv.command)
        ? (state.argv.command as unknown[]).map(String)
        : [];

      // help's own walk, so `schema db:migrate` names what `help db:migrate`
      // names, and a typo is refused with the same suggestion. The chain is
      // innermost first and ends at the root, which is not a segment
      const under =
        words.length > 0
          ? (await resolveCommandPath(state, words))
              .slice(0, -1)
              .reverse()
              .map((cmd) => cmd.name)
          : [];

      const { commandSurface, inputSchemasJson } = await import('../reference/index.js');
      writeOut(inputSchemasJson(await commandSurface(state.schema), { under }));
    },
  });

  // the document is a function of the schema, so a value argv did not carry is
  // not missing from anything -- the reason `completion` carries it. See
  // `needsNoValues`
  command[Internal].needsNoValues = true;
  // and the framework's, which is what an alias taking `schema` is told. See
  // `builtIn`
  command[Internal].builtIn = true;

  internal.commands.add(command);
}
