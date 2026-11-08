// The fetch, in the one place both paths reach it.
//
// This module is used two ways and that is deliberate. `check()` **imports**
// it when the app is a single-file executable, because such an app has no
// separate runtime to spawn -- `process.execPath` is the app's own binary, so
// the ordinary path would re-execute the CLI. And `workerSource()` reads this
// file as **text** and pipes it into `node -` on every other path, which is
// what keeps the default check in a process that outlives the CLI.
//
// Being both is what stops there being two fetchers that come to disagree.
// It costs two rules, and neither is this module's invention:
//
// - It imports `node:` builtins and **types** and nothing else. A piped script
//   cannot resolve a relative import, so a value import of a sibling would
//   work in process and fail the moment it was spawned. An `import type` is
//   the exception, because it erases -- verified piped on both runtimes.
// - It is TypeScript piped into a runtime that strips types on its way in.
//   Every runtime this package supports does -- `engines` says node >=22.19.0
//   and stripping has been on by default since 22.18, and `bun -` reads it
//   natively -- which is the same guarantee that lets a command module be a
//   `.ts`. Verified on both for `import type`, top-level `await` and an
//   appended call.
//
// Nothing in here decides anything. Which URL, which headers and where the
// version sits in the answer are all the parent's, and the response is cached
// **verbatim**: what a worker works out for itself is what nothing else can
// check, and this one is now left with no judgement to make.

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * What the runtime is told, which is nothing but "read a module from stdin".
 *
 * `['--input-type', 'module']` is a spelling only node accepts: bun reads the
 * space-separated form as a script path and fails with
 * `Script not found "module"`, and `bun --input-type=module` with a script on
 * stdin prints its usage text instead -- so the default update check could not
 * run at all on one of the two runtimes this framework packages apps with. A
 * bare `-` reads a module from stdin on both, with imports, env, top-level
 * `await` and the inherited `cwd` all intact, measured on node 26.10 and bun
 * 1.4.4.
 *
 * It is a constant so that the test asserting the spelling and the call using
 * it cannot come apart, which a test grepping the source for a flag could not
 * promise -- the first one matched the comment explaining the flag.
 *
 * It lives here rather than beside `workerSource()` because it is half of
 * the protocol between the parent and this file, and because that module is
 * replaced whole by the build and can hold nothing but the text.
 */
export const WORKER_ARGV: readonly string[] = ['-'];

/**
 * The call appended to the source to make a module that exports into a script
 * that runs. The in-process path imports the same file, which is what stops
 * there being two fetchers; piped, this line is the whole of the entry point.
 */
export const WORKER_ENTRY = '\nawait main(process.env);\n';

/** What a cache file holds. */
export interface UpdateCache {
  /** The response, exactly as it came back. */
  body?: unknown;
  /** When it came back. */
  ts?: number;
}

/**
 * The most a response body may be, in bytes, before the fetch gives up on it.
 *
 * An npm dist-tags answer is a few hundred bytes and a GitHub release a few
 * hundred kilobytes with every asset listed, so this is generous for any
 * document a checker should be pointed at -- an abbreviated packument for a
 * package with thousands of versions still fits -- and it is a bound. Without
 * one, a registry that answers with an endless body grew a string until the
 * runtime ran out of memory, in a process nobody is watching.
 */
export const MAX_BODY_BYTES: number = 16 * 1024 * 1024;

/** What `fetchJSON()` is given. */
export interface FetchJSONOptions {
  /** Request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Inactivity timeout in milliseconds; `0` opts out. */
  readonly timeout: number;
  /**
   * Whether to let the process exit with the request still in flight.
   *
   * The in-process path's default. Spawned, the worker **is** the process and
   * unreffing its own socket would end the check it exists to perform.
   */
  readonly unref?: boolean;
  /** The URL to GET. */
  readonly url: string;
}

/**
 * GETs a URL and parses the answer as JSON.
 *
 * @param opts - The request.
 * @returns The parsed body.
 * @throws If the request fails, times out, answers more than `MAX_BODY_BYTES`,
 * or the answer is not JSON.
 */
