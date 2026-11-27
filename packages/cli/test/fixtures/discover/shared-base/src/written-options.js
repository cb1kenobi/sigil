// A key written to a spread const after its declaration (SIG-736). The runtime's
// placeholder for `x` has `options`, so `x --force` is an option from source; the
// literal of `shared` holds only `hidden` and a built app carries no `options`.
const shared = { hidden: true };
shared.options = { '--force': { type: 'bool' } };

export default {
  baseDir: import.meta.dirname,
  commands: { x: { ...shared, path: './commands/a.js' } },
  name: 'shared-base',
};
