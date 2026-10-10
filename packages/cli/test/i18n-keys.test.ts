import { keysIn } from '../src/build/i18n.ts';
import { MODULE_RE, parseModule } from '../src/build/parse-module.ts';
import { SIGIL_KEYS, SIGIL_PLURAL_KEYS } from '@ttylabs/sigil/i18n-keys';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', 'sigil', 'src');
const tag = join(root, 'i18n', 'index.ts');
const generated = join(root, 'i18n', 'keys.ts');

/** Every module under the runtime's `src/`, bar the i18n module itself. */
function* modules(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name < b.name ? -1 : 1
	)) {
		const path = join(dir, entry.name);

		if (entry.isDirectory()) {
			yield* modules(path);
		} else if (MODULE_RE.test(entry.name) && path !== tag && path !== generated) {
			yield path;
		}
	}
}

/** The specifier a module reaches the tag by, which depends on how deep it is. */
function specifierFrom(file: string): string {
	const rel = relative(dirname(file), tag).replaceAll('\\', '/').replace(/\.ts$/, '.js');

	return rel.startsWith('.') ? rel : `./${rel}`;
}

/** The keys the framework's source declares, read the way the generator reads them. */
function fromSource(): { plurals: string[]; strings: string[] } {
	const plurals = new Set<string>();
	const strings = new Set<string>();

	for (const file of modules(root)) {
		const source = readFileSync(file, 'utf8');

		if (!source.includes('__`') && !source.includes('__n(')) {
			continue;
		}

		for (const found of keysIn(parseModule(file, source), { from: specifierFrom(file) })) {
			(found.kind === 'plural' ? plurals : strings).add(found.key);
		}
	}

	return { plurals: [...plurals].sort(), strings: [...strings].sort() };
}

describe('the committed key set', () => {
	// the shape `the committed utility sheet` already has, and for its reason:
	// the generator and its output are two files, so a key added to the source
	// without a regeneration is a key `sigil check` never mentions -- which is
	// silence in exactly the place the whole build-time check exists to break
	it('should hold every key the framework`s source declares', () => {
		const { plurals, strings } = fromSource();

		expect([...SIGIL_KEYS].sort()).toEqual([...new Set([...strings, ...plurals])].sort());
	});

	it('should name the plural keys, and only those', () => {
		expect([...SIGIL_PLURAL_KEYS].sort()).toEqual(fromSource().plurals);
	});

	it('should be sorted, so that two regenerations are one file', () => {
		expect([...SIGIL_KEYS]).toEqual([...SIGIL_KEYS].sort());
		expect([...SIGIL_PLURAL_KEYS]).toEqual([...SIGIL_PLURAL_KEYS].sort());
	});

	it('should repeat nothing', () => {
		expect(SIGIL_KEYS).toHaveLength(new Set(SIGIL_KEYS).size);
	});

	it('should hold the keys a reader would check by hand', () => {
		// a handful named outright, because an assertion that only compares two
		// derived lists passes if both derivations break the same way
		expect(SIGIL_KEYS).toContain('Unknown option "{0}"');
		expect(SIGIL_KEYS).toContain('Invalid value "{0}" for {1}');
		expect(SIGIL_KEYS).toContain('Usage:');
		expect(SIGIL_KEYS).toContain('option {0}');
		// two, since the multiline field's log line counts lines -- `Alias:` was the
		// only plural until SIG-135
		expect(SIGIL_PLURAL_KEYS).toEqual(['(+{0} more line)', 'Alias:']);
	});

	it('should number a slot per interpolation, never name one', () => {
		// the tag hands over values rather than names, so a key with a `{name}` in
		// it is a key nothing will ever look up
		for (const key of SIGIL_KEYS) {
			expect(key.match(/\{[^}]*\}/g) ?? [], key).toEqual(
				(key.match(/\{[^}]*\}/g) ?? []).filter((slot) => /^\{\d+\}$/.test(slot))
			);
		}
	});
});
