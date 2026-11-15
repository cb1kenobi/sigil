/**
 * Finding, listing and fetching the runtime a binary will embed.
 *
 * `sigil package` embeds a runtime, and which **version** it embeds is the app's
 * to choose for the same reason the runtime itself is: the end user has nothing
 * installed, so the version is a decision about what the app may use and what it
 * is reproducible against rather than about anybody's machine.
 *
 * ## Node: run the target's own `--build-sea`
 *
 * The obvious design is the wrong one, and it was measured before this was
 * written. Node's SEA config has an `executable` field that names a base binary,
 * so the host's `--build-sea` can inject into some other `node` -- and it
 * **silently produces a broken binary** across a version boundary: a v25.5.0
 * base built by v26.10.0 answers nothing at all, `--version` included, and exits
 * **0**. The blob format moved between those two releases and the loader in the
 * base could not read what the host wrote.
 *
 * So the target's own `--build-sea` runs instead. Producer and consumer are then
 * the same binary, there is no cross-version blob question to get wrong, and a
 * Node released after this code was written works without it being taught
 * anything.
 *
 * What that costs is a floor. `--build-sea` arrived in **25.5**, and the two LTS
 * lines below it -- 24 and 22 -- can generate a blob and have no way to inject
 * it, which is what `postject` exists for: an npm package from the nodejs org,
 * abandoned at `1.0.0-alpha.6` since 2023, whose one known bug is in the
 * `process.dlopen()` path that embedded native bindings need. Taking it was
 * considered and declined; the floor is refused with a message that says so.
 *
 * ## Bun: the compiler and the runtime must be the same version
 *
 * `bun build --compile --target=bun-<platform>-<arch>-v<version>` downloads the
 * requested runtime, which looks like all that is needed and is not: the
 * **bundler** is still the `bun` on `PATH`, and a 1.4.4 bundler writing into a
 * 1.3.0 runtime produces a binary that prints Bun's usage text instead of the
 * app -- exit 0 at compile time and exit 0 at run time, with no warning at
 * either end.
 *
 * So a requested version is resolved to a `bun` **executable** of that version,
 * and that executable does the bundling. Bun keeps the runtimes it downloads at
 * `~/.bun/install/cache/bun-<platform>-<arch>-v<version>`, and a host-platform
 * one of those is an ordinary runnable `bun` -- so the cache Bun already fills
 * is the first place to look before fetching anything.
 */

import { NODE_BUILD_SEA, RUNTIMES, type Runtime, type Target } from './compile.ts';
import { isInside } from './discover.ts';
import { escapeControls } from '@ttylabs/sigil/error-handler';
import { cache } from '@ttylabs/sigil/paths';
import { isFreshStamp } from '@ttylabs/sigil/updates';
import { whichSync } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Where a fetched runtime is kept, under the XDG cache. */
const CACHE = 'sigil/runtimes';

/**
 * What a cached runtime's executable is called on this platform.
 *
 * The `.exe` matters and was missing: a fetched `node.exe` was renamed to
 * `node`, which on Windows is not an executable at all -- so the download
 * succeeded and nothing could be spawned from it. One function so the write and
 * the lookup cannot disagree, which is how the two would have drifted.
 *
 * @param runtime - Which runtime.
 * @returns The file name.
 */
function executable(runtime: Runtime): string {
  return process.platform === 'win32' ? `${runtime}.exe` : runtime;
}

/**
 * What a runtime version looks like, anchored at **both** ends.
 *
 * The version is not only compared: it names the directory a downloaded
 * runtime is renamed into and made executable in, `<cache>/<runtime>/<version>`.
 * This was written `/^\d+\.\d+\.\d+/` with no `$`, so a version had only to
 * *start* like one -- `node@26.12.1/../../../tmp/pwn` passed, and `join()`
 * normalises, so the binary landed wherever the tail pointed. The one string
 * reached that path from three places, `--runtime`, `package.runtime` in
 * `sigil.json`, and a registry's release listing, and only the first two were
 * checked at all.
 */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Whether a string is a `<major>.<minor>.<patch>` version and nothing else.
 *
 * The one test every source of a version goes through, so that what is typed
 * and what a registry lists cannot come to mean two different things.
 *
 * @param version - The candidate, without a leading `v`.
 * @returns Whether it is one.
 */
export function isVersion(version: unknown): version is string {
  return typeof version === 'string' && VERSION_RE.test(version);
}

/**
 * The directory a downloaded runtime of this version goes in.
 *
 * Both checks, and the second is not redundant with the first so much as the
 * guard that does not depend on it: the version is refused unless it is exactly
 * a version, and the directory it names is refused unless it is inside the
 * cache. A pattern is a claim about what a path can say; asking where the path
 * actually went is the claim about where the write lands, and it is the one
 * that survives the pattern being loosened by somebody who did not know what it
 * was for.
 *
 * Exported for the reason `undo()` is: reaching it through `resolve()` means a
 * download, and a test of a download is a test of the network.
 *
 * @param root - The runtime's cache directory.
 * @param runtime - Which runtime, for the message.
 * @param version - The version.
 * @returns The directory.
 * @throws If the version is not one, or names somewhere outside the cache.
 */
export function cacheDir(root: string, runtime: Runtime, version: string): string {
  if (!isVersion(version)) {
    throw new Error(
      `"${version}" is not a ${runtime} version, so there is nothing to download. Name one as <major>.<minor>.<patch>, for example ${example(runtime)}.`
    );
  }

  const into = join(root, version);

  if (!isInside(root, into)) {
    throw new Error(
      `Refusing to install ${runtime} ${version} at ${into}, which is outside the runtime cache ${root}.`
    );
  }

  return into;
}

/** A spec somebody could type, for a message. */
function example(runtime: Runtime): string {
  return runtime === 'bun' ? 'bun@1.3.14' : 'node@26.12.1';
}

/** Where Bun keeps the target runtimes it downloads for `--compile`. */
const BUN_CACHE = '.bun/install/cache';

