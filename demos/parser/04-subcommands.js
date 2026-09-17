/**
 * Nested commands, aliases, hidden commands, and how options resolve.
 *
 *   node demos/parser/04-subcommands.js db migrate up --steps 2
 *   node demos/parser/04-subcommands.js db m up
 *   node demos/parser/04-subcommands.js -v db migrate up
 *   node demos/parser/04-subcommands.js db migrate up -v
 *   node demos/parser/04-subcommands.js --help
 *   node demos/parser/04-subcommands.js help db
 */
import { main } from '@ttylabs/sigil';

await main({
	argv: process.argv.length > 2 ? undefined : ['db', 'migrate', 'up', '--steps', '2'],
	schema: {
		name: 'stack',
		desc: 'Commands inside commands',

		// declared once at the root, and every command below can use it -- before
		// or after the command name, either works
		options: { '-v, --verbose': 'Say more' },

		commands: {
			// the first bare label names the command, the rest are aliases
			'db, d': {
				desc: 'Database commands',
				options: { '--url [dsn]': { default: 'postgres://localhost', desc: 'Connection string' } },
				commands: {
					'migrate, m': {
						desc: 'Run migrations',
						args: ['<direction>'],
						options: { '--steps [n]': { default: 1, type: 'int' } },
						run({ argv, contexts }) {
							console.log('direction:', argv.direction, 'steps:', argv.steps);
							// the whole chain is inherited, innermost first
							console.log('url from the parent:', argv.url);
							console.log('verbose from the root:', argv.verbose);
							console.log('context chain:', contexts.map((c) => c.name).join(' <- '));
						},
					},
				},
			},

			// `!` keeps a command out of help without stopping it working
			'!internal': {
				desc: 'Not listed, still runs',
				run: () => console.log('you found it'),
			},
		},
	},
});
