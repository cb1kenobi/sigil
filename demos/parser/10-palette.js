/**
 * A command palette, generated from the command registry.
 *
 * The point of this one is that there is no second catalog: every name,
 * description, alias, `hidden` flag, argument and required option the palette
 * shows is something the schema below already told the *parser*. Pick a command
 * and it asks for whatever that command needs, then hands the whole thing back
 * to `main()` as the argv you would have typed.
 *
 *   node demos/parser/10-palette.js                  <- opens the palette
 *   node demos/parser/10-palette.js db migrate up    <- the ordinary path
 *   node demos/parser/10-palette.js --help
 *
 * Type to filter, arrows or the page keys to move, Enter to run, Escape to
 * dismiss. Try `mig`, `dbs`, and `up` -- that last one is `migrate`'s alias,
 * which ranks it without being shown.
 *
 * It is a `default` command, which is how a palette is reached idiomatically:
 * the context chain a `run()` is handed is what the palette is scoped to, and
 * `main()` already dispatches whatever it answers with. The command is `hidden`
 * so that it does not offer to reopen itself.
 *
 * Needs a terminal on **both** sides, because `createInput()` refuses to exist
 * unless stdin and the terminal's output are both terminals: the query is read
 * off one and drawn to the other. Piped, it prints the catalog it would have
 * offered and exits 0, which is what the guard below does.
 */
import { main } from '@ttylabs/sigil';
import { commandCatalog, commandPalette, PromptError } from '@ttylabs/sigil/components';

const schema = {
	name: 'stack',
	desc: 'A palette over a command tree',

	options: { '-v, --verbose': 'Say more' },

	commands: {
		// `default` means the name is implied, so `stack` with no arguments runs
		// this one; `!` keeps it out of help and out of its own palette
		'!palette': {
			default: true,
			desc: 'Pick a command',
			run: open,
		},

		'db, d': {
			desc: 'Database commands',
			commands: {
				'migrate, m, up': {
					desc: 'Run migrations',
					args: [{ choices: ['up', 'down'], desc: 'Which way', name: '<direction>' }],
					options: { '--steps [n]': { default: 1, desc: 'How many', type: 'int' } },
					run: ({ argv }) => console.log('migrate', argv.direction, 'steps', argv.steps),
				},
				seed: {
					desc: 'Load fixtures',
					args: ['[fixture]'],
					run: ({ argv }) => console.log('seed', argv.fixture ?? '(all)'),
				},
			},
		},

		build: {
			desc: 'Build the app',
			args: ['<entry>'],
			// a required option: the palette asks for it too, because a command it
			// listed and then could not run is worse than one it did not list
			options: { '--target <name>': { choices: ['esm', 'cjs'], desc: 'Module format' } },
			run: ({ argv }) => console.log('build', argv.entry, 'as', argv.target),
		},

		deploy: {
			desc: 'Ship it',
			args: ['<host...>'],
			run: ({ argv }) => console.log('deploy to', argv.host.join(', ')),
		},

		// hidden, so it is in neither help nor the palette -- one rule, not two
		'!internal': { desc: 'Not listed, still runs', run: () => console.log('you found it') },
	},
};

/**
 * Opens the palette over the chain this command was dispatched in.
 *
 * @param state - The parse state, which is what the catalog reads.
 */
async function open(state) {
	// both sides, because the query is read off stdin and drawn to the terminal's
	// output -- a guard on stdin alone lets `| cat` through from a terminal and
	// prints a stack to the pipe
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.log('No terminal, so here is the catalog the palette reads:\n');
		for (const entry of commandCatalog(state)) {
			const needs = entry.slots.map((slot) => slot.label).join(' ');
			console.log(`  ${entry.label.padEnd(12)} ${entry.desc ?? ''}${needs ? `  [${needs}]` : ''}`);
		}
		console.log('\nEvery line of that came out of the registry the parser built.');
		return;
	}

	try {
		const chosen = await commandPalette(state);

		if (!chosen) {
			console.log('\nDismissed.');
			return;
		}

		console.log(`\n$ stack ${chosen.argv.join(' ')}\n`);
		// running a selection is dispatching a command, which `main()` already
		// does -- so the palette answers with an argv and nothing more
		await main({ argv: chosen.argv, schema });
	} catch (err) {
		if (err instanceof PromptError) {
			// the two ways a palette does not get answered, which differ in kind:
			// Escape is a dismissal and resolves, Ctrl-C is the abort
			console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
			process.exitCode = 1;
		} else {
			throw err;
		}
	}
}

await main({ schema });
