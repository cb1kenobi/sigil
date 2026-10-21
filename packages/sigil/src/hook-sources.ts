import { type AfterRunHook, type BeforeErrorHook, type ParseState, type Schema } from './types.js';

/**
 * Which sources declare a hook, in what order, and once each.
 *
 * The one mechanism `beforeError` and `afterRun` share, which is why it is a
 * module rather than a function in each of them: the two differ in what a
 * return value means and in what a throw does, and in nothing at all about
 * *whose* hook fires when. Two copies of this walk is how the command side and
 * the schema side come to disagree about ordering.
 */

/** The hooks this walk can collect, by name and by signature. */
interface Collectable {
  afterRun: AfterRunHook;
  beforeError: BeforeErrorHook;
}

/** Anything that can declare one: the schema, and every command in the chain. */
type HookSource = {
  hooks?: Partial<Collectable>;
};

/**
 * Collects the hooks of one name that apply to a run, innermost command first
 * and the schema last.
 *
 * Innermost first because that is the direction both of its callers travel: an
 * error leaves through each layer in turn, so each sees what the layer inside
 * it made of it, and a command's own cleanup runs before its parent's. The
 * schema is last either way, which is why it is where telemetry belongs -- it
 * is the only source that sees every command.
 *
 * **Nothing here may throw**, and that used to be a claim rather than a
 * property. One caller runs on the error path, where an exception would lose
 * the error being reported -- and `handleError()` calls it from inside
 * `main()`'s own `catch`, so a throw there does not reach a handler, it makes
 * `main()` **reject**, which is the one thing `main()` is documented not to do.
 * The other caller runs from what is effectively a `finally`, where a throw
 * would put a broken walk in front of the error the user needed.
 *
 * Two reads were outside the guard and both are reachable from a command's own
 * `run()`, which is handed the state: spreading `state.contexts` after
 * `state.contexts = 42`, and reading `state.schema` after somebody redefined it
 * as a throwing getter. Measured on both, and in both directions -- the same two
 * inputs make `main()` reject through `beforeError` alone, with nothing
 * rendered, which it has done since `collectHooks()` was written. Sharing one
 * walk is what makes one fix answer for both.
 *
 * A value that is not a function is **ignored** rather than rejected, and that
 * is the one rule a reader has to be told rather than shown. A hook is checked
 * where it is *declared*: `initCommand()` refuses a non-function on a command
 * and `parse()` refuses one on the schema, which between them cover every hook
 * an app writes down. A value assigned **later** -- by a `parse` hook, by a
 * `run()`, by another hook -- is past every check this framework has, so it is
 * skipped here rather than confessed. One rule for every hook there is, rather
 * than a fourth confession in the one walk that could not have prevented it
 * anyway.
 *
 * @param name - Which hook to collect.
 * @param state - The parse state, when parsing got far enough to produce one.
 * @param schema - The schema, for errors thrown before there was a state. Left
 *   out where there is always a state, which is every caller but the error path.
 * @returns The hooks to fire, in order, each one only once.
 */
export function collectHooks<K extends keyof Collectable>(
  name: K,
  state: ParseState | undefined,
  schema?: Schema | undefined
): Collectable[K][] {
  // the innermost context is an initialized command, the outermost is the
  // schema itself -- but as the copy `initCommand()` made of it, so the schema
  // is worth visiting again and a set of the hooks themselves, not of their
  // sources, is what keeps them from firing twice
  // two `try` blocks rather than one, because a wrecked `contexts` must not
  // cost the schema its hook -- which is what a single block round both reads
  // would do, and is pinned either way.
  //
  // Nothing filters what goes in. An `Array.isArray()` on the chain and a
  // `filter(Boolean)` over it were both written here and both deleted for
  // failing a sabotage: the per-source `try` below answers for every bad entry
  // there is, so a `contexts` of `42` throws out of the spread into this
  // `catch` and a `contexts` holding a `null` throws out of `source.hooks` into
  // that one. Two guards for one answer is one guard and a comment, which is
  // what this file does with the second
  const sources: HookSource[] = [];

  try {
    sources.push(...((state?.contexts ?? []) as HookSource[]));
  } catch {
    // a `contexts` that is not a chain has no chain to contribute
  }

  try {
    // there may be no schema at all, which is an error raised before anything
    // read one rather than anything hostile
    const root = (state?.schema ?? schema) as HookSource | undefined;
    if (root) {
      sources.push(root);
    }
  } catch {
    // nor has a `schema` that refuses to be read
  }

  const hooks = new Set<Collectable[K]>();

  for (const source of sources) {
    let hook: Collectable[K] | undefined;

    try {
      hook = source.hooks?.[name] as Collectable[K] | undefined;
    } catch {
      // a throwing getter has nothing to contribute
      continue;
    }

    if (typeof hook === 'function') {
      hooks.add(hook);
    }
  }

  return [...hooks];
}
