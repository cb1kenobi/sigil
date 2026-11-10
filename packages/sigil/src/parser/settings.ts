import type { Schema, Settings } from '../types.js';

/**
 * Every key of `Settings`, which is what the merge is made over.
 *
 * Read with plain property access rather than by spreading or `Object.entries()`,
 * which see own enumerable keys only. Before `Schema.settings`, `main()` read
 * `opts.settings?.errorHandler` and `parse()` kept `opts.settings` itself as
 * `state.settings`, so a settings object with its values on a prototype -- a class
 * instance, `Object.create(defaults)` -- or behind a getter worked, and a merge that
 * could not see them would have quietly turned its settings off. Reading a fixed
 * list of keys is what keeps that true, and makes the one reader below the only
 * place that decides what a key's value is.
 *
 * A key outside the list is no longer carried onto `state.settings`: the object is a
 * new one, and nothing in this repository reads a key that is not in `Settings`. A
 * hook of an app's own that read one off `state.settings` would have to read it off
 * the object it passed.
 */
const SETTING_KEYS = [
  'allowExtraArguments',
  'allowUnexpectedArguments',
  'allowUnknownOptions',
  'assertCwd',
  'errorHandler',
  'helpExitCode',
  'suggestions',
] as const satisfies readonly (keyof Settings)[];

/** The keys of `Settings` that `SETTING_KEYS` leaves out. */
type Uncovered = Exclude<keyof Settings, (typeof SETTING_KEYS)[number]>;

/**
 * A compile error here means `Settings` gained a key and the list above did not,
 * which would leave that setting out of every merge. A type-level check, because
 * the list and the interface are two spellings of one fact.
 */
const COVERS_EVERY_SETTING: [Uncovered] extends [never] ? true : { uncovered: Uncovered } = true;
void COVERS_EVERY_SETTING;

/**
 * One setting off an object, the way every reader here asks.
 *
 * Plain property access, so a prototype or a getter answers as it always did, and
 * `undefined` for a source that is not an object -- which is the same answer as a
 * key it does not name.
 *
 * @param source - A settings object, or whatever was passed in its place.
 * @param key - The setting.
 * @returns Its value, which may be `undefined`.
 */
function read<K extends keyof Settings>(source: unknown, key: K): Settings[K] | undefined {
  return isObject(source) ? (source as Settings)[key] : undefined;
}

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
 * @throws If either is present and is not an object, or a getter of either throws.
 */
export function resolveSettings(schema: Schema | undefined, call?: Settings): Settings {
  const declared = schema?.settings;

  if (declared !== undefined && !isObject(declared)) {
    throw new TypeError('Expected schema settings to be an object');
  }

  if (call !== undefined && !isObject(call)) {
    throw new TypeError('Expected settings to be an object');
  }

  const merged: Record<string, unknown> = {};

  for (const key of SETTING_KEYS) {
    const named = read(call, key);
    const value = named !== undefined ? named : read(declared, key);

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

/**
 * The error handler to use when the settings could not be merged.
 *
 * `resolveSettings()` throws when either half is not an object, or a getter on
 * either half threw (`get settings()` on the schema, a throwing key inside it, or a
 * throwing key on the call) -- and the half that is fine still has an opinion. Order: the
 * call's own handler, if its settings is an object and names one; then the
 * schema's, if its `settings` is an object; then `undefined`, which is the built-in.
 * Each is read in its own `try`, because this runs on the error path where a
 * second error hiding the first is the only thing worse than a bad schema.
 *
 * Either bad half used to discard the other's handler: a bad schema dropped the
 * call's, and a bad call (`settings: null`, now refused) dropped the schema's, so an
 * app declaring `errorHandler: false` on its schema had its error rendered by the
 * built-in instead of rethrown.
 *
 * @param schema - The schema.
 * @param call - The settings the caller passed.
 * @returns The handler setting, or `undefined` for the built-in.
 */
export function salvagedErrorHandler(
  schema: Schema | undefined,
  call?: Settings
): Settings['errorHandler'] {
  try {
    const handler = read(call, 'errorHandler');
    if (handler !== undefined) {
      return handler;
    }
  } catch {
    // an unreadable call handler is not a reason to ignore the schema's
  }

  try {
    return read(schema?.settings, 'errorHandler');
  } catch {
    // the built-in handler reports the original error
  }

  return undefined;
}
