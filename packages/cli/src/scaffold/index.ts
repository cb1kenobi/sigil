/**
 * `sigil new`: the files a new app starts as.
 *
 * A scaffold is a set of decisions somebody would otherwise make wrong once and
 * live with. The ones here are each written down where they are made, and two
 * are worth reading before the templates:
 *
 * ## An entry exports a schema; something else runs it
 *
 * `sigil build` reads the app's entry to find its `commands` -- it *parses* the
 * module rather than importing it, because importing would run the app -- so
 * the entry has to be a module whose default export is the schema and nothing
 * more. That leaves nothing to run during development, which is what `dev.ts`
 * is: it imports the schema and calls `main()`.
 *
 * Two files rather than one because there is no third option. A single module
 * that both exports a schema and calls `main()` when executed would need
 * `import.meta.main`, which is node 24 and the floor here is 22.19. The dev
 * runner is deliberately *not* called `src/cli.ts`: `cli` is one of the names
 * discovery looks for, and a second entry candidate sitting beside the real one
 * is an ambiguity waiting for somebody to delete the wrong file.
 *
 * ## The tsconfig is not boilerplate
 *
 * `lib: ["esnext"]` and `types: ["node"]` are load-bearing rather than taste.
 * Without them `lib.dom` is included, which declares `setInterval(): number`
 * and shadows node's `NodeJS.Timeout` -- so an ejected spinner fails to compile
 * with `Property 'unref' does not exist on type 'number'`, on a component whose
 * source already writes `timer.unref?.()`. Nothing about the component is wrong
 * and nothing about it can fix it. Found by ejecting into a bare app and
 * type-checking it, which is the only way it surfaces before a user hits it.
 */

/** What the app is written in. */
export type Language = 'js' | 'ts';

/** How its commands are arranged. */
export type Layout = 'multi' | 'single';

/** Which linter it starts with, if any. */
export type Linter = 'biome' | 'eslint' | 'none' | 'oxlint';

/** Everything `new` needs to decide before it writes anything. */
export interface ScaffoldOptions {
	/** The language. */
	readonly language: Language;
	/** The layout. */
	readonly layout: Layout;
	/** The linter. */
	readonly linter: Linter;
	/** The app's name, which is also its bin. */
	readonly name: string;
	/**
	 * The version to ask for of `@ttylabs/sigil` and `@ttylabs/cli`.
	 *
	 * One field rather than two, because the two cannot differ: the toolchain
	 * depends on the runtime at its own version and the release workflow
	 * refuses a tag that does not match every package, so a scaffold asking for
	 * different ones would be asking for a pair that was never published
	 * together. They were two while `--link` existed, when each could be a
	 * local path.
	 */
	readonly version: string;
	/** The versions of the shared devDependencies, read off the toolchain. */
	readonly versions: Readonly<Record<string, string>>;
}

/**
 * The linters, and the versions a new app asks for.
 *
 * Written here rather than read off this repository, which was the first
 * attempt and was wrong in a way worth recording: `oxlint` is a devDependency
 * of the *workspace root* and not of `@ttylabs/cli`, so the lookup answered
 * `undefined`, `JSON.stringify` dropped the key, and the scaffold wrote a
 * `lint` script for a tool it never installed. `eslint` and `biome` are not in
 * this repository at all and never will be, so there is nothing to read for
 * them either.
 *
 * Caret rather than exact, which is the one place this parts company with the
 * pinning rule: these are ranges on tools whose releases this repository does
 * not track, and pinning one means a scaffold that hands out a version that was
 * current the day it was written. The app's own lockfile is what pins them.
 */
const LINTERS = {
	biome: { config: 'biome.json', deps: { '@biomejs/biome': '^2.5.14' }, script: 'biome check .' },
	eslint: {
		config: 'eslint.config.js',
		deps: { '@eslint/js': '^10.0.1', eslint: '^10.11.0' },
		script: 'eslint .',
	},
	none: undefined,
	oxlint: { config: '.oxlintrc.json', deps: { oxlint: '^1.85.0' }, script: 'oxlint' },
} as const satisfies Record<
	Linter,
	{ config: string; deps: Record<string, string>; script: string } | undefined
>;

/** One file to write. */
export interface ScaffoldFile {
	/** Its contents. */
	readonly contents: string;
	/** Whether it needs the executable bit, where the platform has one. */
	readonly executable?: boolean;
	/** Its path, relative to the app root, with forward slashes. */
	readonly path: string;
}

/**
 * Whether a string is usable as both an npm package name and a bin.
 *
 * npm's own rule, minus the parts that do not apply to something being created:
 * no uppercase, no leading dot or underscore, and nothing that needs escaping
 * in a path. A scope is refused rather than handled -- the name is also the
 * directory and the bin, and `@acme/thing` is neither.
 *
 * @param name - The proposed name.
 * @returns What is wrong with it, or `undefined`.
 */
