/**
 * The themes sigil ships, swapped under a live frame.
 *
 *   pnpm build
 *   node demos/style/04-theme-switcher.js        <- needs a terminal; 1-5 switch, q quits
 *   node demos/style/04-theme-switcher.js | cat  <- the same themes, rendered one after another
 *   SIGIL_COLOR_SCHEME=light node demos/style/04-theme-switcher.js
 *   NO_COLOR=1 node demos/style/04-theme-switcher.js
 *
 * `02-themes.js` is the mechanism: a theme is a stylesheet origin, so restyling a
 * built-in is an ordinary rule. This is the *vocabulary* and what ships with it.
 *
 * Every declaration the framework shares between two built-ins is on a **role** --
 * `.sigil-accent`, `.sigil-muted`, `.sigil-heading`, `.sigil-success`,
 * `.sigil-error`, `.sigil-warn`, `.sigil-info` -- and an element carries its
 * component class and its role together. So the panel below wears a dozen
 * component classes and each theme sets exactly seven things. Before the roles,
 * "de-emphasise what the framework de-emphasises" meant finding
 * `.sigil-prompt-hint`, `.sigil-prompt-answer`, `.sigil-prompt-placeholder`,
 * `.sigil-choice-hint`, `.sigil-help-note` and `.sigil-decrypt-cipher` and writing
 * all six.
 *
 * The named themes come from `@ttylabs/sigil/themes`, which an app imports by name
 * so that a bundler drops the ones it did not take -- measured: an app importing
 * `VIOLET` alone bundles `VIOLET` and shakes the rest out.
 *
 * Every colour in them is a palette index rather than a hex value, which is what
 * makes a shipped theme safe on a background it cannot see. The tension is
 * arithmetic: a colour bright enough to read on black is usually too light to read
 * on white, and measured with WCAG contrast against both, every truecolor palette
 * anybody reaches for has entries below 3:1 on one side. An index delegates the
 * choice to the only actor that knows the background -- the user's own terminal
 * theme. An app's own theme may use truecolor freely, and owes the other scheme a
 * `@media (prefers-color-scheme: light)` half when it does.
 *
 * `NO_COLOR=1` drops every colour *and* every attribute, so run it that way to see
 * the panel with the roles doing nothing at all. It still has to read, which is why
 * no line here depends on colour to say what it is -- the marks carry that.
 */
import { supportsColor } from '@ttylabs/sigil/ansi';
import { table } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { parseStylesheet } from '@ttylabs/sigil/style';
import { parseTheme, themedCascade } from '@ttylabs/sigil/theme';
import { AMBER, FOREST, MONO, NEON, VIOLET } from '@ttylabs/sigil/themes';

/** The seven roles, which is the whole of what a theme is a value for. */
const ROLES = ['accent', 'muted', 'heading', 'success', 'error', 'warn', 'info'];

/**
 * Every property any theme here sets, turned off for every role.
 *
 * A switcher needs this and an app does not, which is the distinction worth
 * drawing: an app picks one theme at startup and never switches, while switching
 * **adds** a sheet over the last one because a `Cascade` has `add` and no `remove`.
 * So a property the new theme does not mention keeps whatever the old one said --
 * measured, going from `MONO` to `VIOLET` left MONO's `underline` on the heading,
 * its `inverse` on the error and its `italic` on the info line, because a colour
 * theme has no reason to mention any of them.
 *
 * Prepending this makes each switch complete whatever came before it. It is also
 * why `sigil` below has to restate the defaults rather than being the absence of a
 * sheet: there is nothing to remove, so going back means saying them again.
 */
const RESET = ROLES.map(
	(role) =>
		`.sigil-${role} { color: initial; dim: false; font-weight: normal; ` +
		`text-decoration: none; inverse: false; italic: false }`
).join('\n');

/** The framework's own defaults, restated so that the switcher can return to them. */
const SIGIL = `
.sigil-accent { color: cyan }
.sigil-muted { dim: true }
.sigil-heading { font-weight: bold }
.sigil-success { color: green }
.sigil-error { color: red }
.sigil-warn { color: yellow }
.sigil-info { color: blue }

@media (prefers-color-scheme: light) {
	.sigil-muted { color: gray; dim: false }
}
`;

/** What a number key selects. `sigil` first, because it is what you start on. */
const THEMES = [
	['sigil', SIGIL],
	['mono', MONO],
	['violet', VIOLET],
	['forest', FOREST],
	['amber', AMBER],
	['neon', NEON],
];

const ROWS = [
	{ file: 'dist/index.mjs', size: '12.4 kB', note: 'entry' },
	{ file: 'dist/ansi.mjs', size: '4.9 kB', note: '' },
];

/**
 * Layout only, at origin `app`.
 *
 * Nothing here names a colour -- not even the border, which is why it stays the
 * terminal's own foreground while everything inside it moves. The point is that
 * every colour on screen arrives through a role, and a gray border would also sit
 * right on top of the framework's gray de-emphasis in light mode.
 *
 * Parsed at module scope so that a typo in it fails the piped demos test, which
 * never reaches the terminal branch below.
 */
const layout = parseStylesheet(`
	.panel { flex-direction: column; width: 48; border: round; padding: 1 }
	.row { flex-direction: row; column-gap: 1 }
`);

/** A theme as the switcher applies it: complete, whatever was applied before it. */
const sheetFor = (css) => parseTheme(`${RESET}\n${css}`);

