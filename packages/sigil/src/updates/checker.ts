// What an update check looks at, as data rather than as code.
//
// A checker crosses a process boundary -- the ordinary path pipes the fetch
// into a spawned worker -- so it cannot be a function, and making it one would
// be an API that works in a compiled binary and silently does nothing outside
// one. What differs between asking npm and asking GitHub is a URL, some
// headers, and where the version sits in the answer, so that is what this is.

import { escapeControls } from '../util/escape-controls.js';
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
  /**
   * The registry to ask, which defaults to npm's: an absolute `https://` URL,
   * with a path if the registry has one and no credentials, query or fragment.
   * Anything else throws a `TypeError`.
   */
  readonly registryURL?: string;
}

/** What `githubChecker()` is given. */
export interface GithubCheckerOptions {
  /**
   * The API root, for an enterprise host. Defaults to `api.github.com`. An
   * absolute `https://` URL, keeping its path (`https://host/api/v3`), with no
   * credentials, query or fragment. Anything else throws a `TypeError`.
   */
  readonly apiURL?: string;
  /**
   * `owner/name`, each half in the characters GitHub allows: letters, digits,
   * `-` and `_` in the owner, and those plus `.` in the name, which is never
   * `.` or `..`.
   */
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

/** What `customChecker()` is given. */
export interface CustomCheckerOptions {
  /**
   * Where the version sits in the JSON response, as a non-empty list of keys.
   * A list rather than a dotted string so a key may contain a dot.
   */
  readonly path: readonly string[];
  /**
   * The endpoint to GET: an absolute `https://` URL with a host. A query is
   * kept (`https://h/api/latest?channel=stable`); whitespace, a control
   * character, credentials and a fragment are refused. Anything else throws a
   * `TypeError`.
   */
  readonly url: string;
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

  // a name and a tag are strings, and `encodeURIComponent()` takes anything: an
  // `undefined` became the package called `undefined` and a request for it
  // (SIG-545). `check()` asks the same of its own options, and this is the
  // builder an app calls without going through it
  if (typeof packageName !== 'string' || !packageName) {
    throw new TypeError(
      `Update check package name must be a non-empty string, got "${escapeControls(packageName)}"`
    );
  }
  if (typeof distTag !== 'string' || !distTag) {
    throw new TypeError(
      `Update check dist tag must be a non-empty string, got "${escapeControls(distTag)}"`
    );
  }

