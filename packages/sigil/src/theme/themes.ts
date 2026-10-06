/**
 * Themes sigil ships, as the CSS an app hands to `themedCascade({ theme })`.
 *
 * A theme here is a value for each of the seven roles and nothing else, which is
 * the whole of what the role layer is for: `FRAMEWORK_CSS` puts every declaration
 * two built-ins share on a role, so seven declarations restyle a surface wearing a
 * dozen component classes.
 *
 * ## Why these are palette colours rather than hex
 *
 * A shipped theme cannot know what it is drawn against, and the tension is
 * arithmetic rather than aesthetic: a colour bright enough to read on black is
 * usually too light to read on white. Measured over the obvious candidates, with
 * WCAG contrast against both `#000` and `#fff`, every truecolor palette anybody
 * would reach for has entries below 3:1 on one side -- `#ffd166` is 1.44:1 on
 * white and `#1a1a1a` is 1.21:1 on black. There is no single hex value that is
 * safe on an unknown background.
 *
 * The basic sixteen are not colours, which is what gets round it: they are indices
 * the user's own terminal theme resolves, so the choice is delegated to the only
 * actor that knows what the background is. That is not a guarantee -- yellow on
 * white is hard for any theme -- but it is strictly better than this module
 * guessing, and it is the rule `FRAMEWORK_CSS` already keeps: every colour in it is
 * an index, which is why it needs no light half for anything except `dim`.
 *
 * So a theme that ships names indices. An **app's own** theme may use truecolor
 * freely: it knows its audience, and `@ttylabs/sigil/ansi` downsamples for a
 * terminal that cannot do better. What it owes in exchange is a
 * `@media (prefers-color-scheme: light)` half, because a hex value picked against
 * one background is a bet on that background.
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
 * Measured: with a frozen `Record` of all four beside them, an app importing
 * `VIOLET` alone bundled **all four**, because the map references each one and so
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
 * the one theme here that is unchanged by a terminal's own colours. At colour
 * level 0 it collapses to plain text like everything else -- the attributes go
 * too -- which is why no built-in relies on one to say what a line is.
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

/** Magenta where the defaults are cyan. */
export const VIOLET = `
.sigil-accent { color: magenta }
.sigil-muted { color: gray; dim: false }
.sigil-heading { color: brightMagenta }
.sigil-success { color: green }
.sigil-error { color: red }
.sigil-warn { color: yellow }
.sigil-info { color: blue }
`;

/** Green, with the cooler half of the sixteen behind it. */
export const FOREST = `
.sigil-accent { color: green }
.sigil-muted { color: gray; dim: false }
.sigil-heading { color: brightGreen }
.sigil-success { color: brightGreen }
.sigil-error { color: red }
.sigil-warn { color: yellow }
.sigil-info { color: cyan }
`;

/** Yellow and red, for a surface that reads warm. */
export const AMBER = `
.sigil-accent { color: yellow }
.sigil-muted { color: gray; dim: false }
.sigil-heading { color: brightYellow }
.sigil-success { color: green }
.sigil-error { color: brightRed }
.sigil-warn { color: brightYellow }
.sigil-info { color: magenta }
`;
