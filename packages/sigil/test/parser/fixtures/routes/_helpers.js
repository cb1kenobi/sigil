// Not a route: a `_` prefix is how a helper lives inside a `commands/` tree.
// If this were ever registered it would be a command called `_helpers`.
export default { desc: 'not a command', run: () => 'helpers' };