  return {
    headers: {
      accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
    },
    // the response is `{ "latest": "1.2.3", ... }`, so the tag is the whole
    // path. A tag may hold a dot -- `v1.x` is a real one -- which is why a
    // path is a list of keys rather than a dotted string
    path: [distTag],
    type: 'npm',
    url: distTagsURL(
      packageName,
      registryURL === undefined ? undefined : checkedURL(registryURL, 'registryURL', 'root')
    ),
  };
}

/**
 * A URL as a refusal may quote it: nothing up to the last `@`, then nothing
 * after the first `?` or `#`, so a refusal never prints a password or a token
 * written in the places one goes.
 *
 * Deliberately cruder than the grammar. The value is one the parser may have
 * refused, and a parser that refused it cannot say where the credentials were:
 * `https://u:pa/ss@h` reads as a host `u` and a port `pa`. So both cuts are by
 * character, on the raw string. The `@` goes first, and the order matters: a
 * password may hold a `?` or a `#`, and cutting at one first removes the `@`
 * the other cut needs and leaves the userinfo in front of it. The price is a
 * legitimate `@` in a path hidden in a refusal -- a message losing detail
 * rather than a log gaining a secret.
 *
 * What it does not recognize is a secret with no `@` after it and none of
 * those characters before it: a bare token passed as the whole value, or
 * `https://user:secret` with the host forgotten. No cut by character can tell
 * those from a mistyped host.
 */
function redact(value: unknown): string {
  return String(value)
    .replace(/^[\s\S]*@/, '***@')
    .replace(/([?#])[\s\S]*$/, '$1***');
}

/**
 * Validates a URL an update check asks, and returns it normalized (SIG-544,
 * SIG-546).
 *
 * `apiURL` and `registryURL` are joined to a path, and either was taken as
 * given: a newline, a missing scheme or `ftp:` produced a request that failed
 * in the worker, which the check swallows -- the silent miss it exists to stop.
 * A `custom` check's `url` is the whole request and was taken the same way. The
 * rule is the one the worker holds the whole URL to, `https:`, and nothing
 * wider. `http:` is not accepted although the ticket allowed it, because the
 * worker refuses it (`CHECK_URL must use https`) and the in-process fetch is
 * `node:https`, so accepting it moves the failure to where nobody sees it.
 *
 * What `new URL()` accepts is wider than what this is willing to build on: it
 * strips tabs and newlines rather than rejecting them and trims a leading
 * space, so the raw string is checked for whitespace and control characters
 * first, and has to open with `https://` and a host -- which is the whole of
 * the scheme rule, since the parser cannot then read it as anything but `https:`.
 * Credentials would travel in an environment variable and a process listing, so
 * they are refused, and so is a fragment, which no request carries.
 *
 * The two kinds differ in the query and in the path. A **root** is joined to a
 * path, so a query would land in the middle of it and is refused, the path is
 * kept (an enterprise root is `.../api/v3`), and a trailing slash goes. An
 * **endpoint** is the request itself: it may carry a query
 * (`https://h/api/latest?channel=stable`), and is returned as it was written,
 * so a trailing slash is part of the path.
 *
 * @param value - What the caller passed.
 * @param label - The option's name, for the message.
 * @param kind - `root` for a URL a path is joined to, `endpoint` for one that is fetched as it stands.
 * @returns The URL as the parser wrote it, minus any trailing slash for a root.
 * @throws If it is not an `https` URL of that shape.
 */
function checkedURL(value: unknown, label: string, kind: 'endpoint' | 'root'): string {
  const root = kind === 'root';
  const refuse = (): never => {
    throw new TypeError(
      `Update check ${label} must be an absolute https:// URL with no credentials` +
        `${root ? ', query or fragment' : ' or fragment'}, got "${escapeControls(redact(value))}"`
    );
  };

  if (
    typeof value !== 'string' ||
    /[\p{Cc}\s]/u.test(value) ||
    !/^https:\/\/[^/\\]/i.test(value) ||
    value.includes('#') ||
    (root && value.includes('?'))
  ) {
    return refuse();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse();
  }
  if (url.username || url.password) {
    return refuse();
  }

  return root ? url.href.replace(/\/+$/, '') : url.href;
}

/**
 * What an owner is made of: letters, digits and hyphens, and the underscore an
 * enterprise managed user's login carries (`octocat_acme`), which is a valid
 * owner of a repository and which the looser reading would have refused.
 */
const ownerRE = /^[A-Za-z0-9_-]+$/;

/** What a repository's name is made of: letters, digits, `.`, `-` and `_`. */
const repoNameRE = /^[A-Za-z0-9._-]+$/;

/**
 * Asks GitHub for a repository's latest release.
 *
 * The answer to "my app is a binary people download from the releases page",
 * which is the case a compiled app is usually in and the one npm cannot serve.
 *
 * @param opts - The repository, the API root and the tag prefix.
 * @returns The checker.
 * @throws If the repository is not `owner/name`, or either half is not a name
 * GitHub allows.
 */
export function githubChecker(opts: GithubCheckerOptions): UpdateChecker {
  const { apiURL = defaultApiURL, prefix = 'v', repo } = opts;
  const root = checkedURL(apiURL, 'apiURL', 'root');

  // `owner/name` and nothing else: a bare name, a trailing slash or a whole
  // URL each produce a request to a path that is not the one meant, and the
  // answer to that is a 404 the check swallows rather than an error anybody
  // sees. Checked here, where a test can reach it, for the reason the registry
  // URL is built here rather than in the worker
  //
  // Each half also has to be a name GitHub could have given, so the characters
  // are checked as well as the count: a newline or a space went into the
  // request path and produced the same swallowed 404 (SIG-541). The classes
  // are ASCII spelled out, since GitHub's names are and a Unicode-aware `\w`
  // would not be. `.` and `..` as a whole repository name are refused: both
  // are in the class, neither is a name, and `..` is a path segment the URL
  // resolves away. Length, and a leading, trailing or doubled hyphen, are
  // left to GitHub, which still holds legacy accounts that break each
  //
  // A `repo` that is not a string is the same refusal and not Node's own
  // `repo.split is not a function` (SIG-545): the types guard `sigil.json` and
  // a plain-JavaScript caller has nothing to
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (
    parts.length !== 2 ||
    !ownerRE.test(parts[0]!) ||
    !repoNameRE.test(parts[1]!) ||
    parts[1] === '.' ||
    parts[1] === '..'
  ) {
    throw new TypeError(`Update check repo must be "owner/name", got "${escapeControls(repo)}"`);
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
    url: `${root}/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(
      parts[1]
    )}/releases/latest`,
  };
}

/**
 * Asks an endpoint of your own for the latest version.
 *
 * The third source beside npm and GitHub, for an app that publishes a version
 * somewhere else: a JSON file on a CDN, an API of its own. It is what
 * `sigil.json`'s `{ "type": "custom" }` builds, so a URL baked in at build time
 * and one built in source are held to the same rule (SIG-546).
 *
 * @param opts - The endpoint and where the version sits in its answer.
 * @returns The checker.
 * @throws If the URL is not an `https` URL of that shape, or the path is not a
 * non-empty list of non-empty strings.
 */
export function customChecker(opts: CustomCheckerOptions): UpdateChecker {
  const { path, url } = opts;

  // an empty path reads the whole body, which is never a string, and a key
  // that is not one is looked up as whatever it coerces to: either is a check
  // that answers `undefined` for ever, which is the silent miss again
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.some((key) => typeof key !== 'string' || !key)
  ) {
    throw new TypeError(
      `Update check path must be a non-empty list of non-empty strings, got "${escapeControls(path)}"`
    );
  }

  return { path: [...path], type: 'custom', url: checkedURL(url, 'url', 'endpoint') };
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

  if (typeof value !== 'string') {
    return undefined;
  }

  // trimmed here, by the one reader of the answer, because `isNewer()` trims
  // what it compares and the notice prints what this returns: a registry
  // answering `"\r1.0.1"` was newer than `1.0.0` and printed as
  // `1.0.0 → \r1.0.1`, a carriage return in the middle of the line
  const version = value.trim();
  if (!version) {
    return undefined;
  }

  const { prefix } = checker;
  return prefix && version.startsWith(prefix) ? version.slice(prefix.length) : version;
}

// The pre-release and the build metadata are dot-separated identifiers, none of
// them empty: a class with the dot inside it read `1.0.0-a..b` as newer than
// `1.0.0-a`, and semver forbids an empty identifier. The dot is outside each
// class, so every repetition is unambiguous and the match stays linear. It is
// also what keeps a hostile answer off the terminal -- anchored, ASCII only,
// no space and no control character -- so it may only ever get narrower.
const VERSION_RE =
  /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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
