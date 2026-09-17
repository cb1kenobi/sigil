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
