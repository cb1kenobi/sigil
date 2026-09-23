/**
 * The utility layer: single-purpose classes over the property set, generated
 * from the property table.
 *
 * ```
 * <Box class="flex flex-col gap-1 p-2 border border-blue">
 *   <Text class="bold text-red">Failed</Text>
 * </Box>
 * ```
 *
 * The invariant that makes this not a third way of styling: **a utility is a
 * generated stylesheet rule, and nothing in the runtime knows the difference.**
 * `p-2` is `.p-2 { padding: 2 }` -- the same class selector, the same
 * specificity, the same cascade. No new resolution path, no new precedence rule,
 * nothing added to the matching engine. The runtime cost is zero because there
 * is no runtime: this is a generator and a stylesheet.
 *
 * It is worth stating as a rule rather than an implementation detail, because
 * the obvious optimization breaks it. The moment somebody special-cases
 * `class="p-2"` into a direct property write it becomes a parallel mechanism
 * with its own precedence, its own bugs, and a divergence from the cascade that
 * only shows up where nobody tested.
 *
 * Why a terminal changes the shape of this: Tailwind's central engineering
 * problem is that the utility space is combinatorially enormous, so it cannot
 * ship them all and needs a scanner. Here the scale is bounded by the medium.
 * Spacing is a handful of cells because there is nothing between one cell and
 * two, there are sixteen named colours, and the property set is forty entries.
 * The whole base set is a few hundred rules, which is small enough to simply
 * ship. The JIT machinery solves a problem this does not have -- until arbitrary
 * values, which are SIG-81's and are deliberately not here.
 */

import {
	isProperty,
	kebab,
	PROPERTIES,
	PROPERTY_NAMES,
	type PropertyName,
	readDeclarations,
} from '@ttylabs/sigil/style';

/** One generated utility: the class name, and the declarations it stands for. */
export interface Utility {
	/** The class, without a leading dot and without any variant prefix. */
	readonly name: string;
	/** The declarations, as source text, in the order they are written. */
	readonly declarations: readonly (readonly [property: string, value: string])[];
}

export interface UtilityOptions {
	/**
	 * How far the spacing scale goes, in cells.
	 *
	 * Eight, because a terminal's meaningful spacing is tiny -- there is nothing
	 * between one cell and two, and a `p-40` is not a thing anybody wants on a
	 * screen eighty columns wide. Past the scale is what arbitrary values are
	 * for, and they are SIG-81's.
	 */
	readonly spacing?: number;
	/** How far `w-N` and `h-N` go, in cells. */
	readonly sizing?: number;
	/** Whether to generate the variants as well as the base set. */
	readonly variants?: boolean;
}

const DEFAULTS = { sizing: 12, spacing: 8, variants: true } as const;

/**
 * The sixteen colours, by the names the value parser already takes.
 *
 * Not a second list: `parseColor()` is what decides whether a name is a colour,
 * and every one of these is run through it when the sheet is generated, so a
 * name that stopped being a colour would fail the build rather than ship a rule
 * that matches nothing.
 */
const COLORS: readonly (readonly [utility: string, value: string])[] = [
	['black', 'black'],
	['red', 'red'],
	['green', 'green'],
	['yellow', 'yellow'],
	['blue', 'blue'],
	['magenta', 'magenta'],
	['cyan', 'cyan'],
	['white', 'white'],
	// the class is hyphenated and the value is not, which is the split this file
	// is built on: the utility name is ours to define and the value has to be one
	// `parseColor()` already takes. Generating `bright-black` as a *value* is what
	// the check below caught on the first run
	['bright-black', 'brightblack'],
	['bright-red', 'brightred'],
	['bright-green', 'brightgreen'],
	['bright-yellow', 'brightyellow'],
	['bright-blue', 'brightblue'],
	['bright-magenta', 'brightmagenta'],
	['bright-cyan', 'brightcyan'],
	['bright-white', 'brightwhite'],
];

