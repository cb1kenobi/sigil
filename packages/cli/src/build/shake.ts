/**
 * Style shaking: emitting only the utility rules an app can actually name.
 *
 * ## What this is, and what it deliberately is not
 *
 * SIG-115 asked for two things about stylesheets -- shake them, and emit them
 * **as data** rather than as source to be parsed at startup -- and said the two
 * should be one pass because they read the same sheet. They are one pass here,
 * and the pass does one of them, because the other was measured and is a loss.
 * The numbers are in AGENTS.md; the short version is that a parsed rule is
 * simply more information than the CSS that produced it. The utility sheet is
 * 13.3 kB of CSS and **103 kB** of minified JS literal, against a stylesheet
 * parser that is 9.1 kB and a parse that is 0.59 ms. Shaking moves both numbers
 * the same way; emitting data trades 90 kB for half a millisecond.
 *
 * ## Only the generated vocabulary is shaken
 *
 * That is SIG-81's own argument taken at its word. Hand-written CSS cannot be
 * shaken soundly -- "can this app ever produce `class="error"`?" is a question
 * about arbitrary JavaScript -- and a hand-written sheet has no bytes in it to
 * win back anyway. The utility sheet is the opposite on both counts: the build
 * knows the entire grammar that produced it, and it is 383 rules an app may
 * name a dozen of.
 *
 * It is also the one sheet with a seam the build can reach. `utilitySheet()` is
 * opt-in, so it is a call **in the app's own source**, which a transform can
 * rewrite -- and rewriting it is what makes `UTILITY_CSS` unreferenced, so the
 * 13.3 kB shakes out of the bundle rather than being replaced in it. The
 * framework sheet has no such seam: nothing in an app calls `frameworkSheet()`,
 * because every built-in reaches it through `themedCascade()` from inside the
 * runtime. It is left alone, and at 19 rules and 0.023 ms that is not a loss
 * worth inventing a seam for.
 *
 * ## The analysis is evidence, not proof
 *
 * A class reaches the cascade as a string, so the question is which strings an
 * app's source can produce. Every string literal and every template quasi in
 * the app's own files is tokenized, and a utility survives if some token could
 * be it. That is Tailwind's scanner, and like Tailwind's it is unsound in
 * exactly one direction: a class assembled entirely out of values that never
 * appear as literals -- read from JSON, joined out of an array that came from
 * somewhere else -- leaves no evidence and its rule is dropped.
 *
 * Two affordances make the common dynamic shapes safe, and they are the reason
 * this is not simply a regex over the source. A literal that sits next to an
 * interpolation is **open** on that side, so `` `text-${colour}` `` and
 * `'text-' + colour` both leave the token `text-` open on the right, and every
 * `text-*` utility survives it. A literal with nothing next to it is closed and
 * matches by equality, so `'Hello, '` keeps nothing. Which end is open is read
 * off the tree rather than guessed at from the text, which is the whole
 * difference between this and a scanner.
 *
 * What is left over is the escape hatch: `build.safelist` in `sigil.json` names
 * classes to keep whatever the evidence says, and `build.shake: false` turns
 * the whole thing off. The count is in the build summary either way, because a
 * build that quietly kept everything and a build that quietly dropped the wrong
 * rule look identical from outside.
 *
 * ## Why over-approximating is the safe direction, everywhere
 *
 * Keeping a rule nothing can match costs 35 bytes. Dropping one something can
 * match costs a layout that is subtly wrong in a terminal with nothing to point
 * at. So every uncertainty here resolves towards keeping: a file that does not
 * parse falls back to a raw token scan of its own text, files rolldown would
 * never have reached are scanned anyway, and a `utilitySheet` the matcher
 * cannot claim is simply left alone with the whole sheet behind it.
 */

import { generateUtilities, utilities } from '../utilities/index.ts';
import { bindingName, importBindings, reachable } from './bindings.ts';
import { MODULE_RE, parseModule } from './parse-module.ts';
import { walk } from './walk.ts';
import MagicString from 'magic-string';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CallExpression, Node } from 'oxc-parser';

