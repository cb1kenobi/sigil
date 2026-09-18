const dashCharRegExp = /[-_ ]+(\w)/g;

export function camelCase(str = ''): string {
	// `toUpperCase()` and not `toLocaleUpperCase()`: the locale one reads the
	// process locale, and in Turkish and Azeri `i` uppercases to `İ` (U+0130), so
	// `--log-info` landed on `logİnfo` on a machine set to `tr-TR` while
	// `Capitalize` -- which is how `src/infer.ts` writes this rule in the type
	// system, and which is locale-independent -- still said `logInfo`. The types
	// and the destination disagreeing is a bug nobody can reproduce, because `\w`
	// is ASCII and `i` is the only letter that differs, so an en-US CI never sees
	// it. A destination is a JavaScript identifier, not prose, and identifiers do
	// not have a language
	return str.replace(dashCharRegExp, (s, m) => m.toUpperCase());
}
