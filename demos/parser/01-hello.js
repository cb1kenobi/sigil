/**
 * The smallest thing that works: one command, one option, one argument.
 *
 *   node demos/parser/01-hello.js greet world
 *   node demos/parser/01-hello.js greet world --loud
 *   node demos/parser/01-hello.js --help
 */
import { main } from '@ttylabs/sigil';

await main({
	// a demo argv when you did not pass one, so the file does something on its own
	argv: process.argv.length > 2 ? undefined : ['greet', 'world'],
	schema: {
		name: 'hello',
		desc: 'A very small CLI',
		commands: {
			greet: {
				desc: 'Say hello to somebody',
				args: ['<who>'],
				options: { '--loud': 'Shout it' },
				run({ argv }) {
					const greeting = `Hello, ${argv.who}!`;
					console.log(argv.loud ? greeting.toUpperCase() : greeting);
				},
			},
		},
	},
});