/**
 * How a keyword property's utilities are spelled.
 *
 * This is the part that cannot come from the table, and the ticket says so: the
 * table knows `justify-content` takes `space-between`, and that the utility for
 * it is called `justify-between` is ours to decide. What the table does provide
 * is the keyword list itself -- so adding a keyword to a property gets its
 * utility for free, and a utility can never name a value the property would
 * refuse.
 *
 * `prefix` is prepended to each keyword; `short` renames individual keywords
 * where Tailwind has a shorter spelling people already have muscle memory for.
 */
interface KeywordFamily {
	readonly property: PropertyName;
	readonly prefix: string;
	readonly short?: Readonly<Record<string, string>>;
}

const ALIGN_SHORT = {
	'flex-start': 'start',
	'flex-end': 'end',
	'space-around': 'around',
	'space-between': 'between',
	'space-evenly': 'evenly',
} as const;

const KEYWORD_FAMILIES: readonly KeywordFamily[] = [
	{
		prefix: 'flex-',
		property: 'flexDirection',
		short: { column: 'col', 'column-reverse': 'col-reverse' },
	},
	{ prefix: '', property: 'flexWrap' },
	{ prefix: 'justify-', property: 'justifyContent', short: ALIGN_SHORT },
	{ prefix: 'items-', property: 'alignItems', short: ALIGN_SHORT },
	{ prefix: 'self-', property: 'alignSelf', short: ALIGN_SHORT },
	{ prefix: 'content-', property: 'alignContent', short: ALIGN_SHORT },
	{
		prefix: 'box-',
		property: 'boxSizing',
		short: { 'border-box': 'border', 'content-box': 'content' },
	},
	{ prefix: 'border-', property: 'borderStyle' },
	{ prefix: '', property: 'position' },
	{ prefix: 'overflow-', property: 'overflow' },
	// Tailwind's spelling, and it keeps `hidden` meaning display:none the way
	// everybody expects rather than colliding with it
	{ prefix: '', property: 'visibility', short: { hidden: 'invisible' } },
	{ prefix: 'text-', property: 'textAlign' },
	{ prefix: 'case-', property: 'textTransform' },
	{ prefix: 'truncate-', property: 'textOverflow' },
	{ prefix: 'whitespace-', property: 'whiteSpace' },
	{ prefix: 'display-', property: 'display' },
];

/** The edge prefixes, which every spacing family shares. */
const EDGES: readonly (readonly [suffix: string, properties: readonly string[]])[] = [
	['', ['top', 'right', 'bottom', 'left']],
	['x', ['left', 'right']],
	['y', ['top', 'bottom']],
	['t', ['top']],
	['r', ['right']],
	['b', ['bottom']],
	['l', ['left']],
];

/** The fractions `w-` and `h-` take, which is what a terminal can divide evenly. */
const FRACTIONS: readonly (readonly [name: string, percent: string])[] = [
	['1/2', '50%'],
	['1/3', '33%'],
	['2/3', '67%'],
	['1/4', '25%'],
	['3/4', '75%'],
	['full', '100%'],
];

/**
 * Every utility in the base set.
 *
 * @param opts - The scales, and whether to include variants.
 * @returns The utilities, in a stable order.
 */
