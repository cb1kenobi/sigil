import { Internal, main } from '@ttylabs/sigil';
/**
 * One command running another, without going anywhere near `process.argv`.
 *
 *   node demos/parser/11-dispatch.js release
 *   node demos/parser/11-dispatch.js ship
 *   node demos/parser/11-dispatch.js ship --dry-run
 *   node demos/parser/11-dispatch.js shortcut
 *   node demos/parser/11-dispatch.js --help
 *
 * Two things an app wants from its own command tree, and both are one `main()`
 * call with a list of tokens:
 *
 *   re-routing   this command decides that another should handle the request
 *   executing    this command runs another as one step of its own work
 *
 * **The argv list is the interface, and that is deliberate.** It is the one
 * thing that goes through coercion, defaults, environment fallback, `choices`,
 * `transform`, the hooks and a lazy load -- so you never touch `process.argv`
 * and you never build a *string*, you build a list of tokens and the parser
 * does everything else. That is the palette's own rule one layer along: what is
 * dispatched is what you would have typed, so a value the schema refuses is
 * refused here exactly as it would be from a shell.
 *
 * `shortcut` is the command that earns the paragraph above. It reaches a
 * sibling through the registry and calls its `run()` directly, which is the
 * obvious shortcut and is **silently wrong in two different ways** -- and for a
 * lazily loaded command it is not merely wrong, there is nothing there to call.
 *
 * What the mechanism does **not** have is a recursion guard: two commands that
 * re-route to each other are an infinite loop, and `main()` says nothing about
 * it -- measured past two thousand levels deep, where it is a tail call through
 * promises rather than a stack overflow, so there is not even a throw to notice.
 * `ship` below cannot loop, and the reason is worth being exact about: not the
 * condition it routes on, but that the commands it routes *to* do no routing of
 * their own. A tree where two of them might route to each other needs a depth or
 * a visited set, and that is the app's to carry -- nothing here sees the cycle.
 *
 * It reads no keys, so there is nothing here that needs a terminal.
 */
import { join } from 'node:path';

/** The command `shortcut` and `release` both reach for. */
const clean = {
	desc: 'Remove the build output',
	options: {
		'--force': 'Do not ask',
		'--mode <mode>': { desc: 'How thorough', default: 'soft', choices: ['soft', 'hard'] },
	},
	run({ argv, cmd }) {
		console.log(
			`    clean: mode=${JSON.stringify(argv.mode)} force=${JSON.stringify(argv.force)} ` +
				`verbose=${JSON.stringify(argv.verbose)} cmd=${JSON.stringify(cmd?.name)}`
		);
	},
};

const schema = {
	name: 'rel',
	desc: 'One command running another',

	// a root option, so that what a nested dispatch does and does not inherit is
	// visible rather than a claim
	options: { '-v, --verbose': 'Say more' },

	commands: {
		clean,

		'build, b': {
			desc: 'Build the app',
			args: ['[target]'],
			options: { '--minify': 'Compress the output' },
			run({ argv }) {
				console.log(
					`    build: target=${JSON.stringify(argv.target ?? 'default')} ` +
						`minify=${JSON.stringify(argv.minify)}`
				);
			},
		},

		// a *deferred* command: its module is not read until something matches it,
		// which is what makes `shortcut`'s third finding possible at all
		deploy: { path: join(import.meta.dirname, 'commands', 'deploy.js') },

		release: { desc: 'Clean, build and deploy, in order', run: release },
		ship: {
			desc: 'Hand the request to whichever command should have it',
			options: { '--dry-run': 'Route to a build rather than a release' },
			run: ship,
		},
		shortcut: { desc: 'Why calling a sibling’s run() directly is a trap', run: shortcut },
	},
};

/**
 * Runs one command and hands its failure back rather than rendering it.
 *
 * `errorHandler: false` is the whole of what makes this composable. Left at the
 * default, a nested `main()` *renders* the error, sets `process.exitCode`, and
 * resolves with `undefined` -- so the step looks like it succeeded, the pipeline
 * carries on, and the message is printed by the inner call rather than by
 * whoever knows what the step was for. Measured: the outer call saw `undefined`
 * and an `exitCode` of 1, which is a failure a caller has to go looking for.
 *
 * The schema is `state.schema` rather than the module-level one, and that is
 * worth knowing because it is what keeps a dispatch from needing any setup at
 * all: a `run()` is handed the schema its own parse used -- measured,
 * `state.schema === schema` is `true` -- so a command can re-enter the parser
 * without closing over anything, and this whole function is one `main()` call
 * that an app only writes down because the forwarding and the error policy are
 * its own decisions rather than the framework's.
 *
 * @param {import('@ttylabs/sigil').ParseState} state - The calling command's.
 * @param {string[]} argv - The tokens, exactly as they would have been typed.
 * @returns {Promise<unknown>} Whatever the command returned.
 */
