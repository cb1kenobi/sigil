// The shape an app is written in: a few keys shared between placeholders as a
// `const` that is only ever spread, with nothing after the spread to say what the
// spread cannot (SIG-440). The build used to refuse every one of these for `name`,
// `path` and `load`, and warn about `desc`, `alias` and `default`, because
// `base` is a name; a name nothing else touches is what it was declared as.
// Plain JavaScript, so that what runs from source is what the build is compared to.
const named = { name: 'renamed' };
const pathed = { path: './commands/a.js' };
const loaded = { load: () => import('./commands/b.js') };
const routing = { alias: 'sh', default: true };
const words = { desc: 'Shared words', hidden: false };
// carrying options and args, which the build never reads, is not a reason to refuse it (SIG-725)
const shape = { options: { '--force': { type: 'bool' } }, args: ['[target]'] };
// a const the build cannot seal, because something reads a member of it, that still
// visibly holds no `name`, `path` or `load` (SIG-731): nothing can have written one
// to it, so the spread decides none of the three and the placeholder is read
const tagged = { tags: ['a'] };
tagged.tags.push('b');

export default {
  name: 'placeholder-sealed',
  baseDir: import.meta.dirname,
  commands: {
    renamed: { ...named, path: './commands/a.js' },
    viapath: { ...pathed },
    viaload: { ...loaded },
    // the default command, answering to `sh`, described by a const of its own
    aliased: { ...words, ...routing, ...pathed },
    withopts: { ...shape, ...pathed },
    mixed: { ...tagged, path: './commands/b.js' },
  },
};