/**
 * How long to wait for a **listing**, which blocks the picker.
 *
 * Short on purpose, and the number came from measuring the bad case rather than
 * from taste: with the registries black-holed this answers in **5015ms**, where
 * the OS connect timeout alone was 10.5s and a connection that established and
 * then stalled would have waited the download's two minutes. Somebody at a
 * terminal waiting ten seconds for a prompt assumes it has hung.
 *
 * The first measurement of that was **wrong** and is worth recording, because
 * the mistake is easy: timing the *process* said 10.5s both before and after,
 * which read as the timeout having no effect. The abort was working the whole
 * time -- an isolated probe threw at 2002ms for a 2000ms signal -- and what
 * takes 10.5s is the process *exiting*, because the dead socket keeps the event
 * loop alive after the promise has settled. Time the answer, not the exit.
 *
 * That lingering socket is a real if minor wart: offline, a run that consulted
 * a registry can sit for a few seconds after printing its summary. It is
 * bounded by this timeout, `fetch` gives no handle to close, and the window is
 * narrow -- nothing consults a registry unless the picker ran or a runtime had
 * to be resolved from one.
 *
 * Giving up is cheap here, which is what lets it be short: `latest()` answers
 * with an empty list and the picker falls back to what is local, which is
 * verified rather than assumed -- with both registries unreachable it still
 * offers every installed and cached version plus the two custom rows.
 */
const LIST_TIMEOUT = 5_000;

/**
 * How long to wait for a **download**, which is tens of megabytes.
 *
 * Long, because the alternative to waiting is failing a package that was going
 * to work. Nothing is blocked on it that the user did not ask for: a fetch only
 * happens once a runtime has been chosen, and it says so while it runs.
 */
const TIMEOUT = 120_000;

/**
 * How many version lines back the picker offers.
 *
 * Both registries list every line they ever published, and for Bun that reaches
 * `0.0.12`. A picker offering it would be offering a runtime from before Bun
 * could do any of this -- so the listing is capped, and a version older than the
 * cap is still reachable by typing it, where the failure is at least specific.
 *
 * Four, because that is what covers Bun's useful span: 1.4, 1.3 and 1.2 are
 * node-compat 26, 24 and 22, which is the range somebody choosing a runtime for
 * its Node behaviour is choosing between.
 */
const LINES = 4;

/** A runtime version that can be embedded, and where it was found. */
export interface Found {
  /** How it was found, which is what the picker shows. */
  readonly how: 'cache' | 'download' | 'path';
  /** The executable, when there is one locally. */
  readonly path?: string;
  /** The version, without a leading `v`. */
  readonly version: string;
}

/**
 * The version of the runtime on `PATH`, if there is one.
 *
 * Asked by spawning rather than read off `process.versions`, because the
 * question is about the executable a compile would use and for Bun that is
 * never this process. Node is spawned too, for one answer rather than two.
 *
 * @param runtime - Which runtime.
 * @returns What is installed, or `undefined`.
 */
export function installed(runtime: Runtime): Found | undefined {
  const at = whichSync(runtime);

  if (!at) {
    return undefined;
  }

  const run = spawnSync(at, ['--version'], { encoding: 'utf-8', timeout: TIMEOUT });

  if (run.status !== 0 || !run.stdout) {
    return undefined;
  }

  // node prints `v26.10.0` and bun prints `1.4.4`, so the `v` is stripped
  // rather than assumed either way
  const version = run.stdout.trim().replace(/^v/, '');

  return version ? { how: 'path', path: at, version } : undefined;
}

/**
 * Every version already on this machine, newest first.
 *
 * Three places, and the Bun one is the reason this is not just a directory
 * listing: Bun fills its own cache with the runtimes it downloads for
 * `--compile`, and a host-platform entry there is an ordinary runnable `bun`.
 * Finding it means a second request for the same version costs nothing.
 *
 * @param runtime - Which runtime.
 * @param target - What is being built, which decides which Bun cache entries
 *   are runnable here.
 * @returns What is available locally, newest first.
 */
export function local(runtime: Runtime, target: Target): Found[] {
  const found = new Map<string, Found>();
  const here = installed(runtime);

  if (here) {
    found.set(here.version, here);
  }

  const own = cache(CACHE, runtime);
  if (own && existsSync(own)) {
    for (const entry of readdirSync(own)) {
      const at = join(own, entry, executable(runtime));

      if (!found.has(entry) && existsSync(at)) {
        found.set(entry, { how: 'cache', path: at, version: entry });
      }
    }
  }

  if (runtime === 'bun') {
    for (const entry of bunCached(target)) {
      if (!found.has(entry.version)) {
        found.set(entry.version, entry);
      }
    }
  }

  return [...found.values()].sort((one, other) => compare(other.version, one.version));
}

/**
 * The host-runnable Bun runtimes in Bun's own download cache.
 *
 * Only the ones whose platform is the host's: a `bun-linux-x64-v1.3.0` sitting
 * there is a Linux binary this machine cannot run, so it is a runtime Bun will
 * use and not a bundler this can.
 *
 * @param target - What is being built, for its platform naming.
 * @returns What Bun has already fetched that runs here.
 */
function bunCached(target: Target): Found[] {
  const dir = join(homedir(), BUN_CACHE);

  if (!existsSync(dir)) {
    return [];
  }

  // the host's triple, which is not the target's: a bundler has to run here
  const host = bunTriple({ arch: process.arch === 'x64' ? 'x64' : 'arm64', platform: hostOs() });
  void target;

  const found: Found[] = [];
  for (const entry of readdirSync(dir)) {
    const at = join(dir, entry);
    const version = entry.startsWith(`${host}-v`) ? entry.slice(`${host}-v`.length) : undefined;

    if (version && existsSync(at)) {
      found.push({ how: 'cache', path: at, version });
    }
  }

  return found;
}

