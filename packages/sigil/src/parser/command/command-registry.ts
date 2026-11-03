import { Internal, InternalCommand } from '../../types.js';

export class CommandRegistry extends Map<string, InternalCommand> {
  // null-prototype: a command really can be named `__proto__`, and on a plain
  // object `#lookup['__proto__'] = name` goes through `Object.prototype`'s
  // accessor and is dropped, so the command registered but never matched. The
  // inherited members are the other half of it -- `constructor` and `toString`
  // read back truthy from a plain object and answered a lookup nothing declared
  #lookup: Record<string, string> = Object.create(null);
  #default: string | undefined;

  add(cmd: InternalCommand): void {
    const { name } = cmd;

    this.assertReachable(cmd);

    if (cmd.default) {
      // two siblings both claiming to be the default is a schema bug with no
      // right answer, and picking one of them would pick it by registration
      // order -- which for a directory of command modules is whatever the
      // file system felt like. The names are sorted so the message does not
      // depend on that order either
      if (this.#default !== undefined && this.#default !== name) {
        const [a, b] = [this.#default, name].sort();
        throw new Error(`Only one default command is allowed: "${a}" and "${b}" are both default`);
      }
      this.#default = name;
    } else if (this.#default === name) {
      // the command being replaced was the default and its replacement is not
      this.#default = undefined;
    }

    this.set(name, cmd);
    this.#lookup[name] = name;

    for (const alias of cmd[Internal].aliases) {
      this.#lookup[alias] = name;
    }
  }

  /**
   * Refuses a command that would leave a sibling with no spelling: an alias
   * that is a sibling's name, in either order, or a loaded module renaming its
   * command onto one.
   *
   * A later registration wins a shared spelling, which is harmless between two
   * aliases -- the loser is still reachable by its name -- and is a trapdoor
   * when the spelling is a sibling's **name**: `{ ship: {}, other: { alias:
   * 'ship' } }` routes `ship` to `other`, leaves the `ship` command with no
   * spelling at all, and still lists it in help. Asked of both directions,
   * because the alias may arrive before the name or after it and either way
   * one command has lost the one spelling that must always reach it.
   *
   * `add()` asks it of every sibling it registers. `loadCommand()` asks it of
   * a command that has just loaded, before anything writes it back -- a
   * module's own aliases, and a `subcommandLoaded` replacement's, are only
   * known then -- so the answer does not depend on whether, or how, a caller
   * puts the loaded command into this registry afterwards. A write-back that
   * puts a loaded command where its placeholder was asks it with the
   * placeholder's name as the slot, so the placeholder is not mistaken for a
   * sibling of the command it became.
   *
   * @param cmd - The command arriving.
   * @param slot - The name of the registered command `cmd` stands in for, which
   *   is its own name unless a loaded module renamed it. That command is the
   *   one being replaced rather than a sibling, so it is not asked about.
   */
  assertReachable(cmd: InternalCommand, slot: string = cmd.name): void {
    const { name } = cmd;

    // a loaded module that renames its command onto a sibling's name is the
    // same outcome arriving another way: writing it back under that name takes
    // the sibling's key, and the sibling is left with no spelling at all. Only
    // reachable through a rename, since `add()` passes no slot and a command
    // registered under its own name is a replacement rather than a sibling
    if (name !== slot && this.has(name)) {
      throw renamedOntoName(slot, name);
    }

    for (const alias of cmd[Internal].aliases) {
      if (alias !== name && alias !== slot && this.has(alias)) {
        throw shadowsName(name, alias);
      }
    }

    for (const sibling of this.values()) {
      if (sibling.name !== name && sibling.name !== slot && sibling[Internal].aliases.has(name)) {
        throw shadowsName(sibling.name, name);
      }
    }
  }

  find(name?: string): InternalCommand | undefined {
    return name ? super.get(this.#lookup[name]) : undefined;
  }

  /**
   * The command to run when argv never named one. `undefined` unless exactly
   * one registered command is marked `default`.
   */
  get default(): InternalCommand | undefined {
    return this.#default === undefined ? undefined : super.get(this.#default);
  }
}

/**
 * The error for an alias that takes a sibling's name.
 *
 * @param owner - The command declaring the alias.
 * @param name - The alias, which is also the sibling's name.
 * @returns The error, naming both commands and what to do.
 */
function shadowsName(owner: string, name: string): Error {
  return new Error(
    `The "${owner}" command's alias "${name}" is the name of a sibling command: "${name}" would run "${owner}" and nothing could reach the "${name}" command, so remove the alias or rename one of the two`
  );
}

/**
 * The error for a loaded module that renames its command onto a sibling's
 * name, said the way `shadowsName()` says an alias.
 *
 * @param slot - The name the command was declared under, which is what the
 *   reader will find in their schema.
 * @param name - The name the module gives it, which is also the sibling's.
 * @returns The error, naming both and what to do.
 */
function renamedOntoName(slot: string, name: string): Error {
  return new Error(
    `The "${slot}" command's module renames it "${name}", which is the name of a sibling command: "${name}" would run "${slot}" and nothing could reach the "${name}" command, so rename one of the two`
  );
}
