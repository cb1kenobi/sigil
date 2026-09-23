/**
 * Builds `registry/`: the component sources `sigil add` copies into an app.
 *
 * Run as part of this package's `build`, and the output is shipped rather than
 * committed -- it is derived from `src/components/` in full, so a committed
 * copy would be a second spelling of those files with nothing keeping the two
 * in agreement.
 *
 * ## Why the package has to carry sources at all
 *
 * `files` is `["dist", "registry"]`, and `dist` is bundled, minified, and
 * chunked by something other than module boundaries -- there is no
 * `spinner.mjs` in it to copy, and if there were it would be minified output
 * rather than something anybody wants in their source tree. So the ejectable
 * form is generated here.
 *
 * It ships in `@ttylabs/sigil` rather than in the toolchain on purpose: the app
 * depends on the runtime at an exact version, so the source it ejects always
 * matches the API it is ejected from. In `@ttylabs/cli` -- a devDependency, on
 * its own version line -- a copy of `spinner.ts` could be a release ahead of
 * the runtime the app actually imports.
 *
 * ## The rewrite, and why it can happen here
 *
 * A component imports its neighbours relatively (`../element/index.js`), and
 * those paths mean nothing once the file is in somebody's app. Each one is
 * rewritten to the published subpath that answers for it, which is a mapping
 * this package already writes down twice -- the `exports` map and the tsdown
 * entry list, which `test/exports.test.ts` keeps in agreement.
 *
 * The rewrite does **not** depend on where the file lands, which is the
 * property that lets it happen at build time rather than inside `sigil add`. A
 * sibling import goes to `@ttylabs/sigil/components` rather than to a copy of
 * the sibling, so ejecting a spinner does not drag `mount.ts` along: what those
 * siblings export is public API, and the whole point of ejecting is to own the
 * *component*, not the plumbing under it.
 *
 * So what ships is exactly what lands in the app, byte for byte, and `add` is a
 * copy anybody can audit rather than a transform they have to trust.
 */

import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'registry');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

/**
 * The entries, and nothing else in `src/components/`.
 *
 * `index.ts` is the barrel, and `mount.ts` and `keys.ts` are the plumbing the
 * rule above says stays in the package. What is listed here is what somebody
 * would want to *edit*: a spinner whose frames should be different, a table
 * that should draw its own borders, a prompt that should take another key.
 *
 * One entry per file rather than one per export. `prompt.ts` holds all five
 * prompts and splitting it into five entries means splitting the source, which
 * is a refactor of the runtime rather than a decision about a registry.
 */
const ENTRIES = [
	{
		desc: 'An animated spinner that settles into a success or failure line',
		name: 'spinner',
	},
	{
		desc: 'A progress bar that falls back to a percentage where there is no terminal',
		name: 'progress',
	},
	{
		desc: 'A table with measured column widths, alignment and truncation',
		name: 'table',
	},
	{
		desc: 'The five prompts: text, password, confirm, select and multiselect',
		name: 'prompt',
	},
];

/** `./src/element/index.ts` -> `element`, read off the build's own entry list. */
const subpaths = new Map();
for (const [name, source] of Object.entries(entryMap())) {
	subpaths.set(source.replace(/^\.\//, ''), name);
}

/**
 * The tsdown entry map, read as text rather than imported.
 *
 * Importing it would pull tsdown in, and this script runs after the build has
 * already finished with it. The shape is a flat object literal of
 * `name: './src/...'`, which is the whole of what is needed.
 *
 * @returns The entry name for each source path.
 */
function entryMap() {
	const source = readFileSync(join(root, 'tsdown.config.ts'), 'utf-8');
	const block = source.slice(source.indexOf('entry: {'), source.indexOf('format:'));
	const found = {};

	for (const [, name, path] of block.matchAll(/([\w'-]+):\s*'([^']+)'/g)) {
		found[name.replaceAll("'", '')] = path;
	}

	if (Object.keys(found).length === 0) {
		throw new Error('Read no entries out of tsdown.config.ts');
	}

	return found;
}

/**
 * One import specifier, as the ejected copy should spell it.
 *
 * @param spec - The specifier as the source writes it.
 * @returns The published specifier, or `undefined` if it is already one.
 */
function rewrite(spec) {
	if (!spec.startsWith('.')) {
		return undefined;
	}

	// a sibling: `./mount.js` is `src/components/mount.ts`, and what it exports
	// is reached through the components subpath
	if (spec.startsWith('./')) {
		return `${manifest.name}/components`;
	}

	// `../element/index.js` -> `src/element/index.ts`
	const source = `src/${spec.replace(/^\.\.\//, '').replace(/\.js$/, '.ts')}`;
	const subpath = subpaths.get(source);

	if (!subpath) {
		throw new Error(
			`"${spec}" resolves to ${source}, which no published subpath answers for. ` +
				`A registry component may only import what the package exports.`
		);
	}

	return subpath === 'index' ? manifest.name : `${manifest.name}/${subpath}`;
}

/** Every `from '...'` in a source file, rewritten. */
function rewriteImports(source) {
	return source.replaceAll(/(\bfrom\s*)'([^']+)'/g, (whole, from, spec) => {
		const to = rewrite(spec);
		return to === undefined ? whole : `${from}'${to}'`;
	});
}

rmSync(out, { force: true, recursive: true });
mkdirSync(out, { recursive: true });

const entries = {};

for (const { desc, name } of ENTRIES) {
	const file = `${name}.ts`;
	const source = rewriteImports(readFileSync(join(root, 'src', 'components', file), 'utf-8'));

	// the check that the rewrite is total. A relative specifier left behind is a
	// file that will not resolve once it is in somebody's app, and it would fail
	// for them rather than here
	const leftover = [...source.matchAll(/\bfrom\s*'(\.[^']*)'/g)].map(([, spec]) => spec);
	if (leftover.length > 0) {
		throw new Error(`${file} still imports ${leftover.join(', ')} relatively`);
	}

	writeFileSync(join(out, file), source);

	entries[name] = {
		classes: [...new Set(source.match(/sigil-[a-z-]+/g) ?? [])].sort(),
		desc,
		files: [{ from: file, to: file }],
		imports: [...new Set([...source.matchAll(/\bfrom\s*'(@[^']+)'/g)].map(([, s]) => s))].sort(),
		// nothing in the seed registry needs another entry: every import a
		// built-in makes is answered by a published subpath, so there is no file
		// to drag along. The field is here because a third-party registry will
		// have them, and a shape that only describes the easy case is one that
		// gets discovered to be wrong by somebody else
		registryDeps: [],
	};
}

writeFileSync(
	join(out, 'registry.json'),
	`${JSON.stringify({ entries, name: manifest.name, version: manifest.version }, undefined, '\t')}\n`
);

process.stdout.write(`Wrote ${ENTRIES.length} registry entries to ${out}\n`);
