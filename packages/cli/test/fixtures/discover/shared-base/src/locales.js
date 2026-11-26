// A shared base carrying `locales`, spread into a schema that spells its own
// (SIG-728): the catalogs the app has are the last ones written, `fr`, and the
// check has to be about those and not about `de`, which nothing loads.
const base = {
  locales: { de: () => import('./locales/de.json', { with: { type: 'json' } }) },
};

export default {
  ...base,
  baseDir: import.meta.dirname,
  commands: { a: './commands/a.js' },
  locales: { fr: () => import('./locales/fr.json', { with: { type: 'json' } }) },
  name: 'shared-base',
};
