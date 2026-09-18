/**
 * Hooks: watching the parse, changing a command while it runs, and rewriting an
 * error on the way out.
 *
 *   node demos/parser/08-hooks.js build app.js
 *   node demos/parser/08-hooks.js build app.js --added
 *   node demos/parser/08-hooks.js missing
 */
import { main } from '@ttylabs/sigil';

await main({
	argv: process.argv.length > 2 ? undefined : ['build', 'app.js', '--added'],
	schema: {
		name: 'hooks',
		hooks: {
			beforeParse: (state) => console.log('[beforeParse]', state.$orig.join(' ')),
			afterParse: (state) => console.log('[afterParse] command:', state.cmd?.name),

			// a hook may replace an error, never swallow it
			beforeError: (err) =>
				err.message.startsWith('Unexpected argument')
					? new Error(`${err.message} -- try \`hooks --help\``)
					: undefined,
		},

		commands: {
			build: {
				args: ['<entry>'],
				hooks: {
					init: ({ options }) => console.log('[init] options so far:', options.size),

					// the registries are live: adding here means argv can use it
					parse: async ({ options }) => {
						console.log('[parse] adding --added');
						await options.add({ format: '--added', desc: 'Added by a hook' });
					},
				},
				run: ({ argv }) => console.log('[run]', argv),
			},
		},
	},
});
