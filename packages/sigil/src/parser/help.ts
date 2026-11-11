import { __ } from '../i18n/index.js';
import {
  type HelpRequest,
  Internal,
  type InternalCommand,
  type InternalOption,
  type ParsedCommand,
  type ParseState,
  type Schema,
} from '../types.js';
import { splitTopic, topicSeparator } from '../util/topic.js';
import { initCommand } from './command/init-command.js';
import { loadCommand } from './command/load-command.js';
import { resolveTopic } from './command/topic.js';
import { addFreeFlag } from './option/free-flag.js';
import { unknownCommand } from './suggest.js';
import { typedOn } from './typed-on.js';

/**
 * The `--help` flag and the `help` command a schema gets for free, so that
 * `parse()` can tell whether one of them was the thing that was asked for. A
 * schema that declares its own keeps it, and then neither is here.
 */
export interface HelpHandles {
  command?: InternalCommand;
  option?: InternalOption;
}

/**
 * Adds `--help` and `help` to the root context, unless the app already has them
 * or has turned them off.
 *
 * Both go on the root rather than on every command, because options resolve
 * across the whole context chain: one `--help` there answers everywhere, and a
 * command that declares its own shadows it for itself and nowhere else.
 *
 * Nothing is added over the top of what the app declared. A CLI whose `-h` means
 * `--host` keeps it and gets `--help` without the short form; one that declares
 * `--help` itself gets no flag from here at all, and is then responsible for what
 * `--help` does -- which is the only reading of a declaration that means anything.
 *
 * @param root - The root context, built from the schema.
 * @param schema - The schema, for `help: false`.
 * @returns What was added, so a parse can recognize it later.
 */
export async function registerHelp(root: InternalCommand, schema: Schema): Promise<HelpHandles> {
  if (schema.help === false) {
    return {};
  }

  const internal = root[Internal];
  const handles: HelpHandles = {};

  // nothing over a spelling or a name the app already holds; see `addFreeFlag()`
  const option = await addFreeFlag(internal.options, {
    desc: () => __`Show help for a command`,
    name: 'help',
    short: 'h',
  });
  if (option) {
    handles.option = option;
  }

  if (!internal.commands.find('help')) {
    const command = await initCommand({
      args: [{ desc: __`The command to describe`, name: '[command...]' }],
      // the same sentence as the option's, so it is the same key -- which is
      // the merge keying on the English buys
      desc: __`Show help for a command`,
      name: 'help',
    });
    // the framework's, which is what an alias taking `help` is told: an app
    // that never declared this command cannot rename it. See `builtIn`
    command[Internal].builtIn = true;
    internal.commands.add(command);
    handles.command = internal.commands.find('help');
  }

  return handles;
}

/**
 * Whether this parse was a request for help, and what it should describe.
 *
 * Called once argv has been walked and before anything is validated, because
 * help has to win over a missing required option: `mycli build --help` is asking
 * what `build` needs, and answering "you did not say" is not an answer.
 *
 * @param state - The parse state.
 * @param handles - What `registerHelp()` added.
 * @returns The request, or `undefined` when help was not what was asked for.
 */
export async function detectHelp(
  state: ParseState,
  handles: HelpHandles
): Promise<HelpRequest | undefined> {
  // the command form is asked first, because it is the more specific of the two
  // when both are present: somebody who typed `help build` named the command
  // they meant, and the `--help` after it adds nothing
  if (handles.command && state.cmd === handles.command) {
    return { contexts: await resolve(state, path(state, handles.command)), via: 'command' };
  }

  if (typedOn(state, handles.option)) {
    return { contexts: asked(state), via: 'option' };
  }

  return undefined;
}

/**
 * The chain argv actually asked about.
 *
 * Usually that is the chain the parse ended in, but not when a default command
 * was dispatched: `mycli --help`, on a CLI whose `serve` is the default, is asking
 * what `mycli` does, and answering with `serve`'s screen hides every other command
 * there is. So the chain is trimmed back to the commands argv named -- one
 * `ParsedCommand` each, and none for a default, which is exactly the difference.
 *
 * @param state - The parse state.
 * @returns The chain, innermost first.
 */
function asked(state: ParseState): InternalCommand[] {
  const named = state.$.filter((parsed) => parsed.type === 'Command').length;
  return state.contexts.slice(state.contexts.length - (named + 1));
}

/**
 * The command path `help` was given, which is every positional after it.
 *
 * After it, and not simply every positional there is: `mycli nope help build`
 * would otherwise start the walk at `nope` and report that as the unknown
 * command, when the question was about `build`.
 *
 * Read off `state.$` rather than `state.argv`, because nothing has processed the
 * arguments yet: help is detected before validation, which is the point of it.
 *
 * @param state - The parse state.
 * @param command - The help command, to find where its arguments start.
 * @returns The names, in order.
 */
function path(state: ParseState, command: InternalCommand): string[] {
  const names: string[] = [];
  let reached = false;

  for (const parsed of state.$) {
    if (!reached) {
      reached = parsed.type === 'Command' && (parsed as ParsedCommand).cmd === command;
      continue;
    }

    if (parsed.type === 'Unknown') {
      for (const input of parsed.inputs) {
        if (typeof input === 'string' && input) {
          names.push(input);
        }
      }
    }
  }

  return names;
}

/**
 * The context chain for a command named by path, innermost first.
 *
 * `help build targets` describes `targets`, and to describe it the way
 * `mycli build targets --help` would, the chain above it has to be the same
 * chain -- so this walks down from the root the way the parser does, loading a
 * lazily declared command when it reaches one, and hands back what it walked
 * through.
 *
 * @param state - The parse state.
 * @param names - The command path.
 * @returns The chain, innermost first.
 */
async function resolve(state: ParseState, names: string[]): Promise<InternalCommand[]> {
  // the root, which is the last element of any chain
  const chain = [state.contexts[state.contexts.length - 1]!];
  const separator = topicSeparator(state.schema);

  for (const name of names) {
    const parent = chain[0]!;
    const found = parent[Internal].commands.find(name);

    if (found) {
      // a lazily declared command has its description and its own subcommands
      // in a module, and describing it means reading them -- so `help
      // <command>` is a load like any other and its parent is told about it
      // like any other
      const loaded = await loadCommand(found, parent);
      if (loaded !== found) {
        // recorded the way the parse and the `:` walk record one, which is
        // what keeps `help db` and `help db:migrate` leaving one registry
        parent[Internal].commands.replace(found, loaded);
      }
      chain.unshift(loaded);
      continue;
    }

    // `help db:migrate` answers the question `mycli db:migrate --help` would,
    // through the parse's own rule rather than a second one: whole first, then
    // split, and the split only when every segment resolves. The message is
    // what that buys -- a refused split reports `db:bogus` and
    // `http://example.com` whole, which is what the parse says about the same
    // token, where splitting on the first segment alone would report
    // `Unknown command "http"` about a URL
    const segments = splitTopic(name, separator);

    // `chain` is a context chain, innermost first, which is what
    // `resolveTopic()` grows -- so the walk puts what it resolved on the front
    // of it and takes it back off again where the path is refused
    if (!(segments && (await resolveTopic(chain, segments)))) {
      throw new Error(unknownCommand(name, parent, state.settings));
    }
  }

  return chain;
}
