import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
	// Every entry here must have a matching subpath in the package's `exports`
	// map or its `bin`; the "package wiring" tests in `test/cli.test.ts` assert
	// they stay in sync, and "the built bin" tests assert the output is real.
	entry: {
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
	external: ['@ttylabs/sigil'],
});

export default config;
