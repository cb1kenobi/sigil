import { tempDir } from './temp.js';
import { cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `@ttylabs/sigil` in this workspace, which every linked fixture resolves to. */
const SIGIL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sigil');

/**
 * Copies a fixture app to `to`, leaving out every `node_modules` inside it.
 *
 * Every whole-tree copy of a fixture goes through this, and the filter is the
 * reason. A build writes its scratch directory under the app's own
 * `node_modules/.sigil/` and removes it when it finishes -- `WORK_DIR` in
 * `src/build/bundle.ts`, and `sigil package`'s staging directory beside it --
 * and other test files build the shared fixtures in place, from other workers,
 * at the same time. A copy that walks into `node_modules` can list one of those
 * directories and then find it gone, which is `ENOENT` from `cpSync` in a test
 * that passes every time it is run alone. SIG-331, and four copies in
 * `package-command.test.ts` had already been through it one at a time.
 *
 * Leaving it out costs nothing, because nothing a fixture commits is under a
 * `node_modules`: the root `.gitignore` excludes it at any depth and does not
 * re-include it, so all a copy could carry from one is another build's
 * leftovers. It is also what a test copying an app usually wants -- one copied
 * out of the workspace so that nothing resolves `@ttylabs/sigil` is the point
 * of `an import nothing can resolve`, and a `node_modules` brought along works
 * against that.
 *
 * A directory the filter refuses is not descended into, so a skipped
 * `node_modules` is never listed at all -- which is what closes the race,
 * rather than merely dropping what the race found. Matched as a path
 * **segment** relative to the fixture, so neither a checkout that happens to
 * sit under a `node_modules` nor a file whose name merely contains the word is
 * mistaken for one.
 *
 * @param from - The fixture's directory.
 * @param to - Where the copy goes; created if it does not exist.
 */
export function copyFixture(from: string, to: string): void {
  cpSync(from, to, {
    filter: (path) => !relative(from, path).split(sep).includes('node_modules'),
    recursive: true,
  });
}

/**
 * Copies a fixture app into a fresh temp directory and links `@ttylabs/sigil`
 * into it, so that the copy builds as the fixture does in place.
 *
 * A copy outside the workspace resolves nothing by walking up, which is the
 * point of a plain `copyFixture()` for a test about an import nothing can
 * resolve -- and is in the way of a test that wants to change what sits beside
 * the app (an earlier build's `dist/`, a broken module) without touching the
 * shared fixture other workers are building. A junction rather than a symlink,
 * because Windows creates one without privileges and it is the same thing to
 * node's resolver.
 *
 * @param from - The fixture's directory.
 * @param prefix - What the temp directory's name starts with.
 * @returns The copy's root, removed when the test file finishes.
 */
export function linkedFixture(from: string, prefix: string): string {
  const app = tempDir(prefix);
  copyFixture(from, app);

  const scope = join(app, 'node_modules', '@ttylabs');
  mkdirSync(scope, { recursive: true });
  symlinkSync(SIGIL, join(scope, 'sigil'), 'junction');

  return app;
}
