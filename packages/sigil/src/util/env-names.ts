/**
 * Reads a declaration's `env` -- one variable name or a list of them -- as the
 * set of names to look up.
 *
 * Shared by `initOption()` and `initArg()`, which read `env` the same way and
 * used to say so twice: a string is one name, a list is several, and an entry
 * that is not a non-empty string is skipped rather than refused, so a list built
 * from something optional can carry a hole.
 *
 * @param env - The declared `env`.
 * @param what - What declared it, as it reads in the error: `option` or
 * `argument`.
 * @returns The names, in the order they were declared.
 */
export function envNames(env: unknown, what: 'argument' | 'option'): Set<string> {
  const envs = new Set<string>();

  if (env !== undefined) {
    const list = typeof env === 'string' ? [env] : env;

    if (!Array.isArray(list)) {
      throw new TypeError(
        `Expected ${what} environment variable to be a string or array of strings`
      );
    }

    for (const e of list) {
      if (e && typeof e === 'string') {
        envs.add(e);
      }
    }
  }

  return envs;
}
