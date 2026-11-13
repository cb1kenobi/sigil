import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    allowOnly: true,
    coverage: {
      include: ['src/**/*.ts'],
      reporter: ['html', 'lcov', 'text'],
    },
    // read by every process a test spawns. pnpm and npm call
    // `module.enableCompileCache()` on startup, which writes
    // `node-compile-cache` into the tmpdir and nothing removes it. See "A
    // spawned tool's compile cache" in packages/sigil/src/testing/AGENTS.md
    env: { NODE_DISABLE_COMPILE_CACHE: '1' },
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    pool: 'threads',
    reporters: ['verbose'],
    setupFiles: ['./test/setup.ts'],
    silent: false,
    testTimeout: 10000,
    watch: false,
  },
});

export default config;
