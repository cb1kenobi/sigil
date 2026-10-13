import { isPlainObject } from './dotted.js';

/**
 * What JSON cannot hold, asked before a write rather than discovered after one.
 *
 * `JSON.stringify` has three answers for a value it cannot represent and only
 * one of them is loud. It **throws** for a `BigInt`. It answers `undefined` --
 * the value, not a string -- for `undefined`, a function and a symbol, which
 * reaches a file as broken output. And it **silently rewrites** `NaN`,
 * `Infinity` and `-Infinity` as `null`, a `Map` or a `Set` as `{}`, and a class
 * instance as whatever its own enumerable keys happen to be. The third is the
 * reason this exists: a store that wrote them would be the silent-loss class
 * every other decision in this module refuses.
 *
 * A value with a **`toJSON`** passes and is not walked, which is this asking
 * what `JSON.stringify` will do rather than what the value holds:
 * `JSON.stringify` calls `toJSON` first and never looks at the rest, so an
 * object that said what it is in JSON has said it. A `Date` is the case that
 * matters -- its JSON form is an ISO string and the schema's own `date` type
 * reads one back, so it round trips through this module rather than through
 * JSON alone -- and a plain object with a `toJSON` is the same statement
 * somebody wrote by hand. What that method **answers** is not checked, because
 * checking means calling a caller's code during a guard; `serialize()` throws
 * for the one answer that would reach a file broken.
 *
 * Not translated. A value handed to `set()` is the **app's** own, and a file
 * cannot hold anything JSON cannot represent by construction, so nothing a user
 * writes can provoke this -- which is the line `dotted.ts` already draws.
 */

/** Why JSON cannot hold a value, or nothing where it can. */
function why(value: unknown): string | undefined {
	switch (typeof value) {
		case 'bigint':
			return 'JSON has no bigint';
		case 'function':
			return 'JSON has no function';
		case 'symbol':
			return 'JSON has no symbol';
		case 'undefined':
			return 'JSON has no undefined; delete the key instead';
		case 'number':
			return Number.isFinite(value) ? undefined : `JSON has no ${value}`;
		default:
			break;
	}

	return undefined;
}

/** What JSON writes an object of no kind it knows as, which is `{}`. */
function asEmpty(value: object): string {
	return `JSON writes a ${value.constructor?.name ?? 'value'} of this kind as {}`;
}

/**
 * Whether JSON can hold a value, and where it cannot.
 *
 * Walks, because the offending value is almost never the one that was handed
 * over: `set('server', { retries: Infinity })` is a plain object holding
 * something JSON turns into `null`, and a refusal that named `server` rather
 * than `server.retries` would be pointing at the thing that is fine.
 *
 * @param value - The value.
 * @param path - What to call it, which is a dotted path from the caller's own.
 * @returns `true`, or a sentence saying why not.
 */
export function jsonCanHold(value: unknown, path: string): true | string {
	// the objects this walk is inside, so that a cycle is a refusal rather than a
	// hang -- added and removed around the recursion rather than only added,
	// which is `copyInto()`'s own rule and for its reason: a value referenced
	// twice is a DAG that JSON writes twice, and only a genuine cycle is refused
	const answer = look(value, path, new WeakSet<object>());
	return answer ?? true;
}

/** The walk, with the objects it is inside. */
function look(value: unknown, where: string, seen: WeakSet<object>): string | undefined {
	const at = (answer: string): string => (where === '' ? answer : `${answer} (at "${where}")`);
	const answer = why(value);

	if (answer !== undefined) {
		return at(answer);
	}

	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	if (seen.has(value)) {
		return at('a value that refers back to itself');
	}

	// asked before the structure, because `JSON.stringify` asks it before the
	// structure: a value with a `toJSON` is written as whatever that answers, so
	// walking its own keys would refuse it for what it holds rather than for what
	// it says. `{ toJSON: () => 1 }` is a plain object and is still that statement
	if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		return undefined;
	}

	const list = Array.isArray(value);
	if (!list && !isPlainObject(value)) {
		return at(asEmpty(value));
	}

	seen.add(value);
	try {
		const entries: [string, unknown][] = list
			? value.map((it, i) => [`${i}`, it])
			: Object.entries(value);

		for (const [key, it] of entries) {
			const inner = look(it, where === '' ? key : `${where}.${key}`, seen);
			if (inner !== undefined) {
				return inner;
			}
		}
	} finally {
		seen.delete(value);
	}

	return undefined;
}
