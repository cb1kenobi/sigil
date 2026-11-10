import debug from '../../debug/index.js';
import { Command, Internal, InternalCommand } from '../../types.js';
import { errorMessage } from '../../util/error-message.js';
import { initCommand, loadCommandDir } from './init-command.js';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { log } = debug('sigil:parser:load-command');

/**
 * Fetches the module a command's declaration named, however it named it.
 *
 * `path` is a file to read and `load` is a function to call, and they are the
 * same statement: the module *is* the command. Everything after this point --
 * the validation, the merge, the aliases, the label -- is identical, which is
 * why the two sources part company here and nowhere else. A bundled app is the
 * whole reason there are two: it has no file to read, because its command
 * modules are chunks a bundler named, so `sigil build` emits the loader and the
 * deferral survives bundling.
 *
 * Either failure names the module it was reading as well as what went wrong. A
 * loader is an anonymous closure, so `Failed to load command module: no chunk`
 * identified nothing at all -- while the export check below it already said
 * which command it was reading, which is two errors about one failure
 * disagreeing about whether the reader is told where to look. A `path` is the
 * same hole for a less obvious reason: a module that is simply missing reports
 * its own specifier, and one that does not *parse* reports `Unexpected end of
 * input` and names no file.
 *
 * And either keeps what it caught as the `cause`. The message is the one line a
 * reader is shown, and the stack it replaces is the only thing that says which
 * line of the module threw -- so without it a module that fails while it is
 * evaluated cannot be located, even with `errorHandler: false` or
 * `DEBUG=sigil:error`. The message is `errorMessage()`'s, because a loader can
 * reject with anything, a string or an object with no prototype included.
 *
 * @param cmd - The command whose module to fetch.
 * @returns The module's default export and the file it came from, or
 *   `undefined` when the command declared no module at all.
 */
async function fetchModule(
  cmd: InternalCommand
): Promise<{ def: unknown; entryFile?: string } | undefined> {
  const internal = cmd[Internal];

  if (internal.load) {
    log('Loading command from its loader');

    let mod;
    try {
      mod = await internal.load();
    } catch (e: unknown) {
      throw new Error(
        `Failed to load command module (the "${cmd.name}" command's loader): ${errorMessage(e)}`,
        { cause: e }
      );
    }

    // read for a `default` the way an imported module is, so that
    // `() => import('./build.js')` is the whole of the ordinary use -- and so
    // that a loader handing back the command object itself is not silently a
    // different contract
    const def = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;

    // no `entryFile`: there is no file, so there is nothing for a path the
    // module declares to be relative to. A bundled module declaring a `path`
    // is already asking for a file that is not there, and resolving it from
    // the working directory -- which is wherever the user was standing -- is
    // the answer a schema written inline already gets
    return { def };
  }

  if (internal.path) {
    log(`Loading command: ${internal.path}`);

    if (!existsSync(internal.path)) {
      throw new Error(`Command module not found: ${internal.path}`);
    }

    try {
      // the URL is for the loader and goes no further: everything else here
      // answers questions about the file system -- where the module sits, and
      // so what the paths it declares are relative to -- and `file:///a/b.js`
      // is not a directory anything can be resolved against
      const def = (await import(pathToFileURL(internal.path).href)).default;
      return { def, entryFile: internal.path };
    } catch (e: unknown) {
      throw new Error(`Failed to load command module (${internal.path}): ${errorMessage(e)}`, {
        cause: e,
      });
    }
  }

  return undefined;
}

/**
 * Tells the command that declared this one that it has finished loading.
 *
 * One place rather than one per `loadCommand()` return, because the two paths --
 * a module was fetched, or there was never one to fetch -- are the same event to
 * whoever declared it, and a parent that saw only the first would see some of
 * its subcommands and not others according to how each was declared.
 *
 * It is reached only after both `loaded` flags are set, which is what bounds a
 * hook that loads something itself: a hook reaching back into `loadCommand()`
 * for this same command takes the early return rather than looping.
 *
 * @param cmd - The subcommand that loaded.
 * @param parent - The command that declared it, when the caller knows it.
 * @param slot - The name the parent's registry holds it under, which is the
 *   placeholder's even when the module renamed the command.
 * @returns The command the parse should use: the one that loaded, or whatever
 *   the hook replaced it with.
 */
