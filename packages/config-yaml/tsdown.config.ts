import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  // `yaml` stays an import rather than being inlined, which is the call
  // `@ttylabs/config-xml` already makes about its own parser: this package
  // declares the dependency, so npm installs it, and inlining would ship a
  // second copy to any app that also depends on it directly
  deps: { neverBundle: ['@ttylabs/sigil', 'yaml'] },
  // one entry, one subpath, which is the sibling's shape and for its reason:
  // there is one of each, so there is nothing for the map and the entries to
  // drift about
  entry: { index: './src/index.ts' },
  format: ['es'],
  minify: true,
  platform: 'node',
  tsconfig: './tsconfig.build.json',
});

export default config;
