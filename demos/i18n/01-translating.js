/**
 * Translating: the English sentence is the key, plurals, a prompt's own
 * vocabulary, and changing the locale while the app is running.
 *
 *   node demos/i18n/01-translating.js
 *   LANG=de_DE.UTF-8 node demos/i18n/01-translating.js
 *   SIGIL_LOCALE=pl node demos/i18n/01-translating.js   # four plural forms
 *   SIGIL_LOCALE=ja node demos/i18n/01-translating.js   # one plural form
 *   LANG=de_DE.UTF-8 node demos/i18n/01-translating.js --help
 */
import { main } from '@ttylabs/sigil';
import { __, __n, confirmKeys, locale, setLocale } from '@ttylabs/sigil/i18n';

// A catalog is keyed by the English sentence itself, with `{0}` and `{1}` where
// the values go. There is nothing to invent and nothing to look up: the key is
// the literal already at the call site, so a key no catalog carries renders the
// English rather than a placeholder.
//
// Written inline here because a loader is a function and may do anything. An
// app ships JSON and imports it, which is the body to write -- a literal
// specifier inside a dynamic import is the one shape `sigil build` can split,
// so each locale gets a chunk of its own and one is loaded.
const de = {
	// the slots are **reordered**, which is the whole reason numbered slots beat
	// `%s`: printf consumes its arguments in order and cannot do this
	'Copied {0} to {1}': 'Nach {1} wurde {0} kopiert',
	// a yes-or-no prompt's hint **is** its keys, so this one entry decides both
	// what `(J/n)` draws and that `j` answers it -- there is no second entry for a
	// translator to contradict
	'y/n': 'j/n',
	'{0} file changed': { one: '{0} Datei geändert', other: '{0} Dateien geändert' },
	// the framework's own chrome is keyed the same way, so `--help` translates
	// out of the same catalog with no second mechanism
	'Commands:': 'Befehle:',
	'Options:': 'Optionen:',
	'Say less': 'Weniger sagen',
	'Show help for a command': 'Hilfe zu einem Befehl anzeigen',
	'Usage:': 'Verwendung:',
	'[command]': '[Befehl]',
	'[options]': '[Optionen]',
	'say what changed': 'sagen, was sich geändert hat',
	'what this demo is for': 'wofür diese Demo gut ist',
};

const pl = {
	'Copied {0} to {1}': 'Skopiowano {0} do {1}',
	// `n` already means no in English, so it is named once rather than twice
	'y/n': 'tak/nie',
	// Polish has four categories and `Intl.PluralRules` knows them, so this
	// needs no grammar written for it: 1 is `one`, 2-4 are `few`, 5 and up are
	// `many`, and a fraction is `other`
	'{0} file changed': {
		few: '{0} pliki zmienione',
		many: '{0} plików zmienionych',
		one: '{0} plik zmieniony',
		other: '{0} pliku zmienionego',
	},
};

const ja = {
	'Copied {0} to {1}': '{0} を {1} にコピーしました',
	// the key is each half's first **code point**, so these are は and い -- a half
	// may be a whole word and the key is still one character of it
	'y/n': 'はい/いいえ',
	// one form for every count, so a plain string is taken rather than an object
	'{0} file changed': '{0} 個のファイルが変更されました',
	// ...and every chrome key is deliberately missing, so `--help` shows what a
	// partial catalog does: each one falls back to the English it was keyed on,
	// which is a working screen rather than a wall of `[missing: …]`
};

/** The two things this app says, built fresh every time it is asked. */
function say(label) {
	console.log(`\n  ${label}`);
	console.log(`    ${__`Copied ${'./src'} to ${'./dist'}`}`);

	// one count per plural category Polish distinguishes
	for (const n of [1, 2, 5]) {
		console.log(`    ${__n(n, '{0} file changed', '{0} files changed')}`);
	}

	// and what a `confirm()` would draw and read in this locale. Printed rather
	// than prompted on purpose: `confirmKeys()` is a function of the catalog entry,
	// so it needs no terminal and this demo stays one anybody can pipe
	const keys = confirmKeys(__`y/n`, true);
	console.log(
		`    confirm draws ${keys.hint}  yes: ${keys.yes.join(' ')}  no: ${keys.no.join(' ')}`
	);
}

await main({
	schema: {
		name: 'i18n',
		// a thunk rather than a value: this object literal is evaluated when the
		// module is imported, which is before `main()` has loaded anything -- so a
		// `__` written as a value here would always be English
		desc: () => __`what this demo is for`,
		locales: {
			de: () => Promise.resolve(de),
			ja: () => Promise.resolve(ja),
			pl: () => Promise.resolve(pl),
		},
		commands: {
			show: {
				default: true,
				desc: () => __`say what changed`,
				async run() {
					// what the environment resolved, which `main()` did before `parse()`
					// -- so a parse error and `--help` are already in this locale
					say(`as the environment resolved it: ${locale() ?? 'en (no catalog)'}`);

					// and now the thing `setLocale()` is for: the app has read its
					// config and knows better than `LANG` did
					for (const tag of ['de', 'pl', 'ja', undefined]) {
						await setLocale(tag);
						say(
							`after setLocale(${tag === undefined ? 'undefined' : `'${tag}'`}): ${locale() ?? 'en'}`
						);
					}

					console.log(`
Nothing printed above changed when the locale did, and that is the one thing to
take away: a string is translated where it is built. So each line is in the
locale that was in effect when it was written, and \`setLocale()\` reaches the
next one rather than the last.

Which is why a parse error and \`--help\` are always in the environment's locale:
both happen before a command runs, so an app that failed to parse never got to
read its config. Try it:

  LANG=de_DE.UTF-8 node demos/i18n/01-translating.js --help
  SIGIL_LOCALE=ja node demos/i18n/01-translating.js --help   # a partial catalog
`);
				},
			},
		},
		// the shorthand takes a thunk too, because a string there *is* a `desc`
		options: { '--quiet': () => __`Say less` },
	},
});
