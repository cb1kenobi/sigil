import debug from './debug/index.js';
import { ErrorState, type BeforeErrorHook, type ParseState, type Schema } from './types.js';
import { safeLog } from './util/safe-log.js';

const { log } = debug('main2:error');

/**
 * Anything that can declare `beforeError` hooks: the schema, and every command
 * in the context chain.
 */
type HookSource = {
	hooks?: {
		beforeError?: BeforeErrorHook[];
	};
};

/**
 * Stashes the in-flight parse state on an error on its way out, so the error
 * path can still reach the matched command -- and with it the usage line worth
 * printing. Invisible to anything inspecting the error; see `ErrorState`.
 *
 * @param err - The thrown value.
 * @param state - The state that was in flight, if there was one.
 */
export function attachState(err: unknown, state: ParseState | undefined): void {
	if (!state || err === null || (typeof err !== 'object' && typeof err !== 'function')) {
		return;
	}

	try {
		Object.defineProperty(err, ErrorState, {
			configurable: true,
			enumerable: false,
			value: state,
			writable: true,
		});
	} catch {
		// a frozen error keeps its own counsel
	}
}

/**
 * Recovers the parse state `parse()` stashed on an error it threw.
 *
 * @param err - The thrown value.
 * @returns The state that was in flight, if there was one.
 */
export function stateFromError(err: unknown): ParseState | undefined {
	try {
		return (err as { [ErrorState]?: ParseState } | null | undefined)?.[ErrorState];
	} catch {
		return undefined;
	}
}

/**
 * Collects the `beforeError` hooks that apply to an error, innermost command
 * first and the schema last, so each layer sees what the layer inside it made
 * of the error -- the same direction the error itself travels.
 *
 * Nothing here may throw: it runs on the error path, and an exception would
 * lose the error being reported. A hook list that is not an array of
 * functions is ignored rather than rejected; `parse()` and `initCommand()`
 * already reject those when the schema is initialized.
 *
 * @param state - The parse state, when parsing got far enough to produce one.
 * @param schema - The schema, for errors thrown before there was a state.
 * @returns The hooks to fire, in order, each one only once.
 */
function collectHooks(
	state: ParseState | undefined,
	schema: Schema | undefined
): BeforeErrorHook[] {
	// the innermost context is an initialized command, the outermost is the
	// schema itself -- but as the proxy `initCommand()` wrapped it in, so the
	// schema is worth visiting again and a set of the hooks themselves, not of
	// their sources, is what keeps them from firing twice
	const sources: HookSource[] = [...(state?.contexts ?? []), state?.schema ?? schema].filter(
		(source) => !!source
	) as HookSource[];
	const hooks = new Set<BeforeErrorHook>();

	for (const source of sources) {
		let list: BeforeErrorHook[] | undefined;

		try {
			list = source.hooks?.beforeError;
		} catch {
			// a throwing getter has nothing to contribute
			continue;
		}

		if (Array.isArray(list)) {
			for (const hook of list) {
				if (typeof hook === 'function') {
					hooks.add(hook);
				}
			}
		}
	}

	return [...hooks];
}

/**
 * Fires the `beforeError` hooks for an error on its way out.
 *
 * A hook may observe the error, mutate it, or return a replacement -- it may
 * never suppress it. Returning `undefined` (which is what a hook that only
 * looks returns) keeps the current error; returning anything else makes that
 * value the error from there on, including for the hooks that follow. A hook
 * that throws is logged and skipped: the error already in flight is the one
 * the user needs, and a broken hook must not take its place.
 *
 * @param err - The thrown value.
 * @param state - The parse state, when parsing got far enough to produce one.
 * @param schema - The schema, for errors thrown before there was a state.
 * @returns The error to report, which is `err` unless a hook replaced it.
 */
export async function fireBeforeError(
	err: unknown,
	state: ParseState | undefined,
	schema?: Schema
): Promise<unknown> {
	let current = err;

	for (const hook of collectHooks(state, schema)) {
		let result: unknown;

		try {
			result = await hook(current, state);
		} catch (hookErr) {
			// `DEBUG=main2:error` is where a broken hook confesses
			safeLog(log, hookErr);
			continue;
		}

		if (result !== undefined && result !== current) {
			current = result;
			// the replacement has to carry the state too, otherwise swapping the
			// error out costs the renderer its usage line
			attachState(current, state);
		}
	}

	return current;
}
