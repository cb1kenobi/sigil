import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  // the runtime stays an import, which is the call every package that depends
  // on it makes: an app already has `@ttylabs/sigil`, and inlining it would ship
  // a second copy whose `main()` and registries are not the app's
  deps: { neverBundle: ['@ttylabs/sigil'] },
  entry: { index: './src/index.ts' },
  format: ['es'],
  minify: true,
  platform: 'node',
  tsconfig: './tsconfig.build.json',
});

export default config;
