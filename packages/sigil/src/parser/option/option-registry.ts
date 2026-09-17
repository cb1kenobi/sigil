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