/** Where `utilitySheet` comes from. */
export const STYLE_MODULE = '@ttylabs/sigil/style';

/** What it is exported as. */
export const SHEET_EXPORT = 'utilitySheet';

/**
 * The characters a class name is made of, as far as this has to care.
 *
 * Word characters and a hyphen are most of it; a slash is in because ten base
 * utilities are named `w-1/2` and its siblings, and a colon is in because that
 * is how a variant is spelled and leaving it out would silently stop working
 * the day the variants ship. Everything else -- a quote, a space, an angle
 * bracket, an equals sign -- is a boundary, which is what lets a `ui`
 * template's `class="p-2 bold"` be read out of the one literal chunk it
 * arrives in.
 */
const TOKEN_RE = /[\w\-/:]+/g;

/**
 * What an app's source says about the classes it can name.
 *
 * Four buckets rather than one set, because where a literal sat decides what it
 * is evidence *of*: a closed literal is the class, and an open one is a piece
 * of one.
 */
export interface ClassEvidence {
	/** How many files were read, for the report and for the tests. */
	readonly files: number;
	/**
	 * Whether the app could name this class.
	 *
	 * @param name - The class name, unescaped.
	 * @returns Whether some literal in the app is evidence for it.
	 */
	mayName(name: string): boolean;
}

/** One literal chunk, and which of its ends touch something unknown. */
interface Chunk {
	/** Whether something unknown is concatenated on the left. */
	readonly openLeft: boolean;
	/** Whether something unknown is concatenated on the right. */
	readonly openRight: boolean;
	readonly text: string;
}

/** The evidence, collected. */
class Evidence implements ClassEvidence {
	files = 0;
	readonly #exact = new Set<string>();
	readonly #infix = new Set<string>();
	readonly #prefix = new Set<string>();
	readonly #suffix = new Set<string>();

	/** Adds a name that is kept whatever the source says. */
	safelist(name: string): void {
		this.#exact.add(name);
	}

	/**
	 * Reads one literal chunk.
	 *
	 * A token is open on an end only when it *touches* that end: in `'Hello, '`
	 * followed by an interpolation, the chunk is open on the right and the token
	 * `Hello` is not, because the comma sits between them. That is what keeps
	 * the affordance for `` `text-${c}` `` from becoming an affordance for every
	 * string in the app.
	 *
	 * @param chunk - The literal text and which ends are open.
	 */
	read(chunk: Chunk): void {
		for (const match of chunk.text.matchAll(TOKEN_RE)) {
			const token = match[0];
			const left = chunk.openLeft && match.index === 0;
			const right = chunk.openRight && match.index + token.length === chunk.text.length;

			if (left && right) {
				this.#infix.add(token);
			} else if (left) {
				this.#suffix.add(token);
			} else if (right) {
				this.#prefix.add(token);
			} else {
				this.#exact.add(token);
			}
		}
	}

	mayName(name: string): boolean {
		if (this.#exact.has(name)) {
			return true;
		}
		for (const prefix of this.#prefix) {
			if (name.startsWith(prefix)) {
				return true;
			}
		}
		for (const suffix of this.#suffix) {
			if (name.endsWith(suffix)) {
				return true;
			}
		}
		for (const infix of this.#infix) {
			if (name.includes(infix)) {
				return true;
			}
		}
		return false;
	}
}

/** Directories a scan never descends into. */
const SKIPPED = new Set(['node_modules']);

/** What to scan, and what to keep regardless. */
export interface ScanOptions {
	/** Absolute directories to leave out -- the output directory, normally. */
	readonly exclude?: readonly string[];
	/** Class names kept whatever the source says. */
	readonly safelist?: readonly string[];
}