async function announceLoaded(
  cmd: InternalCommand,
  parent: InternalCommand | undefined,
  slot: string = cmd.name
): Promise<InternalCommand> {
  const hook = parent?.hooks?.subcommandLoaded;

  if (!parent || !hook) {
    return cmd;
  }

  log(`Announcing "${cmd.name}" to "${parent.name}"`);

  const replacement = await hook({ cmd, parent });

  if (replacement === undefined) {
    return cmd;
  }

  // a replacement answers "what is this command" and a `path` or a `load` asks
  // it again -- and nothing would read one, since this is already past the
  // fetch, so such a command would be handed to the parse with its module
  // never imported. Refused rather than fetched, because fetching it is this
  // hook re-entered on its own answer
  if (replacement.path !== undefined || replacement.load !== undefined) {
    throw new Error(
      `The "${parent.name}" command's subcommandLoaded hook returned a command declaring "${
        replacement.path !== undefined ? 'path' : 'load'
      }": the module has already been loaded, so a replacement is a command rather than another module to fetch`
    );
  }

  // a replacement for `migrate` is a `migrate`, so the name it is replacing is
  // the one it keeps unless it brought its own. Initialized against the
  // *parent's* directory, because the hook is the parent's code and a path in
  // a declaration is relative to the file that declared it
  const replaced = await initCommand(
    replacement.name === undefined ? { ...(replacement as Command), name: cmd.name } : replacement,
    undefined,
    parent[Internal].baseDir
  );

  // a replacement may bring aliases of its own, and it stands in the slot the
  // command it replaced was registered under -- so it is asked the question
  // `add()` asks of a sibling, against the siblings it now sits beside
  parent[Internal].commands.assertReachable(replaced, slot);

  return replaced;
}

/**
 * Loads a command's module, if it declared one, and tells its parent.
 *
 * @param cmd - The command to load.
 * @param parent - The command that declared it, so that its
 *   `subcommandLoaded` hook can fire. Omitted by a caller with no tree above
 *   this command, in which case no hook fires because there is nobody to tell.
 * @returns The loaded command, which is a different object from `cmd` whenever
 *   a module was merged into it.
 */