export function nameProblem(name: string): string | undefined {
	if (name.length === 0) {
		return 'A name is required';
	}
	if (name.length > 214) {
		return 'A name must be 214 characters or fewer';
	}
	if (name.startsWith('.') || name.startsWith('_')) {
		return 'A name cannot start with a dot or an underscore';
	}
	if (name.startsWith('@')) {
		return 'A scoped name cannot be used here, because the name is also the directory and the bin';
	}
	if (name !== name.toLowerCase()) {
		return 'A name must be lowercase';
	}
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
		return 'A name may only hold lowercase letters, digits, dots, hyphens and underscores';
	}
	return undefined;
}

/** The extension the app's modules take. */
function ext(language: Language): string {
	return language === 'ts' ? 'ts' : 'js';
}

/** The app's manifest. */
function manifest(opts: ScaffoldOptions): string {
	const { language, linter, name, version, versions } = opts;

	const scripts: Record<string, string> = {
		build: 'sigil build',
		check: 'sigil check',
		dev: `node dev.${ext(language)}`,
	};

	const devDependencies: Record<string, string> = { '@ttylabs/cli': version };

	if (language === 'ts') {
		devDependencies['@types/node'] = versions['@types/node'] as string;
		devDependencies.typescript = versions.typescript as string;
		scripts['type-check'] = 'tsc --noEmit';
	}

	const lint = LINTERS[linter];
	if (lint) {
		Object.assign(devDependencies, lint.deps);
		scripts.lint = lint.script;
	}

	// the check that a script never names a tool nothing installs. The first
	// version of this read the versions off a manifest that did not have them,
	// and `JSON.stringify` drops an undefined value rather than complaining --
	// so the manifest was wrong in a way only running it could show
	for (const [dep, spec] of Object.entries(devDependencies)) {
		if (typeof spec !== 'string' || spec.length === 0) {
			throw new Error(
				`No version to write for ${dep}, so the manifest would name it and not install it`
			);
		}
	}

	// exact versions rather than ranges, which is the rule this toolchain's own
	// repository keeps and for the reason it records: a range means a fresh
	// install and an old lockfile can resolve to different trees, with nothing
	// in the diff to point at
	return `${JSON.stringify(
		{
			bin: { [name]: `./dist/${name}.mjs` },
			dependencies: { '@ttylabs/sigil': version },
			description: '',
			devDependencies: sorted(devDependencies),
			engines: { node: '>=22.19.0' },
			name,
			private: true,
			scripts: sorted(scripts),
			type: 'module',
			version: '0.0.0',
		},
		undefined,
		2
	)}\n`;
}

/** An object with its keys in order, so a generated file is stable. */
function sorted(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** The TypeScript config, whose `lib` and `types` are load-bearing. */
function tsconfig(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				allowImportingTsExtensions: true,
				// `esnext` and `node` rather than the defaults, and not as taste:
				// lib.dom declares setInterval(): number, which shadows node's
				// NodeJS.Timeout and makes an ejected spinner fail to compile
				lib: ['esnext'],
				module: 'nodenext',
				moduleResolution: 'nodenext',
				noEmit: true,
				skipLibCheck: true,
				strict: true,
				target: 'esnext',
				types: ['node'],
				verbatimModuleSyntax: true,
			},
			include: ['src', 'dev.ts'],
		},
		undefined,
		2
	)}\n`;
}

/** The dev runner: the half of the app that actually starts it. */
function devRunner(opts: ScaffoldOptions): string {
	const from = opts.language === 'ts' ? './src/index.ts' : './src/index.js';

	return `#!/usr/bin/env node
// Runs the app from source, with nothing compiled.
//
// \`src/index\` exports the schema and does not run it, because \`sigil build\`
// *parses* that module to find the commands rather than importing it --
// importing would run the app. So starting it is this file's job.
import { main } from '@ttylabs/sigil';
import schema from '${from}';

await main({ schema });
`;
}

/** The schema, in whichever layout was chosen. */
function entry(opts: ScaffoldOptions): string {
	const { language, layout, name } = opts;
	const typed = language === 'ts';

	if (layout === 'single') {
		return `${header(name)}
