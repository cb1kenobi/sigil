import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
	// Every entry here must have a matching subpath in the package's `exports`
	// map, and vice versa; `test/exports.test.ts` asserts they stay in sync.
	entry: {
		ansi: './src/ansi/index.ts',
		canvas: './src/canvas/index.ts',
		components: './src/components/index.ts',
		'error-handler': './src/error-handler.ts',
		help: './src/help/index.ts',
		layout: './src/layout/index.ts',
		index: './src/index.ts',
		paths: './src/paths.ts',
		signals: './src/signals/index.ts',
		style: './src/style/index.ts',
		terminal: './src/terminal/index.ts',
		updates: './src/updates/index.ts',
		width: './src/width/index.ts',
		wrap: './src/wrap/index.ts',
	},
	format: ['es'],
	minify: true,
	platform: 'node',
	tsconfig: './tsconfig.build.json',
	// `updates` spawns the worker by reading it off disk relative to its own
	// module URL, so it has to land next to dist/updates.mjs
	copy: [{ from: './src/updates/get-version-worker.js' }],
});

export default config;
