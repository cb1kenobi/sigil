// The worker, as a string, however this module was reached.
//
// `worker.ts` is piped into a runtime rather than imported on the spawned
// path -- that is what keeps the worker a script nothing can stub or call one
// function out of -- and a file nothing imports is a file no bundler can see.
// So a built app read it off a path relative to `import.meta.url`, which
// points wherever the bundle was written, and every app `sigil build`
// produced died on `ENOENT` the first time it checked for an update, with the
// build having reported complete success.
//
// The fix is that `tsdown.config.ts` replaces this module wholesale with the
// worker baked in as a string literal, so what ships carries no read at all.
// From source there is nothing to replace it and the file is right there,
// which is what keeps the worker an ordinary lintable, type-checked module
// rather than a template literal somebody has to escape by hand -- and what
// keeps the two paths piping the same bytes. `test/dist.test.ts` is what
// stops the replacement quietly stopping: a build that forgets it looks
// exactly like one that did it, right up until an app checks for an update.

// Nothing else belongs in this module: the build replaces it whole, so an
// export added here would exist from source and vanish once bundled. The
// plugin refuses a second export rather than leaving that to a comment.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * The worker script.
 *
 * @returns The source, read once.
 */
export function workerSource(): string {
  cached ??= readFileSync(fileURLToPath(new URL('./worker.ts', import.meta.url)), 'utf-8');
  return cached;
}
