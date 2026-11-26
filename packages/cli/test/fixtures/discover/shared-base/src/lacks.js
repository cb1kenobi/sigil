// A mixin spread after `commands` that spells no `commands` (SIG-730). Not a const
// the build can seal -- something reads a member of it -- but it visibly holds no
// `commands` and nothing writes one, so it cannot replace the ones written above it.
const mixin = { name: 'shared-base', tags: ['a'] };
mixin.tags.push('b');

export default {
  baseDir: import.meta.dirname,
  commands: { a: './commands/a.js', b: './commands/b.js' },
  ...mixin,
};