export default {
	name: '${name}',
	desc: 'What ${name} does',
	args: [{ name: '[who]', desc: 'Who to greet' }],
	options: {
		'-v, --verbose': { desc: 'Say more', type: 'bool' },
	},

	run({ argv }${typed ? ': { argv: { who?: string; verbose: boolean } }' : ''}) {
		process.stdout.write(\`hello \${argv.who ?? 'world'}\\n\`);
	},
};
`;
	}

	return `${header(name)}
export default {
	name: '${name}',
	desc: 'What ${name} does',
	options: {
		'-v, --verbose': { desc: 'Say more', type: 'bool' },
	},

	// What './commands' below is relative to. Without it the runtime would
	// resolve that path from whatever directory the CLI was *run* in, while
	// \`sigil build\` resolves it from this file -- so the same line would mean
	// two different things. Naming the directory keeps 'commands' a plain string
	// that the build can still read without running anything.
	baseDir: import.meta.dirname,

	// A directory of commands: every module inside is a command named after its
	// file, and a subdirectory is a command with subcommands of its own. Nothing
	// is imported until argv names it.
	commands: './commands',
};
`;
}

/** The comment at the top of the entry, which is where the shape is explained. */
function header(name: string): string {
	return `// ${name}'s schema.
//
// Exported rather than run: \`sigil build\` reads this module without importing
// it, so anything here that *did* something would happen at build time. \`dev\`
// is what starts the app.`;
}

/** The one example command, in the multi-command layout. */
function exampleCommand(language: Language): string {
	const typed = language === 'ts';

	return `// \`${'${bin}'} hello\` -- one command per file, named after the file.
export default {
	desc: 'Say hello',
	args: [{ name: '[who]', desc: 'Who to greet' }],

	run({ argv }${typed ? ': { argv: { who?: string } }' : ''}) {
		process.stdout.write(\`hello \${argv.who ?? 'world'}\\n\`);
	},
};
`;
}

/** The linter's config, where there is one. */
function linterConfig(linter: Linter): ScaffoldFile | undefined {
	if (linter === 'oxlint') {
		return {
			contents: `${JSON.stringify(
				{ categories: { correctness: 'error', suspicious: 'warn' }, ignorePatterns: ['dist'] },
				undefined,
				2
			)}\n`,
			path: LINTERS.oxlint.config,
		};
	}

	if (linter === 'eslint') {
		return {
			contents: `import js from '@eslint/js';

export default [
	{ ignores: ['dist'] },
	js.configs.recommended,
];
`,
			path: LINTERS.eslint.config,
		};
	}

	if (linter === 'biome') {
		return {
			contents: `${JSON.stringify(
				{
					$schema: 'https://biomejs.dev/schemas/2.0.0/schema.json',
					files: { includes: ['**', '!dist'] },
					linter: { enabled: true, rules: { recommended: true } },
				},
				undefined,
				2
			)}\n`,
			path: LINTERS.biome.config,
		};
	}

	return undefined;
}

/** The README, which is the only place the next steps are written down. */
function readme(opts: ScaffoldOptions): string {
	const { language, layout, name } = opts;
	const e = ext(language);

	return `# ${name}

A CLI built with [sigil](https://github.com/cb1kenobi/sigil).

## Getting started

\`\`\`sh
npm run dev -- --help
npm run dev -- hello world
\`\`\`

\`npm run build\` bundles it into \`dist/${name}.mjs\`, which depends on nothing.

## Layout

\`\`\`
src/index.${e}${' '.repeat(Math.max(1, 14 - e.length))}the schema: the app's name, its options, and where its commands are
${
	layout === 'multi'
		? `src/commands/${' '.repeat(9)}one command per file, loaded only when argv names it\n`
		: ''
}dev.${e}${' '.repeat(Math.max(1, 20 - e.length))}runs it from source
\`\`\`

## Components

The spinner, progress bar, table and prompts are in \`@ttylabs/sigil/components\`
and need nothing installed:

\`\`\`js
import { createSpinner } from '@ttylabs/sigil/components';
\`\`\`

To restyle one, write an ordinary rule against the classes it draws with — that
keeps it up to date. \`sigil add <component>\` copies the source into
\`src/components/\` when the structure or the behaviour has to change, and what
lands there stops following the framework.
`;
}

/**
 * Every file a new app starts as.
 *
 * Returned rather than written, so that `new` can show the tree before it
 * creates anything -- the same split `add` makes, and for the same reason: the
 * showing and the doing must not be two walks that agree for now.
 *
 * @param opts - What was chosen.
 * @returns The files, in the order they would be written.
 */
export function scaffold(opts: ScaffoldOptions): ScaffoldFile[] {
	const e = ext(opts.language);
	const files: ScaffoldFile[] = [
		{ contents: manifest(opts), path: 'package.json' },
		{ contents: readme(opts), path: 'README.md' },
		{ contents: 'node_modules\ndist\n', path: '.gitignore' },
		// written rather than left to the convention: a scaffold is exactly where
		// a project's conventions should be explicit, and it is what stops
		// `sigil add` having to guess and print a guess
		{
			contents: `${JSON.stringify({ components: 'src/components' }, undefined, 2)}\n`,
			path: 'sigil.json',
		},
		{ contents: devRunner(opts), executable: true, path: `dev.${e}` },
		{ contents: entry(opts), path: `src/index.${e}` },
	];

	if (opts.language === 'ts') {
		files.splice(1, 0, { contents: tsconfig(), path: 'tsconfig.json' });
	}

	if (opts.layout === 'multi') {
		files.push({
			contents: exampleCommand(opts.language).replaceAll('${bin}', opts.name),
			path: `src/commands/hello.${e}`,
		});
	}

	const linter = linterConfig(opts.linter);
	if (linter) {
		files.push(linter);
	}

	return files;
}
