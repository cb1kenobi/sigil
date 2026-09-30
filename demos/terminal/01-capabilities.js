/**
 * What the environment guessed, what the terminal answered, and where they part.
 *
 *   node demos/terminal/01-capabilities.js        <- the whole picture
 *   node demos/terminal/01-capabilities.js | cat  <- the inference, and why that is all
 *
 * Everything sigil knew about its terminal, it used to infer from environment
 * variables: `supportsColor()` reads `TERM`, `COLORTERM` and `NO_COLOR`, and the
 * whole colour-degradation ladder hangs off that one guess. This asks instead.
 *
 * Two halves, because the interesting part is the fourth of the five sections it
 * prints. A terminal that exports `COLORTERM=truecolor` and then resolves as
 * something else is exactly what asking is for, and the only way anybody sees
 * that is a dump that prints both. So is a mode that was set and did not take:
 * the router turns bracketed paste on when it starts, so DECRPM should read it
 * back as `set` -- and if it does not, a mode we believe is set is off.
 *
 * With no terminal there is nobody to answer, so no router is built and no query
 * is written. It prints the inference, says so, and exits zero: a capability dump
 * has a perfectly good answer with no terminal, which is the guess, labelled as a
 * guess. `04-prompts.js` fails loudly instead because a prompt with nobody to
 * answer it has no answer at all.
 *
 * `packages/sigil/scripts/terminal-probe.mjs --detect` is the other half of this
 * and is not replaced by it: that one is run by hand against a real terminal to
 * falsify claims only a terminal can, and it imports `dist/` directly. This reads
 * the same capabilities back through the public API, which is also what makes it
 * prove the API is usable from outside the package.
 */
import { supportsColor } from '@ttylabs/sigil/ansi';
import { table } from '@ttylabs/sigil/components';
import {
	createInput,
	detectCapabilities,
	QUERY_TIMEOUT,
	queryCursor,
	queryMode,
} from '@ttylabs/sigil/input';

/** What a level means, so the number is not the only thing on the line. */
const LEVELS = ['no colour', '16 colours', '256 colours', 'truecolor'];

/**
 * The modes worth asking about, and each is here for its own reason.
 *
 * 2004 is bracketed paste, which the router turns on when it starts -- so it
 * should read back `set`, and anything else means a mode we believe is set is
 * not. 1006 is SGR mouse tracking, which nothing here turns on, so it is the
 * honest "off" case. 9999 is a mode no terminal has: it should come back
 * `unrecognised` rather than silent, and that distinction -- off versus never
 * heard of it -- is the whole reason to ask DECRPM anything.
 */
const MODES = [
	[2004, 'bracketed paste'],
	[1006, 'SGR mouse'],
	[9999, 'a mode nobody has'],
];

const show = (value) => (value === undefined || value === '' ? '<unset>' : value);

/** The environment half, which costs nothing and is always available. */
function inferred() {
	const level = supportsColor();
	return {
		level,
		rows: [
			{ Read: 'TERM', Value: show(process.env.TERM) },
			{ Read: 'COLORTERM', Value: show(process.env.COLORTERM) },
			{ Read: 'NO_COLOR', Value: show(process.env.NO_COLOR) },
			{ Read: 'FORCE_COLOR', Value: show(process.env.FORCE_COLOR) },
			{ Read: 'TERM_PROGRAM', Value: show(process.env.TERM_PROGRAM) },
			// read here rather than resolved, because turning a palette index into a
			// light or dark background is `prefers-color-scheme`'s and not this
			// ticket's. Printed anyway: it is half of what somebody debugging a
			// washed-out screen needs to see
			{ Read: 'COLORFGBG', Value: show(process.env.COLORFGBG) },
			{ Read: 'ColorLevel', Value: `${level} (${LEVELS[level]})` },
		],
	};
}

console.log('\nWhat the environment says');
const env = inferred();
console.log(table(env.rows, { columns: ['Read', 'Value'] }));

