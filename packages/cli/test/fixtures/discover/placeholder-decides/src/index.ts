import { __ } from '@ttylabs/sigil/i18n';

const words = 'computed words';
const flag = false;

// Placeholders that declare a `desc` or a `hidden` the build cannot take as a
// plain literal. The runtime registers each placeholder as written, so what it
// declares is what help shows before the module loads -- and the build baked
// the module's answer instead (SIG-352).
export default {
  name: 'placeholder-decides',
  baseDir: import.meta.dirname,
  commands: {
    // evaluated when this module is imported, before `main()` loads a catalog,
    // so from source it is the English
    tagged: { desc: __`Placeholder words`, load: () => import('./commands/build.ts') },
    // evaluated during the parse, after the catalog, so it is translated
    thunk: { desc: () => __`Placeholder words`, load: () => import('./commands/build.ts') },
    computed: { desc: words, load: () => import('./commands/build.ts') },
    // the module hides itself, and the placeholder's computed `false` is what
    // an unloaded command shows
    shown: { hidden: flag, load: () => import('./commands/hidden.ts') },
  },
  locales: {
    de: () => import('./locales/de.json', { with: { type: 'json' } }),
  },
};
