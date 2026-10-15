import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  // `@xmldom/xmldom` stays an import rather than being inlined, which is the
  // call `@ttylabs/cli` already makes about the runtime: this package declares
  // the dependency, so npm installs it, and inlining would ship a second copy
  // to any app that also depends on it directly
  deps: { neverBundle: ['@ttylabs/sigil', '@xmldom/xmldom'] },
  // one entry, one subpath. `test/exports.test.ts` in `@ttylabs/sigil` asserts
  // that package's map against its entries; this package has one of each, so
  // there is nothing for the two to drift about
  entry: { index: './src/index.ts' },
  format: ['es'],
  minify: true,
  platform: 'node',
  tsconfig: './tsconfig.build.json',
});

export default config;
