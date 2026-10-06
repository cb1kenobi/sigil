/**
 * A theme is seven declarations, and they restyle the whole surface.
 *
 *   pnpm build
 *   node demos/style/04-theme-switcher.js        <- needs a terminal; 1-5 switch, q quits
 *   node demos/style/04-theme-switcher.js | cat  <- the same themes, rendered one after another
 *
 * `02-themes.js` is the mechanism: a theme is a stylesheet origin, so restyling a
 * built-in is an ordinary rule. This one is the *vocabulary*. Every declaration
 * the framework shares between two built-ins is on a **role** --
 * `.sigil-accent`, `.sigil-muted`, `.sigil-heading`, `.sigil-success`,
 * `.sigil-error`, `.sigil-warn`, `.sigil-info` -- and an element carries its
 * component class and its role together.
 *
 * So the panel below wears a dozen component classes and every theme here sets
 * exactly seven things. Before the roles, "de-emphasise what the framework
 * de-emphasises" meant finding `.sigil-prompt-hint`, `.sigil-prompt-answer`,
 * `.sigil-prompt-placeholder`, `.sigil-choice-hint`, `.sigil-help-note` and
 * `.sigil-decrypt-cipher` and writing all six.
 *
 * Two things worth noticing in the themes themselves.
 *
 * None of them de-emphasises with `dim`, and that is deliberate: SGR 2 blends the
 * foreground *towards the background*, so it is grey on black one way and grey on
 * white the other. The framework's own sheet uses `dim` and carries a light half
 * for exactly that reason; a theme that uses a colour needs no second half, which
 * is the easier thing to get right. Run any of this under
 * `SIGIL_COLOR_SCHEME=light` to see the framework's half switch.
 *
 * And a theme that only works in colour is not a theme: `NO_COLOR=1` drops every
 * colour *and* every attribute, so run it that way to see the panel with the
 * roles doing nothing at all. It still has to read, which is why no line here
 * depends on colour to say what it is -- the marks carry that.
 */
import { supportsColor } from '@ttylabs/sigil/ansi';
import { table } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { parseStylesheet } from '@ttylabs/sigil/style';
import { parseTheme, themedCascade } from '@ttylabs/sigil/theme';

/**
 * The themes. Each one gives a colour to every role, every time.
 *
 * That is not tidiness, it is the mechanism: switching **adds** a sheet at origin
 * `theme` over the last one, because a cascade can `add` a sheet and cannot take
 * one away. So a property the new theme leaves out keeps whatever the previous
 * theme said -- miss `.sigil-error` out of one of these and the last theme's red
 * is still on screen under the new one's name.
 *
 * Two consequences worth seeing rather than being told.
 *
 * `framework` restates the defaults instead of being the absence of a sheet,
 * since there is nothing to remove -- going back means saying them again. It is
 * the only one here with a light half, because it is the only one that
 * de-emphasises with `dim`: SGR 2 blends the foreground *towards* the background,
 * so it is grey on black one way and grey on white the other, and a theme using it
 * owes the other scheme a rule. Try `SIGIL_COLOR_SCHEME=light`.
 *
 * And every colour theme says `dim: false` on `.sigil-muted`. A theme overrides
 * per *property*, so a theme that only sets a colour inherits the framework's
 * `dim: true` and the text comes out dim **and** coloured. `color: initial` is the
 * other half of the same rule: it is how a theme says "nothing here" rather than
 * leaving the last theme's value standing.
 */
