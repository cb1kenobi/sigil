/**
 * Themes: the stylesheet origin between the framework's defaults and the app.
 *
 * Every built-in -- the spinner, the progress bar, the table, the prompts, and
 * the help screen -- draws itself with classes and no colours of its own, and
 * this module holds the sheet that gives those classes their colours. It is
 * parsed at origin `framework`, which is where a browser's user-agent stylesheet
 * sits, and that answers the question the ticket left open: **the defaults are a
 * framework origin rather than an app one.** An app that writes
 * `.sigil-spinner-frame { color: magenta }` beats them with an ordinary rule, no
 * `!important` and no specificity contest, because its own sheet is a later
 * origin -- which is only true because these are not.
 *
 * ```js
 * import { table } from '@ttylabs/sigil/components';
 *
 * table(rows, { theme: '.sigil-table-head { color: magenta }' });
 * ```
 *
 * A theme sits between the two: it may restyle every built-in without touching
 * what an app said about its own components, and an app may still override the
 * theme. That is one axis of the cascade doing all three jobs, rather than three
 * mechanisms that have to be kept in agreement.
 */

import type { Ansi, ColorLevel } from '../ansi/index.js';
import {
	Cascade,
	type ColorScheme,
	DEFAULT_MEDIA,
	forcedMotion,
	parseStylesheet,
	type ReducedMotion,
	schemeFromEnv,
	type Stylesheet,
} from '../style/index.js';

/**
 * The classes every built-in is drawn with, and nothing else.
 *
 * Read it as the list of names a theme may restyle. Two rules hold it together
 * and both matter. Nothing here sets a *layout* property that the component did
 * not already ask for in props -- a theme that changed a prompt's padding would
 * move the caret, and the component is what knows where that goes -- so this
 * sheet is colours and attributes. And no built-in carries a colour in its
 * props: a prop beats a sheet per property, so a colour written into a template
 * is one a theme cannot reach without `!important`, which is the trap
 * `!important` exists to get out of rather than a thing to walk into.
 *
 * The same rule is a *theme's* to keep, and nothing enforces it: a theme is
 * ordinary CSS over an ordinary cascade, so it may set any property it likes.
 * Where a built-in worked its own geometry out -- the table's column widths, the
 * prompt's caret -- a layout property from a theme is a number the component
 * never heard about. `box-sizing` starts at `border-box` here, so
 * `.sigil-table-cell { padding-left: 3 }` takes three columns *out of* a width
 * the table measured, and a narrow column comes out empty. That is what CSS does
 * with a border-box width, and it is the theme author's to get right; what this
 * sheet can promise is only that the defaults do not do it.
 *
 * The state classes are spelled `is-*` because they are states rather than
 * kinds: `:focus` and `:hover` are the cascade's own and are used where they
 * apply, and these are the ones a terminal has no pseudo-class for.
 */
