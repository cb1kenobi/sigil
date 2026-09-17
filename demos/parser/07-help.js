/**
 * The generated help screen: groups, contributed sections, and replacing it.
 *
 *   node demos/parser/07-help.js --help
 *   node demos/parser/07-help.js build --help
 *   node demos/parser/07-help.js release --help
 *   node demos/parser/07-help.js help build
 */
import { main } from '@ttylabs/sigil';

await main({
	argv: process.argv.length > 2 ? undefined : ['build', '--help'],
	schema: {
		name: 'helpdemo',
		desc: 'What the help screen can do',
		options: { '-v, --verbose': 'Say more' },
		commands: {
			build: {
				desc: 'Build the project',
				options: {
					'--target [name]': { choices: ['esm', 'cjs'], desc: 'Output format' },

					// `group` gives an option its own heading
					'--sourcemap': { desc: 'Emit source maps', group: 'Advanced' },
					'--tsconfig [path]': { desc: 'Use a different config', group: 'Advanced' },

					// hidden still parses, it is just not listed
					'--experimental': { desc: 'Not listed', hidden: true },
				},

				hooks: {
					// a section is described but not parsed, which is the point: a
					// command can document every platform's options while only the
					// platform that was named actually parses
					help: [
						({ sections }) =>
							sections.add({
								title: 'iOS',
								options: {
									'--sdk [version]': 'iOS SDK version',
									'--simulator [udid]': 'Simulator to run on',
								},
							}),
					],
				},

				run: () => console.log('built'),
			},

			release: {
				desc: 'A command that writes its own help',
				// a function is handed the generated screen and may add to it; a
				// string replaces it outright
				help: ({ generated }) => `${generated}\n\nSee https://example.com/releasing`,
				run: () => console.log('released'),
			},
		},
	},
});