/** The host's platform in this module's own vocabulary. */
function hostOs(): Target['platform'] {
  return process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';
}

/**
 * Bun's own name for a platform and architecture.
 *
 * Bun says `aarch64` where everything else in this package says `arm64`, and
 * its cache entries and `--target` both use Bun's spelling -- so the
 * translation lives here rather than at each call.
 *
 * @param target - The target.
 * @returns Bun's triple, without a version.
 */
export function bunTriple(target: Target): string {
  const arch = target.arch === 'arm64' ? 'aarch64' : 'x64';

  return `bun-${target.platform}-${arch}`;
}

/**
 * Compares two dotted versions.
 *
 * Numerically per component rather than as strings, because `1.10.0` sorts
 * before `1.9.0` lexically and a picker that offered them in that order would
 * be offering the wrong latest.
 *
 * @param one - A version.
 * @param other - Another.
 * @returns Negative when `one` is older.
 */
export function compare(one: string, other: string): number {
  const a = one.split('.').map(Number);
  const b = other.split('.').map(Number);

  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    const diff = (a[at] ?? 0) - (b[at] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

/**
 * Whether a Node version can package itself.
 *
 * The floor is `--build-sea`, which arrived in 25.5. Below it a Node can write
 * the blob and has nothing to inject it with -- see this module's own comment
 * for why `postject` is not that thing.
 *
 * @param version - The version, without a leading `v`.
 * @returns Whether it can.
 */
export function canEmbed(version: string): boolean {
  const [major, minor] = NODE_BUILD_SEA;

  return compare(version, `${major}.${minor}.0`) >= 0;
}

/**
 * The newest release of each major line, newest first.
 *
 * Read from the registry each runtime actually publishes to rather than
 * hard-coded: a list written here is a list that is wrong by the next release,
 * and the picker's whole job is to say what is available now.
 *
 * Node's own `dist/index.json` carries the LTS codename, which is worth
 * surfacing -- "24.22.1 (Krypton)" answers a question somebody choosing a
 * runtime is usually asking. Bun has no such concept, so it has none.
 *
 * Bun's versions come from **npm** rather than from GitHub's releases API,
 * which is rate-limited unauthenticated and would fail in CI for no reason.
 * The `bun` package on npm mirrors the real release list exactly -- checked
 * against it -- and npm is a registry this toolchain already talks to.
 *
 * @param runtime - Which runtime.
 * @returns The newest of each line, newest first, or an empty list when the
 *   network could not be reached.
 */
export async function latest(runtime: Runtime): Promise<Release[]> {
  const fresh = cached(runtime, LISTING_TTL);

  if (fresh) {
    return fresh;
  }

  try {
    const releases = runtime === 'node' ? await latestNode() : await latestBun();

    remember(runtime, releases);

    return releases;
  } catch {
    // a listing nobody could fetch is not an error: a **stale** cache beats
    // nothing, because last week's version list is still mostly right and the
    // picker's job is to offer something. Falling all the way back to what is
    // local is the last resort, and an explicit `runtime@version` resolves
    // whatever happens. That includes a listing stamped in the future: its
    // clock was wrong, not its versions
    return cached(runtime) ?? [];
  }
}

/**
 * How long a version listing is reused before it is fetched again.
 *
 * A day, which is `src/updates/`'s own interval for its npm check and is
 * chosen for the same reason: a new release is interesting within a day and
 * never within a minute. Without it the picker hit **both** registries on
 * every interactive run, which is a request per prompt for a list that moves
 * every few weeks.
 *
 * It is deliberately not configurable. The thing a caller wants when it wants
 * a different answer is a *specific version*, which `runtime@version` gives
 * without consulting a listing at all.
 */
const LISTING_TTL = 86_400_000;

/** Where a runtime's cached listing lives. */
function listingFile(runtime: Runtime): string | undefined {
  const root = cache(CACHE);

  return root ? join(root, `${runtime}-versions.json`) : undefined;
}

/**
 * A listing from the cache, if it is fresh enough.
 *
 * `within` is a parameter rather than the constant so that the failure path can
 * leave it out and ask for one however old or far ahead its stamp is: a stale
 * listing is worth more than no listing when the network is gone, and that is
 * the same file read with a different question. Fresh is `isFreshStamp()`'s
 * rule, which is the update check's: a stamp more than a minute ahead of this
 * clock, or one that is not a finite number, is stale (SIG-420).
 *
 * @param runtime - Which runtime.
 * @param within - The oldest acceptable age in milliseconds, or `undefined`
 *   for a listing of any age. A `ts` that is not a finite number is refused
 *   either way, as a file this did not write.
 * @returns The releases, or `undefined`.
 */
function cached(runtime: Runtime, within?: number): Release[] | undefined {
  const at = listingFile(runtime);

  if (!at) {
    return undefined;
  }

  try {
    const held = JSON.parse(readFileSync(at, 'utf-8')) as {
      releases?: (Release | null)[];
      ts?: unknown;
    };

    // a stamp that is not a finite number is a file this did not write, which
    // is the same answer as an unreadable one, on either path
    if (!Number.isFinite(held.ts) || !Array.isArray(held.releases)) {
      return undefined;
    }

    // only "too old" used to be asked, so a listing stamped while the clock was
    // ahead stayed fresh until real time caught up with it, and a `ts` that is
    // a string of digits was concatenated rather than added to
    if (within !== undefined && !isFreshStamp(held.ts, within)) {
      return undefined;
    }

    // a file on disk is one more place a version comes from, so it is held to
    // the same rule as the registry it was copied out of
    return held.releases.filter((one): one is Release => isVersion(one?.version));
  } catch {
    // unreadable, absent, or not the shape this wrote: all the same answer,
    // which is to go and ask. A cache that throws is worse than no cache
    return undefined;
  }
}

/**
 * Writes a listing to the cache, and never fails over it.
 *
 * A listing that could not be saved costs a request next time and nothing
 * else, so it must not fail a package -- which is the rule the removals in
 * `compileAll()` and `signed()` already follow for the same reason.
 *
 * @param runtime - Which runtime.
 * @param releases - What the registry said.
 */
function remember(runtime: Runtime, releases: readonly Release[]): void {
  const at = listingFile(runtime);

  if (!at) {
    return;
  }

  try {
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, `${JSON.stringify({ releases, ts: Date.now() })}\n`, 'utf-8');
  } catch {
    // see above
  }
}

/** One release a picker can offer. */
export interface Release {
  /** The LTS codename, where the runtime has such a thing. */
  readonly lts?: string;
  /** The major line, for grouping. */
  readonly major: number;
  /** The version, without a leading `v`. */
  readonly version: string;
}

/** The newest Node of each major line. */
async function latestNode(): Promise<Release[]> {
  const all = (await fetchJson('https://nodejs.org/dist/index.json')) as {
    lts: false | string;
    version: string;
  }[];

  const lines = new Map<number, Release>();
  for (const one of all) {
    const version = typeof one.version === 'string' ? one.version.replace(/^v/, '') : undefined;

    // a listing is a registry's data, and its version becomes a cache path the
    // moment somebody picks it -- so a row that is not a version is not offered,
    // and the line falls through to the next row that is
    if (!isVersion(version)) {
      continue;
    }

    const major = Number(version.split('.')[0]);

    // the list is newest first, so the first of each line is that line's newest
    if (!lines.has(major)) {
      lines.set(major, { major, version, ...(one.lts ? { lts: one.lts } : {}) });
    }
  }

  return [...lines.values()].sort((one, other) => other.major - one.major);
}

/** The newest Bun of each minor line, which is how Bun versions move. */
async function latestBun(): Promise<Release[]> {
  const meta = (await fetchJson('https://registry.npmjs.org/bun')) as {
    versions: Record<string, unknown>;
  };

  // Bun's major has been 1 throughout, so a per-major listing would be one
  // entry. The line that moves is the minor, which is what is grouped on --
  // and prereleases are dropped, because a picker should not offer one
  const lines = new Map<string, Release>();
  for (const version of Object.keys(meta.versions)) {
    // a prerelease has a `-` and is not a version by this rule, and neither is
    // anything else a registry might list that would make a path of itself
    if (!isVersion(version)) {
      continue;
    }

    const line = version.split('.').slice(0, 2).join('.');
    const held = lines.get(line);

    if (!held || compare(version, held.version) > 0) {
      lines.set(line, { major: Number(version.split('.')[0]), version });
    }
  }

  return [...lines.values()].sort((one, other) => compare(other.version, one.version));
}

/**
 * Reads JSON from a URL, with a deadline.
 *
 * `fetch` rather than `node:https`, which is what `src/updates/` uses: that one
 * is a string piped into a runtime with no module resolution, and this is the
 * toolchain, where the global is simply the shorter correct thing.
 *
 * @param url - What to read.
 * @returns The parsed body.
 * @throws If it could not be read in time.
 */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(LIST_TIMEOUT) });

  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }

  return response.json();
}

