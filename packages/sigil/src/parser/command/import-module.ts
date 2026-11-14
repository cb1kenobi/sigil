import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How the parser imports a module the app declared, and how a caller replaces
 * that for one `main()`.
 *
 * Node's own `import()` is the default and the right answer for every run a
 * user starts. The one caller that needs another is a test: under vitest,
 * `runCommand()` routes to a command module through this `import()`, which is
 * node's, so a command that imports a `.tsx` component fails with `Unknown file
 * extension ".tsx"` -- node strips types and does not compile JSX. An
 * `importModule` written in the test file, `(url) => import(url)`, is vite's
 * import instead, and vite compiles it (SIG-431).
 *
 * **Per call, through async context, rather than a parameter.** A module the app
 * declared is imported from two places -- `loadCommand()` for a command's `path`
 * and a routed directory's modules, and `initCommand()` for a package's entry,
 * which happens while the schema is being built -- and those are reached from
 * the parse, from help, from the `:` topic walk and from completion, each
 * through its own chain of calls. A parameter would have to run down every one
 * of them, and the one it missed would silently use node's import, which is the
 * failure this exists to remove. `main()` opens a slot for its call and fills
 * it, so every import made on the call's behalf reads the same answer and two
 * calls at once each read their own. A **fresh** slot per `main()`: a nested
 * `main()` that was not given an importer uses node's, rather than inheriting
 * the outer call's, which is the rule `settings` already follows.
 */

/** A replacement for `import()`, handed the module's `file:` URL. */
export type ModuleImporter = (url: string) => Promise<unknown>;

/** The importer one `main()` call was given, if any. */
interface Slot {
  importer?: ModuleImporter;
}

const slots = new AsyncLocalStorage<Slot>();

/**
 * Imports a module the app declared.
 *
 * Handed a `file:` URL rather than a path, which is what node's own `import()`
 * needs -- a Windows path starts with a drive letter, which the ESM loader reads
 * as a scheme -- and so it is what a replacement is handed too: the ordinary
 * replacement is `(url) => import(url)`, and vite takes the URL as it is.
 *
 * @param url - The module's `file:` URL.
 * @returns The module namespace, or whatever the caller's importer resolved
 *   with.
 */
export function importModule(url: string): Promise<unknown> {
  const importer = slots.getStore()?.importer;
  return importer ? importer(url) : import(url);
}

/**
 * Runs one `main()` call in a slot of its own, empty until it is filled.
 *
 * @param body - The call.
 * @returns What the call resolved with.
 */
export function withModuleImports<T>(body: () => Promise<T>): Promise<T> {
  return slots.run({}, body);
}

/**
 * Fills the current call's slot with the importer it was given.
 *
 * Separate from opening the slot so that the read happens inside `main()`'s
 * error path: a value that is not a function is refused there, through the
 * `beforeError` hooks like any other bad option.
 *
 * @param importer - What the caller passed as `importModule`.
 * @throws If it is neither `undefined` nor a function.
 */
export function useModuleImporter(importer: unknown): void {
  if (importer === undefined) {
    return;
  }
  if (typeof importer !== 'function') {
    throw new TypeError('Expected importModule to be a function');
  }
  const slot = slots.getStore();
  if (slot) {
    slot.importer = importer as ModuleImporter;
  }
}