/**
 * A probe needs a terminal on **both** sides, and asking about one is a bug.
 *
 * The reply lands on stdin, so there has to be somebody to send it; the query is
 * written to stdout, so there has to be somewhere to write it -- and
 * `createInput()` refuses to exist unless both are terminals, for exactly that
 * reason. Asking only about stdin is what this did first, and the case it got
 * wrong is the one the header documents: `node … | cat` **from a terminal** leaves
 * stdin a TTY and pipes stdout, so the guard passed, `createInput()` threw, and
 * the demo printed a stack and a minified module over the dump. The demos test
 * could never catch it, because it spawns with stdin ignored, which takes the
 * other branch.
 */
const missing = [
	process.stdin.isTTY ? undefined : 'stdin is not a terminal, so nobody would answer',
	process.stdout.isTTY ? undefined : 'stdout is not a terminal, so there is nowhere to ask',
].filter(Boolean);

if (missing.length > 0) {
	// each side for its own reason, rather than one sentence about both: piping
	// *stdout* leaves a perfectly good stdin, so "nobody to answer" is the wrong
	// thing to say about it -- what is missing there is somewhere to write the query
	console.log(
		`Nothing was probed: ${missing.join(', and ')}.\n` +
			'Everything above is inference, which is what a CLI runs on -- a round trip is\n' +
			'not paid to print one line. Both streams have to be a terminal for the other\n' +
			'column, since the query goes out on one and the reply comes back on the other.\n'
	);
	// and no `process.exit(0)`, which is what this reached for first and is a way to
	// lose the output: `console.log` to a pipe is asynchronous, and exiting forces the
	// process down with the write still queued. Falling off the end of the module lets
	// node drain it -- and the demos test would have passed either way, since it
	// asserts an exit code and an empty stderr rather than that anything was printed
} else {
	// one router, because one thing owns stdin: a reply arrives on it interleaved
	// with whatever is being typed, and a private listener here is the failure the
	// router exists to replace
	const input = createInput();

	try {
		const started = Date.now();
		const caps = await detectCapabilities(input, {
			background: true,
			// what the environment inferred, which is the floor a reply may raise and may
			// not lower: zero is what `NO_COLOR` and a pipe produce, and neither is ours
			// to overrule
			colorLevel: env.level,
			geometry: true,
		});
		const took = Date.now() - started;

		// each of these is its own round trip, and each is here because it answers a
		// different question. The cursor is the one query whose reply cannot be told
		// from a key by its bytes, so it is asked on its own
		const cursor = await queryCursor(input);
		const modes = [];
		for (const [mode, name] of MODES) {
			modes.push({ label: `${mode} (${name})`, mode, state: await queryMode(input, mode) });
		}
		const whole = Date.now() - started;

		/**
		 * Whether the sentinel came back, which is not whether DA1 is *printable*.
		 *
		 * `CSI ? c` is a DA1 with no parameters: it ends the batch and every mode probe,
		 * and it has nothing to put in a table cell. Round one's fix for the blank cell
		 * used the parameter list as the test for both questions, so a terminal
		 * answering that one sequence was reported as having answered nothing and as
		 * having waited out every deadline -- while in fact four of the five probes had
		 * ended on it. Two questions, two reads.
		 */
		const sawSentinel = caps.replies.some((it) => it.kind === 'device' && it.prefix === '?');

		const answered = [];
		const silent = [];
		// an empty string is not an answer, for the same reason an empty parameter list is
		// not: `ESC ] 11 ; BEL` and `ESC P > | ST` both parse, and both come back as a
		// blank cell under a heading saying the terminal said something
		const say = (what, value) =>
			value === undefined || value === '' ? silent.push(what) : answered.push([what, value]);

		say('DA1 (device attributes)', caps.device?.length ? caps.device.join(';') : undefined);
		say('XTVersion (name)', caps.name);
		say('XTVersion (version)', caps.version);
		say('cell size', caps.cell && `${caps.cell.width}x${caps.cell.height}px`);
		say('text area', caps.pixels && `${caps.pixels.width}x${caps.pixels.height}px`);
		// on this branch the background comes back as the reply's own text: reading it
		// as a light or dark scheme is `prefers-color-scheme`'s
		const background = caps.replies.find((it) => it.kind === 'osc' && it.params[0] === 11);
		say('background (OSC 11)', background?.text);
		say('cursor position', cursor && `row ${cursor.row}, column ${cursor.column}`);
		for (const it of modes) {
			say(`mode ${it.label}`, it.state);
		}

		console.log(`\nWhat the terminal answered  (${took}ms for the batch)`);
		console.log(
			answered.length === 0
				? '  nothing at all, which is itself an answer: see below\n'
				: table(
						answered.map(([Query, Answer]) => ({ Answer, Query })),
						{ columns: ['Query', 'Answer'] }
					)
		);

		console.log('\nAsked and never answered');
		console.log(
			silent.length === 0
				? '  nothing -- every query came back\n'
				: `  ${silent.join('\n  ')}\n\n` +
						'  Silence is the only signal a terminal gives for a query it does not\n' +
						'  understand, which is why DA1 is written last as a sentinel: its reply means\n' +
						'  every query in the batch has been answered or never will be.\n' +
						// the cost is *measured* rather than worked out from which queries were
						// silent, because that arithmetic was wrong every way it was written: a
						// cursor report, a mode reply and an empty DA1 each end a probe early, so
						// counting the silences and multiplying told the reader a run had taken five
						// deadlines when it had taken one. A clock cannot be wrong about it
						`  ${sawSentinel ? 'It came back here' : 'It did not come back here'}, and the five probes came to ${whole}ms in all --\n` +
						`  against ${5 * QUERY_TIMEOUT}ms if every one of them had waited out its own deadline. The\n` +
						'  cursor query is the one with no sentinel, because a DA1 arriving first would\n' +
						`  end it before the position did, so a silent cursor always costs ${QUERY_TIMEOUT}ms.\n`
		);

		// disagreements and confirmations are kept apart, because a heading promising
		// disagreement over a paragraph saying the two agree is a heading that lies --
		// and the paste line is an agreement most of the time
		const apart = [];
		const together = [];

		if (caps.colorLevel !== undefined) {
			apart.push(
				`The environment said level ${env.level} (${LEVELS[env.level]}) and a version reply names a\n` +
					`  terminal known to do truecolor, so it is raised to ${caps.colorLevel}. Deliberately not\n` +
					`  attributed to "${caps.name}" above: a raise comes from *any* version reply, and\n` +
					'  the name reported is the first of them -- tmux answers for itself and can pass\n' +
					'  the outer terminal through, in which case the first name is not the one that\n' +
					'  did it. Read off the reply rather than worked out a second time here.'
			);
		}

		const claimsTruecolor =
			process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit';
		/**
		 * Which variable outranked `COLORTERM`, rather than a list of candidates.
		 *
		 * `supportsColor()` reads these three before it reads `COLORTERM`, and in this
		 * order -- and stdout is a terminal on this branch, so one of them is the
		 * answer whenever the claim did not carry. Naming the list instead was the
		 * first version, and a dump that hands the reader three things to check is a
		 * dump that has not answered. `NO_COLOR` is read as set only when it is not the
		 * empty string, which is the convention and is easy to get wrong here.
		 */
		const outranked =
			process.env.FORCE_COLOR !== undefined
				? `FORCE_COLOR=${process.env.FORCE_COLOR}`
				: process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== ''
					? `NO_COLOR=${process.env.NO_COLOR}`
					: process.env.TERM === 'dumb'
						? 'TERM=dumb'
						: undefined;

		if (claimsTruecolor && env.level < 3 && caps.colorLevel === undefined) {
			// the headline case, and the reason a dump prints both columns: something
			// overrode a claim the environment also makes, and one column cannot show it
			apart.push(
				`COLORTERM claims truecolor and the level resolved to ${env.level} (${LEVELS[env.level]}) anyway.\n` +
					(outranked === undefined
						? '  Nothing that `supportsColor()` reads first explains it, which makes this a\n' +
							'  bug in the inference rather than a setting -- worth reporting with the table\n' +
							'  above.\n'
						: `  ${outranked} outranks it: \`supportsColor()\` reads that before COLORTERM.\n`) +
					(env.level === 0
						? '  And no reply could raise it back, because a refinement may not raise a level\n' +
							'  off a floor of zero: that floor is what NO_COLOR and a pipe produce, and\n' +
							'  neither is ours to overrule.'
						: '  And no reply raised it back, because no name that answered is one the table\n' +
							'  knows does truecolor -- and a refinement raises a level, never lowers one.')
			);
		} else if (claimsTruecolor) {
			together.push(
				caps.name === undefined
					? 'COLORTERM claims truecolor and the terminal answered no XTVersion, so nothing\n' +
							'  confirms it. The claim stands anyway: a refinement never lowers a level,\n' +
							'  because COLORTERM is a thing people export on purpose, often precisely\n' +
							'  because their terminal sits behind a multiplexer that under-reports.'
					: `COLORTERM claims truecolor and the terminal calls itself ${caps.name}. Believed\n` +
							'  either way, for the same reason: a reply may raise a level, never lower one.'
			);
		}

		const paste = modes.find((it) => it.mode === 2004)?.state;
		if (paste === 'set') {
			together.push(
				'Bracketed paste reads back as set, and the router is what turned it on when it\n' +
					'  started. That is DECRPM earning its place: an app that asks for a mode\n' +
					'  otherwise has no way to find out that nothing happened. What it cannot tell\n' +
					'  apart is a mode that was already on, since both answer the same way.'
			);
		} else if (paste === 'permanently-set') {
			together.push(
				'Bracketed paste reads back as permanently-set, which is the mode locked on rather\n' +
					'  than the router having set it -- a request cannot produce that state, so this\n' +
					'  terminal would have answered the same before anything asked. The mode is on\n' +
					'  either way, which is what the app needed to know.'
			);
		} else if (paste === undefined) {
			apart.push(
				'Bracketed paste was asked for with `CSI ? 2004 h` and DECRQM answered nothing\n' +
					'  this can read -- silence, or a state outside the five DEC defines, which come\n' +
					'  to the same thing for a caller. So there is no telling a mode that did not\n' +
					'  take from a terminal that does not implement the query: the one case asking\n' +
					'  exists for that asking cannot close.'
			);
		} else if (paste === 'unrecognised') {
			apart.push(
				'Bracketed paste reads back as unrecognised, which is DECRQM working and saying\n' +
					'  this terminal has no such mode -- although it accepted `CSI ? 2004 h` without\n' +
					'  complaint, because an unknown mode is ignored rather than refused.'
			);
		} else {
			apart.push(
				`Bracketed paste reads back as ${paste} although the router turned it on. A mode we\n` +
					'  believe is set is off, which is exactly what there was no way to find out\n' +
					'  before there was something to ask.'
			);
		}

		if (answered.length === 0) {
			apart.push(
				'Nothing came back that this dump can read, so there is nothing to compare: the\n' +
					`  only column with anything in it is the environment. ${whole}ms went on asking.\n` +
					'  "Nothing at all" is the weaker claim on purpose -- a secondary device attributes\n' +
					'  reply, or an OSC with no numeric command, is a reply that arrived and that\n' +
					'  nothing here has a row for.'
			);
		}

		console.log('Where the two columns disagree');
		console.log(
			apart.length === 0 ? '  nothing -- the guess held up\n' : `  ${apart.join('\n\n  ')}\n`
		);

		if (together.length > 0) {
			console.log('And where they confirm each other');
			console.log(`  ${together.join('\n\n  ')}\n`);
		}
	} catch (error) {
		// a message and never a stack, which is the rule `errorHandler()` keeps: a
		// terminal that answers something this cannot read is a thing to say in one
		// line rather than a trace over the dump
		process.exitCode = 1;
		console.error(`Could not finish probing: ${error instanceof Error ? error.message : error}`);
	} finally {
		// put back what you attached: the router set raw mode and asked for the paste
		// markers, and a demo that leaves either on hands the shell back broken
		input.stop();
	}
}
