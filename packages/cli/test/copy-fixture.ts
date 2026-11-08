import { cpSync } from 'node:fs';
import { relative, sep } from 'node:path';

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
