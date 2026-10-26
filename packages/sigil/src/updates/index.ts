import debug from '../debug/index.js';
import { mkdirOwnerSync } from '../util/mkdir-owner-sync.js';
import { npmChecker, versionFrom, type UpdateChecker } from './checker.js';
import { bakedConfig, compiledHost } from './host.js';
import { cacheFileName } from './registry.js';
import { workerSource } from './worker-source.js';
import { cacheResponse, fetchJSON, WORKER_ARGV, WORKER_ENTRY, type UpdateCache } from './worker.js';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const { log } = debug('sigil:updates');
const oneDay = 86400000;

export type { GithubCheckerOptions, NpmCheckerOptions, UpdateChecker } from './checker.js';
export { githubChecker, npmChecker, versionFrom } from './checker.js';
export type { BakedUpdateConfig } from './host.js';

export interface CheckOptions {
  cacheDir?: string;
  checkInterval?: number;
  /**
   * Where to look, and how to read the answer.
   *
   * Beats anything the build baked in, because this is the app saying so in
   * its own source. Left out, a build's `updateCheck` decides; with neither,
   * an app that is not a compiled binary asks npm about `packageName` and a
   * compiled one does not check at all.
   */
  checker?: UpdateChecker;
  distTag?: string;
  force?: boolean;
  /**
   * Whether an in-process check may hold the process open until it settles.
   *
   * Only the compiled path has one. A spawned worker outlives the CLI by
   * construction, which is the whole reason the default path spawns; an
   * executable has no runtime to spawn, so its check runs here and its socket
   * is unreffed -- it costs the run nothing and completes only if the app
   * outlives it, which a fast CLI will not. This is how to say "wait for it
   * rather than lose it", and it costs up to `timeout` on the one run per
   * `checkInterval` where the check actually fires.
   */
  linger?: boolean;
  notifyInterval?: number;
  packageName: string;
  packageVersion: string;
  registryURL?: string;
  timeout?: number;
  wait?: boolean;
}

export async function check(
  opts: CheckOptions
): Promise<{ current: string; latest: string | undefined }> {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('Update check options must be an object');
  }

  const {
    cacheDir,
    checkInterval = oneDay,
    distTag = 'latest',
    force = false,
    linger = false,
    packageName,
    packageVersion,
    timeout = 5000,
    wait = false,
  } = opts;

  if (!packageName || typeof packageName !== 'string') {
    throw new TypeError('Update check package name must be a non-empty string');
  }

  if (!packageVersion || typeof packageVersion !== 'string') {
    throw new TypeError('Update check package version must be a non-empty string');
  }

  if (!distTag || typeof distTag !== 'string') {
    throw new TypeError('Update check dist tag must be a non-empty string');
  }

  const compiled = await compiledHost();
  const checker = resolveChecker(opts, compiled, distTag);

  if (!checker) {
    // An executable that was never told what to check does not check, and
    // that is the whole of the compiled default. npm is the right answer for
    // a package somebody installs and a guess for a binary somebody
    // downloaded, which may well not be published anywhere -- so it is the
    // app's to declare, through `updateCheck` in `sigil.json` or through the
    // `checker` option, rather than ours to assume.
    log(
      compiled
        ? 'Compiled app with no update checker declared; skipping the check'
        : 'Update check disabled'
    );
    return { current: packageVersion, latest: undefined };
  }

  const cacheFile = cacheDir ? join(cacheDir, cacheFileName(packageName, distTag)) : undefined;

  let cache: UpdateCache | undefined;
  if (cacheFile) {
    log(`Cache file: ${cacheFile}`);
    try {
      cache = JSON.parse(readFileSync(cacheFile, 'utf-8')) as UpdateCache;
    } catch {}
  }

  // A cache is stale when it is old **or when this checker cannot read a
  // version out of it**, which is one rule covering two cases that would
  // otherwise each be a day of answering `undefined` while looking current.
  //
  // A cache written by an older sigil is the first: that one held the
  // extracted `version` and this one holds the response the version is read
  // out of, so it has no `body` at all. The second is an app whose
  // `updateCheck` changed -- the cache file is keyed by package name and
  // dist tag, not by checker, so yesterday's npm dist-tags are sitting
  // where today's GitHub release should be and `versionFrom()` finds
  // nothing at `tag_name`.
  //
  // It refetches on every run where the answer carries no version, which is
  // the right way round: that is not a successful check, and treating it as
  // one is how a check comes to look like it is working.
  const fresh =
    cache?.ts !== undefined &&
    cache.ts + checkInterval >= Date.now() &&
    versionIn(cache, checker) !== undefined;

  if (force || !fresh) {
    // the directory is made here on both paths: a spawned worker cannot
    // resolve a relative import, so `mkdirOwnerSync()` is out of its reach
    if (cacheFile) {
      mkdirOwnerSync(dirname(cacheFile));
    }

    if (compiled) {
      cache = await checkInProcess({ cache, cacheFile, checker, linger, timeout, wait });
    } else {
      cache = await checkInWorker({ cache, cacheFile, checker, timeout, wait });
    }
  }

  // TODO: notifyInterval

  const latest = versionIn(cache, checker);

  log(`Current=${packageVersion} Latest=${latest} (${checker.type})`);

  return {
    current: packageVersion,
    latest,
  };
}