export function utilities(opts: UtilityOptions = {}): Utility[] {
	const spacing = opts.spacing ?? DEFAULTS.spacing;
	const sizing = opts.sizing ?? DEFAULTS.sizing;
	const out: Utility[] = [];

	const taken = new Set<string>();
	const add = (name: string, declarations: readonly (readonly [string, string])[]): void => {
		// two utilities of one name is a class that quietly applies both, which is
		// the failure mode a generated vocabulary is most prone to: `hidden` was
		// display:none and visibility:hidden at the same time until this caught it
		if (taken.has(name)) {
			throw new Error(`Two utilities are both called "${name}"`);
		}
		taken.add(name);
		out.push({ declarations, name });
	};

	// --- keywords, straight off the table -----------------------------------
	for (const family of KEYWORD_FAMILIES) {
		const { keywords } = PROPERTIES[family.property];
		if (!keywords) {
			throw new Error(
				`"${family.property}" has no keyword list: a keyword family can only be generated for a property the table enumerates`
			);
		}
		for (const value of keywords) {
			const short = family.short?.[value] ?? value;
			add(`${family.prefix}${short}`, [[family.property, value]]);
		}
	}

	// `flex` on its own is the display, because that is the one everybody types
	add('flex', [['display', 'flex']]);
	add('hidden', [['display', 'none']]);

	// --- the boolean attributes ----------------------------------------------
	for (const name of PROPERTY_NAMES) {
		if (PROPERTIES[name].initial === false && typeof PROPERTIES[name].initial === 'boolean') {
			add(ATTRIBUTE_NAMES[name] ?? name, [[name, 'true']]);
			add(`not-${ATTRIBUTE_NAMES[name] ?? name}`, [[name, 'false']]);
		}
	}

	// --- spacing --------------------------------------------------------------
	for (const [suffix, edges] of EDGES) {
		for (let n = 0; n <= spacing; n++) {
			add(
				`p${suffix}-${n}`,
				edges.map((edge) => [`padding-${edge}`, String(n)])
			);
			add(
				`m${suffix}-${n}`,
				edges.map((edge) => [`margin-${edge}`, String(n)])
			);
		}
		add(
			`m${suffix}-auto`,
			edges.map((edge) => [`margin-${edge}`, 'auto'])
		);
	}

	for (let n = 0; n <= spacing; n++) {
		add(`gap-${n}`, [
			['row-gap', String(n)],
			['column-gap', String(n)],
		]);
		add(`gap-x-${n}`, [['column-gap', String(n)]]);
		add(`gap-y-${n}`, [['row-gap', String(n)]]);
	}

	// --- sizing ---------------------------------------------------------------
	for (const [axis, property] of [
		['w', 'width'],
		['h', 'height'],
	] as const) {
		for (let n = 0; n <= sizing; n++) {
			add(`${axis}-${n}`, [[property, String(n)]]);
		}
		add(`${axis}-auto`, [[property, 'auto']]);
		for (const [name, value] of FRACTIONS) {
			add(`${axis}-${name}`, [[property, value]]);
		}
		add(`min-${axis}-0`, [[`min-${property}`, '0']]);
		add(`max-${axis}-none`, [[`max-${property}`, 'none']]);
	}

	// --- flex factors ----------------------------------------------------------
	add('grow', [['flex-grow', '1']]);
	add('grow-0', [['flex-grow', '0']]);
	add('shrink', [['flex-shrink', '1']]);
	add('shrink-0', [['flex-shrink', '0']]);
	add('basis-0', [['flex-basis', '0']]);
	add('basis-auto', [['flex-basis', 'auto']]);

	// --- position --------------------------------------------------------------
	for (const edge of ['top', 'right', 'bottom', 'left']) {
		for (let n = 0; n <= spacing; n++) {
			add(`${edge}-${n}`, [[edge, String(n)]]);
		}
	}
	add(
		'inset-0',
		(['top', 'right', 'bottom', 'left'] as const).map((edge) => [edge, '0'])
	);
	for (let n = 0; n <= spacing; n++) {
		add(`z-${n}`, [['z-index', String(n)]]);
	}

	// --- colour ----------------------------------------------------------------
	for (const [name, value] of COLORS) {
		add(`text-${name}`, [['color', value]]);
		add(`bg-${name}`, [['background-color', value]]);
		add(`border-${name}`, [['border-color', value]]);
	}

	// `border` with no value is one cell of single-line border, which is ours to
	// define: a terminal border has exactly one width, so Tailwind's `border-2`
	// has nothing to mean here
	add('border', [['border-style', 'single']]);

	return out;
}