/**
 * Resolves a requested version to an executable, fetching it if need be.
 *
 * Local first, always: a version already on `PATH` or in either cache is the
 * one to use, because downloading a runtime somebody has is a slow way to get
 * the same answer. The exception is a runtime in **sigil's own** cache, which is
 * used only while it still matches the digest recorded when it was verified
 * (see `distrust()`); one that does not is discarded and fetched again.
 *
 * @param runtime - Which runtime.
 * @param version - The version, without a leading `v`.
 * @param target - What is being built.
 * @param onFetch - Called before a download starts, so the caller can say so.
 *   `discarded` is why a cached copy was removed first, when one was.
 * @returns The executable to use.
 * @throws If it is not available and could not be fetched.
 */
export async function resolve(
  runtime: Runtime,
  version: string,
  target: Target,
  onFetch?: (version: string, discarded?: string) => void
): Promise<string> {
  const here = local(runtime, target).find((one) => one.version === version);

  let discarded: string | undefined;

  if (here?.path) {
    discarded = isOwn(runtime, here.path) ? distrust(runtime, version, here.path) : undefined;

    if (discarded === undefined) {
      return here.path;
    }
  }

  onFetch?.(version, discarded);

  return download(runtime, version);
}

/**
 * Fetches a runtime into sigil's own cache and returns its executable.
 *
 * Extracted with `tar`, which is not a dependency on any platform this
 * supports: macOS and Linux ship it, and Windows 10 and newer ship bsdtar as
 * `tar.exe`. What it must **not** be handed is a `.zip` on Linux, where `tar`
 * is GNU tar and cannot read one -- which is why Bun comes from npm as a
 * `.tgz` rather than from GitHub as a `.zip`. Node's Windows archive is a zip,
 * and that is the one platform whose `tar` is bsdtar and reads it.
 *
 * The extraction goes to a sibling directory of its own, and what is verified
 * is **moved into place** -- the record, then the executable, as two renames --
 * so a download that dies half way leaves no directory that looks like a cached
 * runtime. Two builds fetching the same version race on those renames: each
 * rename is atomic, and the loser's record and executable are byte-identical to
 * the winner's -- both hashed the same verified archive -- and replace them. Where
 * a rename over a running executable is refused (Windows, while another build is
 * running that very file), the entry already there is used if `distrust()`
 * accepts it.
 *
 * A directory an interrupted run left behind is removed once it is an hour old
 * (`sweep()`), because Ctrl-C ends the process without running a `finally`. A
 * live download touches its directory far more often than that, so only one
 * suspended for an hour or more can lose its directory -- and it then fails
 * having cached nothing.
 *
 * Nothing is extracted until the archive has hashed to the digest its own origin
 * publishes (`originDigest()`), and what lands in the cache carries a record of
 * what it was verified as, which `distrust()` re-checks on every later use.
 *
 * @param runtime - Which runtime.
 * @param version - The version, without a leading `v`.
 * @returns The executable.
 * @throws If the download, the verification or the extraction failed.
 */
