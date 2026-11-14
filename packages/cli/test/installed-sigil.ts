import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** `@ttylabs/sigil`'s package directory, as this package resolves it: the workspace. */
const sigil = dirname(require.resolve('@ttylabs/sigil/package.json'));

/**
 * Puts a copy of `@ttylabs/sigil` under a `node_modules`, the way an install
 * does: its `package.json` and every path its `files` names, which is what a
 * publish ships (SIG-431).
 *
 * A copy and not a link to the workspace, because where the runtime sits decides
 * who loads it. vitest transforms whatever does not resolve under a
 * `node_modules`, and a link to `packages/sigil` resolves to a path with none in
 * it -- so the whole runtime went through vite, and with it the `import()` that
 * `main()` reaches a command module through. vite's import compiles a `.tsx`
 * where node's refuses it, so a scaffold whose test failed once installed passed
 * here, for every JSX app launched from a command. Under a `node_modules` node
 * loads the runtime, as it does for a user, and the app's test about five times
 * faster besides, since nothing is transformed (SIG-426 measured 72 ms against 14).
 *
 * Shared by `new-tui.test.ts` and the guides' apps (`guides.ts`), and it imports
 * no vitest, because the website's capture script runs the guides with plain
 * `node`.
 *
 * @param nodeModules - The `node_modules` directory to install into.
 * @returns The package directory it wrote.
 */
export function installSigil(nodeModules: string): string {
  const target = join(nodeModules, '@ttylabs', 'sigil');
  const { files } = JSON.parse(readFileSync(join(sigil, 'package.json'), 'utf-8')) as {
    files: string[];
  };

  mkdirSync(target, { recursive: true });
  copyFileSync(join(sigil, 'package.json'), join(target, 'package.json'));
  for (const entry of files) {
    cpSync(join(sigil, entry), join(target, entry), { recursive: true });
  }
  return target;
}