/**
 * Reads an app's source for the classes it could name.
 *
 * The app's own tree rather than the module graph rolldown builds, and that is
 * a deliberate over-approximation in both directions: it reads files nothing
 * imports, which can only keep a rule that was going to be kept anyway, and it
 * does not read the app's dependencies, which is the one place it can be short.
 * A package that renders sigil elements with sigil utility classes is exotic,
 * and `build.safelist` is what it would use. The alternative -- collecting
 * during rolldown's own `transform` -- cannot work: the rewrite happens in a
 * module's transform and the evidence is not complete until every module has
 * been through one.
 *
 * What it must not read is a *previous build's output*, which holds the whole
 * utility sheet as a string and would therefore be evidence for every rule
 * there is. The output directory is excluded for that reason, and a build
 * cleans it first in any case. A **second**, stale output directory somewhere
 * else in the app is the case that gets through, and the failure is the safe
 * one: everything is kept, and the summary says `383 of 383` rather than
 * saying nothing. That is what the count is in the summary for.
 *
 * @param root - The app root.
 * @param options - What to leave out, and what to keep regardless.
 * @returns What the source says.
 */
export function scanClassEvidence(root: string, options: ScanOptions = {}): ClassEvidence {
	const evidence = new Evidence();
	// resolved on both sides, because the caller's `out` and this walk's
	// `join()` are two spellings of one directory and a trailing slash or a
	// `./` would make them miss each other -- which is the one exclusion that
	// really matters, since a previous build's output holds the whole utility
	// sheet and reading it keeps every rule
	const exclude = new Set((options.exclude ?? []).map((path) => resolve(path)));

	for (const name of options.safelist ?? []) {
		evidence.safelist(name);
	}

	const visit = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// a directory that cannot be read contributes nothing, and refusing to
			// build over one would fail on a permissions problem in a corner of the
			// tree that holds no source
			return;
		}

		for (const entry of entries) {
			const path = join(dir, entry.name);

			if (entry.isDirectory()) {
				// a dot directory is `.git`, `.turbo`, a cache -- never source
				// `path` needs no resolving of its own: the walk starts at a resolved
				// root and `join()` normalizes, so it is already the spelling the set
				// holds. A second `resolve()` here reads as load-bearing and is not,
				// which is the guard this repository keeps deleting
				if (!entry.name.startsWith('.') && !SKIPPED.has(entry.name) && !exclude.has(path)) {
					visit(path);
				}
				continue;
			}

			if (entry.isFile() && MODULE_RE.test(entry.name)) {
				readFile(path, evidence);
			}
		}
	};

	visit(resolve(root));
	return evidence;
}

/**
 * Reads one file's literals into the evidence.
 *
 * A file that does not parse falls back to a raw token scan of its whole text,
 * every token closed. That is strictly more conservative than the parse -- it
 * reads identifiers and comments as though they were class names -- so a
 * syntax error somewhere in the tree costs bytes rather than correctness. The
 * alternative was to skip such a file, which loses evidence and can drop a rule
 * the app really does name; the one after that was to fail the build, which
 * would refuse an app over a file rolldown never reads.
 *
 * @param path - The file.
 * @param into - Where the evidence goes.
 */
function readFile(path: string, into: Evidence): void {
	let source: string;
	try {
		source = readFileSync(path, 'utf-8');
	} catch {
		return;
	}

	into.files++;

	try {
		collectLiterals(parseModule(path, source).program, into);
	} catch {
		into.read({ openLeft: false, openRight: false, text: source });
	}
}

/**
 * Every string literal and template quasi in a tree, with its open ends.
 *
 * The two shapes that produce an open end are a template literal with
 * interpolations and a `+` chain with a non-literal in it, and both are read
 * here rather than inferred from the text: `'text-'` in `'text-' + colour` is
 * open on the right and the same string on its own is not, and nothing about
 * the characters says which.
 *
 * A tagged template's quasis are read like any other, which is what makes a
 * `ui` template's `class="p-2"` visible at all -- the class sits inside the
 * template's text rather than in a string of its own.
 *
 * @param program - The tree.
 * @param into - Where the evidence goes.
 */