async function download(runtime: Runtime, version: string): Promise<string> {
  const root = cache(CACHE, runtime);

  if (!root) {
    throw new Error(
      `Cannot work out where to cache a runtime: no XDG cache directory, and ${runtime} ${version} is not installed.`
    );
  }

  const into = cacheDir(root, runtime, version);
  const binary = join(into, executable(runtime));

  // a directory nothing else has ever used. It was `.partial-<pid>`, which a
  // process killed mid-extraction leaves behind and a later one with the same
  // pid -- ordinary in a container over a persisted cache -- reuses without
  // emptying: `findBinary()` then picked a stale executable over the one from
  // the verified archive, and it was hashed into the record as verified. It
  // also had two `resolve()` calls in one process sharing one directory
  mkdirSync(root, { recursive: true });
  sweep(root);
  const partial = mkdtempSync(`${into}.partial-`);

  try {
    const url = downloadUrl(runtime, version);

    // the origin's own digest first, so a version it does not list costs a few
    // hundred bytes rather than an archive
    const expected = await originDigest(runtime, version, url);
    const archive = join(partial, runtime === 'node' ? 'node.tar.gz' : 'bun.tgz');
    const bytes = await get(runtime, version, url, 'bytes');

    // before the bytes are written, let alone extracted: `tar` parses what it is
    // handed, and nothing here has decided yet that it should
    const actual = createHash(expected.algorithm).update(bytes).digest('hex');
    if (actual !== expected.hex) {
      throw new Error(
        `Refusing ${runtime} ${version}: ${basename(url)} does not match the ${expected.algorithm} digest ${expected.source} publishes for it.\n  expected ${expected.algorithm}:${expected.hex}\n  got      ${expected.algorithm}:${actual}\n  Nothing was extracted or run, and nothing was cached. Try again; if this repeats, something between here and the origin is serving a different file.`
      );
    }

    writeFileSync(archive, bytes);

    const tar = spawnSync('tar', ['-xf', archive, '-C', partial], {
      encoding: 'utf-8',
      timeout: TIMEOUT,
    });

    if (tar.status !== 0) {
      throw new Error(
        `Could not extract ${runtime} ${version}: ${tar.stderr || tar.error?.message}`
      );
    }

    const candidates = findBinaries(partial, runtime);
    if (candidates.length === 0) {
      throw new Error(`Downloaded ${runtime} ${version} but found no ${runtime} executable in it.`);
    }

    // one, because the one that is hashed into the record is the one that runs,
    // and choosing among several is a choice nobody verified. Every real
    // archive has exactly one: node's `bin/node` or `node.exe`, bun's
    // `package/bin/bun`
    if (candidates.length > 1) {
      throw new Error(
        `Downloaded ${runtime} ${version} but its archive holds ${candidates.length} files named ${executable(runtime)}, so there is no telling which is the runtime. Nothing was cached.`
      );
    }

    const found = candidates[0]!;

    // the record goes down **before** the binary, because the binary's presence
    // is what makes a cache entry visible to `local()`: a binary with no record
    // is an entry `distrust()` discards, so a second build looking at the
    // directory between the two writes would throw away a download in progress
    mkdirSync(into, { recursive: true });
    const record: Record<string, string> = {
      archive: `${expected.algorithm}:${expected.hex}`,
      binary: `sha256:${hashFile(found)}`,
      file: basename(url),
      runtime,
      source: expected.source,
      version,
    };

    // written beside and renamed in rather than written in place: a write in
    // place truncates first, and a build reading the record in that window
    // would take a good entry for a bad one and remove it
    writeFileSync(join(partial, RECORD), `${JSON.stringify(record, null, 2)}\n`);
    renameSync(join(partial, RECORD), join(into, RECORD));

    try {
      renameSync(found, binary);
    } catch (error) {
      // Windows refuses to replace an executable another build is running. That
      // build put the same verified bytes there, so what is there is used if it
      // still answers to the record -- and its removal is attempted, and this
      // fails, if not
      if (existsSync(binary) && distrust(runtime, version, binary) === undefined) {
        return binary;
      }

      throw error;
    }

    chmodSync(binary, 0o755);

    return binary;
  } finally {
    rmSync(partial, { force: true, recursive: true });
  }
}

/** What a download is checked against, and who said so. */
interface Digest {
  /** The hash function the origin publishes the digest in. */
  readonly algorithm: 'sha256' | 'sha512';
  /** The digest, as lower case hex whatever the origin spelled it as. */
  readonly hex: string;
  /** The origin's document it came from, for the message. */
  readonly source: string;
}

/** The file beside a cached executable that says what it was verified as. */
const RECORD = 'sigil-verified.json';

/**
 * Fetches a URL a runtime is verified through, and refuses to follow a redirect.
 *
 * `redirect: 'error'` because neither host redirects for any of these URLs --
 * probed with `curl -sI` for Node's archive and `SHASUMS256.txt` and for npm's
 * tarball and version document, all `200` with no `Location` -- so a redirect
 * is not a thing that happens, and the place it would be an event is the place
 * that would hand the digest or the bytes to a host nobody named. A host that
 * starts redirecting fails loudly here, which is the right response to finding
 * out.
 *
 * @param runtime - Which runtime, for the message.
 * @param version - The version, for the message.
 * @param url - What to read.
 * @param as - How to return the body: `bytes` as a `Buffer`, `text` as a string,
 *   or `json` as the parsed value.
 * @returns The body, read in full, in the form `as` asked for.
 * @throws If it could not be fetched or read in time, did not answer `200`, or
 *   was asked for as `json` and is not.
 */