function run(state, argv) {
	// the root's options are re-read from *this* argv rather than inherited, so a
	// nested dispatch that wants them has to forward them. Measured: an outer
	// `--verbose` came back `false` inside the nested call, because the nested
	// argv never mentioned it
	const forwarded = state.argv.verbose === true ? ['--verbose', ...argv] : argv;
	return main({ argv: forwarded, schema: state.schema, settings: { errorHandler: false } });
}

/** Executing: three commands as three steps of one piece of work. */
async function release(state) {
	console.log(`
  Executing: each step is a token list through a full parse, so each one
  gets its own defaults, its own coercion and its own validation -- and
  "deploy" is read off disk on the way past, because the parse is what
  loads it.
`);

	for (const step of [
		['clean', '--mode', 'hard'],
		['build', 'dist', '--minify'],
		['deploy', 'prod'],
	]) {
		console.log(`  $ rel ${step.join(' ')}`);
		await run(state, step);
	}

	// and the half that is worth seeing fail: `choices` is enforced here exactly
	// as it is from a shell, which is the whole argument for the argv list being
	// the interface
	console.log('\n  $ rel clean --mode sideways');
	try {
		await run(state, ['clean', '--mode', 'sideways']);
	} catch (err) {
		console.log(`    refused: ${err.message}`);
	}
}

/** Re-routing: this command decides another should have the request. */
async function ship(state) {
	const to = state.argv.dryRun === true ? ['build', 'dist'] : ['release'];

	console.log(`
  Re-routing: "ship" does no work of its own. It looks at what it was
  given and hands the whole request to the command that should have had
  it -- which is a token list and a ${'`main()`'} call, the same two things
  executing a step is.

  $ rel ${to.join(' ')}
`);

	return run(state, to);
}

/**
 * The shortcut, and why it is one.
 *
 * A `run()` is handed the `ParseState`, which carries `contexts` -- the chain,
 * innermost first, ending at the root -- so every sibling really is reachable
 * through the root's registry. Calling one is where it goes wrong, and it goes
 * wrong quietly: the command runs, it simply runs over the wrong values.
 */
async function shortcut(state) {
	const root = state.contexts[state.contexts.length - 1];
	const registry = root[Internal].commands;
	// `find()` rather than `get()`: the registry is a `Map` of canonical names with
	// an alias table beside it, so `get()` is the raw `Map.get` and answers
	// `undefined` for an alias while `find()` resolves one -- which the line below
	// prints rather than claims. So `find()` is what takes a name anybody typed or
	// wrote, and `get()` only a name already known to be canonical. `values()` is
	// not that: it yields the commands themselves, where `keys()` yields the names
	const sibling = registry.find('clean');

	console.log(`
  Every sibling is reachable: ${[...registry.keys()].join(', ')}

  "b" is build's alias, which is the whole of find() against get():
      find("b") -> ${JSON.stringify(registry.find('b')?.name)}
      get("b")  -> ${JSON.stringify(registry.get('b')?.name)}

  (a) sibling.run(state) -- the state this command was handed
`);
	// `clean` sees *this* command's argv, so none of its own options exist and it
	// does not even know which command it is
	await sibling.run(state);
	console.log(`      mode and force are missing and cmd is wrong: it was handed
      "shortcut"'s values, because that is what it was passed.

  (b) sibling.run({ ...state, cmd: sibling, argv: { force: true } })
`);
	// closer, and the subtler failure: the value asked for arrives, the
	// *default* never does, the inherited root option is gone, and `choices`
	// was never consulted at all
	await sibling.run({ ...state, cmd: sibling, argv: { force: true } });
	console.log(`      force arrived, and mode is undefined where the declaration says
      "soft" -- the default was never applied. verbose is gone with it,
      and nothing checked the value against choices.

  (c) main({ argv: ['clean', '--force'], schema })
`);
	await run(state, ['clean', '--force']);
	console.log(`      everything: the default, the coercion, the inherited option,
      and the command knowing which command it is.`);

	// and the one that is not a matter of degree
	const deferred = registry.find('deploy');
	console.log(`
  Then the case that settles it. "deploy" is a deferred command, so the
  registry holds a placeholder:

      run      ${typeof deferred.run}
      desc     ${JSON.stringify(deferred.desc)}
      loaded   ${deferred[Internal].loaded}

  There is nothing to call. The desc is undefined only because this
  declaration gave none -- one written { path, desc } carries its own
  onto the placeholder, and run is the one thing no declaration supplies.

  So (a) and (b) are not wrong for a lazily loaded command, they are
  impossible -- and filesystem routing makes that the
  common case rather than the exotic one. A parse is what loads it, so
  (c) is the only one of the three that works at all.
`);
}

await main({
	argv: process.argv.length > 2 ? undefined : ['release'],
	schema,
});
