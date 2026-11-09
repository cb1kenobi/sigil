import type { Schema, Settings } from '../types.js';

/**
 * The settings a parse runs under: the schema's, with the call's laid over them.
 *
 * Per key, with the call winning. A schema says what the app is and the call says
 * how this run was started, so a flag beats the file -- and a key the call did not
 * name falls through to the schema, which is what lets an app declare
 * `allowUnknownOptions: false` once and have a test, a nested `main()` or a
 * one-off run override only the setting it means to.
 *
 * Always a **new** object. `parse()` used to keep the object its caller passed, so
 * anything that wrote to `state.settings` wrote to the caller's, and a merge that
 * returned either source would hand that back. A value of `undefined` on the call
 * is a key not named rather than a key cleared, so `{ errorHandler: undefined }`
 * leaves the schema's in place instead of silently turning it off.
 *
 * This is the one place the two are combined. `main()` reads `assertCwd` and
 * `errorHandler` itself and `parse()` hands the rest to everything else, so
 * each of them asking for it separately is how the schema's settings would come
 * to reach three of the seven and not the others.
 *
 * @param schema - The schema, whose `settings` are the base.
 * @param call - The settings the caller of `main()` or `parse()` passed.
 * @returns The settings to use.
 * @throws If either is present and is not an object.
 */
export function resolveSettings(schema: Schema | undefined, call?: Settings): Settings {
  const declared = schema?.settings;

  if (declared !== undefined && !isObject(declared)) {
    throw new TypeError('Expected schema settings to be an object');
  }

  if (call !== undefined && !isObject(call)) {
    throw new TypeError('Expected settings to be an object');
  }

  const merged: Record<string, unknown> = { ...declared };

  for (const [key, value] of Object.entries(call ?? {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged as Settings;
}

/** Whether a value is a non-null, non-array object. */
function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