/** The properties whose CSS name is not what people would type for the utility. */
const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
	strikethrough: 'strike',
};

/**
 * A variant: a prefix on a class, and the context it puts the rule in.
 *
 * Width breakpoints and colour depth are better here than on the web, which is
 * the unusual part. `md:flex-row` where `md` is a wide terminal is exactly the
 * responsive problem a TUI has and that nothing solves well today; `c16:text-red`
 * lets an author say what a colour means on a sixteen-colour terminal instead of
 * being quantized by the degradation ladder, which is SIG-61's "give the author
 * control" in a shape people already know.
 *
 * Not `hover:` until mouse tracking exists, and not `dark:` -- a terminal has no
 * such mode.
 */
interface Variant {
	readonly name: string;
	/** A media query this variant's rules sit inside, if any. */
	readonly media?: string;
	/** A pseudo-class appended to the selector, if any. */
	readonly pseudo?: string;
}

const VARIANTS: readonly Variant[] = [
	{ media: '(min-width: 60)', name: 'sm' },
	{ media: '(min-width: 80)', name: 'md' },
	{ media: '(min-width: 120)', name: 'lg' },
	{ media: '(min-width: 160)', name: 'xl' },
	{ media: '(color-level: 0)', name: 'c0' },
	{ media: '(color-level: 1)', name: 'c16' },
	{ media: '(color-level: 2)', name: 'c256' },
	{ name: 'focus', pseudo: ':focus' },
	{ name: 'disabled', pseudo: ':disabled' },
	{ name: 'checked', pseudo: ':checked' },
	{ name: 'first', pseudo: ':first-child' },
	{ name: 'last', pseudo: ':last-child' },
];

/** Every variant, for documentation and for tests that walk them. */
export const VARIANT_NAMES: readonly string[] = VARIANTS.map((variant) => variant.name);

/**
 * A class name, escaped for use in a selector.
 *
 * `md:flex-row` and `w-1/2` contain characters the selector grammar reads as
 * something else, so the rule is written `.md\\:flex-row`. This is what Tailwind
 * does and it is why its class names are legal at all.
 */
function escapeClass(name: string): string {
	return name.replace(/[^\w-]/g, (c) => `\\${c}`);
}

/**
 * Generates the utility stylesheet.
 *
 * Every declaration is parsed on the way out, so a utility that names a property
 * the table does not have, or a value the property would refuse, fails here
 * rather than shipping a rule that silently matches nothing.
 *
 * @param opts - The scales, and whether to include variants.
 * @returns The stylesheet source, in the utilities layer.
 */
export function generateUtilities(opts: UtilityOptions = {}): string {
	const base = utilities(opts);
	const lines: string[] = ['@layer utilities {'];

	for (const utility of base) {
		lines.push(`\t${rule(utility, '')}`);
	}

	if (opts.variants ?? DEFAULTS.variants) {
		for (const variant of VARIANTS) {
			const body = base.map((utility) => rule(utility, variant.name, variant.pseudo));
			if (variant.media) {
				lines.push(`\t@media ${variant.media} {`);
				lines.push(...body.map((line) => `\t\t${line}`));
				lines.push('\t}');
			} else {
				lines.push(...body.map((line) => `\t${line}`));
			}
		}
	}

	lines.push('}');
	return `${lines.join('\n')}\n`;
}

/**
 * One declaration, checked against the property table and written in kebab.
 *
 * The table's keys are camelCase and a property name resolves in both
 * spellings, which is what let the two printers here come apart: the spacing
 * utilities are written `padding-top` and the flexbox ones `flexDirection`, so
 * `@apply` emitted one spelling and `generateUtilities()` the other, and both
 * parsed. That did not matter while the output was an intermediate; it does now
 * that the base set is committed as `UTILITY_CSS` and read by whoever wants to
 * know what a class does. A stylesheet spells a property the way a stylesheet
 * does, wherever the table happened to write it.
 *
 * The check is shared for the same reason the printing is. `@apply` used to
 * trust the table while `generateUtilities()` parsed every declaration on the
 * way out, and the rule is the generator's rather than one caller's: a utility
 * must not carry a value its own property would refuse, however it is reached.
 *
 * @param utility - The utility it belongs to, named in the error.
 * @param property - The property, in either spelling.
 * @param value - The value, as source text.
 * @returns The declaration as `property: value`.
 */
