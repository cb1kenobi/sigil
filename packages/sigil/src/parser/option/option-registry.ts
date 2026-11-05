import { Internal, InternalOption, Option } from '../../types.js';
import { initOption } from './init-option.js';

/**
 * Computes the key an option is stored under.
 *
 * A negated flag and its positive twin — `--no-cheese` and `--cheese <type>` —
 * resolve to the same name and the same destination, yet they are two distinct
 * options: one takes a value, the other only turns the destination off. Keying
 * them apart is what lets a schema declare both without one replacing the
 * other. A `:` cannot appear in an option name, so a negated key can never
 * collide with a positive one.
 *
 * @param opt - The initialized option.
 * @returns The registry key.
 */
function optionKey(opt: InternalOption): string {
  return opt.negate ? `no:${opt.name}` : opt.name;
}

export class OptionRegistry extends Map<string, InternalOption> {
  // null-prototype, for the same reason as `CommandRegistry`: an option named
  // `__proto__` cannot register its bare name on a plain object, and a lookup of
  // `constructor` or `toString` finds `Object.prototype`'s and short-circuits
  // the `#chars[name] || #lookup[name]` fall-through with something that is
  // truthy and is not a key
  #chars: Record<string, string> = Object.create(null);
  #lookup: Record<string, string> = Object.create(null);

  async add(it: Option | InternalOption): Promise<void> {
    const opt = (Internal in it ? it : await initOption(it)) as InternalOption;
    const { name } = opt;

    if (!name || typeof name !== 'string') {
      throw new TypeError(`Invalid option name: ${JSON.stringify(it.name)}`);
    }

    const negate = !!opt.negate;
    const key = optionKey(opt);
    const twinKey = negate ? name : `no:${name}`;
    const twin = super.get(twinKey);

    // asked before anything is written, so a refused option leaves the registry
    // as it found it
    this.#assertFree(opt, key);

    this.set(key, opt);

    if (twin) {
      // the two share a destination, and the positive twin owns it: it is
      // kept ahead of the negated one so environment and default fallbacks
      // resolve in the same order no matter which was declared first, and
      // the negated flag's implied default gives way to it, so that
      // `--cheese <type>` is not quietly satisfied by the `true` that
      // `--no-cheese` implies
      const negated = negate ? opt : twin;
      const positive = negate ? twin : opt;
      negated[Internal].skipDefault = negated[Internal].impliedDefault;
      positive[Internal].negatedTwin = negated;

      if (!negate) {
        this.delete(twinKey);
        this.set(twinKey, twin);
      }
    }

    for (const alias of opt[Internal].short) {
      this.#chars[alias] = key;
    }

    // a negated flag answers to the positive spelling as well, but only
    // claims it when nothing else has, so `--cheese` resolves to
    // `--cheese <type>` in either declaration order
    for (const alias of [...opt[Internal].long, name]) {
      if (negate && (alias === name || alias === `--${name}`)) {
        this.#lookup[alias] ??= key;
      } else {
        this.#lookup[alias] = key;
      }
    }
  }

  /**
   * Refuses an option that would take a spelling another option holds.
   *
   * A later registration used to win a shared spelling silently, so
   * `'-a, --alpha'` beside `'-a, --beta'` sent `-a` to `--beta` while help
   * printed `-a` on both rows -- one of them a lie, and nothing said which. An
   * option's every spelling is in its help row, which is the difference from a
   * command's property alias that lets `CommandRegistry` keep later-wins
   * between aliases.
   *
   * Three things are not a collision. An option registered under the **same
   * key** is a replacement, which is how a hook swaps a declaration out, and it
   * inherits every spelling the one it replaces held. A spelling whose holder
   * is no longer in the registry is a stale entry, not an owner. And a negated
   * flag's claim on the positive long spelling, `--name`, is a fallback that
   * gives way to its twin, so the twin taking it back is the rule rather than a
   * clash. That exemption is for `--name` alone: a short alias both twins
   * declare is refused whichever of them is declared first.
   *
   * @param opt - The option arriving.
   * @param key - The key it will be stored under.
   */
  #assertFree(opt: InternalOption, key: string): void {
    const positive = `--${opt.name}`;
    const holder = (spelling: string, held: string | undefined): void => {
      if (held === undefined || held === key || !super.has(held)) {
        return;
      }
      const other = super.get(held) as InternalOption;
      // the negated twin's fallback claim on `--name`, which it only ever took
      // because nothing else had. That spelling and no other: a short alias the
      // twin declared is its own, so the positive twin declaring it too is a
      // collision in either order rather than only when it arrives first
      if (spelling === positive && !opt.negate && other.negate && other.name === opt.name) {
        return;
      }
      throw new Error(
        `Options "${other.format}" and "${opt.format}" both declare ${spelling}: an option's spelling must be its own`
      );
    };

    for (const alias of opt[Internal].short) {
      holder(alias, this.#chars[alias]);
    }

    for (const alias of opt[Internal].long) {
      // a negated flag claims the positive spelling only where it is free, so it
      // never collides over that one: see `add()`
      if (!(opt.negate && alias === positive)) {
        holder(alias, this.#lookup[alias]);
      }
    }
  }

  find(name?: string): InternalOption | undefined {
    // eslint-disable-next-line const-comparisons
    const key = name ? this.#chars[name] || this.#lookup[name] : undefined;
    return key ? super.get(key) : undefined;
  }

  get(name: string): InternalOption | undefined {
    const key = this.#lookup[name];
    return key ? super.get(key) : undefined;
  }
}
