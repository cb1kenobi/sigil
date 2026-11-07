import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  // the runtime stays an import: an app taking a screenshot already depends on
  // it, and a second copy inlined here would be a second `CellBuffer` class
  deps: { neverBundle: ['@ttylabs/sigil'] },
  // one entry, one subpath, as in the config stores. The fonts are not bundled
  // and not copied: `src/fonts.ts` reads them from `../fonts/`, which is the
  // same directory from `src/` and from `dist/`, so the build reads none of them
  entry: { index: './src/index.ts' },
  format: ['es'],
  minify: true,
  platform: 'node',
  tsconfig: './tsconfig.build.json',
});

export default config;
