/**
 * Copies a declaration into a new object for the library to own and normalize.
 *
 * Every array the declaration carries — `alias`, `args`, `choices`, `default`,
 * `env`, and anything custom — is copied too, so nothing reachable from the
 * parser's copy can be appended to and have that reach back into the schema
 * and change what the next parse sees.
 *
 * The copy is shallow beyond that: functions and objects are shared, because
 * a library cannot meaningfully clone a `run` handler or a `transform`. The
 * parser never writes to those.
 *
 * @param it - The declaration to copy.
 * @returns A new object with the same properties.
 */
export function copyDeclaration<T extends object>(it: T): T {
	const copy = { ...it } as Record<string, unknown>;
	for (const [key, value] of Object.entries(copy)) {
		if (Array.isArray(value)) {
			copy[key] = [...value];
		}
	}
	return copy as T;
}