export const FRAMEWORK_CSS = `
/*
 * The classes that carry no default and are here to be written against:
 *   .sigil-spinner  .sigil-spinner-text
 *   .sigil-progress  .sigil-progress-label  .sigil-progress-percent
 *   .sigil-table  .sigil-table-row  .sigil-table-cell
 *   .sigil-prompt  .sigil-prompt-line  .sigil-prompt-field
 *   .sigil-choice  .sigil-choice-pointer  .sigil-choice-mark  .sigil-choice-hint
 *   .sigil-scroll  .sigil-scroll-row  .sigil-scroll-viewport  .sigil-scroll-content
 *   .sigil-scroll-bar  .sigil-scroll-slot  .sigil-scroll-spacer
 *   .sigil-typewriter  .sigil-typewriter-text
 *   .sigil-large-text  .sigil-large-text-body
 *   .sigil-decrypt  .sigil-decrypt-text
 *   .sigil-help
 * A class with no rule is still a hook; giving it an empty rule would be a
 * declaration that says nothing and a line for somebody to wonder about.
 */

/* the mark a prompt or a settled spinner leads with */
.sigil-symbol { color: cyan }
.sigil-symbol.is-success { color: green }
.sigil-symbol.is-error { color: red }
.sigil-symbol.is-warn { color: yellow }
.sigil-symbol.is-info { color: blue }

/* spinner */
.sigil-spinner-frame { color: cyan }

/* progress */
.sigil-progress-bar { color: cyan }

/* table */
.sigil-table-head { font-weight: bold }

/* prompts */
.sigil-prompt-message { font-weight: bold }
.sigil-prompt-hint { dim: true }
.sigil-prompt-answer { dim: true }
.sigil-prompt-placeholder { dim: true }
.sigil-prompt-error { color: red }
.sigil-caret { inverse: true }
.sigil-choice.is-active { color: cyan }
.sigil-choice-mark.is-on { color: green }
.sigil-choice-hint { dim: true }

/*
 * scroll box
 *
 * Two classes rather than one, because the track and the thumb are two elements
 * stacked over one rectangle and each resolves its own style -- which is the
 * whole reason the bar is built that way. Both are palette indices, so neither
 * needs a light half: 8 is the one a light theme has to render text in, so it is
 * dark there and grey here, and cyan is whatever the user chose it to be.
 */
.sigil-scroll-track { color: gray }
.sigil-scroll-thumb { color: cyan }

/*
 * decrypt
 *
 * The one declaration, and it is a state rather than a kind: while any cell is
 * still hidden the whole block is de-emphasised, and the frame that resolves the
 * last cell is what brings it up to full strength. That is the component's reveal
 * beat expressed in the cascade, and it is as far as a colour can go here --
 * colouring resolved cells apart from hidden ones would need an element per run
 * of them, and three texts in a row are placed beside each other's boxes rather
 * than after each other's last line.
 *
 * Nothing is drawn differently at colour level 0, deliberately: the attributes go
 * there along with the colour, so what is left is the characters changing, which
 * is the whole effect. A decrypt asked for plain text gets plain text.
 */
.sigil-decrypt-text.is-masked { dim: true }

/* help */
.sigil-help-heading { font-weight: bold }
.sigil-help-note { dim: true }

/*
 * And the light half, which is smaller than it looks and is the honest size.
 *
 * Nearly nothing above needs one: every colour in this sheet is a palette index,
 * and the basic sixteen are whatever the user's terminal theme says they are -- so
 * a colour like cyan is one they already chose to be legible against their own
 * background. That rule is why this sheet has so little to fix, and it is also
 * exactly why an *app* or a *theme* needs the feature: a #666 somebody wants for
 * de-emphasis is legible on one background and invisible on the other, and nothing
 * about the sixteen helps there.
 *
 * What does not follow the theme is the dim attribute, which is the one declaration
 * here whose legibility depends on which way the background goes. SGR 2 is rendered
 * by blending the foreground *towards the background*, so on a dark terminal dim
 * grey sits on black and on a light one it sits on white -- and grey on white is
 * the unreadable parenthetical this feature was asked for. The light half carries
 * the de-emphasis on a palette index instead, so it is still the user's own colour
 * and it is still legible: gray is index 8, which a light theme renders dark
 * because it has to render *text* in it.
 *
 * Conservative on purpose: the states, the symbols and the bars are left alone,
 * because a palette colour is already the right answer for them and changing one
 * here would be inventing a problem to solve.
 *
 * No backtick and no dollar-brace anywhere in this string, because it is a template
 * literal: a backtick in a comment ends the sheet, which is a syntax error twenty
 * lines further down than the character that caused it.
 */
@media (prefers-color-scheme: light) {
	.sigil-prompt-hint { dim: false; color: gray }
	.sigil-prompt-answer { dim: false; color: gray }
	.sigil-prompt-placeholder { dim: false; color: gray }
	.sigil-choice-hint { dim: false; color: gray }
	.sigil-decrypt-text.is-masked { dim: false; color: gray }
	.sigil-help-note { dim: false; color: gray }
}
`;

/**
 * The framework's own sheet, parsed once.
 *
 * Once because a `Stylesheet` is frozen and a `Cascade` only reads it: parsing
 * it per spinner would be the same work per component per process, and there is
 * nothing about it that can differ between two callers.
 */
let framework: Stylesheet | undefined;

/**
 * The stylesheet every built-in is drawn with.
 *
 * @returns The sheet, at origin `framework`.
 */
export function frameworkSheet(): Stylesheet {
	framework ??= parseStylesheet(FRAMEWORK_CSS, { origin: 'framework' });
	return framework;
}

