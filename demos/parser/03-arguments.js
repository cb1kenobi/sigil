/**
 * Positional arguments: required, optional, and variadic.
 *
 *   node demos/parser/03-arguments.js copy a.txt b.txt c.txt dist/
 *   node demos/parser/03-arguments.js copy
 *   node demos/parser/03-arguments.js env prod
 *   node demos/parser/03-arguments.js env nope
 */
import { main } from '@ttylabs/sigil';

await main({
	argv: process.argv.length > 2 ? undefined : ['copy', 'a.txt', 'b.txt', 'dist/'],
	schema: {
		name: 'args',
		commands: {
			copy: {
				desc: 'Copy files somewhere',
				// `<>` is required, `[]` is optional, `...` collects the rest. A bare
				// name is optional here, unlike Commander
				args: ['<source>', '[rest...]'],
				run({ argv, _ }) {
					console.log('source:', argv.source);
					console.log('rest:  ', argv.rest);
					console.log('all positionals:', _);
				},
			},

			env: {
				desc: 'An argument with choices and a default',
				args: [{ name: 'stage', choices: ['dev', 'prod'], default: 'dev' }],
				run({ argv }) {
					console.log('stage:', argv.stage);
				},
			},
		},
	},
});
