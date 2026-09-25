/**
 * `sigil add`: copy a component's source into the app, so you own it.
 *
 * ## It is an eject, not an install
 *
 * This is where it parts company with shadcn, which is otherwise the model.
 * There, nothing is installed and copying is the only way to get anything.
 * Here the components ship in `@ttylabs/sigil/components` and work with no
 * toolchain involved, so **nobody needs `add` to use a spinner**.
 *
 * The ladder, which the command prints when it is given nothing to do:
 *
 * 1. Theme it -- `.sigil-spinner-frame { color: magenta }`. An ordinary rule
 *    against the classes the component draws with, beaten by nothing, and it
 *    keeps the component's upgrades.
 * 2. Override a prop at the call site, for a one-off.
 * 3. Eject it, when the structure or the behaviour has to change -- which the
 *    cascade cannot reach.
 *
 * Only the third costs the upgrades, and saying so is the honest way to offer
 * it. A tool that leads with copying teaches people to fork what they could
 * have themed.
 *
 * ## It shows what it will write
 *
 * `add` puts code from a package somebody installed into their source tree. The
 * plan is printed first and nothing is written until it is accepted, and the
 * printing and the writing read the same plan rather than being two walks that
 * agree for now.
 */

import {
	CONFIG_FILE,
	DEFAULT_REGISTRY,
	findAppRoot,
	loadRegistry,
	parseSpec,
	type Plan,
	planAdd,
	readConfig,
	type Registry,
} from '../registry/index.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { confirm, table } from '@ttylabs/sigil/components';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Prints what a registry has, which is what `add` with no entries does.
 *
 * Listing rather than erroring, because "what can I add" is the question
 * somebody has at that moment and an empty usage line does not answer it.
 *
 * @param registry - The registry to describe.
 */
function list(registry: Registry): void {
	const rows = Object.entries(registry.manifest.entries)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, entry]) => ({ Component: name, Description: entry.desc }));

	process.stdout.write(
		`\n${registry.pkg} ${registry.manifest.version}\n\n${table(rows)}\n\n` +
			`Add one with \`sigil add <component>\`.\n\n` +
			`Most customization does not need one. A built-in is restyled with an\n` +
			`ordinary rule against the classes it draws with, which keeps it up to\n` +
			`date; ejecting is for when the structure or the behaviour has to change.\n`
	);
}

/**
 * Prints the plan.
 *
 * The entries pulled in as dependencies are called out separately from the ones
 * that were asked for: a command that quietly writes four files when one was
 * named is one nobody can predict.
 *
 * @param plan - What would be written.
 * @param registry - Where it comes from.
 * @param target - Where it lands, for the heading.
 */
function describe(plan: Plan, registry: Registry, target: string): void {
	process.stdout.write(`\nFrom ${registry.pkg} ${registry.manifest.version} into ${target}:\n\n`);

	for (const file of plan.files) {
		const note = file.exists ? '  (overwrites)' : '';
		process.stdout.write(`  ${file.shown}${note}\n`);
	}

	if (plan.pulled.length > 0) {
		process.stdout.write(`\nAlso needed: ${plan.pulled.join(', ')}\n`);
	}

	const classes = plan.entries
		.flatMap((name) => registry.manifest.entries[name]?.classes ?? [])
		.sort();

	if (classes.length > 0) {
		process.stdout.write(
			`\nThese draw with ${classes.map((c) => `.${c}`).join(', ')} --\n` +
				`restyling those needs no copy, and keeps the component up to date.\n`
		);
	}
}

/** Writes the plan, making directories as it goes. */
function apply(plan: Plan): void {
	for (const file of plan.files) {
		mkdirSync(dirname(file.to), { recursive: true });
		copyFileSync(file.from, file.to);
	}
}

const add: AnyCommand = command({
	args: [
		{
			desc: 'The components to copy in. With none, lists what the registry has',
			multiple: true,
			name: '[components...]',
		},
	],
	desc: 'Copy a component into your app, so you own it',
	options: {
		'--dir [path]': {
			desc: `Where they land, overriding ${CONFIG_FILE} and the convention`,
		},
		'--force': {
			desc: 'Overwrite a file that is already there',
			type: 'bool',
		},
		'-y, --yes': {
			desc: 'Write without asking',
			type: 'bool',
		},
	},

	async run({ argv }) {
		const root = findAppRoot(process.cwd());
		const specs = (argv.components as string[] | undefined) ?? [];

		// with nothing named there is nothing to resolve a package from, so the
		// listing is the default registry's
		if (specs.length === 0) {
			list(loadRegistry(root, DEFAULT_REGISTRY));
			return;
		}

		// every spec has to name the same registry: two registries in one plan
		// means two `registryDeps` namespaces, and a dep that resolves in one and
		// not the other is a failure nobody could read. One call per registry is
		// the answer, and it is what the error says.
		const parsed = specs.map((spec) => parseSpec(spec));
		const packages = [...new Set(parsed.map((p) => p.pkg))];

		if (packages.length > 1) {
			throw new Error(
				`One registry at a time, and this names ${packages.join(' and ')}. ` +
					`Run \`sigil add\` once per registry.`
			);
		}

		const registry = loadRegistry(root, packages[0] as string);
		const config = readTarget(root, argv.dir as string | undefined);
		const plan = planAdd(
			registry,
			parsed.map((p) => p.entry),
			config.target,
			root
		);

		if (plan.missing.length > 0) {
			const have = Object.keys(registry.manifest.entries).sort().join(', ');
			throw new Error(
				`${registry.pkg} has no ${plan.missing.map((n) => `"${n}"`).join(' or ')}. It has: ${have}`
			);
		}

		const clashes = plan.files.filter((file) => file.exists);

		if (clashes.length > 0 && !argv.force) {
			throw new Error(
				`${clashes.map((f) => f.shown).join(', ')} already ${clashes.length === 1 ? 'exists' : 'exist'}. ` +
					`Pass --force to overwrite, having looked at what is there.`
			);
		}

		describe(plan, registry, config.shown);

		if (!argv.yes) {
			process.stdout.write('\n');
			if (!(await confirm({ message: 'Write these files?' }))) {
				process.stdout.write('Nothing written.\n');
				return;
			}
		}

		apply(plan);

		process.stdout.write(
			`\nCopied ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}. ` +
				`They are yours now -- edit them freely, and note that they no longer\n` +
				`follow ${registry.pkg} when it changes.\n`
		);
	},
});

/**
 * Where the files land, and how to print it.
 *
 * `--dir` beats the config, which beats the convention, and the answer is shown
 * either way -- a guess nobody can see is the kind that costs an afternoon, and
 * this one writes files.
 *
 * @param root - The app root.
 * @param dir - What `--dir` said, if anything.
 * @returns The absolute target and the way to print it.
 */
function readTarget(root: string, dir: string | undefined): { shown: string; target: string } {
	if (dir !== undefined) {
		return { shown: dir, target: join(root, dir) };
	}

	const config = readConfig(root);

	return {
		shown: config.declared ? config.components : `${config.components} (no ${CONFIG_FILE})`,
		target: join(root, config.components),
	};
}

export default add;