const THEMES = [
	[
		'framework',
		`.sigil-accent { color: cyan }
		 .sigil-muted { color: initial; dim: true }
		 @media (prefers-color-scheme: light) { .sigil-muted { color: gray; dim: false } }
		 .sigil-heading { color: initial }
		 .sigil-success { color: green }
		 .sigil-error { color: red }
		 .sigil-warn { color: yellow }
		 .sigil-info { color: blue }`,
	],
	[
		'ember',
		`.sigil-accent { color: #ff7b29 }
		 .sigil-muted { color: #8a6a55; dim: false }
		 .sigil-heading { color: #ffd166 }
		 .sigil-success { color: #c2d94c }
		 .sigil-error { color: #ff4d4d }
		 .sigil-warn { color: #ffb300 }
		 .sigil-info { color: #d98cff }`,
	],
	[
		'ocean',
		`.sigil-accent { color: #35d0ba }
		 .sigil-muted { color: #5c7a8a; dim: false }
		 .sigil-heading { color: #9fe8ff }
		 .sigil-success { color: #4fd6a0 }
		 .sigil-error { color: #ff6b8a }
		 .sigil-warn { color: #ffd479 }
		 .sigil-info { color: #7aa2f7 }`,
	],
	[
		'grape',
		`.sigil-accent { color: magenta }
		 .sigil-muted { color: #7a6b8a; dim: false }
		 .sigil-heading { color: #e0b0ff }
		 .sigil-success { color: #9fe88a }
		 .sigil-error { color: #ff5d8f }
		 .sigil-warn { color: #ffc94d }
		 .sigil-info { color: #8ab4ff }`,
	],
	[
		'paper',
		// for a light terminal: the same seven roles, picked to sit on white
		`.sigil-accent { color: #0b6e99 }
		 .sigil-muted { color: #6b6b6b; dim: false }
		 .sigil-heading { color: #1a1a1a }
		 .sigil-success { color: #1b7f3b }
		 .sigil-error { color: #b3261e }
		 .sigil-warn { color: #8a5a00 }
		 .sigil-info { color: #3b4ea8 }`,
	],
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
 * right on top of the framework's gray de-emphasis in light mode. Parsed at module scope so that a typo in it fails the piped
 * demos test, which never reaches the terminal branch below.
 */
const layout = parseStylesheet(`
	.panel { flex-direction: column; width: 48; border: round; padding: 1 }
	.row { flex-direction: row; column-gap: 1 }
	.bar { height: 1; width: 24 }
`);

/**
 * The panel, wearing the classes the built-ins really emit.
 *
 * It hands back the heading as well as the box, because the live branch has to
 * write the theme's name into it -- and reaching it as `children[0]` would be a
 * position rather than a reference, which is a thing that moves the moment
 * anything is added above it.
 */
function panel(name) {
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
		text('(seven declarations, a dozen classes)', { class: 'sigil-help-note sigil-muted' })
	);

	return { heading, view };
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
		// turn this off is the user: `NO_COLOR` and `FORCE_COLOR=0` are somebody
		// saying something, where a pipe and a missing `TERM` are only a destination
		env: { TERM: 'xterm-256color', ...process.env },
		stream: { columns: 80, isTTY: true },
	});

	for (const [name, css] of THEMES) {
		const cascade = themedCascade({ sheets: [layout], theme: css });

		console.log(renderToString(panel(name).view, { cascade, colorLevel, width: 50 }));
		console.log(table(ROWS, { colorLevel, indent: 2, sheets: [layout], theme: css }));
		console.log();
	}

	console.log('On a terminal this is one panel with 1-5 switching the theme under it.');
}

/** One tree, one renderer, and a number key swaps the sheet under it. */
function live() {
	let at = 0;

	// the cascade is kept, because switching is a sheet added to *this* one and a
	// `touchSheets()` to say every rule it matched is stale. That is the one thing
	// only the owner of a restyler can do, which is why the handle exposes it
	const cascade = themedCascade({ sheets: [layout], theme: THEMES[0][1] });

	let heading;

	function App() {
		const built = panel(THEMES[at][0]);
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

			cascade.add(parseTheme(css));
			// the heading names the theme, so it is the one thing the switch has to
			// write rather than restyle
			heading.setText(`theme: ${name}`);
			view.restyler.touchSheets();
			view.frame();
		}
	});
}
