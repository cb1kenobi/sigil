import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type UserConfig } from 'tsdown';

/**
 * Every command module, as its own entry.
 *
 * The CLI routes its own commands off the filesystem, and a filesystem route
 * needs a file: bundled into hashed chunks there is no `dist/commands/` for the
 * walk to read, and the published bin fails with `Unsupported command module`.
 * So each one is an entry and lands at the path its route name implies.
 *
 * Read from the directory rather than written out, because a hand-kept list
 * beside a directory that *is* the list is the drift this repo already records
 * for `COLOR_PROPERTIES` and the registry -- and here it would drift into a
 * command that works from source and 404s once published.
 *
 * `isPrivateRoute`'s `_` prefix is honoured here for the same reason the walk
 * honours it: `_inspect.ts` is shared by two commands and is not one, so it
 * stays a chunk.
 */
function commandEntries(): Record<string, string> {
	const dir = join(import.meta.dirname, 'src', 'commands');

	return Object.fromEntries(
		readdirSync(dir)
			.filter((file) => file.endsWith('.ts') && !file.startsWith('_') && !file.startsWith('.'))
			.map((file) => {
				const name = file.slice(0, -'.ts'.length);
				return [`commands/${name}`, `./src/commands/${file}`];
			})
	);
}

const config: UserConfig = defineConfig({
	// Every entry here must have a matching subpath in the package's `exports`
	// map or its `bin`; the "package wiring" tests in `test/cli.test.ts` assert
	// they stay in sync, and "the built bin" tests assert the output is real.
	entry: {
		...commandEntries(),
		build: './src/build/index.ts',
		index: './src/index.ts',
		sigil: './src/sigil.ts',
		template: './src/template/index.ts',
		utilities: './src/utilities/index.ts',
	},
	format: ['es'],
	minify: true,
	platform: 'node',
	tsconfig: './tsconfig.build.json',
	// `@ttylabs/sigil` is a workspace dependency rather than something to inline:
	// the zero-dependency promise is about what an app *ships*, and an app ships a
	// bundle. The toolchain itself is a devDependency and may resolve normally.
	deps: { neverBundle: ['@ttylabs/sigil'] },
});

export default config;
