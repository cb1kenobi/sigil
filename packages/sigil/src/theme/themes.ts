/**
 * Themes sigil ships, as the CSS an app hands to `themedCascade({ theme })`.
 *
 * A theme here is a value for each of the seven roles and nothing else, which is
 * the whole of what the role layer is for: `FRAMEWORK_CSS` puts every declaration
 * two built-ins share on a role, so seven declarations restyle a surface wearing a
 * dozen component classes.
 *
 * ## Two palettes per colour theme, picked by the terminal rather than by the app
 *
 * Each of the four colour themes names the basic sixteen first and then a richer
 * set inside `@media (min-color-level: 2)`, per scheme. So a 16-colour terminal
 * gets the user's own palette, a 256-colour one gets the shade the theme actually
 * wanted, and a light background gets a value picked for white -- with no `if`
 * anywhere in the app, because the cascade already answers all three questions.
 *
 * `MONO` is the one with a single half, and that is what it is rather than an
 * omission: it names no colour, so there is no shade for a richer terminal to
 * improve on. Its light half is about `dim`, which is the one declaration whose
 * legibility depends on which way the background goes.
 *
 * That is why there is no `VIOLET_256` beside `VIOLET`. A pair of exports makes
 * the app choose, which means reading `ansi.level` and the scheme at startup and
 * getting it wrong on a terminal it did not anticipate; one theme carrying both
 * cannot be chosen wrongly. It also costs nothing extra to ship, since the two
 * halves are one string.
 *
 * ## Why the base half is palette indices
 *
 * At sixteen colours a shipped theme cannot know what it is drawn against, and the
 * tension is arithmetic rather than aesthetic: a colour bright enough to read on
 * black is usually too light to read on white. Measured with WCAG contrast against
 * both `#000` and `#fff`, every truecolor palette anybody reaches for has entries
 * below 3:1 on one side -- `#ffd166` is 1.44:1 on white and `#1a1a1a` is 1.21:1 on
 * black.
 *
 * The basic sixteen are not colours, which is what gets round it: they are indices
 * the user's own terminal theme resolves, so the choice is delegated to the only
 * actor that knows the background. The richer half can name a value precisely
 * *because* it is written per scheme -- it knows which background it is for.
 *
 * ## What each of these sets
 *
 * All seven roles, every time. Switching themes at runtime **adds** a sheet rather
 * than replacing one -- a `Cascade` has `add` and no `remove` -- so a role a theme
 * leaves out keeps whatever the previous one said. Ship an incomplete theme and
 * switching to it leaks.
 *
 * And `dim` is the one attribute that owes the other scheme a rule: SGR 2 blends
 * the foreground *towards* the background, so it is grey on black one way and grey
 * on white the other. Only `MONO` uses it, and it carries the light half the
 * framework's own sheet carries for the same reason.
 *
 * ## There is deliberately no map of them
 *
 * An enumeration would be convenient for an app offering a `--theme` option, and
 * it is refused because it defeats the one thing this module is shaped for.
 * Measured: with a frozen `Record` of all of them beside them, an app importing
 * `VIOLET` alone bundled **every one**, because the map references each and so
 * nothing is unreachable. With it gone, the same app bundles `VIOLET` and drops
 * the rest.
 *
 * So an app that offers a choice writes its own map of the themes it chose to
 * offer, and bundles exactly those -- which is the honest version anyway, since
 * which themes an app offers is the app's decision rather than this module's.
 */

/**
 * No colour at all: the seven roles told apart by attribute.
 *
 * For an app that wants a restrained surface rather than a different palette, and
 * the one theme here that is unchanged by a terminal's own colours -- so it has no
 * richer half, because there is no richer version of "not coloured". At colour
 * level 0 it collapses to plain text like everything else.
 */
export const MONO = `
.sigil-accent { color: initial; font-weight: bold }
.sigil-muted { color: initial; dim: true }
.sigil-heading { color: initial; font-weight: bold; text-decoration: underline }
.sigil-success { color: initial; font-weight: bold }
.sigil-error { color: initial; inverse: true }
.sigil-warn { color: initial; text-decoration: underline }
.sigil-info { color: initial; italic: true }

@media (prefers-color-scheme: light) {
	.sigil-muted { color: gray; dim: false }
}
`;

/**
 * Green on black, the way a monochrome monitor did it.
 *
 * Named for the coating rather than the colour: P1 phosphor is what made those
 * screens green, and `AMBER` below is the other one they came in.
 */
