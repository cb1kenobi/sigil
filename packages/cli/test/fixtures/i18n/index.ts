import { __, __n } from '@ttylabs/sigil/i18n';

export default {
	baseDir: import.meta.dirname,
	commands: './commands',
	locales: {
		de: () => import('./locales/de.json', { with: { type: 'json' } }),
		// a loader this build cannot read, which is reported rather than refused:
		// a loader is a function and may do anything at run time
		fr: async () => ({}),
	},
	name: 'fixture-i18n',
	options: {
		// a thunk, because this literal is evaluated when the module is imported
		// -- which is before `main()` has loaded a catalog, so a value here would
		// always be English
		'--where [w]': { desc: () => __`Where to put it` },
	},
};

/** A string the app owns, so the key set is not only the framework's. */
export function greeting(name: string): string {
	return __`Hello, ${name}!`;
}

/** And a plural, so the plural half of the key set has a caller. */
export function files(n: number): string {
	return __n(n, '{0} file changed', '{0} files changed');
}