function declaration(utility: Utility, property: string, value: string): string {
	if (!isProperty(property)) {
		throw new Error(
			`Utility "${utility.name}" sets "${property}", which is not a property the table has`
		);
	}
	// parsed and thrown away: this is the check that a utility cannot ship a
	// value its own property would refuse
	readDeclarations({ [property]: value });
	return `${kebab(property)}: ${value}`;
}

/** One rule, with its declarations checked against the property table. */
function rule(utility: Utility, variant: string, pseudo = ''): string {
	const declarations = utility.declarations
		.map(([property, value]) => declaration(utility, property, value))
		.join('; ');

	const name = variant ? `${variant}:${utility.name}` : utility.name;
	return `.${escapeClass(name)}${pseudo} { ${declarations} }`;
}

export function expandApply(source: string, opts: UtilityOptions = {}): string {
	const byName = new Map(utilities(opts).map((utility) => [utility.name, utility]));

	/** The declarations a name list stands for. */
	const expand = (names: string): string => {
		const wanted = names.trim().split(/\s+/).filter(Boolean);
		if (wanted.length === 0) {
			throw new Error('@apply names no utilities');
		}

		const out: string[] = [];
		for (const name of wanted) {
			const utility = byName.get(name);
			if (!utility) {
				throw new Error(
					`@apply names "${name}", which is not a utility. A variant cannot be applied -- it is a rule in another context, not a set of declarations`
				);
			}
			out.push(
				...utility.declarations.map(([property, value]) => declaration(utility, property, value))
			);
		}
		return out.join('; ');
	};

	/** Steps over a comment, or answers `undefined` if there is not one here. */
	const comment = (at: number): number | undefined => {
		if (!source.startsWith('/*', at)) {
			return undefined;
		}
		const end = source.indexOf('*/', at + 2);
		if (end === -1) {
			throw new Error('Unterminated comment');
		}
		return end + 2;
	};

	const out: string[] = [];
	let at = 0;

	while (at < source.length) {
		// a comment is copied through untouched, so an `@apply` that lives inside
		// one is a note about `@apply` rather than one
		const past = comment(at);
		if (past !== undefined) {
			out.push(source.slice(at, past));
			at = past;
			continue;
		}

		if (!source.startsWith('@apply', at) || /[\w-]/.test(source[at + 6] ?? '')) {
			out.push(source[at]);
			at++;
			continue;
		}

		// the name list runs to the end of the statement: a semicolon, or the `}`
		// that closes the block. A comment inside it is *trivia*, the way it is
		// everywhere else in a stylesheet -- treating it as a boundary made
		// `@apply p-1 /* and */ m-1;` expand only half of itself and leave the
		// rest behind as a declaration the parser then choked on
		let i = at + '@apply'.length;
		let names = '';

		for (; i < source.length; i++) {
			const skip = comment(i);
			if (skip !== undefined) {
				names += ' ';
				i = skip - 1;
				continue;
			}
			const ch = source[i];
			if (ch === ';' || ch === '{' || ch === '}') {
				break;
			}
			names += ch;
		}

		const semicolon = source[i] === ';' ? ';' : '';
		// whatever followed the last name is put back: a source transform that
		// eats the space before a `}` is one whose output nobody can diff
		const trimmed = names.trimEnd();
		out.push(expand(trimmed), semicolon, names.slice(trimmed.length));
		at = i + (semicolon ? 1 : 0);
	}

	return out.join('');
}
