// A schema whose only `locales` is a getter (SIG-735). The catalogs exist when the
// app runs, and the check cannot read them, so it has to say it did not check them
// rather than report no problems.
export default {
  baseDir: import.meta.dirname,
  commands: { a: './commands/a.js' },
  get locales() {
    return { fr: () => import('./locales/fr.json', { with: { type: 'json' } }) };
  },
  name: 'shared-base',
};
