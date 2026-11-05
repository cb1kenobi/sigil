import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    reporters: ['verbose'],
    testTimeout: 10000,
    watch: false,
  },
});
