import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
	// Every entry here must have a matching subpath in the package's `exports`
	// map or its `bin`; the "package wiring" tests in `test/cli.test.ts` assert
	// they stay in sync, and "the built bin" tests assert the output is real.
	entry: {
		index: './src/index.ts',
		main2: './src/main2.ts',
	},
	format: ['es'],
	minify: true,
	platform: 'node',
	tsconfig: './tsconfig.build.json',
	// `main2` is a workspace dependency rather than something to inline: the
	// zero-dependency promise is about what an app *ships*, and an app ships a
	// bundle. The toolchain itself is a devDependency and may resolve normally.
	external: ['main2'],
});

export default config;
