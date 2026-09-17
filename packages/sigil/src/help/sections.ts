import { initArgs, normalizeArgs } from '../parser/argument/init-args.js';
import { initOption } from '../parser/option/init-option.js';
import { OptionRegistry } from '../parser/option/option-registry.js';
import {
	type HelpSection,
	type HelpSections,
	Internal,
	type InternalArgument,
	type InternalOption,
} from '../types.js';
import { assertSectionTitle, isLabel } from '../util/assert-label.js';

/**
 * A section of a help screen, with its declarations built.
 *
 * The options come back as a registry rather than as a list, because that is
 * what pairs a negated flag with the option it shares a destination with -- and
 * a contributed section should describe that pairing the same way the command's
 * own options do.
 */
export interface BuiltSection {
	args: InternalArgument[];
	options: OptionRegistry;
	title: string;
}

/**
 * Collects the sections a command's `help` hooks contribute.
 *
 * Adding is async because building an option is: the declarations go through the
 * same `initOption()` and `initArg()` the schema's own do, so a contributed
 * option is described exactly as a declared one is and there is no second
 * rendering path to keep in step with the first.
 *
 * @returns The collector, and the sections it has collected.
 */
export function createSections(): HelpSections & { list: BuiltSection[] } {
	const list: BuiltSection[] = [];

	return {
		list,

		async add(section: HelpSection): Promise<void> {
			if (!section || typeof section !== 'object') {
				throw new TypeError('Expected a help section object');
			}

			const { args, options } = section;
			const title = assertSectionTitle(section.title, 'help section title');

			// a title used twice is one section, not two headings saying the same
			// thing: two platforms that share a title, or a hook run twice, add to
			// what is there rather than repeating it
			const existing = list.find((it) => it.title === title);
			const where = `the "${title}" help section`;

			// everything is built and checked before anything is kept, so an `add()`
			// that throws halfway leaves the section it was merging into alone
			let merged = existing?.args ?? [];

			if (args !== undefined) {
				if (!Array.isArray(args)) {
					throw new TypeError(`Expected help section "${title}" arguments to be an array`);
				}
				// the rules are about the list, so they are applied to the whole of the
				// merged one rather than to the piece being added
				merged = normalizeArgs([...merged, ...initArgs(args, where)], where);
			}

			const added: InternalOption[] = [];

			if (options !== undefined) {
				if (!options || typeof options !== 'object') {
					throw new TypeError(`Expected help section "${title}" options to be an object`);
				}

				// the same reading of a declaration the schema gets: a string is the
				// description, `null` and `undefined` are a format and nothing else
				for (const [format, value] of Object.entries(options)) {
					if (value === null || value === undefined) {
						added.push(await initOption({ format }));
					} else if (typeof value === 'string') {
						added.push(await initOption({ desc: value, format }));
					} else if (typeof value === 'object') {
						added.push(await initOption({ ...value, format: value.format ?? format }));
					} else {
						throw new TypeError(`Expected help section "${title}" option to be an object`);
					}
				}
			}

			const built = existing ?? { args: [], options: new OptionRegistry(), title };
			built.args = merged;

			// added to the section's own registry, so a negated flag pairs with the
			// option it shares a destination with even when the two arrived in
			// different calls
			for (const opt of added) {
				await built.options.add(opt);
			}

			if (!existing) {
				list.push(built);
			}
		},
	};
}

/**
 * The sections the command's own options make, by their `group`.
 *
 * One for each group, in the order the groups are first seen in the registry,
 * which is the order the schema declared them in. Options that named no group
 * are not here: they are the command's own list, and they keep the heading a
 * command with no groups at all has.
 *
 * @param options - The command's options, already filtered for `hidden`.
 * @returns The ungrouped options, and a section per group.
 */
export function byGroup(options: InternalOption[]): {
	groups: { options: InternalOption[]; title: string }[];
	ungrouped: InternalOption[];
} {
	const ungrouped: InternalOption[] = [];
	const groups = new Map<string, InternalOption[]>();

	for (const opt of options) {
		// validated at `initOption()`, and checked again here because `group` stays
		// editable: a hook that sets it to something that cannot be a heading gets
		// no heading rather than a broken screen, the same way a default that cannot
		// be written as JSON is written as itself
		const group = isLabel(opt.group) ? (opt.group as string).trim() : undefined;

		if (group === undefined) {
			ungrouped.push(opt);
			continue;
		}

		const existing = groups.get(group);
		if (existing) {
			existing.push(opt);
		} else {
			groups.set(group, [opt]);
		}
	}

	return {
		groups: [...groups].map(([title, grouped]) => ({ options: grouped, title })),
		ungrouped,
	};
}

/**
 * Whether an option is a negated flag another option in the same registry owns
 * the row of. Shared by the command's own options and a contributed section, so
 * that both describe a pair the same way.
 *
 * @param options - The options to consider together.
 * @returns The ones that get a row of their own.
 */
export function withoutTwins(options: InternalOption[]): InternalOption[] {
	const twins = new Set(options.map((opt) => opt[Internal].negatedTwin).filter(Boolean));
	return options.filter((opt) => !twins.has(opt));
}