async function get(runtime: Runtime, version: string, url: string, as: 'bytes'): Promise<Buffer>;
async function get(runtime: Runtime, version: string, url: string, as: 'text'): Promise<string>;
async function get(runtime: Runtime, version: string, url: string, as: 'json'): Promise<unknown>;
async function get(
  runtime: Runtime,
  version: string,
  url: string,
  as: 'bytes' | 'json' | 'text'
): Promise<Buffer | string | unknown> {
  let response: Response;

  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) });
  } catch (error) {
    throw failed(runtime, version, url, error, 'could not be fetched');
  }

  if (!response.ok) {
    throw new Error(
      `Could not download ${runtime} ${version}: ${url} answered ${response.status}.\n  Check the version exists, and pin one that does with --runtime ${runtime}@<version>. "sigil package" at a terminal, with neither --runtime nor "package.runtime" in sigil.json, offers the newest of each line.`
    );
  }

  // read here, inside the same translation: the archive is tens of megabytes
  // and so the read most likely to fail, and a reset mid-body is a bare
  // `terminated` and a timeout one is `The operation was aborted`
  let body: Buffer | string;

  try {
    body = as === 'bytes' ? Buffer.from(await response.arrayBuffer()) : await response.text();
  } catch (error) {
    throw failed(runtime, version, url, error, 'was cut off while it was being read');
  }

  if (as !== 'json') {
    return body;
  }

  try {
    return JSON.parse(body as string) as unknown;
  } catch {
    throw new Error(
      `Could not download ${runtime} ${version}: ${url} did not answer with JSON, so there is nothing to check the download against. Something between here and the origin may be answering in its place, such as a sign-in page.\n  Nothing was downloaded, extracted or run.`
    );
  }
}

/**
 * The error for a request or a read that failed, saying why.
 *
 * undici reports every failure as `fetch failed` and keeps the reason in
 * `cause`, which nothing downstream renders. The reason is not always a
 * message: a refused connection on a host with both an IPv4 and an IPv6 address
 * is an `AggregateError` whose message is empty, with the answer in `code` and
 * `errors`. And it is text from the network, so it is escaped.
 *
 * @param runtime - Which runtime.
 * @param version - The version.
 * @param url - What was being read.
 * @param error - What was thrown.
 * @param what - What happened to the URL, as a clause for the sentence.
 * @returns The error to throw.
 */
function failed(
  runtime: Runtime,
  version: string,
  url: string,
  error: unknown,
  what: string
): Error {
  const why = (error instanceof Error && error.cause instanceof Error ? error.cause : error) as {
    code?: unknown;
    errors?: unknown;
    message?: unknown;
  };
  const inner = Array.isArray(why?.errors)
    ? why.errors
        .map((one: { message?: unknown }) => String(one?.message ?? one))
        .filter(Boolean)
        .join('; ')
    : '';
  const reason = escapeControls(
    String(
      (typeof why?.message === 'string' && why.message) ||
        (typeof why?.code === 'string' && why.code) ||
        inner ||
        String(why)
    )
  );

  // undici's own text, the same on node 22, 24 and 26; a host name that happens
  // to contain the word is not a redirect
  if (why?.message === 'unexpected redirect') {
    return new Error(
      `Refusing ${runtime} ${version}: ${url} answered with a redirect, which is not followed -- these origins serve these files directly, so a redirect means something between here and them is answering instead.\n  Nothing was downloaded, extracted or run.`,
      { cause: error }
    );
  }

  return new Error(
    `Could not download ${runtime} ${version}: ${url} ${what} (${reason}).\n  A runtime is verified against its origin when it is fetched, so a fetch needs the network; one already cached and verified does not. Check the connection and try again.`,
    { cause: error }
  );
}

/**
 * The digest the runtime's own origin publishes for the archive at `url`.
 *
 * Same origin as the archive, and that is the whole of what this can promise: a
 * CDN, a mirror or a proxy that serves a modified archive is caught, and a
 * compromise of the origin itself -- nodejs.org, or the npm registry -- is not,
 * because it can change the digest along with the file. No signature is
 * checked and no table of digests is shipped, so that any `--runtime
 * node@x.y.z` that exists keeps working.
 *
 * - **Node** publishes `SHASUMS256.txt` beside the release, one `sha256  name`
 *   line per file.
 * - **Bun** is downloaded as npm's `@oven/bun-<triple>` tarball (see
 *   `downloadUrl()`), so the digest is the `dist.integrity` of that version of
 *   that package -- sha512 in SRI form -- read from the registry's per-version
 *   document rather than the full packument, which is megabytes.
 *
 * @param runtime - Which runtime.
 * @param version - The version.
 * @param url - The archive's URL.
 * @returns What the archive has to hash to.
 * @throws If the document could not be read or says nothing usable about the file.
 */
async function originDigest(runtime: Runtime, version: string, url: string): Promise<Digest> {
  const file = basename(url);

  if (runtime === 'node') {
    const sums = `${url.slice(0, url.lastIndexOf('/'))}/SHASUMS256.txt`;
    const text = await get(runtime, version, sums, 'text');
    const found = new Set<string>();

    for (const line of text.split('\n')) {
      const match = /^([0-9a-fA-F]{64}) [ *](.+?)\s*$/.exec(line);

      if (match?.[2] === file) {
        found.add(match[1]!.toLowerCase());
      }
    }

    if (found.size !== 1) {
      throw new Error(
        `Refusing ${runtime} ${version}: ${sums} ${found.size ? `lists ${file} with ${found.size} different digests` : `has no line for ${file}`}, so there is nothing to check the download against.\n  Nothing was downloaded, extracted or run.`
      );
    }

    return { algorithm: 'sha256', hex: [...found][0]!, source: sums };
  }

  const triple = url.slice(url.indexOf('/@oven/') + 7).split('/')[0]!;
  const doc = `https://registry.npmjs.org/@oven%2f${triple}/${version}`;
  const meta = (await get(runtime, version, doc, 'json')) as {
    dist?: { integrity?: unknown };
  } | null;
  const integrity = typeof meta?.dist?.integrity === 'string' ? meta.dist.integrity : '';
  const sri = integrity
    .split(/\s+/)
    .map((one) => /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(one)?.[1])
    .find((one) => one !== undefined);

  const hex = sri === undefined ? '' : Buffer.from(sri, 'base64').toString('hex');
  if (hex.length !== 128) {
    throw new Error(
      `Refusing ${runtime} ${version}: ${doc} publishes no sha512 integrity for ${file}, so there is nothing to check the download against.\n  Nothing was downloaded, extracted or run.`
    );
  }

  return { algorithm: 'sha512', hex, source: doc };
}

