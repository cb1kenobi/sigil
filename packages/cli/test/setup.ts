import { removeTempDirs } from './temp.js';
import { afterAll, afterEach } from 'vitest';

// a setup file runs before every test file, so this hook is registered on each
// of them and removes what that file made once it has finished
afterAll(removeTempDirs);

/** The hosts a test may reach, which are this machine's own. */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

// No test reaches the network, and this is what makes that a rule rather than a
// hope. A branch written for `sigil package` refusing a missing Bun went on
// passing once the refusal became a fetch -- 85 MB of Bun, compiled into a
// binary, on every CI job -- and the runner it starved timed out three tests
// that had nothing to do with it (SIG-303). Nothing said a download had
// happened, because a test that passes says nothing at all. A test that needs a
// response stubs `fetch`, as `runtimes-cache.test.ts` does; `vi.stubGlobal`
// hands this back afterwards, since this is what it found.
//
// Refusing the request is not enough on its own, and was measured not to be:
// the refusal is an error that mentions Bun, which is all that branch asked of
// its stderr, so the test went on passing -- faster. So the attempt is recorded
// and the test that made it fails afterwards, whatever it did with the error
const realFetch = globalThis.fetch;
const reached: string[] = [];
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK.has(url.hostname)) {
    reached.push(url.href);
    return Promise.reject(new Error(`A test reached for the network: ${url.href}`));
  }
  return realFetch(input, init);
}) as typeof fetch;

afterEach(() => {
  if (reached.length > 0) {
    throw new Error(
      `This test reached for the network: ${reached.splice(0).join(', ')}\n  Stub fetch, or skip the test where what it needs is not installed.`
    );
  }
});