export function fetchJSON(opts: FetchJSONOptions): Promise<unknown> {
  const { headers = {}, timeout, unref, url } = opts;

  // asked for rather than imported, so the parent can import this module
  // without loading tls; src/updates/AGENTS.md has the measurement. SIG-328
  const https = process.getBuiltinModule('node:https');

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      // kept as bytes and decoded once at the end, because a chunk boundary can
      // fall inside a multi-byte character and decoding each chunk on its own
      // would turn both halves into replacement characters
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      // a connection that drops part way through a body is the other way a
      // fetch never ends, and the timeout below does not cover it: the socket
      // is gone, so the inactivity timer went with it, while `end` never comes
      // because the response did not finish. Without this listener nothing
      // settles the promise and the worker waits forever -- measured, and it
      // is not an uncaught exception, which is why it reads as the process
      // simply never exiting
      res.on('error', reject);
      res.on('data', (chunk: Buffer) => {
        if (over) {
          return;
        }
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // rejected before the request is destroyed, so the reason is this
          // rather than whatever the torn-down socket reports after it
          over = true;
          chunks.length = 0;
          reject(new Error(`Update check response exceeded ${MAX_BODY_BYTES} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (over) {
          return;
        }
        try {
          if (res.statusCode && res.statusCode >= 400) {
            throw new Error(`Update check failed ${res.statusCode} ${res.statusMessage}`);
          }
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });

    // the socket is the handle that holds the event loop open, so this is what
    // makes an in-process check cost the run nothing -- and it is why the
    // in-process path can be best-effort at all. `fetch()` has no handle to
    // reach, which is the whole reason this is `node:https`
    if (unref) {
      req.on('socket', (socket) => socket.unref());
    }

    // `https.get()` has no timeout of its own, so a registry that accepts the
    // connection and then says nothing leaves this running forever -- and on
    // the default fire-and-forget path the parent has unreffed its own timer,
    // so nothing else is coming to end it. An inactivity timeout is the one
    // that covers a stall partway through a response as well as a first byte
    // that never arrives; destroying the request surfaces as the `error`
    // below. A timeout of `0` is the caller opting out, the same way the
    // parent skips its own timer
    if (timeout) {
      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Update check timed out after ${timeout}ms`));
      });
    }

    req.on('error', reject);
    req.end();
  });
}

/**
 * Writes a response into the cache file, keeping whatever else was in it.
 *
 * The directory is the caller's to create: a spawned worker cannot resolve a
 * relative import, so `mkdirOwnerSync()` is out of its reach and `check()`
 * makes the directory before it spawns.
 *
 * @param cacheFile - Where the cache lives.
 * @param body - The response, as it came back.
 */
export function cacheResponse(cacheFile: string, body: unknown): void {
  let cache: UpdateCache = {};
  try {
    const obj: unknown = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    if (obj && typeof obj === 'object') {
      cache = obj as UpdateCache;
    }
  } catch {}
  cache.ts = Date.now();
  cache.body = body;
  writeFileSync(cacheFile, JSON.stringify(cache));
}

/**
 * Reads the timeout out of the environment.
 *
 * @param raw - What the variable held.
 * @returns The timeout in milliseconds.
 * @throws If it is there and is not a number.
 */
export function readTimeout(raw: string | undefined): number {
  // an empty variable is read as unset, the way the parser reads one -- but
  // whitespace is not empty, and `Number(' ')` is `0`, which is the one value
  // that means "no timeout at all". A variable nobody meant to set must not be
  // the way the timeout gets switched off
  if (!raw) {
    return 5000;
  }
  const timeout = raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error(`Invalid REQUEST_TIMEOUT: "${raw}"`);
  }
  return timeout;
}

/**
 * What the spawned worker runs.
 *
 * `check()` appends a call to this after the source it pipes, which is why
 * this file has exports at all: imported, nothing runs; piped, the appended
 * line is the whole of the entry point.
 *
 * @param env - The environment the parent built.
 */
export async function main(env: Record<string, string | undefined>): Promise<void> {
  try {
    const { CACHE_FILE: cacheFile, CHECK_HEADERS: rawHeaders, CHECK_URL: url } = env;

    if (!url) {
      throw new Error('CHECK_URL is not set');
    }

    if (!url.startsWith('https:')) {
      throw new Error('CHECK_URL must use https');
    }

    const body = await fetchJSON({
      headers: rawHeaders ? (JSON.parse(rawHeaders) as Record<string, string>) : {},
      timeout: readTimeout(env.REQUEST_TIMEOUT),
      url,
    });

    if (cacheFile) {
      cacheResponse(cacheFile, body);
    }

    process.stdout.write(JSON.stringify(body));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
