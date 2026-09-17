/**
 * Every option shape in one place: flags, values, types, defaults, the
 * environment, choices, repeats, and negation.
 *
 *   node demos/parser/02-options.js --target cjs -vv --define A=1 --define B=2
 *   node demos/parser/02-options.js --no-color --port 3000
 *   PORT=9000 node demos/parser/02-options.js
 *
 * An option that takes a value must be given one, so `--port` on its own is an
 * error rather than a zero -- `[n]` says the option may be left out, not that
 * its value may be. `--port=` does give a value, an empty one, which `int` has
 * no reading of:
 *
 *   node demos/parser/02-options.js --port     # Missing value for option --port
 *   node demos/parser/02-options.js --port=    # Invalid integer:
 *   node demos/parser/02-options.js --help
 */
import { main } from '@ttylabs/sigil';

await main({
	argv: process.argv.length > 2 ? undefined : ['--target', 'cjs', '-vv', '--define', 'A=1'],
	schema: {
		name: 'options',
		desc: 'One of each kind of option',
		commands: {
			show: {
				default: true,
				options: {
					// a flag is always true or false, never undefined
					'--minify': 'Minify the output',

					// `[value]` takes an optional value; `<value>` would make the
					// option itself required
					'--target [name]': { choices: ['esm', 'cjs'], default: 'esm', desc: 'Output format' },

					// a data type coerces argv, the environment, and a string default
					'--port [n]': { default: 8080, desc: 'Port to serve on', env: 'PORT', type: 'int' },

					// repeats collect into an array
					'--define [pair]': { desc: 'Define a global', multiple: true },

					// a counter counts its uses, and `-v=3` sets it outright
					'-v, --verbose': { desc: 'Say more, repeatable', type: 'count' },

					// two options, one destination: `color` is true or false
					'--color': { default: true, desc: 'Colorize output' },
					'--no-color': 'Turn color off',
				},
				run({ argv }) {
					console.log(argv);
				},
			},
		},
	},
});
