/**
 * What a thrown value says about itself, as one line of text.
 *
 * A leaf module so that anything may ask it -- the signals graph reports an
 * effect that threw, and that layer may not import the error handler -- while
 * `@ttylabs/sigil/error-handler` is where it is published. The registry maps
 * this file to that subpath, so an ejected component imports it from there.
 */

/**
 * What is said when the thrown value has nothing to say for itself.
 */
const fallbackMessage = 'Unknown error';

/**
 * Reads a string property without letting a throwing getter escape.
 *
 * @param obj - The object to read from.
 * @param key - The property to read.
 * @returns The value, when it is a non-empty string.
 */
export function readString(obj: object, key: 'message' | 'name'): string | undefined {
  try {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Coerces anything to a string without throwing. A null-prototype object has
 * no `toString`, and a `toString` of someone else's making can throw.
 *
 * @param value - The value to coerce.
 * @returns The coerced string, or the fallback message.
 */
function stringify(value: unknown): string {
  try {
    return String(value) || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

/**
 * Extracts a user-facing message from anything that can be thrown.
 *
 * Parser errors are plain `Error`s whose messages are written for the person
 * running the CLI, so the message is all that is wanted. Everything else --
 * a thrown string, a plain object, `null` -- still has to render as something
 * rather than crash the code that is reporting it, which is what the inline
 * `err instanceof Error ? err.message : String(err)` did for an object with no
 * prototype: `String(Object.create(null))` is a `TypeError`, thrown from
 * inside the `catch` that was handling the first one.
 *
 * @param err - The thrown value.
 * @returns A single-line-ish message, never empty.
 */
export function errorMessage(err: unknown): string {
  if (typeof err === 'string') {
    return err || fallbackMessage;
  }

  if (err === null || err === undefined) {
    return fallbackMessage;
  }

  if (typeof err === 'object') {
    // `message` first, then `name` for an error thrown with neither a
    // message nor a subclass of its own
    return readString(err, 'message') ?? readString(err, 'name') ?? stringify(err);
  }

  return stringify(err);
}
