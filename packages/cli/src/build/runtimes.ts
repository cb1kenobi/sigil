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
import { cache } from '@ttylabs/sigil/paths';
import { whichSync } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a fetched runtime is kept, under the XDG cache. */
const CACHE = 'sigil/runtimes';

/** Where Bun keeps the target runtimes it downloads for `--compile`. */
const BUN_CACHE = '.bun/install/cache';

/** How long to wait for a registry listing or a download. */
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
      const at = join(own, entry, runtime);

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
  try {
    return runtime === 'node' ? await latestNode() : await latestBun();
  } catch {
    // a listing nobody could fetch is not an error: the picker falls back to
    // what is local, and an explicit `--runtime-version` still resolves
    return [];
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
    const version = one.version.replace(/^v/, '');
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
    if (version.includes('-')) {
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
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });

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
 * the same answer.
 *
 * @param runtime - Which runtime.
 * @param version - The version, without a leading `v`.
 * @param target - What is being built.
 * @param onFetch - Called before a download starts, so the caller can say so.
 * @returns The executable to use.
 * @throws If it is not available and could not be fetched.
 */
export async function resolve(
  runtime: Runtime,
  version: string,
  target: Target,
  onFetch?: (version: string) => void
): Promise<string> {
  const here = local(runtime, target).find((one) => one.version === version);

  if (here?.path) {
    return here.path;
  }

  onFetch?.(version);

  return download(runtime, version);
}

/**
 * Fetches a runtime into sigil's own cache and returns its executable.
 *
 * Extracted with `tar`, which is not a dependency on any platform this
 * supports: macOS and Linux ship it, and Windows 10 and newer ship bsdtar as
 * `tar.exe`, which reads the `.zip` Bun publishes as well as the `.tar.gz` Node
 * does. Writing an unzip here would be writing an unzip.
 *
 * The extraction goes to a sibling directory and is **renamed into place**, so
 * a download that dies half way leaves no directory that looks like a cached
 * runtime. Two builds fetching the same version race on the rename, which is
 * atomic, and the loser's copy is discarded.
 *
 * @param runtime - Which runtime.
 * @param version - The version, without a leading `v`.
 * @returns The executable.
 * @throws If the download or the extraction failed.
 */
async function download(runtime: Runtime, version: string): Promise<string> {
  const root = cache(CACHE, runtime);

  if (!root) {
    throw new Error(
      `Cannot work out where to cache a runtime: no XDG cache directory, and ${runtime} ${version} is not installed.`
    );
  }

  const into = join(root, version);
  const binary = join(into, runtime);
  const partial = `${into}.partial-${process.pid}`;

  mkdirSync(partial, { recursive: true });

  try {
    const url = downloadUrl(runtime, version);
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });

    if (!response.ok) {
      throw new Error(
        `Could not download ${runtime} ${version}: ${url} answered ${response.status}.\n  Check the version exists -- "sigil package --runtime ${runtime} --runtime-version list" prints what does.`
      );
    }

    const archive = join(partial, runtime === 'node' ? 'node.tar.gz' : 'bun.zip');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

    const tar = spawnSync('tar', ['-xf', archive, '-C', partial], {
      encoding: 'utf-8',
      timeout: TIMEOUT,
    });

    if (tar.status !== 0) {
      throw new Error(
        `Could not extract ${runtime} ${version}: ${tar.stderr || tar.error?.message}`
      );
    }

    const found = findBinary(partial, runtime);
    if (!found) {
      throw new Error(`Downloaded ${runtime} ${version} but found no ${runtime} executable in it.`);
    }

    mkdirSync(into, { recursive: true });
    renameSync(found, binary);
    chmodSync(binary, 0o755);

    return binary;
  } finally {
    rmSync(partial, { force: true, recursive: true });
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

  return `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${bunTriple({
    arch,
    platform,
  }).replace(/^bun-/, 'bun-')}.zip`;
}

/**
 * Finds the runtime's executable inside an extracted archive.
 *
 * A search rather than a known path, because the two archives are laid out
 * differently -- Node's is `node-v<v>-<os>-<arch>/bin/node` and Bun's is
 * `bun-<os>-<arch>/bun` -- and a third layout is a thing a release can change
 * without telling anybody.
 *
 * @param dir - Where it was extracted.
 * @param runtime - The executable's name.
 * @returns Its path, or `undefined`.
 */
function findBinary(dir: string, runtime: Runtime): string | undefined {
  const wanted = process.platform === 'win32' ? `${runtime}.exe` : runtime;

  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === wanted) {
      return join(entry.parentPath, entry.name);
    }
  }

  return undefined;
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

  if (version !== undefined && !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(
      `"${version}" is not a version. Name one as <major>.<minor>.<patch>, for example ${runtime === 'bun' ? 'bun@1.3.14' : 'node@26.12.1'}.`
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
