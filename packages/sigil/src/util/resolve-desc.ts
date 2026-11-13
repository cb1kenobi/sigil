/**
 * Resolving a description that may have been written as a thunk.
 *
 * One function because there are three callers -- `initCommand()`,
 * `initOption()` and `initArg()` -- and three readings of "a description may be
 * a function" is three answers to one question, which is the rule
 * `readRoutes()` already records for the two route walks. See {@link DescThunk}
 * for why the thunk exists at all.
 */

/**
 * The description a declaration meant.
 *
 * @param desc - What the declaration said: a string, a thunk, or nothing.
 * @param what - What is being described, for the message.
 * @returns The description, or nothing.
 * @throws If it is neither a string nor a function, or a function answers
 *   something that is not a string.
 */
export function resolveDesc(desc: unknown, what: string): string | undefined {
  if (desc === undefined || typeof desc === 'string') {
    return desc;
  }

  if (typeof desc !== 'function') {
    throw new TypeError(descTypeMessage(what));
  }

  const text: unknown = (desc as () => unknown)();

  // checked rather than passed on, because a description is *measured* and
  // *wrapped*: a non-string one reaches `stringWidth()` several layers from the
  // mistake, which is what `desc: () => 42` did before this -- `r.split is not a
  // function`, out of the wrapper, naming nothing. `Schema.version` is lenient
  // about the same shape and is entitled to be, since what it answers is
  // interpolated into a string and coerces
  if (typeof text !== 'string') {
    throw new TypeError(descReturnMessage(what));
  }

  return text;
}

/**
 * What a description that is neither a string nor a function is refused with.
 *
 * Exported, through `@ttylabs/sigil/routes`, because `sigil build` refuses the
 * same placeholder from source and has to say it in these words (SIG-421).
 *
 * @param what - What is being described, as `resolveDesc()` takes it.
 * @returns The message.
 */
export function descTypeMessage(what: string): string {
  return `Expected desc for ${what} to be a string or a function`;
}

/**
 * What a description thunk that answers something other than a string is
 * refused with -- a number, or the promise an `async` one always answers.
 *
 * @param what - What is being described, as `resolveDesc()` takes it.
 * @returns The message.
 */
export function descReturnMessage(what: string): string {
  return `Expected desc for ${what} to return a string`;
}