export const PHOSPHOR = `
.sigil-accent { color: green }
.sigil-muted { color: gray; dim: false }
.sigil-heading { color: brightGreen }
.sigil-success { color: brightGreen }
.sigil-error { color: red }
.sigil-warn { color: yellow }
.sigil-info { color: cyan }

@media (min-color-level: 2) {
	.sigil-accent { color: palette(46) }
	.sigil-muted { color: palette(243) }
	.sigil-heading { color: palette(83) }
	.sigil-success { color: palette(46) }
	.sigil-error { color: palette(203) }
	.sigil-warn { color: palette(227) }
	.sigil-info { color: palette(51) }
}

@media (min-color-level: 2) and (prefers-color-scheme: light) {
	.sigil-accent { color: palette(28) }
	.sigil-muted { color: palette(241) }
	.sigil-heading { color: palette(22) }
	.sigil-success { color: palette(28) }
	.sigil-error { color: palette(160) }
	.sigil-warn { color: palette(130) }
	.sigil-info { color: palette(30) }
}
`;

/**
 * Magenta where the defaults are cyan.
 */
export const VIOLET = `
.sigil-accent { color: magenta }
.sigil-muted { color: gray; dim: false }
.sigil-heading { color: brightMagenta }
.sigil-success { color: green }
.sigil-error { color: red }
.sigil-warn { color: yellow }
.sigil-info { color: blue }

@media (min-color-level: 2) {
	.sigil-accent { color: palette(171) }
	.sigil-muted { color: palette(243) }
	.sigil-heading { color: palette(183) }
	.sigil-success { color: palette(120) }
	.sigil-error { color: palette(203) }
	.sigil-warn { color: palette(221) }
	.sigil-info { color: palette(111) }
}

@media (min-color-level: 2) and (prefers-color-scheme: light) {
	.sigil-accent { color: palette(127) }
	.sigil-muted { color: palette(241) }
	.sigil-heading { color: palette(90) }
	.sigil-success { color: palette(28) }
	.sigil-error { color: palette(160) }
	.sigil-warn { color: palette(130) }
	.sigil-info { color: palette(26) }
}
`;

/**
 * Amber on black, the other colour a monochrome monitor came in -- with the rest
 * of the roles warmed to match.
 */
export const AMBER = `
.sigil-accent { color: yellow }
.sigil-muted { color: gray; dim: false }
.sigil-heading { color: brightYellow }
.sigil-success { color: green }
.sigil-error { color: brightRed }
.sigil-warn { color: brightYellow }
.sigil-info { color: magenta }

@media (min-color-level: 2) {
	.sigil-accent { color: palette(214) }
	.sigil-muted { color: palette(243) }
	.sigil-heading { color: palette(222) }
	.sigil-success { color: palette(148) }
	.sigil-error { color: palette(203) }
	.sigil-warn { color: palette(220) }
	.sigil-info { color: palette(176) }
}

@media (min-color-level: 2) and (prefers-color-scheme: light) {
	.sigil-accent { color: palette(166) }
	.sigil-muted { color: palette(241) }
	.sigil-heading { color: palette(130) }
	.sigil-success { color: palette(28) }
	.sigil-error { color: palette(160) }
	.sigil-warn { color: palette(94) }
	.sigil-info { color: palette(97) }
}
`;

/**
 * Magenta and cyan, which is what a build log looks like when it is having fun.
 *
 * Two accents rather than one: the bracketed labels and timestamps a tool prints
 * down the left take `heading`, and the things they are *about* -- versions, file
 * names, URLs -- take `accent`. Modelled on a dumber/BrowserSync log, where that
 * split is what makes a wall of output skimmable.
 */
export const NEON = `
.sigil-accent { color: brightMagenta }
.sigil-muted { color: gray; dim: false }
.sigil-heading { color: brightCyan }
.sigil-success { color: brightGreen }
.sigil-error { color: brightRed }
.sigil-warn { color: brightYellow }
.sigil-info { color: cyan }

@media (min-color-level: 2) {
	.sigil-accent { color: palette(201) }
	.sigil-muted { color: palette(243) }
	.sigil-heading { color: palette(51) }
	.sigil-success { color: palette(118) }
	.sigil-error { color: palette(203) }
	.sigil-warn { color: palette(227) }
	.sigil-info { color: palette(45) }
}

@media (min-color-level: 2) and (prefers-color-scheme: light) {
	.sigil-accent { color: palette(162) }
	.sigil-muted { color: palette(241) }
	.sigil-heading { color: palette(31) }
	.sigil-success { color: palette(28) }
	.sigil-error { color: palette(160) }
	.sigil-warn { color: palette(130) }
	.sigil-info { color: palette(24) }
}
`;