function collectLiterals(program: Node, into: Evidence): void {
	walk(program, (node) => {
		if (node.type === 'BinaryExpression' && node.operator === '+') {
			const operands = flatten(node);

			// the walk then descends and reads each of these literals *again*, as
			// closed, which changes no answer and is why there is no bookkeeping
			// here to stop it: a closed reading matches by equality and the open
			// one it duplicates matches a superset of that, so the weaker reading
			// is redundant rather than wrong. A `claimed` set that suppressed it
			// was written first and deleted, because sabotaging it failed no test
			for (const [at, operand] of operands.entries()) {
				if (isStringLiteral(operand)) {
					into.read({
						openLeft: at > 0,
						openRight: at < operands.length - 1,
						text: String(operand.value),
					});
				}
			}
			return true;
		}

		if (node.type === 'TemplateLiteral') {
			const { expressions, quasis } = node;

			for (const [at, quasi] of quasis.entries()) {
				into.read({
					openLeft: at > 0,
					openRight: at < quasis.length - 1 && expressions.length > 0,
					text: quasi.value.cooked ?? quasi.value.raw,
				});
			}
			return true;
		}

		if (isStringLiteral(node)) {
			into.read({ openLeft: false, openRight: false, text: String(node.value) });
		}

		return true;
	});
}

/** Whether a node is a string literal, which oxc spells as a `Literal`. */
function isStringLiteral(node: Node): node is Node & { value: string } {
	return node.type === 'Literal' && typeof (node as { value?: unknown }).value === 'string';
}

/**
 * A `+` chain flattened left to right.
 *
 * `'a' + b + 'c'` parses as `('a' + b) + 'c'`, so the operands have to be
 * gathered before any of them can be told whether something unknown sits beside
 * it -- read off the nested shape, the `'a'` would look like the whole left
 * side of one addition rather than the start of three things joined.
 *
 * @param node - The outermost `+`.
 * @returns Its operands, in source order.
 */
function flatten(node: Node): Node[] {
	const expression = node as { left: Node; operator: string; right: Node };

	const left =
		expression.left.type === 'BinaryExpression' &&
		(expression.left as unknown as { operator: string }).operator === '+'
			? flatten(expression.left)
			: [expression.left];

	return [...left, expression.right];
}

/** What the utility sheet came to once the evidence had been applied. */
export interface ShakenSheet {
	/** The sheet source, with only the surviving rules in it. */
	readonly css: string;
	/** How many utilities survived. */
	readonly kept: number;
	/** How many there were. */
	readonly total: number;
}

/**
 * The utility sheet, with only the rules the evidence allows.
 *
 * Regenerated rather than printed back out of a parsed sheet, which is the
 * decision worth knowing: `generateUtilities()` is what produced the committed
 * sheet, so asking it for a subset gives text that is byte for byte the subset
 * of that sheet, and there is no stylesheet printer anywhere to drift from the
 * parser. A printer would be a second spelling of the grammar, which is the
 * thing this repository writes down over and over as how two halves of one
 * library come to disagree.
 *
 * @param evidence - What the app's source says.
 * @returns The shaken sheet and what it cost.
 */
export function shakeUtilities(evidence: ClassEvidence): ShakenSheet {
	// the committed sheet is the base set, so this asks for the base set: a
	// shaken sheet that quietly grew the variants would be a different sheet
	const all = utilities({ variants: false });
	const keep = all.filter((utility) => evidence.mayName(utility.name));

	return {
		css: generateUtilities({ only: keep.map((utility) => utility.name), variants: false }),
		kept: keep.length,
		total: all.length,
	};
}

/** What shaking a module's sheets produced. */
export interface ShakenModule {
	/** The rewritten source. */
	readonly code: string;
	/** The source map, as rolldown wants it. */
	readonly map: ReturnType<MagicString['generateMap']>;
	/** How many `utilitySheet()` calls were rewritten. */
	readonly sites: number;
}

/**
 * A name prefix that occurs nowhere in a module.
 *
 * The same contract `compileTemplates()` keeps and for the same two reasons --
 * outward, a local at the splice site shadows a generated name; inward, nothing
 * here prints an expression back, so only the outward half bites, and it bites
 * the same way. `base` is a parameter because both passes may run over one
 * module and two passes choosing one prefix is two sets of names that collide.
 *
 * @param source - The module's source.
 * @param base - The prefix to try first.
 * @returns A prefix the module does not contain.
 */
