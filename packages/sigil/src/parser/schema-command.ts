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
 * ## It takes the word, as `completion` does
 *
 * A command resolves before a positional value, so an app whose root reads one
 * -- `mycli <who>` -- answers `mycli schema` with this command rather than
 * greeting somebody called `schema`. That is `completion`'s and `help`'s cost
 * already, and the answer is theirs: `schema: false`, or a command of the app's
 * own by that name.
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
import type { CommandSurface } from '../reference/surface.js';
import {
  Internal,
  type InternalCommand,
  type ParseState,
  type Schema,
  type TopicSeparator,
} from '../types.js';
import { escapeControls } from '../util/escape-controls.js';
import { programName, programNameProblem } from '../util/program-name.js';
import { splitTopic, topicSeparator } from '../util/topic.js';
import { UsageError } from '../util/usage-error.js';
import { initCommand } from './command/init-command.js';
import { resolveCommandPath } from './help.js';

/**
 * The surface's path for the command a run of words names.
 *
 * Read off the surface's own `tokens`, which are the name the registry knows a
 * command by and every alias that reaches it -- the names it **routes** by --
 * rather than off what loading the command produced. A module may rename its
 * command (`name: 'compile'` behind a `build` placeholder), and the loaded
 * command is then called `compile` while the surface's path says `build`, so a
 * path built from loaded names matched nothing and printed an empty document
 * with exit 0. Found by review.
 *
 * A word is tried whole and then split at the topic separator, every segment
 * having to resolve, which is `resolveTopic()`'s rule. `resolveCommandPath()`
 * has already refused what does not resolve, so a miss here is a command the
 * surface does not record -- one no token can type -- and is refused the same
 * way rather than printed as nothing.
 *
 * @param surface - The app's surface.
 * @param words - The words argv named, which may be empty.
 * @param separator - What a command path is spelled with.
 * @returns The path, by each segment's canonical name.
 * @throws A `UsageError` with the code `unknown-command`.
 */
function surfacePath(
  surface: CommandSurface,
  words: readonly string[],
  separator: TopicSeparator
): readonly string[] {
  const child = (at: readonly string[], token: string): readonly string[] | undefined =>
    surface.commands.find(
      (cmd) =>
        cmd.path.length === at.length + 1 &&
        at.every((segment, i) => cmd.path[i] === segment) &&
        cmd.tokens.includes(token)
    )?.path;

  let path: readonly string[] = [];

  for (const word of words) {
    let next = child(path, word);

    if (!next) {
      next = splitTopic(word, separator)?.reduce<readonly string[] | undefined>(
        (at, segment) => (at ? child(at, segment) : undefined),
        path
      );
    }

    if (!next) {
      throw new UsageError(__`Unknown command "${escapeControls(word)}"`, 'unknown-command');
    }
    path = next;
  }

  return path;
}

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

  // not on an app whose program name the surface would refuse -- one holding
  // whitespace or a control character -- because the command could only fail
  // there, with a message about building a reference, while help listed it.
  // Asked of the name help prints, so an app with no `name` still gets one,
  // named after its script. Found by review
  if (programNameProblem(programName(schema.name))) {
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

      // help's own walk first, so `schema db:migrate` names what
      // `help db:migrate` names and a typo is refused with the same suggestion.
      // What it hands back is not used: those are the *loaded* commands, and a
      // module that renames its command loads under the new name, where the
      // surface keys it by the name it routes by
      if (words.length > 0) {
        await resolveCommandPath(state, words);
      }

      const { commandSurface, inputSchemasJson } = await import('../reference/index.js');
      // named the way help names it, because `Schema.name` is optional and the
      // surface refuses a program with none: help's usage line and `program`
      // here are one answer
      const surface = await commandSurface({
        ...state.schema,
        name: programName(state.schema.name),
      });
      const under = surfacePath(surface, words, topicSeparator(state.schema));

      writeOut(inputSchemasJson(surface, { under }));
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