/**
 * The version a cache holds, as this checker reads it.
 *
 * @param cache - The cache, which may not be there.
 * @param checker - What this check is looking at.
 * @returns The version, or `undefined` where there is none to read.
 */
function versionIn(cache: UpdateCache | undefined, checker: UpdateChecker): string | undefined {
  return cache?.body === undefined ? undefined : versionFrom(cache.body, checker);
}

/**
 * Decides what this check looks at.
 *
 * Four answers in a fixed order, and the middle two are the ticket: the
 * option is the app saying so in code, the baked config is the app saying so
 * in `sigil.json`, npm is the default an installed app can have, and a
 * compiled app with nothing declared has none.
 *
 * @param opts - What the caller passed.
 * @param compiled - Whether this is a single-file executable.
 * @param distTag - The dist tag, defaulted.
 * @returns The checker, or `undefined` when nothing is to be checked.
 */
function resolveChecker(
  opts: CheckOptions,
  compiled: boolean,
  distTag: string
): UpdateChecker | undefined {
  if (opts.checker) {
    return opts.checker;
  }

  const baked = bakedConfig();
  if (baked && 'checker' in baked) {
    // `null` is the app declaring that it checks nothing, which is a
    // different answer from declaring nothing at all -- the second falls
    // through to the default below and the first must not
    return baked.checker ?? undefined;
  }

  if (compiled) {
    return undefined;
  }

  return npmChecker({
    distTag,
    packageName: opts.packageName,
    registryURL: opts.registryURL,
  });
}

/** What both check paths are handed. */
interface RunOptions {
  readonly cache: UpdateCache | undefined;
  readonly cacheFile: string | undefined;
  readonly checker: UpdateChecker;
  readonly timeout: number;
  readonly wait: boolean;
}

/**
 * Checks in a spawned worker, which is what every app that has a runtime does.
 *
 * @param opts - The cache, the checker and the timing.
 * @returns The cache, refreshed where this waited for it.
 */
