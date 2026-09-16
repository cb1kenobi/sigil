import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
	test: {
		allowOnly: true,
		benchmark: {
			include: ['benchmark/**/*.bench.ts'],
		},
		coverage: {
			include: ['src/**/*.ts'],
			reporter: ['html', 'lcov', 'text'],
		},
		environment: 'node',
		globals: false,
		include: ['test/**/*.test.ts'],
		pool: 'threads',
		reporters: ['verbose'],
		silent: false,
		testTimeout: 10000,
		watch: false,
	},
});

export default config;