export async function loadCommand(
  cmd: InternalCommand,
  parent?: InternalCommand
): Promise<InternalCommand> {
  const internal = cmd[Internal];

  if (internal.loaded) {
    return cmd;
  }

  // a directory command reads its own level first: its entries become its
  // subcommands and an `index` module beside them becomes the `path` the fetch
  // below reads. Both halves of one `readdir`, which is why the walk is here
  // rather than beside the discovery that made the placeholder
  if (internal.dir) {
    await loadCommandDir(cmd);
  }

  const fetched = await fetchModule(cmd);

  if (fetched) {
    const { def, entryFile } = fetched;
    const source = entryFile ?? `the "${cmd.name}" command's loader`;

    // `typeof null` is `'object'` and so is an array, so a bare `typeof` check
    // let both through: `null` fell past the merge below and marked the
    // placeholder loaded, and an array merged into an empty command. Either way
    // the parse succeeded with a command that has no `run`, and the load was
    // recorded as done so it was never retried -- `main()` then did nothing at
    // all, which is a worse answer than the error a string export already gets
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      throw new TypeError(`Command module default export is not a valid command object: ${source}`);
    }

    const decl = def as Command;

    // the ESM loader caches the module and hands the same object to every
    // importer, so the placeholder is merged into a copy — mutating `def`
    // would leak the placeholder's name and aliases into the next parse
    const merged: Command = { ...decl };

    // the placeholder's subcommands come across as the commands they already
    // are rather than as the paths they were declared as: those paths are
    // relative to the file that declared the placeholder, and this module is a
    // different file, so reading them again here would read them against the
    // wrong directory. `initCommand()` hands an initialized command straight
    // back, which is what makes registering them again cost nothing
    if (internal.dir) {
      // a directory's subcommands were discovered rather than declared, so an
      // `index` module declaring some of its own adds to them rather than
      // replacing them -- losing `db/migrate.js` because `db/index.js`
      // mentioned one inline command is not something anybody means. What it
      // declares still wins the name it names, since that is the specific
      // statement and the walk is the general one
      merged.commands =
        decl.commands && typeof decl.commands === 'object' && !Array.isArray(decl.commands)
          ? { ...Object.fromEntries(internal.commands), ...decl.commands }
          : (decl.commands ?? Object.fromEntries(internal.commands));
    } else if (decl.commands === undefined && internal.commands.size) {
      merged.commands = Object.fromEntries(internal.commands);
    }

    // every other key but `path` and `load`: those are how this module was
    // found rather than something the command it declares still needs, and
    // either one carried across would be read a second time -- a `path`
    // against this module rather than against the file that declared the
    // placeholder, which is a different directory, and a `load` as a module to
    // fetch all over again
    for (const [key, value] of Object.entries(cmd)) {
      if (key !== 'path' && key !== 'load' && merged[key] === undefined) {
        merged[key] = value;
      }
    }

    // `hidden` is additive, but only the placeholder saw the `!` name
    // prefix, so a module that declares itself visible must not un-hide it
    if (cmd.hidden === true) {
      merged.hidden = true;
    }

    // the module never saw the placeholder's name string either, so the
    // aliases parsed from it have to come across as an explicit list
    if (
      internal.aliases.size &&
      (merged.alias === undefined ||
        typeof merged.alias === 'string' ||
        Array.isArray(merged.alias))
    ) {
      merged.alias = [
        ...internal.aliases,
        ...(merged.alias === undefined
          ? []
          : typeof merged.alias === 'string'
            ? [merged.alias]
            : merged.alias),
      ];
    }

    // every path still left in `merged` is the module's own, so the module is
    // what they are relative to -- which is also the base a hook of the
    // module's reads off the command it is handed
    const loaded = await initCommand(merged, entryFile);

    // ...and the same goes for the help label, **whether or not the module
    // renamed the command**. The label is what a listing publishes, and a
    // listing may only publish a spelling argv reaches: this module was
    // fetched because argv matched the placeholder, so a name string it brings
    // of its own -- `'list, ls'` -- has never routed anything, and its label
    // printed `Alias: ls` beside a command `mycli ls` refuses. The placeholder
    // is the one thing that routed, so its label is the one that is published.
    // The module's spellings still register (below), which is what settles a
    // shared one by declaration order; they are just not advertised. See
    // "The help label is the name string's" (its last paragraph) in
    // `src/help/AGENTS.md`
    loaded[Internal].label = internal.label;

    // a module's own aliases are only known now, so an alias that takes a
    // sibling's name is refused here with the error `add()` raises when the
    // schema is built. Asked of the parent's registry, which still holds the
    // placeholder under `cmd.name`: that slot is this command's own, not a
    // sibling's, which is what passing it says. Asked before the load is
    // marked done, so a refused module is refused again the next time it is
    // matched; before the parent's hook is told, so a hook is never handed a
    // command the tree refuses; and before any caller writes the result back,
    // so the answer is the same whether a walk appends it or puts it where the
    // placeholder was
    parent?.[Internal].commands.assertReachable(loaded, cmd.name);

    // only mark the load done once it actually succeeded: a module that
    // throws must throw again the next time the command is matched
    // instead of quietly resolving to the placeholder
    internal.loaded = true;

    // the command this built *is* the module, so loading it again would
    // re-import the same file and run its init hooks a second time
    loaded[Internal].loaded = true;

    return announceLoaded(loaded, parent, cmd.name);
  }

  internal.loaded = true;

  // a command with no module at all is still a command that has finished
  // loading, which is the whole of what its parent was told about
  return announceLoaded(cmd, parent);
}
