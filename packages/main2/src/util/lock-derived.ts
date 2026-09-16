/**
 * Makes the properties an `init*()` already consumed read-only.
 *
 * Everything the parser has to keep in sync is read exactly once, when the
 * command, option, or argument is built: a name becomes a camelCase
 * destination and a registry key, a format string becomes the set of spellings
 * an option answers to, an `env` list becomes the fallbacks it reads. Writing
 * one of those afterwards would change what a consumer reads back without
 * changing one thing about the parse.
 *
 * Re-deriving on the write is not on offer either. The only hook a plain
 * property assignment gives you is a Proxy `set` trap, which has to answer
 * synchronously, while building a command or an option is async. So rather
 * than drop such a write silently, it throws — and says what to do instead.
 *
 * A property the declaration left out is locked too, and stays non-enumerable
 * so the object still reads back as what was declared.
 *
 * @param it - The object being initialized.
 * @param props - The properties that were read once and must not move.
 * @param message - Builds the error thrown when one of them is assigned.
 */
export function lockDerived(
	it: object,
	props: readonly string[],
	message: (prop: string) => string
): void {
	const target = it as Record<string, unknown>;

	for (const prop of props) {
		const value = target[prop];
		const enumerable = Object.hasOwn(target, prop);

		// a container is frozen as well, so reaching past the property and
		// editing an entry is just as loud as replacing the whole thing
		if (value && typeof value === 'object') {
			Object.freeze(value);
		}

		Object.defineProperty(target, prop, {
			configurable: false,
			enumerable,
			get: () => value,
			set() {
				throw new Error(message(prop));
			},
		});
	}
}
