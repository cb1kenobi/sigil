// An app whose utility classes carry variants (SIG-526), so that `sigil build`
// has to generate rules the committed sheet does not hold.
export default {
  baseDir: import.meta.dirname,
  commands: './commands',
  desc: 'A fixture app that draws with variant-qualified utility classes',
  name: 'variants',
};
