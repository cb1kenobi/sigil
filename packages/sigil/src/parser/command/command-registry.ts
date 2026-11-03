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

    this.#claimDefault(cmd);

    this.set(name, cmd);
    this.#lookup[name] = name;

    for (const alias of cmd[Internal].aliases) {
      this.#lookup[alias] = name;
    }
  }

  /**
   * Puts a loaded command where its placeholder was.
   *
   * Not `add()`, because `add()` is a registration and a registration is the
   * latest one: every spelling it names is claimed over whoever held it, which
   * is right for a command arriving and wrong for one that was declared long
   * ago and has only now been read. The module *is* the placeholder's
   * declaration, so the loaded command keeps the placeholder's position and
   * every spelling the placeholder won, and a spelling only the module names is
   * settled by declaration order -- it is claimed from a sibling declared
   * before this command and left with one declared after it, which is the
   * answer the registry would have given had the module been read when the
   * schema was built.
   *
   * A module that renames the command is re-keyed in place, and every spelling
   * that reached the placeholder reaches the renamed command. Renaming onto a
   * sibling's name takes that sibling's key, which is what `add()` did with it.
   *
   * @param placeholder - The command the registry holds.
   * @param loaded - What `loadCommand()` made of it.
   */
  replace(placeholder: InternalCommand, loaded: InternalCommand): void {
    const from = placeholder.name;
    const to = loaded.name;

    // somebody already changed what this name is, so there is no position left
    // to keep and nothing here to replace
    if (super.get(from) !== placeholder) {
      return;
    }

    if (to === from) {
      // a `Map` keeps an existing key where it was
      this.set(to, loaded);
    } else {
      const entries = [...this];
      this.clear();
      for (const [name, cmd] of entries) {
        if (name === from) {
          this.set(to, loaded);
        } else if (name !== to) {
          this.set(name, cmd);
        }
      }

      for (const spelling in this.#lookup) {
        if (this.#lookup[spelling] === from) {
          this.#lookup[spelling] = to;
        }
      }

      if (this.#default === from) {
        this.#default = to;
      }
    }

    this.#claimDefault(loaded);

    const position = new Map([...this.keys()].map((name, i) => [name, i]));
    const here = position.get(to)!;

    for (const spelling of [to, ...loaded[Internal].aliases]) {
      const owner = this.#lookup[spelling];
      const at = owner === undefined ? undefined : position.get(owner);

      if (at === undefined || at < here) {
        this.#lookup[spelling] = to;
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

  #claimDefault(cmd: InternalCommand): void {
    const { name } = cmd;

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
  }
}
