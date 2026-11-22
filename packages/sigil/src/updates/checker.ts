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
   * Request headers: a plain object of header names to string values, for an
   * endpoint that wants an `Authorization` token or an `Accept` type. A name
   * must be an HTTP token, and a value may hold a tab, printable ASCII and
   * Latin-1 letters and no control character or character past `U+00FF` --
   * what Node would refuse to send, and the C1 controls it would not -- or
   * `customChecker()` throws a `TypeError` naming the header and never quoting
   * its value. The headers travel to the worker in its environment, like
   * anything else a check is told.
   *
   * Code only: `sigil.json` takes no headers, because a value is often a
   * credential and that file is committed.
   */
  readonly headers?: Readonly<Record<string, string>>;
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
  /**
   * A prefix stripped off the version the endpoint answers with, for one that
   * says `v1.2.3` where the app's own version is `1.2.3`. A non-empty string;
   * left out, nothing is stripped.
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
 * What a query parameter's name has to look like to be quoted: the plain
 * identifier a name is (`channel`, `api_key`, `filter[type]`, `v1.2`), short.
 *
 * A name is what the reader typed and is there to be recognized, but the
 * position is also where a token goes when it was pasted in the wrong place, in
 * front of a `=` or on its own -- `?eyJhbGciOi...`, `?token%3Dhunter2`,
 * `?{"token":"hunter2"}` -- and the old rule hid all of those. So a name is
 * quoted only when it is this shape *and* a `=` follows it; anything else is
 * `***`, which keeps the parameter's place in the list and nothing of what it
 * held. A 24-character identifier can still be a token, and that is the price
 * of showing names at all.
 */
const queryNameRE = /^[A-Za-z0-9_.\-[\]]{1,24}$/;

/** How many parameters a refusal lists before it says there were more. */
const MAX_QUERY_PARAMS = 8;

/**
 * A query as a refusal may quote it: each parameter's name, and `***` where its
 * value was (SIG-556).
 *
 * Split by hand on `&` and the first `=`, because the string is one a parser
 * may have refused. A parameter with no `=`, or with nothing but `=` after its
 * first one, is quoted as `***`, name and all: it is a flag to a server and a
 * bare token to a typo (or a token's padding), and nothing here can say which.
 * So `?a=` is `***` too, the one legitimate name this costs. An empty one (`&&`) says nothing and is dropped. Only `&` separates: a
 * `;` is part of a value as far as this knows, and a value is hidden whole.
 */
function redactQuery(query: string): string {
  const shown: string[] = [];
  for (const param of query.split('&')) {
    if (!param) {
      continue;
    }
    // a `=` is what says where a name ends, so it has to be followed by
    // something that is not another one: a base64 token's own padding
    // (`c2VjcmV0==`) is `=` and nothing, and is a bare token and not a name
    const eq = param.indexOf('=');
    const named = eq !== -1 && !/^=*$/.test(param.slice(eq + 1));
    const name = param.slice(0, eq);
    shown.push(!named ? '***' : `${queryNameRE.test(name) ? name : '***'}=***`);
  }
  return shown.length > MAX_QUERY_PARAMS
    ? `${shown.slice(0, MAX_QUERY_PARAMS).join('&')}&...`
    : shown.join('&');
}

/**
 * A URL as a refusal may quote it: nothing up to the last `@`, then nothing
 * after the first `?` or `#`, so a refusal never prints a password or a token
 * written in the places one goes. For an **endpoint**, which may carry a query,
 * the `?` cut is replaced by the query's parameter names with their values
 * hidden (`?channel=***&token=***`), so the reader can see which parameter they
 * wrote (SIG-556); a root URL, which may carry none, still hides it whole.
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
 * The same `@` is the reason a query is not shown whole after it: an `@` inside
 * a query (`?email=a@b&token=hunter2`) is cut like any other, and what is left
 * is the tail of the query, not a host. So where an `@` was cut, nothing past
 * the first `?`, `#`, `&` or `=` of what remains is shown either, and no name is
 * quoted from it. A credential-free URL keeps the names.
 *
 * What it does not recognize is a secret with no `@` after it and none of
 * those characters before it: a bare token passed as the whole value, or
 * `https://user:secret` with the host forgotten. No cut by character can tell
 * those from a mistyped host.
 */