/**
 * A theme, from its source.
 *
 * @param css - The rules.
 * @returns The sheet, at origin `theme`.
 */
export function parseTheme(css: string): Stylesheet {
	return parseStylesheet(css, { origin: 'theme' });
}

/** What everything that draws a built-in accepts, for restyling it. */
export interface ThemeOptions {
	/**
	 * Extra rules, at origin `app`, which beat both the defaults and the theme.
	 *
	 * For a caller that has sheets of its own already parsed. Source text is read
	 * as an app sheet too, since that is where a rule somebody wrote by hand
	 * belongs.
	 */
	sheets?: readonly (Stylesheet | string)[];
	/**
	 * A theme: rules at origin `theme`, over the framework's defaults and under
	 * the app's own.
	 */
	theme?: Stylesheet | string;
}

/**
 * What everything that draws a built-in accepts, for restyling it and for
 * saying how much colour the destination can render.
 *
 * The two go together because they are the two halves of "what does this look
 * like": the sheets say what colour something is and the level says how much of
 * that survives. A caller that has neither gets the framework's defaults at
 * whatever the process's own styler detected.
 */
export interface StyledOptions extends ThemeOptions {
	/**
	 * Whether the output is read against a light background or a dark one.
	 *
	 * Defaults to what the environment knew -- `SIGIL_COLOR_SCHEME`, then
	 * `COLORFGBG` -- and to dark when it knew nothing. A built-in drawn through
	 * `mountLive()` has this refined by an OSC 11 reply where the app called
	 * `Renderer.detect()`; a built-in printed as a string does not, because a string
	 * being built has no screen to ask about.
	 */
	colorScheme?: ColorScheme;
	/**
	 * The styler whose colour level to draw at. Defaults to the process's.
	 *
	 * Only the level is read. Colour is a stylesheet's now, so what is left of an
	 * `Ansi` here is the one thing it answers that the cascade cannot work out.
	 */
	ansi?: Ansi;
	/** How much colour to resolve for. Defaults to the styler's level. */
	colorLevel?: ColorLevel;
	/**
	 * Whether animations run. Defaults to `SIGIL_REDUCED_MOTION`, else nothing
	 * said -- and a built-in drawn through `mountLive()` has the renderer answer
	 * for the terminal on top of that, since whether there is a screen to animate
	 * on is not something a cascade can know.
	 */
	reducedMotion?: ReducedMotion;
}

/**
 * The cascade a built-in draws itself through.
 *
 * Built per call rather than cached, because the sheets differ per call and a
 * `Cascade` holds a bucket index over the ones it was given. What is cached is
 * the parse, which is the part that costs anything.
 *
 * @param opts - The theme and any app sheets.
 * @returns The cascade: framework defaults, then the theme, then the app's.
 */
export function themedCascade(opts: StyledOptions = {}): Cascade {
	const sheets: Stylesheet[] = [frameworkSheet()];

	if (opts.theme !== undefined) {
		sheets.push(typeof opts.theme === 'string' ? parseTheme(opts.theme) : opts.theme);
	}

	for (const sheet of opts.sheets ?? []) {
		sheets.push(typeof sheet === 'string' ? parseStylesheet(sheet) : sheet);
	}

	// the media context is set here rather than left at `DEFAULT_MEDIA`, because
	// this is the one place every built-in's cascade comes from and the scheme is
	// free to learn: an environment read, no round trip, available before anything
	// mounts. Without it `table()` and the help screen would resolve the sheet above
	// at the frozen default and a light terminal would get the dark half, which is
	// the bug this feature is for arriving through the door nobody watched
	return new Cascade(sheets, {
		...DEFAULT_MEDIA,
		colorScheme: opts.colorScheme ?? schemeFromEnv() ?? DEFAULT_MEDIA.colorScheme,
		// the same reasoning one feature along, and the terminal is deliberately not
		// in it: this call is reached by `renderToString()` as well as by a mount,
		// and a string render has no terminal to ask about. `render()` is where the
		// screen joins the chain
		reducedMotion: opts.reducedMotion ?? forcedMotion() ?? DEFAULT_MEDIA.reducedMotion,
	});
}
