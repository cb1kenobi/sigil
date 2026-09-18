// Where an update check looks: the registry URL it fetches and the cache file
// it writes. Both turn a package name into a location, and a scoped name --
// which is what this framework publishes under -- was wrong in both.

const defaultRegistryURL = 'https://registry.npmjs.org';

/**
 * Builds the npm registry endpoint that serves a package's dist-tags.
 */
export function distTagsURL(packageName: string, registryURL: string = defaultRegistryURL): string {
	// The name is one path segment, so the `/` in a scoped name is `%2F` rather
	// than a separator. Interpolated raw, `/-/package/@ttylabs/sigil/dist-tags`
	// asks for a package called `@ttylabs` with `/sigil/dist-tags` trailing --
	// and `@ttylabs/sigil` is this framework's own name, so the one package the
	// check could not look up was itself. registry.npmjs.org happens to accept
	// all of `%40scope%2Fname`, `@scope%2fname` and the raw slash today, which
	// is why nothing caught this; `registryURL` is a caller's option, and a
	// self-hosted registry behind a proxy that normalizes paths is under no
	// obligation to be as forgiving. Encoding the whole segment is also what
	// stops anything else awkward in a name from rewriting the path.
	return `${registryURL.replace(/\/$/, '')}/-/package/${encodeURIComponent(packageName)}/dist-tags`;
}

/**
 * Builds the name of the file an update check caches a version in.
 */
export function cacheFileName(packageName: string, distTag: string): string {
	// A package name is not a filename. `@ttylabs/sigil` carries a slash, so
	// `join(cacheDir, ...)` made the scope a directory and scattered the cache
	// one level down -- not a failed write, since `check()` creates `dirname()`
	// of the whole path and so created the scope too, which is the half of this
	// that looks worse than it is.
	//
	// The half that is worse than it looks is the collision, and it is why the
	// transform is percent-encoding rather than a slash swapped for a dash: two
	// packages sharing a cache file share a version, and one of them is then
	// told the wrong thing to upgrade to. A dash cannot separate a name from a
	// tag, because a name may contain one -- `a-b` at tag `c` and `a` at tag
	// `b-c` were both `a-b-c.json`. The separator is `@` because
	// `encodeURIComponent()` leaves `-` alone but never leaves an `@`, so a
	// literal one cannot appear inside either half and splitting on it recovers
	// exactly what went in. `*` is the one character it leaves that Windows
	// refuses in a filename, so that one goes too.
	const enc = (s: string) => encodeURIComponent(s).replace(/\*/g, '%2A');
	return `${enc(packageName)}@${enc(distTag)}.json`;
}