function redact(value: unknown, kind: 'endpoint' | 'root'): string {
  let rest = String(value);
  const at = rest.lastIndexOf('@');
  const cut = at !== -1;
  if (cut) {
    rest = rest.slice(at + 1);
  }
  const head = cut ? '***@' : '';

  // after a credential cut, what is left may be the tail of a query, so it is
  // cut at the first thing that could separate one parameter's value from the
  // rest, as well as at `?` and `#`
  const end = rest.search(cut ? /[?#&=]/ : /[?#]/);
  if (end === -1) {
    return head + rest;
  }

  const separator = rest[end]!;
  const before = rest.slice(0, end);
  if (separator !== '?' || kind === 'root' || cut) {
    return `${head}${before}${separator}***`;
  }

  const fragment = rest.indexOf('#', end);
  const query = rest.slice(end + 1, fragment === -1 ? undefined : fragment);
  return `${head}${before}?${redactQuery(query)}${fragment === -1 ? '' : '#***'}`;
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
 * (`https://h/api/latest?channel=stable`), and is returned as the parser wrote it
 * (scheme and host lower-cased, a dot segment resolved), so a trailing slash is
 * part of the path and is kept.
 *
 * @param value - What the caller passed.
 * @param label - The option's name, for the message.
 * @param kind - `root` for a URL a path is joined to, `endpoint` for one that is fetched as it stands.
 * @param strict - `false` for a checker written by hand, which is refused only for a URL
 * `https.get()` cannot request (not `https`, or no host) and for credentials, and is returned unchanged.
 * @returns The URL as the parser wrote it, minus any trailing slash for a root.
 * @throws If it is not an `https` URL of that shape.
 */
function checkedURL(
  value: unknown,
  label: string,
  kind: 'endpoint' | 'root',
  strict = true
): string {
  const root = kind === 'root';
  const refuse = (): never => {
    // the fragment is named only where it is refused, so the message does not
    // forbid what the checker it was written for may carry
    const refused = !strict ? '' : root ? ', query or fragment' : ' or fragment';
    throw new TypeError(
      `Update check ${label} must be an absolute https:// URL with no credentials` +
        `${refused}, got "${escapeControls(redact(value, kind))}"`
    );
  };

  // a checker somebody wrote by hand is held to what could never have worked and
  // to credentials, and is returned as it was given: `https.get()` parses the
  // string itself, so what it takes is what `new URL()` takes (SIG-563)
  if (!strict) {
    let given: URL | undefined;
    try {
      given = typeof value === 'string' ? new URL(value) : undefined;
    } catch {}
    if (!given || given.protocol !== 'https:' || !given.hostname) {
      return refuse();
    }
    if (given.username || given.password) {
      return refuse();
    }
    return value as string;
  }

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
 * What a header name is: an HTTP token, which is what `http.validateHeaderName()`
 * accepts and what Node refuses to send anything else as.
 */
const headerNameRE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * What a header value may hold: a tab, printable ASCII and the Latin-1 letters.
 *
 * That is `http.validateHeaderValue()`'s rule with one difference, deliberate:
 * Node also lets `U+0080` to `U+009F` through, the C1 controls, and this does
 * not, so the rule the source and the build already apply to every other
 * string (`\p{Cc}`) is the one applied here. `CR`, `LF` and `NUL` are refused
 * by both, which is the injection and the request Node refuses at send time.
 * Written as a class of escapes rather than asked of `node:http`, so a module
 * the compiled path loads at start-up does not load the whole HTTP stack for
 * one regular expression; `updates.test.ts` compares the two over every code
 * point below `U+0300`, so the rule cannot drift from what would fail.
 */
const headerValueRE = /^[\t\u0020-\u007e\u00a0-\u00ff]*$/;

/**
 * What Node accepts in a header value: `headerValueRE` with the C1 controls
 * (`U+0080` to `U+009F`) it lets through. A checker written by hand is held to
 * this one and `customChecker()` to the stricter one, so a value that was being
 * sent keeps being sent (SIG-563).
 */
const sentHeaderValueRE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/;

/**
 * Validates `headers` and returns a copy of them (SIG-555).
 *
 * A refusal names the header and never its value: a value is often a
 * credential, and a message goes to a terminal and a log. A name that is not a
 * token is quoted (escaped), since it is the thing that is wrong and a name is
 * not where a secret goes; a value's refusal quotes the name, which has passed
 * that test by then, and says nothing of the value but that it is not allowed.
 * The object itself is never echoed, for the same reason.
 *
 * @param headers - What was given.
 * @param strict - `false` for a checker written by hand, which is refused only what
 * Node's `https.get()` refuses to send: a value may hold a C1 control, be a number, a
 * boolean, `null` or a list of those, and the headers may be an instance of a class.
 */
function checkedHeaders(headers: unknown, strict = true): Record<string, string> {
  const proto: unknown =
    typeof headers === 'object' && headers !== null && Object.getPrototypeOf(headers);
  const plain = proto === Object.prototype || proto === null;
  if (
    !strict ? typeof headers !== 'object' || headers === null || Array.isArray(headers) : !plain
  ) {
    throw new TypeError('Update check headers must be an object of header names to string values');
  }

  const valueRE = strict ? headerValueRE : sentHeaderValueRE;
  const checked: [string, string][] = [];
  for (const [name, value] of Object.entries(headers as object)) {
    if (!headerNameRE.test(name)) {
      throw new TypeError(
        `Update check header name must be an HTTP token, got "${escapeControls(name)}"`
      );
    }
    // a string, which is what the type says. Node also sends a number, a boolean,
    // `null` and a list of those, and the worker's JSON hop drops `undefined`
    // (`{ authorization: process.env.TOKEN }` with the variable unset sends no
    // header), so a checker written by hand that has one keeps it. An object, a
    // function, a symbol and a bigint are refused: they are junk or work on one
    // transport only
    const sendable = (v: unknown): boolean =>
      typeof v === 'string' ||
      (!strict &&
        (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined));
    const values = !strict && Array.isArray(value) ? (value as unknown[]) : [value];
    for (const v of values) {
      if (!sendable(v)) {
        throw new TypeError(`Update check header "${name}" must be a string, got a ${typeof v}`);
      }
    }
    if (!values.every((v) => valueRE.test(String(v)))) {
      throw new TypeError(
        `Update check header "${name}" must not contain a control character or a character past U+00FF`
      );
    }
    checked.push([name, value as string]);
  }
  // `fromEntries()` defines each property, where assigning `checked['__proto__']`
  // sets the prototype and drops a header the name test accepted
  return Object.fromEntries(checked);
}

/**
 * Validates `path`, which is where the version sits in the answer.
 *
 * An empty path reads the whole body, which is never a string, and a key that
 * is not one is looked up as whatever it coerces to: either is a check that
 * answers `undefined` for ever, which is the silent miss again. A checker
 * written by hand is held to the first only -- a list with something in it --
 * because an empty key is a real key of a JSON object and looks it up (SIG-563).
 *
 * @param path - What was given.
 * @param strict - `false` for a checker written by hand.
 */
function checkedPath(path: unknown, strict = true): void {
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    (strict && Array.from(path).some((key) => typeof key !== 'string' || !key))
  ) {
    throw new TypeError(
      `Update check path must be a non-empty list of ${strict ? 'non-empty strings' : 'keys'}, ` +
        `got "${escapeControls(path)}"`
    );
  }
}

/**
 * Asks an endpoint of your own for the latest version.
 *
 * The third source beside npm and GitHub, for an app that publishes a version
 * somewhere else: a JSON file on a CDN, an API of its own. It is what
 * `sigil.json`'s `{ "type": "custom" }` builds, so a URL baked in at build time
 * and one built in source are held to the same rule (SIG-546). `headers` and
 * `prefix` are options of the checker it returns and are validated here too
 * (SIG-555), which a hand-written `{ type: 'custom', ... }` object never is.
 *
 * @param opts - The endpoint, where the version sits in its answer, and the headers and prefix.
 * @returns The checker.
 * @throws If the URL is not an `https` URL of that shape, the path is not a
 * non-empty list of non-empty strings, a header is not a valid name and value,
 * or the prefix is not a non-empty string.
 */
export function customChecker(opts: CustomCheckerOptions): UpdateChecker {
  const { headers, path, prefix, url } = opts;

  checkedPath(path);

  // `undefined` is the option left out; an empty string is not. An empty prefix
  // strips nothing, which is what leaving it out says, so it is refused rather
  // than accepted as a second spelling (a GitHub check's `''` means something
  // there only because its default is `v`)
  //
  // `versionFrom()` trims the version before it looks for the prefix, so one that
  // starts with whitespace never matches, and a control character in one is
  // baked into a file and printed nowhere: both are the silent miss again
  if (
    prefix !== undefined &&
    (typeof prefix !== 'string' || !prefix || /^\s|\p{Cc}/u.test(prefix))
  ) {
    throw new TypeError(
      'Update check prefix must be a non-empty string with no leading whitespace or ' +
        `control character, got "${escapeControls(prefix)}"`
    );
  }

  return {
    ...(headers !== undefined && { headers: checkedHeaders(headers) }),
    path: [...path],
    ...(prefix !== undefined && { prefix }),
    type: 'custom',
    url: checkedURL(url, 'url', 'endpoint'),
  };
}

/**
 * Refuses a checker the update check could never have used (SIG-563).
 *
 * `check()` and a schema's `updateCheck` take a checker as **data**, so one
 * written by hand as an object literal never passed through `customChecker()`'s
 * rules, and a header Node refuses to send made `https.get()` throw inside a
 * worker that says nothing. Every checker is asked here, whatever its `type`
 * and however it was built, which is one place for the rules rather than a copy
 * of them: it is `customChecker()`'s own `checkedURL()`, `checkedHeaders()` and
 * `checkedPath()` asked with `strict` off.
 *
 * What it refuses is what could never have worked -- a URL that is not `https`
 * or has no host, a header name or value `https.get()` rejects, a path with
 * nothing in it -- and a URL with credentials, which does work and is refused
 * anyway because a secret in a URL travels in the worker's environment and a
 * process listing, and a header is where it belongs. What `customChecker()`
 * holds a checker to on top of that stays `customChecker()`'s, because it
 * refuses things that were working: a fragment, whitespace in the URL, a C1
 * control in a header value, an empty key and a prefix of `''`.
 *
 * @param checker - What the app handed over.
 * @returns The same checker.
 * @throws A `TypeError` that never quotes a header value or a credential.
 */
export function checkedChecker(checker: unknown): UpdateChecker {
  if (typeof checker !== 'object' || checker === null) {
    throw new TypeError('Update check checker must be an object');
  }

  const { headers, path, url } = checker as Record<string, unknown>;
  checkedURL(url, 'url', 'endpoint', false);
  checkedPath(path, false);
  if (headers !== undefined && headers !== null) {
    checkedHeaders(headers, false);
  }
  return checker as UpdateChecker;
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

  // an answer that is the prefix and nothing else carries no version either,
  // and stripping it left `''` where this promises `undefined` (SIG-562). The
  // remainder is trimmed because the prefix may be followed by whitespace, and
  // only a prefix at the start is stripped: `1.0.0v` is not `v`'s to take
  const { prefix } = checker;
  if (!prefix || !version.startsWith(prefix)) {
    return version;
  }
  return version.slice(prefix.length).trim() || undefined;
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
