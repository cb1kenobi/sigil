// What an update check looks at, as data rather than as code.
//
// A checker crosses a process boundary -- the ordinary path pipes the fetch
// into a spawned worker -- so it cannot be a function, and making it one would
// be an API that works in a compiled binary and silently does nothing outside
// one. What differs between asking npm and asking GitHub is a URL, some
// headers, and where the version sits in the answer, so that is what this is.

import { distTagsURL } from './registry.js';

/**
 * Where to look for the latest version, and how to read it out of the answer.
 *
 * Serializable on purpose: the default path hands this to a worker through the
 * environment, and the compiled path reads the same object in process. One
 * description with two transports, rather than two ideas of what a check is.
 */
export interface UpdateChecker {
  /** Request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Where the version sits in the JSON response, as a sequence of keys. */
  readonly path: readonly string[];
  /** A prefix stripped off the version where the answer carries one. */
  readonly prefix?: string;
  /** What to call this in a message. */
  readonly type: string;
  /** The `https` URL to GET. */
  readonly url: string;
}

/**
 * Whether a value is a checker rather than a set of options.
 *
 * `Schema.updateCheck` takes either, and the two cannot be confused: a checker
 * always says what it is and where to look, and the options never carry a
 * `type` or a `url` -- the options that name a place do it through `checker`.
 * Asked by shape because a checker is data, not a class, for the reason the
 * interface above gives.
 *
 * @param value - Whatever `updateCheck` held.
 * @returns Whether it is a checker.
 */
export function isChecker(value: unknown): value is UpdateChecker {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { path, type, url } = value as Record<string, unknown>;
  return typeof type === 'string' && typeof url === 'string' && Array.isArray(path);
}

/** What `npmChecker()` is given. */
export interface NpmCheckerOptions {
  /** The dist tag to read, which defaults to `latest`. */
  readonly distTag?: string;
  /** The package to ask about. */
  readonly packageName: string;
  /** The registry to ask, which defaults to npm's. */
  readonly registryURL?: string;
}

/** What `githubChecker()` is given. */
export interface GithubCheckerOptions {
  /** The API root, for an enterprise host. Defaults to `api.github.com`. */
  readonly apiURL?: string;
  /** `owner/name`. */
  readonly repo: string;
  /**
   * The tag prefix to strip, which defaults to `v`.
   *
   * `v1.2.3` is the overwhelmingly common spelling of a release tag and
   * `1.2.3` is what the app's own version is, so leaving it on would make
   * every comparison say there is an update forever. An empty string keeps
   * the tag exactly as the release carries it.
   */
  readonly prefix?: string;
}

const defaultApiURL = 'https://api.github.com';

/**
 * Asks an npm registry for a package's dist-tags.
 *
 * This is what a check does when nothing said otherwise and the app is not a
 * compiled binary, which is the case the update check was written for.
 *
 * @param opts - The package, the tag and the registry.
 * @returns The checker.
 */
export function npmChecker(opts: NpmCheckerOptions): UpdateChecker {
  const { distTag = 'latest', packageName, registryURL } = opts;
  return {
    headers: {
      accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
    },
    // the response is `{ "latest": "1.2.3", ... }`, so the tag is the whole
    // path. A tag may hold a dot -- `v1.x` is a real one -- which is why a
    // path is a list of keys rather than a dotted string
    path: [distTag],
    type: 'npm',
    url: distTagsURL(packageName, registryURL),
  };
}

/**
 * Asks GitHub for a repository's latest release.
 *
 * The answer to "my app is a binary people download from the releases page",
 * which is the case a compiled app is usually in and the one npm cannot serve.
 *
 * @param opts - The repository, the API root and the tag prefix.
 * @returns The checker.
 * @throws If the repository is not `owner/name`.
 */
export function githubChecker(opts: GithubCheckerOptions): UpdateChecker {
  const { apiURL = defaultApiURL, prefix = 'v', repo } = opts;

  // `owner/name` and nothing else: a bare name, a trailing slash or a whole
  // URL each produce a request to a path that is not the one meant, and the
  // answer to that is a 404 the check swallows rather than an error anybody
  // sees. Checked here, where a test can reach it, for the reason the registry
  // URL is built here rather than in the worker
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new TypeError(`Update check repo must be "owner/name", got "${repo}"`);
  }

  return {
    headers: {
      accept: 'application/vnd.github+json',
      // GitHub refuses a request with no user agent, which is the one header
      // that is not a preference
      'user-agent': 'sigil-update-check',
    },
    path: ['tag_name'],
    ...(prefix && { prefix }),
    type: 'github',
    url: `${apiURL.replace(/\/$/, '')}/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(
      parts[1]
    )}/releases/latest`,
  };
}

/**
 * Reads the version out of what a checker's URL answered.
 *
 * The worker deliberately does not do this: it caches the response body
 * verbatim and this is asked here, in the parent, where a test can reach it.
 * That is the same rule the registry URL already follows -- what the worker
 * decides for itself is what nothing else can check -- and it is why there is
 * one reader rather than one per transport.
 *
 * @param body - The parsed JSON response.
 * @param checker - The checker that asked for it.
 * @returns The version, or `undefined` when the answer does not carry one.
 */
export function versionFrom(body: unknown, checker: UpdateChecker): string | undefined {
  let value: unknown = body;
  for (const key of checker.path) {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }

  if (typeof value !== 'string' || !value) {
    return undefined;
  }

  const { prefix } = checker;
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version, as far as this reads one. */
interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[] | undefined;
}

function parseVersion(text: string): ParsedVersion | undefined {
  const match = VERSION_RE.exec(text.trim());
  if (!match) {
    return undefined;
  }

  return {
    core: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4]?.split('.'),
  };
}

/** Semver's rule for the pre-release part: numbers compare as numbers, and rank below words. */
function comparePre(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];

    // a set that runs out first is the smaller one: `1.0.0-rc` < `1.0.0-rc.1`
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }

    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);

    if (xn && yn && Number(x) !== Number(y)) {
      return Number(x) - Number(y);
    }

    if (xn !== yn) {
      return xn ? -1 : 1;
    }

    if (!xn && x !== y) {
      return x < y ? -1 : 1;
    }
  }

  return 0;
}

/**
 * Whether `latest` is a later version than `current`.
 *
 * Ordered by semver rather than compared for difference, and that is the
 * point of having it: `latest !== current` tells somebody running a build
 * **newer** than the published one -- a developer on `main`, a release
 * candidate -- that they are out of date, on every run, forever.
 *
 * A version this cannot read is never newer. A check that cannot tell is a
 * check that says nothing, and the alternative is a notice on every run for a
 * scheme (`2026.10.1`, a git sha) nobody declared a comparison for. An app
 * whose versions are not semver writes its own `message`.
 *
 * @param latest - What the check found.
 * @param current - What is running.
 * @returns Whether there is something newer to say.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) {
    return false;
  }

  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) {
      return a.core[i]! > b.core[i]!;
    }
  }

  // an equal core: a release outranks any pre-release of it, so `1.0.0` is
  // newer than `1.0.0-rc.1` and `1.0.0-rc.1` is not newer than `1.0.0`
  if (!a.pre || !b.pre) {
    return !a.pre && !!b.pre;
  }

  return comparePre(a.pre, b.pre) > 0;
}