/**
 * The panel, wearing the classes the built-ins really emit.
 *
 * It hands back the heading as well as the box, because the live branch has to
 * write the theme's name into it -- and reaching it as `children[0]` would be a
 * position rather than a reference, which is a thing that moves the moment
 * anything is added above it.
 */
function panel(name, keys) {
	const line = (mark, markClass, label, labelClass) =>
		box(
			{ class: 'row' },
			text(mark, { class: markClass }),
			text(label, { class: labelClass ?? '' })
		);

	const heading = text(`theme: ${name}`, { class: 'sigil-prompt-message sigil-heading' });

	const view = box(
		{ class: 'panel' },
		heading,
		text('', {}),
		line('?', 'sigil-symbol sigil-accent', 'what is your name?', 'sigil-prompt-message'),
		line(' ', '', 'press enter to accept', 'sigil-prompt-hint sigil-muted'),
		text('', {}),
		line('✔', 'sigil-symbol is-success sigil-success', 'built in 1.2s'),
		line('✖', 'sigil-symbol is-error sigil-error', 'two type errors'),
		line('▲', 'sigil-symbol is-warn sigil-warn', 'no baseDir declared'),
		line('ℹ', 'sigil-symbol is-info sigil-info', 'cached from a previous run'),
		text('', {}),
		text('████████████░░░░░░░░░░░░', { class: 'sigil-progress-bar sigil-accent' }),
		text('(seven declarations, a dozen classes)', { class: 'sigil-help-note sigil-muted' }),
		// the keys, where there are keys to press. Wrapping `text`s rather than a row
		// of them, so that adding a theme cannot push the line off the panel
		...(keys === undefined
			? []
			: [text('', {}), ...keys.map((row) => text(row, { class: 'sigil-help-note sigil-muted' }))])
	);

	return { heading, view };
}

/**
 * The key map, built from `THEMES` so that it cannot drift from it.
 *
 * Adding a theme adds its key here, which is the whole reason this is derived
 * rather than written out -- a hint naming four of five themes is worse than no
 * hint, because it reads as though the fifth key does nothing.
 *
 * Laid out as a padded grid rather than one wrapping line, because wrapping breaks
 * on whitespace and the gap between a key and its theme is whitespace: at this
 * width a single line put `3` at the end of one row and the name at the start of
 * the next. `q` is one more entry rather than a line of its own, since it is a key
 * like the others.
 */
function keyHint() {
	const entries = [...THEMES.map(([name], i) => `${String(i + 1)} ${name}`), 'q quit'];
	const column = Math.max(...entries.map((entry) => entry.length)) + 2;
	const rows = [];

	for (let at = 0; at < entries.length; at += 3) {
		rows.push(
			entries
				.slice(at, at + 3)
				.map((entry) => entry.padEnd(column))
				.join('')
				.trimEnd()
		);
	}

	return rows;
}

if (process.stdin.isTTY && process.stdout.isTTY) {
	live();
} else {
	piped();
}

/** Every theme, one after another -- which needs no terminal and no keys. */
function piped() {
	// a pipe has no colour and the whole point of this branch is seeing the themes
	// side by side -- so the level is asked for a *terminal* rather than for this
	// stream. That is `supportsColor()`'s own answer rather than a `3` written here,
	// which is what keeps `NO_COLOR=1` and `FORCE_COLOR=0` working: both of those
	// are a user saying something, where a pipe is only a destination. Said on both
	// halves because `renderToString()` defaults to truecolor while `table()` asks
	// the environment, so a block would otherwise disagree with itself
	const colorLevel = supportsColor({
		// `TERM` only where the environment has none, so that the one thing able to
		// turn this off is the user
		env: { TERM: 'xterm-256color', ...process.env },
		stream: { columns: 80, isTTY: true },
	});

	for (const [name, css] of THEMES) {
		const cascade = themedCascade({ sheets: [layout], theme: `${RESET}\n${css}` });

		console.log(renderToString(panel(name).view, { cascade, colorLevel, width: 50 }));
		console.log(table(ROWS, { colorLevel, indent: 2, sheets: [layout], theme: css }));
		console.log();
	}

	console.log(`On a terminal this is one panel instead, with ${keyHint().join('  ')}.`);
}

/** One tree, one renderer, and a number key swaps the sheet under it. */
function live() {
	let at = 0;

	// the cascade is kept, because switching is a sheet added to *this* one and a
	// `touchSheets()` to say every rule it matched is stale. That is the one thing
	// only the owner of a restyler can do, which is why the handle exposes it
	const cascade = themedCascade({ sheets: [layout] });
	cascade.add(sheetFor(SIGIL));

	let heading;

	function App() {
		const built = panel(THEMES[at][0], keyHint());
		heading = built.heading;
		return built.view;
	}

	const view = render(App, { cascade, width: 'auto' });
	const input = createInput({ root: view.root });

	input.bind((event) => {
		const { key } = event;

		if (isAbort(key) || key.name === 'q') {
			event.stop();
			view.dispose();
			input.stop();
			console.log(`stopped on ${THEMES[at][0]}`);
			return;
		}

		const n = Number(key.name);
		if (Number.isInteger(n) && n >= 1 && n <= THEMES.length) {
			event.stop();
			at = n - 1;
			const [name, css] = THEMES[at];

			cascade.add(sheetFor(css));
			// the heading names the theme, so it is the one thing the switch has to
			// write rather than restyle
			heading.setText(`theme: ${name}`);
			view.restyler.touchSheets();
			view.frame();
		}
	});
}