/** The sha256 of a file, as hex. */
function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Whether an executable is under sigil's own runtime cache, as opposed to `PATH` or Bun's. */
function isOwn(runtime: Runtime, path: string): boolean {
  const root = cache(CACHE, runtime);

  return root !== undefined && isInside(root, path);
}

/**
 * Whether a runtime in sigil's cache is still the one that was verified, and if
 * it is not, why -- having removed it.
 *
 * A cached runtime is the thing every binary built afterwards embeds, so it is
 * not trusted for being there. It is re-hashed on every use against the sha256
 * of the executable that was written beside it when the archive passed
 * `originDigest()`. A missing or unreadable record, or a digest that does not
 * match, discards the whole entry, and the caller fetches again -- which is also
 * what happens, once, to an entry written before this existed.
 *
 * The limit, stated rather than implied: the record is not signed, and it lives
 * in the directory it protects. It catches a binary that changed under it -- a
 * corrupted write, another tool, a swap that did not know to touch the record --
 * and **not** anyone who can write that directory, who can write the record
 * too. That is the same trust the user's own cache directory already carries.
 *
 * @param runtime - Which runtime.
 * @param version - The version.
 * @param path - The cached executable.
 * @returns `undefined` when it may be used; otherwise what was wrong with it,
 *   as a clause for a sentence. It has been removed in that case.
 */
function distrust(runtime: Runtime, version: string, path: string): string | undefined {
  let why = 'has no verification record';

  try {
    let text: string | undefined;

    try {
      text = readFileSync(join(dirname(path), RECORD), 'utf-8');
    } catch (error) {
      // absent is `has no record`; present and unreadable is a different thing
      // to be told
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        why = 'has no readable verification record';
      }
    }

    if (text !== undefined) {
      why = 'has no readable verification record';

      const record = JSON.parse(text) as {
        binary?: unknown;
        runtime?: unknown;
        version?: unknown;
      } | null;

      if (record !== null && typeof record === 'object') {
        why = 'no longer matches its verification record';

        if (
          record.runtime === runtime &&
          record.version === version &&
          record.binary === `sha256:${hashFile(path)}`
        ) {
          return undefined;
        }
      }
    }
  } catch {
    // a record that does not parse, or an executable that cannot be read: `why`
    // says which of them it was as far as it can be known
  }

  rmSync(dirname(path), { force: true, recursive: true });

  return why;
}

/**
 * What `sigil package` says before it fetches a runtime.
 *
 * Where the fetch follows removing a cached copy that failed its check, it says
 * that rather than "not on this machine", which is untrue of it and leaves the
 * next question -- where did it go -- unanswered.
 *
 * @param runtime - Which runtime.
 * @param version - The version.
 * @param discarded - Why a cached copy was removed first, when one was.
 * @returns The line.
 */
export function fetchNote(runtime: Runtime, version: string, discarded?: string): string {
  return discarded
    ? `The cached ${runtime} ${version} ${discarded}, so it was removed. Fetching it again...`
    : `Fetching ${runtime} ${version}, which is not on this machine...`;
}

/** How old a `.partial-*` directory must be before it is taken for an interrupted run's. */
const STALE_PARTIAL = 60 * 60 * 1000;

/**
 * Removes the scratch directories interrupted runs left in a runtime's cache.
 *
 * Ctrl-C ends node without running a `finally`, and every run has a directory
 * of its own now, so each interrupted one left one for good -- up to a few
 * hundred megabytes of a half-extracted runtime. A live download touches its
 * directory at least every few minutes, since each step is capped by `TIMEOUT`,
 * so only a process suspended for an hour or more -- Ctrl-Z, a sleeping laptop --
 * or a cache on a network file system with a skewed clock can lose its directory;
 * it then fails with `ENOENT` and caches nothing, which is safe. Best effort and
 * silent, and **per entry**: one that cannot be examined or removed, a dangling
 * symlink or a directory that cannot be deleted, must not stop the rest being
 * tidied.
 *
 * @param root - The runtime's cache directory.
 */
function sweep(root: string): void {
  let entries: string[];

  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    try {
      const at = join(root, entry);

      if (
        /^\d+\.\d+\.\d+\.partial-/.test(entry) &&
        Date.now() - statSync(at).mtimeMs > STALE_PARTIAL
      ) {
        rmSync(at, { force: true, recursive: true });
      }
    } catch {
      // tidying is not the job
    }
  }
}

/** Where a runtime of this version is published. */
function downloadUrl(runtime: Runtime, version: string): string {
  const platform = hostOs();
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';

  if (runtime === 'node') {
    const os = platform === 'windows' ? 'win' : platform;
    const ext = platform === 'windows' ? 'zip' : 'tar.gz';

    return `https://nodejs.org/dist/v${version}/node-v${version}-${os}-${arch}.${ext}`;
  }

  // npm rather than GitHub's releases, and the reason is `tar`. Bun publishes a
  // `.zip` on GitHub, and `tar -xf` reads one only where `tar` is **bsdtar** --
  // macOS and Windows. Linux ships GNU tar, which cannot read a zip at all, so
  // the download failed there with `This does not look like a tar archive`:
  // every ubuntu job, for a runtime that had downloaded fine on the machine
  // this was written on.
  //
  // Bun's own platform packages on npm are `.tgz`, which is one format every
  // platform's `tar` reads, and they carry the same binary -- `package/bin/bun`,
  // verified. So there is one archive format and one tool rather than a tool
  // that happens to be two different programs.
  const triple = bunTriple({ arch, platform }).replace(/^bun-/, '');

  return `https://registry.npmjs.org/@oven/bun-${triple}/-/bun-${triple}-${version}.tgz`;
}