export function choosePrefix(source: string, base: string): string {
	if (!source.includes(base)) {
		return base;
	}

	for (let n = 0; ; n++) {
		const candidate = `${base}${n}`;
		if (!source.includes(candidate)) {
			return candidate;
		}
	}
}

/**
 * Rewrites a module's `utilitySheet()` calls to the shaken sheet.
 *
 * The replacement is one module-scope constant rather than one parse per call
 * site, because `utilitySheet()` memoizes and a rewrite that parsed per call
 * would be slower than what it replaced. It is not the same *object* across
 * modules the way the memo is -- two modules that both call it get two sheets
 * -- which nothing can observe: a `Stylesheet` is frozen and a `Cascade` only
 * reads it.
 *
 * A `utilitySheet` reached in any other way -- passed as a value, destructured
 * off a namespace, re-exported through a barrel -- is left alone, and the app
 * then gets the whole sheet there. That is correct output: the shaken sheet is
 * a subset, so the two disagree only about rules the evidence says nothing can
 * match.
 *
 * @param file - The module's path; its extension decides TypeScript.
 * @param source - The module's source.
 * @param sheet - The shaken sheet to splice in.
 * @returns The rewritten module, or `undefined` when it calls nothing.
 */
export function shakeStyles(
	file: string,
	source: string,
	sheet: ShakenSheet
): ShakenModule | undefined {
	// a module that does not mention the module the export comes from cannot be
	// calling it. This is the function's own fast path rather than the build's,
	// which narrows natively before it ever calls here -- the same split
	// `compileTemplates()` records
	if (!source.includes(STYLE_MODULE)) {
		return undefined;
	}

	const parsed = parseModule(file, source);
	const bindings = importBindings(parsed, STYLE_MODULE, SHEET_EXPORT);

	if (!reachable(bindings)) {
		return undefined;
	}

	const calls: CallExpression[] = [];

	walk(parsed.program, (node) => {
		if (
			node.type === 'CallExpression' &&
			node.arguments.length === 0 &&
			bindingName(node.callee as Parameters<typeof bindingName>[0], bindings) !== undefined
		) {
			calls.push(node);
		}
		return true;
	});

	if (!calls.length) {
		return undefined;
	}

	const prefix = choosePrefix(source, '$css');
	const local = `${prefix}s`;
	const edited = new MagicString(source);

	for (const call of calls) {
		edited.overwrite(call.start, call.end, local);
	}

	const head =
		`import { parseStylesheet as ${prefix}p } from ${JSON.stringify(STYLE_MODULE)};\n` +
		`const ${local} = /* @__PURE__ */ ${prefix}p(${JSON.stringify(sheet.css)});\n`;

	// after a shebang rather than before it, for the reason `compileTemplates()`
	// records: `#!` is only a shebang on the first line
	const shebang = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;

	if (shebang > 0) {
		edited.appendLeft(shebang, head);
	} else {
		edited.prepend(head);
	}

	return {
		code: edited.toString(),
		map: edited.generateMap({ hires: true, includeContent: true, source: file }),
		sites: calls.length,
	};
}

/**
 * What a build needs to shake, worked out once and only when something asks.
 *
 * Lazy because the scan is a walk of the app's source tree and the sheet is a
 * regeneration of 383 rules, and an app that never calls `utilitySheet()` --
 * which is most of them, since it is opt-in -- should pay for neither. The
 * plugin asks on the first module that turns out to hold a call, and there is
 * at most one such first module.
 */
export interface Shaker {
	/** The shaken sheet, computed on the first ask. */
	sheet(): ShakenSheet;
	/** What it came to, or `undefined` if nothing ever asked. */
	result(): ShakenSheet | undefined;
}

/**
 * Builds the shaker for one app.
 *
 * @param root - The app root.
 * @param options - What to leave out of the scan, and what to keep regardless.
 * @returns The shaker.
 */
export function createShaker(root: string, options: ScanOptions = {}): Shaker {
	let computed: ShakenSheet | undefined;

	return {
		result: () => computed,
		sheet: () => {
			computed ??= shakeUtilities(scanClassEvidence(root, options));
			return computed;
		},
	};
}