async function checkInWorker(opts: RunOptions): Promise<UpdateCache | undefined> {
  const { cacheFile, checker, timeout, wait } = opts;
  let { cache } = opts;

  // The worker is a self-contained module, so drop NODE_OPTIONS rather than
  // inheriting loader flags (`--import tsx`, coverage hooks, and so on) that
  // are not installed for the spawned process.
  const { NODE_OPTIONS: _ignored, ...parentEnv } = process.env;
  const env = {
    ...parentEnv,
    CACHE_FILE: cacheFile,
    CHECK_HEADERS: JSON.stringify(checker.headers ?? {}),
    CHECK_URL: checker.url,
    REQUEST_TIMEOUT: String(timeout),
  };

  log(`Spawning update worker (${checker.type})...`);
  const worker = spawn(process.execPath, [...WORKER_ARGV], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker.stdin.write(workerSource() + WORKER_ENTRY);
  worker.stdin.end();

  let stdout = '';
  worker.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  let stderr = '';
  worker.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  const prom = new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    if (timeout) {
      timer = setTimeout(() => {
        worker.kill();
        reject(new Error('Update worker timed out'));
      }, timeout);

      // nothing waits on the worker unless `wait` is set, and a referenced
      // timer would hold the process open for the whole timeout after the
      // CLI has finished -- the point of the default path is that it costs
      // the run nothing
      if (!wait) {
        timer.unref();
      }
    }

    worker.on('close', (code) => {
      clearTimeout(timer);
      if (code) {
        reject(new Error(`Update worker error (code ${code})\n${stderr.trim()}`));
      } else {
        resolve();
      }
    });
  });

  if (wait) {
    await prom;
    log('Update worker finished successfully');
    if (cacheFile) {
      try {
        cache = JSON.parse(readFileSync(cacheFile, 'utf-8')) as UpdateCache;
      } catch {}
    } else {
      cache = { body: JSON.parse(stdout) as unknown, ts: Date.now() };
    }
    return cache;
  }

  // fire and forget. The worker writes the cache file itself, so the next
  // run reads what this one found and this one returns what it already had.
  //
  // `disconnect()` was never right: it closes an IPC channel, the worker is
  // spawned with three pipes and no `ipc`, and `ChildProcess.disconnect` is
  // not defined without one -- so every call on the default path threw
  // `worker.disconnect is not a function` and an ordinary update check
  // could not complete at all. What the path actually needs is to stop
  // holding the process open and to stop the unawaited promise from
  // surfacing as an unhandled rejection when the worker fails
  prom.catch((err: Error) => log(`Update worker failed: ${err.message}`));
  worker.unref();

  // the child's pipes are their own handles and hold the loop open on their
  // own, so unreffing the child is not enough. They are sockets and do have
  // `unref`, which the `Readable` they are typed as does not declare; the
  // optional call is what keeps this honest if that ever stops being true.
  // stdin is in the list because the comment above is about pipes and it is
  // one: it cannot cost the worker the script it is being fed, because an
  // unflushed write is a libuv request rather than a handle and `unref()`
  // does not touch those -- the parent stays alive for a write in flight
  // either way
  for (const stream of [worker.stdin, worker.stdout, worker.stderr]) {
    (stream as unknown as { unref?: () => void }).unref?.();
  }

  return cache;
}

/**
 * Checks here, which is what a single-file executable has to do.
 *
 * Inside an executable `process.execPath` is the app's own binary, so the
 * spawned path would re-run the CLI rather than a runtime. What that costs is
 * the one thing spawning bought: a worker outlives the CLI and this cannot,
 * so the default unreffs its socket and finishes only if the app does not
 * exit first. `linger` and `wait` are the two ways to say that is not good
 * enough, and they differ in where the waiting happens -- `wait` holds up
 * `check()` itself, `linger` only holds the process open at the end.
 *
 * @param opts - The cache, the checker and the timing.
 * @returns The cache, refreshed where this waited for it.
 */
async function checkInProcess(
  opts: RunOptions & { readonly linger: boolean }
): Promise<UpdateCache | undefined> {
  const { cacheFile, checker, linger, timeout, wait } = opts;

  log(`Checking in process (${checker.type})...`);
  const prom = fetchJSON({
    headers: checker.headers,
    timeout,
    unref: !wait && !linger,
    url: checker.url,
  }).then((body) => {
    if (cacheFile) {
      cacheResponse(cacheFile, body);
    }
    return body;
  });

  if (!wait) {
    // an unawaited rejection is an unhandled rejection, which on the path
    // whose whole promise is that it costs the run nothing would take the
    // process down over a registry being briefly unreachable
    prom.catch((err: Error) => log(`Update check failed: ${err.message}`));
    return opts.cache;
  }

  return { body: await prom, ts: Date.now() };
}