/**
 * Finds the runtime's executable(s) inside an extracted archive.
 *
 * A search rather than a known path, because the two archives are laid out
 * differently -- Node's is `node-v<v>-<os>-<arch>/bin/node` and Bun's is
 * `bun-<os>-<arch>/bun` -- and a third layout is a thing a release can change
 * without telling anybody.
 *
 * @param dir - Where it was extracted.
 * @param runtime - The executable's name.
 * @returns Every path it is at: one in any real archive.
 */
function findBinaries(dir: string, runtime: Runtime): string[] {
  const wanted = executable(runtime);

  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === wanted)
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A runtime and, optionally, the version of it to embed. */
export interface Spec {
  /** Which runtime. */
  readonly runtime: Runtime;
  /** The version, when one was named. */
  readonly version?: string;
}

/**
 * Reads a `bun`, `node`, `bun@1.3.14` or `node@26.12.1` spec.
 *
 * One flag rather than a `--runtime` and a `--runtime-version` beside it,
 * because it is one choice: the picker offers runtime-and-version rows, and two
 * flags for one row is two ways to say the same thing and a third way to say
 * something incoherent -- `--runtime node --runtime-version 1.3.14`.
 *
 * A bare runtime means "whichever version resolves", which is the installed one
 * if there is one. It is not an error, because pinning a version is a thing an
 * app does when it cares and most do not.
 *
 * @param text - What was typed, from the flag or from `sigil.json`.
 * @returns The runtime and any version.
 * @throws If the runtime is not one, or the version is not a version.
 */
export function parseSpec(text: string): Spec {
  const at = text.indexOf('@');
  const runtime = at === -1 ? text : text.slice(0, at);
  const version = at === -1 ? undefined : text.slice(at + 1);

  if (!(RUNTIMES as readonly string[]).includes(runtime)) {
    throw new Error(
      `"${runtime}" is not a runtime. Use ${RUNTIMES.join(' or ')}, optionally with a version -- ${RUNTIMES.map((one) => `${one}@<version>`).join(' or ')}.`
    );
  }

  if (version !== undefined && !isVersion(version)) {
    throw new Error(
      `"${version}" is not a version. Name one as <major>.<minor>.<patch>, for example ${example(runtime as Runtime)}.`
    );
  }

  if (runtime === 'node' && version !== undefined && !canEmbed(version)) {
    const [major, minor] = NODE_BUILD_SEA;

    throw new Error(
      `Node ${version} cannot package itself: a single executable is built by injecting a blob into a node binary, and Node only gained the ability to do that for itself in ${major}.${minor}. Below that it can write the blob and nothing can inject it.\n  Use node@${major}.${minor}.0 or newer. If you want Node ${version.split('.')[0]}'s behaviour, bun@1.3 is node-compat 24 and bun@1.2 is node-compat 22, measured -- and needs no injection.`
    );
  }

  return { runtime: runtime as Runtime, ...(version !== undefined && { version }) };
}

/** One row the runtime picker offers. */
export interface Choice {
  /** What it says, already laid out. */
  readonly label: string;
  /** What picking it means: a spec, or a prompt for a custom version. */
  readonly value: string;
}

/**
 * The rows the picker offers: both runtimes, newest first, local ones flagged.
 *
 * **Both** runtimes, whatever is installed, which is the whole point of being
 * able to fetch one: an app whose author has no Bun can still ship a Bun binary,
 * and refusing to offer it would be refusing on the grounds of a fact about the
 * laptop rather than about the app. That was the bug this replaced -- a
 * scaffolded app pinned `bun` in `sigil.json`, so the question never reached a
 * picker, and a machine without Bun got `bun is not installed` for an app whose
 * author had never been asked.
 *
 * Node below the `--build-sea` floor is left out rather than listed and refused:
 * a row somebody cannot pick is a row that should not be there. Naming such a
 * version explicitly still explains itself, in `parseSpec()`.
 *
 * @param local - What is on this machine, per runtime.
 * @param releases - What each registry offers, per runtime.
 * @returns The rows, Bun first and newest first within each runtime.
 */
export function choices(
  local: Readonly<Record<Runtime, readonly Found[]>>,
  releases: Readonly<Record<Runtime, readonly Release[]>>
): Choice[] {
  const rows: Choice[] = [];

  for (const runtime of RUNTIMES) {
    const here = new Map(local[runtime].map((one) => [one.version, one]));

    // merged and sorted newest-first across both sources rather than
    // local-then-registry, which put a cached 1.3.0 above a released 1.4.4 --
    // a picker's first row should be the newest thing it offers
    const offered = [
      ...new Set([
        ...local[runtime].map((one) => one.version),
        ...releases[runtime].slice(0, LINES).map((one) => one.version),
      ]),
    ].sort((one, other) => compare(other, one));

    for (const version of offered) {
      if (runtime === 'node' && !canEmbed(version)) {
        continue;
      }

      const lts = releases[runtime].find((one) => one.version === version)?.lts;
      const how = here.get(version)?.how;
      const notes = [
        lts ? `LTS ${lts}` : undefined,
        how === 'path' ? 'installed' : how === 'cache' ? 'cached' : undefined,
      ].filter((one): one is string => one !== undefined);

      rows.push({
        label: `${runtime} ${version}${notes.length ? `  (${notes.join(', ')})` : ''}`,
        value: `${runtime}@${version}`,
      });
    }
  }

  // the escape hatch, one per runtime, because a picker that only offers the
  // newest of each line cannot express "the exact version our other service
  // pins" -- and that is the ordinary reason to care about a version at all
  for (const runtime of RUNTIMES) {
    rows.push({ label: `${runtime}: enter a version…`, value: `custom:${runtime}` });
  }

  return rows;
}
